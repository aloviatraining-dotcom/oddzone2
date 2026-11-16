import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Facial biometric verification contract
//
// POST { action: "verify_face", nin_or_bvn, selfie_base64,
//        liveness_frames_base64?: string[], challenge_id, consent_granted }
//   -> { success: true, confidence: number }        (identity matched)
//   -> { success: false, reason: "..." }            (anything else)
//
// POST { action: "create_face_challenge", id_document_type: "nin" | "bvn" }
//   -> { success: true, challenge_id, expires_at }
//
// The webcam component must first ask for a challenge, then post exactly one
// selfie against it (see 20261019000003_facial_biometric_verification.sql for
// why the challenge exists).
// ---------------------------------------------------------------------------

const PROVIDERS = ["smile_id", "prembly", "youverify"] as const;
type Provider = typeof PROVIDERS[number];

const MATCH_THRESHOLD = 85;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
// ~3 MB of binary. The camera component produces well under this.
const MAX_SELFIE_BYTES = 3 * 1024 * 1024;
const MAX_LIVENESS_BYTES = 1 * 1024 * 1024;
const MAX_LIVENESS_FRAMES = 8;
const MIN_LIVENESS_FRAMES = 6;
const PROVIDER_SUBMIT_TIMEOUT_MS = 60_000;
const STATUS_POLL_TIMEOUT_MS = 5_000;

const NIGERIAN_ID_TYPES = {
  nin: { smileId: "NIN_V2", prembly: "nin", youverify: "nin" },
  bvn: { smileId: "BVN", prembly: "bvn", youverify: "bvn" },
} as const;
type IdDocumentType = keyof typeof NIGERIAN_ID_TYPES;

// Smile ID block reasons that mean "the face or the person failed" rather than
// "risk controls want a review", so the UI can give actionable feedback.
const SMILE_FACE_FAILURES = new Set([
  "face_verification_failed",
  "spoof_detected",
  "identifier_not_found",
]);

type PaystackResponse = {
  status?: boolean;
  message?: string;
  data?: Record<string, unknown>;
  meta?: { pageCount?: number };
};

type SmileTokenResponse = {
  token?: string;
  message?: string;
};

// Everything persisted or shown about a provider answer goes through this shape.
// `confidence` is null when the provider reports only a disposition.
type ProviderVerdict =
  | {
    status: "clear";
    confidence: number | null;
    providerJobId: string | null;
    legalName: string | null;
  }
  | { status: "attention" | "block" | "error"; reason: string; providerJobId: string | null };

type ImageInput = { base64: string; mime: "image/jpeg" | "image/png" };

// A body that carries only the three core fields is the simple selfie -> NIN/BVN
// contract. It gets a single-use challenge minted server-side, so the liveness
// frames are tagged to this capture without putting a challenge round-trip in
// front of callers that only want to post a selfie.
const MINIMAL_VERIFY_KEYS = new Set(["user_id", "nin_or_bvn", "selfie_base64"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMinimalVerifyBody(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body);
  return keys.length > 0 && keys.every((key) => MINIMAL_VERIFY_KEYS.has(key));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function maskIdentityNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `${digits.slice(0, 2)}${"*".repeat(digits.length - 4)}${digits.slice(-2)}`;
}

function validBankCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{2,8}$/.test(value);
}

function validAccountNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{10}$/.test(value);
}

function verifiedLegalName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 120 && !/[\u0000-\u001f\u007f]/.test(name)
    ? name
    : null;
}

function normalizePersonName(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();
}

const WITHDRAWAL_NAME_MISMATCH =
  "Withdrawal failed: The bank account name must match your verified account name.";

const PAYSTACK_TEST_RESOLVE_LIMIT_MESSAGE =
  "Paystack test mode has reached its daily bank-account lookup limit. For testing, use Paystack test bank code 001. For real account checks, configure a live Paystack secret only when real payments are intended.";

function bankResolveErrorMessage(message: unknown, fallback: string): string {
  const providerMessage = typeof message === "string" ? message.trim() : "";
  if (/daily limit.*(?:bank resolves?|account resolves?)|test bank codes|upgrade to live mode/i.test(providerMessage)) {
    return PAYSTACK_TEST_RESOLVE_LIMIT_MESSAGE;
  }
  return providerMessage || fallback;
}

function providerBaseUrl(smileEnvironment: string): string {
  return smileEnvironment === "production"
    ? "https://api.smileidentity.com"
    : "https://testapi.smileidentity.com";
}

// ---------------------------------------------------------------------------
// Image handling
// ---------------------------------------------------------------------------

/**
 * Accepts a data URL or bare base64, verifies the bytes really are JPEG/PNG
 * (the client's declared MIME type is never trusted), enforces the byte cap
 * before decoding, and returns clean bytes.
 */
function readImage(value: unknown, maxBytes: number): ImageInput | null {
  if (typeof value !== "string" || !value) return null;
  const match = value.match(/^data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=\s]+)$/i);
  const payload = (match ? match[2] : value).replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  // 4 base64 chars carry 3 bytes; reject on length before allocating.
  if (Math.floor((payload.length * 3) / 4) > maxBytes) return null;

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length < 12) return null;

  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const mime: ImageInput["mime"] | null = isJpeg ? "image/jpeg" : isPng ? "image/png" : null;
  if (!mime) return null;
  // Declared and actual type must agree.
  if (match && match[1].toLowerCase().startsWith("png") !== (mime === "image/png")) return null;

  return { base64: payload, mime };
}

function imageBlob(image: ImageInput): Blob {
  const bytes = Uint8Array.from(atob(image.base64), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: image.mime });
}

function clampConfidence(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(value)) return null;
  const percent = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

// Terminal HTTP statuses for the { success: false, reason } contract. Over HTTP,
// a 4xx body is hidden from functions.invoke() callers, so 200 is the default;
// these codes are for direct callers and logs.
function httpStatusFor(reason: string): number {
  switch (reason) {
    case "invalid_request":
    case "invalid_selfie":
    case "invalid_liveness_frames":
    case "invalid_nin_or_bvn":
    case "consent_required":
      return 400;
    case "missing_challenge":
    case "challenge_expired":
    case "challenge_consumed":
    case "challenge_user_mismatch":
      return 409;
    case "unauthorized":
      return 401;
    case "rate_limited":
      return 429;
    case "provider_unavailable":
    case "provider_auth_failed":
      return 503;
    case "profile_missing":
    case "persist_failed":
      return 500;
    default:
      return 200;
  }
}

/** Never returns raw provider text: it can contain ID numbers. */
function failure(reason: string, message: string, extra: Record<string, unknown> = {}) {
  return json({ success: false, reason, message, ...extra }, httpStatusFor(reason));
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

type Prerequisites = {
  userId: string;
  email: string | null;
  idDocumentType: IdDocumentType;
  idNumber: string;
  selfie: ImageInput;
  livenessFrames: ImageInput[];
  idMasked: string;
};

type SmileSettings = {
  partnerId: string;
  apiKey: string;
  environment: "production" | "sandbox";
  partnerName: string;
  policyUrl: string;
  callbackUrl: string | null;
};

async function smileToken(settings: SmileSettings): Promise<string | null> {
  const form = new FormData();
  form.set("product", "biometric_kyc");
  const response = await fetch(`${providerBaseUrl(settings.environment)}/v3/token`, {
    method: "POST",
    headers: {
      "SmileID-Partner-ID": settings.partnerId,
      "SmileID-API-Key": settings.apiKey,
    },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json() as SmileTokenResponse;
  if (!response.ok || typeof result.token !== "string" || !result.token) {
    console.error("Smile ID token request failed:", response.status, result.message || "Unknown provider error");
    return null;
  }
  return result.token;
}

/**
 * Smile ID Biometric KYC (REST v3). Submission is asynchronous: 202 + job_id,
 * then GET /v3/status/{jobId} until it is no longer `processing`. That status
 * response carries a disposition only -- no face-match score -- so confidence
 * is null here and the 85% gate cannot be applied to a number Smile ID never
 * published. A `clear` means its face match AND liveness AND authority lookup
 * all passed.
 */
async function verifyWithSmileId(settings: SmileSettings, input: Prerequisites): Promise<ProviderVerdict> {
  const baseUrl = providerBaseUrl(settings.environment);
  const token = await smileToken(settings);
  if (!token) return { status: "error", reason: "provider_auth_failed", providerJobId: null };
  const headers = { "SmileID-Token": token, Accept: "application/json" };

  const form = new FormData();
  form.set("selfie_image", imageBlob(input.selfie), "selfie.jpg");
  for (const [index, frame] of input.livenessFrames.entries()) {
    form.set("liveness_images", imageBlob(frame), `${index}.jpg`);
  }
  form.set("country", "NG");
  form.set("id_type", NIGERIAN_ID_TYPES[input.idDocumentType].smileId);
  // Sent here rather than bound into the token payload: a bound id_number is
  // echoed in partner_params, which the browser receives when an async job starts.
  form.set("id_number", input.idNumber);
  form.set("user_details", JSON.stringify({
    given_names: settings.partnerName,
    last_name: "Member",
    ...(input.email ? { email: input.email } : { phone_number: "+2348000000000" }),
  }));
  // Consent is the component's checkbox; the timestamp is server-side.
  form.set("consent", JSON.stringify({
    granted: true,
    granted_at: new Date().toISOString(),
    notice_language: "EN",
    notice_privacy_policy_url: settings.policyUrl,
  }));
  if (settings.callbackUrl) form.set("callback_url", settings.callbackUrl);
  form.set("partner_params", JSON.stringify({ oddzone_user_id: input.userId }));

  const submit = await fetch(`${baseUrl}/v3/biometric_kyc`, {
    method: "POST",
    headers,
    body: form,
    signal: AbortSignal.timeout(PROVIDER_SUBMIT_TIMEOUT_MS),
  });
  const accepted: unknown = await submit.json().catch(() => null);
  const jobId = isRecord(accepted) && typeof accepted.job_id === "string" ? accepted.job_id : "";
  if (!submit.ok || !jobId) {
    console.error("Smile ID Biometric KYC submission failed:", submit.status);
    return { status: "error", reason: "provider_unavailable", providerJobId: null };
  }

  // The signed webhook fires too; whichever lands first wins (see the claim
  // above the provider call, and the webhook's status-guarded update).
  const deadline = Date.now() + PROVIDER_SUBMIT_TIMEOUT_MS;
  let delay = 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 1.5, 4000);

    const response = await fetch(`${baseUrl}/v3/status/${encodeURIComponent(jobId)}`, {
      headers,
      signal: AbortSignal.timeout(STATUS_POLL_TIMEOUT_MS),
    });
    // 202 is still processing, 200 is terminal. Anything else is a transient
    // failure; keep polling until the deadline rather than failing the user.
    if (response.status !== 200 && response.status !== 202) continue;

    const payload: unknown = await response.json().catch(() => null);
    const statusPayload = isRecord(payload) ? payload : {};
    const state = typeof statusPayload.status === "string" ? statusPayload.status : "processing";
    const reason = typeof statusPayload.reason === "string" ? statusPayload.reason.slice(0, 160) : "";
    if (state === "processing") continue;
    if (state === "clear") {
      const idFields = isRecord(statusPayload.id_fields) ? statusPayload.id_fields : {};
      return {
        status: "clear",
        confidence: null,
        providerJobId: jobId,
        legalName: verifiedLegalName(idFields.full_name),
      };
    }
    if (state === "attention") return { status: "attention", reason: reason || "manual_review", providerJobId: jobId };
    if (state === "block" || state === "error") {
      return { status: state, reason: reason || "verification_failed", providerJobId: jobId };
    }
  }
  return { status: "error", reason: "provider_timeout", providerJobId: jobId };
}

/**
 * Prembly "Face Verification" (also sold as IdentityPass). Synchronous: the
 * response carries both a match flag and a score, which is what makes the 85%
 * gate meaningful.
 */
async function verifyWithPrembly(apiKey: string, input: Prerequisites): Promise<ProviderVerdict> {
  const form = new FormData();
  form.set("image", imageBlob(input.selfie), "selfie.jpg");
  form.set("number", input.idNumber);
  form.set("verification_type", NIGERIAN_ID_TYPES[input.idDocumentType].prembly);

  const response = await fetch("https://api.prembly.com/identitypass/verification/face", {
    method: "POST",
    headers: { "x-api-key": apiKey },
    body: form,
    signal: AbortSignal.timeout(PROVIDER_SUBMIT_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch(() => null);
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};

  const confidence = clampConfidence(
    data.face_match_confidence ?? data.confidence ?? data.match_score ?? data.match_confidence,
  );
  const matched = confidence !== null && confidence >= MATCH_THRESHOLD;
  if (response.ok && matched) {
    return {
      status: "clear",
      confidence,
      providerJobId: null,
      legalName: verifiedLegalName(data.full_name),
    };
  }
  return {
    status: response.ok ? "block" : "error",
    reason: response.ok ? "face_verification_failed" : "provider_unavailable",
    providerJobId: null,
  };
}

/** YouVerify V2 face-match. Synchronous; returns a similarity score. */
async function verifyWithYouVerify(apiKey: string, input: Prerequisites): Promise<ProviderVerdict> {
  const response = await fetch("https://api.youverify.co/v2/api/identity/ng/face/match", {
    method: "POST",
    headers: { token: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      idNumber: input.idNumber,
      idType: NIGERIAN_ID_TYPES[input.idDocumentType].youverify,
      image: imageBlob(input.selfie),
    }),
    signal: AbortSignal.timeout(PROVIDER_SUBMIT_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch(() => null);
  const root = isRecord(payload) ? payload : {};
  const data = isRecord(root.data) ? root.data : {};

  const confidence = clampConfidence(data.confidence ?? data.similarity ?? data.matchScore ?? data.score);
  const matched = confidence !== null && confidence >= MATCH_THRESHOLD;
  if (response.ok && matched) {
    return {
      status: "clear",
      confidence,
      providerJobId: null,
      legalName: verifiedLegalName(data.full_name),
    };
  }
  return {
    status: response.ok ? "block" : "error",
    reason: response.ok ? "face_verification_failed" : "provider_unavailable",
    providerJobId: null,
  };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

type AdminClient = ReturnType<typeof createClient>;

async function createFaceChallenge(
  adminClient: AdminClient,
  userId: string,
  email: string | null,
  idDocumentType: string,
): Promise<Response> {
  if (idDocumentType !== "nin" && idDocumentType !== "bvn") {
    return failure("invalid_request", "Choose NIN or BVN.");
  }

  const { count, error: countError } = await adminClient
    .from("oddzone_face_challenges")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());
  if (countError) {
    console.error("Could not count recent face challenges:", countError.message);
    return failure("persist_failed", "Could not start verification. Please retry.");
  }
  if ((count || 0) >= 5) {
    return failure("rate_limited", "Too many verification attempts. Wait 15 minutes and try again.");
  }

  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();
  const { data, error } = await adminClient
    .from("oddzone_face_challenges")
    .insert({
      user_id: userId,
      id_document_type: idDocumentType,
      user_email: email,
      expires_at: expiresAt,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("Could not create face challenge:", error?.message);
    return failure("persist_failed", "Could not start verification. Please retry.");
  }

  return json({ success: true, challenge_id: data.id, expires_at: expiresAt });
}

type FaceChallenge = { id: string; user_email: string | null; id_document_type: string };

/** Creates and immediately consumes a server-side challenge (see isMinimalVerifyBody). */
async function issueInlineChallenge(
  adminClient: AdminClient,
  userId: string,
  email: string | null,
  idDocumentType: string,
): Promise<{ challenge: FaceChallenge } | { response: Response }> {
  const created = await createFaceChallenge(adminClient, userId, email, idDocumentType);
  if (created.status !== 200) return { response: created };
  const payload = await created.json().catch(() => null);
  const challengeId = isRecord(payload) && typeof payload.challenge_id === "string" ? payload.challenge_id : "";
  if (!isRecord(payload) || payload.success !== true || !challengeId) {
    return { response: failure("persist_failed", "Could not start verification. Please retry.") };
  }
  const { data: claimed, error } = await adminClient
    .from("oddzone_face_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", challengeId)
    .eq("user_id", userId)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (error || !claimed) {
    console.error("Could not claim inline face challenge:", error?.message);
    return { response: failure("persist_failed", "Could not start verification. Please retry.") };
  }
  return { challenge: { id: challengeId, user_email: email, id_document_type: idDocumentType } };
}

/**
 * Picks the challenge a capture belongs to. A `response` means the supplied
 * challenge_id was missing, used, expired, or not this user's.
 */
async function resolveChallenge(
  adminClient: AdminClient,
  userId: string,
  body: Record<string, unknown>,
): Promise<{ challenge: FaceChallenge; inline: boolean } | { response: Response }> {
  if (body.challenge_id !== undefined) {
    const challengeId = body.challenge_id;
    if (typeof challengeId !== "string" || !/^[0-9a-f-]{36}$/i.test(challengeId)) {
      return { response: failure("missing_challenge", "Capture a fresh selfie to verify.") };
    }
    // Filtered by user_id, so another user's id is a miss, not a leak.
    const { data: challenge, error: challengeError } = await adminClient
      .from("oddzone_face_challenges")
      .select("id,user_id,id_document_type,user_email,expires_at,consumed_at")
      .eq("id", challengeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (challengeError) {
      console.error("Could not read face challenge:", challengeError.message);
      return { response: failure("persist_failed", "Could not start verification. Please retry.") };
    }
    if (!challenge) return { response: failure("challenge_user_mismatch", "Capture a fresh selfie to verify.") };
    if (challenge.consumed_at) {
      return { response: failure("challenge_consumed", "That capture was already used. Capture a fresh selfie.") };
    }
    if (new Date(challenge.expires_at).getTime() < Date.now()) {
      return { response: failure("challenge_expired", "The capture expired. Capture a fresh selfie.") };
    }
    return { challenge, inline: false };
  }

  // Minimal contract: no client-issued challenge. The inline one is created
  // and claimed in one step, so it can only ever back this single request.
  const idDocumentType = typeof body.id_document_type === "string" ? body.id_document_type : "nin";
  const issued = await issueInlineChallenge(adminClient, userId, null, idDocumentType);
  if ("response" in issued) return issued;
  return { challenge: issued.challenge, inline: true };
}

async function verifyFace(adminClient: AdminClient, userId: string, body: Record<string, unknown>): Promise<Response> {
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id,is_verified,kyc_id_masked,email")
    .eq("id", userId)
    .maybeSingle();
  if (profileError) {
    console.error("Could not read profile for face verification:", profileError.message);
    return failure("persist_failed", "Could not load your account. Please retry.");
  }
  if (!profile) return failure("profile_missing", "Complete your profile before verifying.");
  // Idempotent: never spend a provider call, and never touch an existing
  // verification, for an account that is already verified.
  if (profile.is_verified === true) {
    return json({ success: true, confidence: 100, confidence_reported: false, already_verified: true });
  }

  if (body.consent_granted !== true) {
    return failure("consent_required", "Tick the consent box before capturing your face.");
  }

  // Validate before minting anything: a bad request must not spend one of the
  // user's five challenges per 15 minutes.
  const idNumber = typeof body.nin_or_bvn === "string" ? body.nin_or_bvn.trim().replace(/[\s-]/g, "") : "";
  // NIN and BVN are both 11 digits.
  if (!/^\d{11}$/.test(idNumber)) {
    return failure("invalid_nin_or_bvn", "Enter the 11-digit NIN or BVN.");
  }

  const selfie = readImage(body.selfie_base64, MAX_SELFIE_BYTES);
  if (!selfie) return failure("invalid_selfie", "The selfie could not be read. Capture again with good lighting.");

  let livenessFrames: ImageInput[];
  if (Array.isArray(body.liveness_frames_base64)) {
    if (body.liveness_frames_base64.length > MAX_LIVENESS_FRAMES) {
      return failure("invalid_liveness_frames", "Too many liveness frames. Capture again.");
    }
    const frames = body.liveness_frames_base64
      .map((frame) => readImage(frame, MAX_LIVENESS_BYTES))
      .filter((frame): frame is ImageInput => frame !== null);
    if (frames.length !== body.liveness_frames_base64.length || frames.length < MIN_LIVENESS_FRAMES) {
      return failure("invalid_liveness_frames", "The liveness frames could not be read. Capture again with good lighting.");
    }
    livenessFrames = frames;
  } else {
    livenessFrames = [selfie];
  }

  const resolved = await resolveChallenge(adminClient, userId, body);
  if ("response" in resolved) return resolved.response;
  const { challenge } = resolved;
  const emailForProvider = challenge.user_email || profile.email || null;
  const idDocumentType = challenge.id_document_type as IdDocumentType;

  const providerName = (Deno.env.get("KYC_PROVIDER") || "smile_id").trim().toLowerCase() as Provider;
  if (!PROVIDERS.includes(providerName)) {
    console.error(`Unsupported KYC_PROVIDER "${providerName}".`);
    return failure("provider_unavailable", "Identity verification is not configured.");
  }
  const apiKey = Deno.env.get("KYC_PROVIDER_SECRET_KEY");
  if (!apiKey) {
    console.error("KYC_PROVIDER_SECRET_KEY is not configured for facial verification.");
    return failure("provider_unavailable", "Identity verification is not configured.");
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const settings: SmileSettings = {
    partnerId: (Deno.env.get("SMILE_ID_PARTNER_ID") || "").trim(),
    apiKey,
    environment: Deno.env.get("SMILE_ID_ENVIRONMENT") === "production" ? "production" : "sandbox",
    partnerName: Deno.env.get("SMILE_ID_PARTNER_NAME") || "OddZone",
    policyUrl: Deno.env.get("KYC_PRIVACY_POLICY_URL") || "https://odddzone.com/privacy",
    callbackUrl: supabaseUrl
      ? `${supabaseUrl.replace(/\/$/, "")}/functions/v1/verify-identity?action=smile_webhook`
      : null,
  };
  if (providerName === "smile_id" && (!settings.partnerId || !settings.callbackUrl || !settings.policyUrl.startsWith("https://"))) {
    console.error("Smile ID partner id, callback URL or HTTPS privacy policy URL is missing.");
    return failure("provider_unavailable", "Identity verification is not configured.");
  }

  // Claim the challenge before calling the provider: whatever happens next,
  // this capture is spent, so a double-click cannot buy a second attempt.
  const { data: claimed, error: claimError } = await adminClient
    .from("oddzone_face_challenges")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", challenge.id)
    .eq("user_id", userId)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (claimError) {
    console.error("Could not claim face challenge:", claimError.message);
    return failure("persist_failed", "Could not start verification. Please retry.");
  }
  if (!claimed) return failure("challenge_consumed", "That capture was already used. Capture a fresh selfie.");

  const input: Prerequisites = {
    userId,
    email: emailForProvider,
    idDocumentType,
    idNumber,
    selfie,
    livenessFrames,
    // NIN needs 11 digits; 6 is the masked helper's floor.
    idMasked: `${idNumber.slice(0, 2)}${"*".repeat(idNumber.length - 4)}${idNumber.slice(-4)}`,
  };

  const verdict = providerName === "smile_id"
    ? await verifyWithSmileId(settings, input)
    : providerName === "prembly"
    ? await verifyWithPrembly(apiKey, input)
    : await verifyWithYouVerify(apiKey, input);

  // Providers that report a score must clear 85%. A null score means the provider
  // published only a disposition, and `clear` is that provider's own verdict.
  const score = verdict.status === "clear" ? verdict.confidence : null;
  const legalName = verdict.status === "clear" && providerName === "smile_id"
    ? verdict.legalName
    : null;
  const approved = verdict.status === "clear"
    && (score === null || score >= MATCH_THRESHOLD);

  // Audit trail for every outcome. session_id uses the same shape as the inline
  // SDK sessions so the status UI needs no branch; the browser never sees it.
  const { data: audit, error: auditError } = await adminClient
    .from("oddzone_kyc_verifications")
    .insert({
      session_id: crypto.randomUUID(),
      user_id: userId,
      provider: providerName,
      status: verdict.status,
      provider_job_id: verdict.providerJobId,
      reason: verdict.status === "clear" ? null : verdict.reason,
      match_confidence: score,
      id_document_type: idDocumentType,
      face_challenge_id: challenge.id,
      completed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (auditError) {
    console.error("Could not record face verification attempt:", auditError.message);
    if (auditError.code === "23505") {
      return failure("challenge_consumed", "That capture was already used. Capture a fresh selfie.");
    }
    return failure("persist_failed", "Could not save the verification result. Please retry.");
  }

  if (!approved) {
    if (verdict.status === "attention") {
      return failure("manual_review", "We need a closer look before verifying your identity. Please contact support.");
    }
    const message = verdict.status !== "clear" && SMILE_FACE_FAILURES.has(verdict.reason)
      ? "The selfie did not match the photo on file for that NIN/BVN, or liveness could not be confirmed. Try again in good lighting."
      : "Identity could not be verified right now. Check your NIN/BVN and try again later.";
    return failure(verdict.status === "clear" ? "low_confidence" : verdict.reason, message);
  }

  const verifiedAt = new Date().toISOString();
  // The hosted Smile ID flow and this flow both write the provider-returned
  // name. A successful face check from another provider must not replace it.
  const { data: profileClaim, error: updateError } = await adminClient
    .from("profiles")
    .update({
      is_verified: true,
      verified_at: verifiedAt,
      kyc_type: providerName === "smile_id" ? "biometric" : `biometric_${providerName}`,
      kyc_id_masked: input.idMasked,
      ...(legalName
        ? {
          legal_name: legalName,
          verified_legal_name: legalName,
          legal_name_verified_at: verifiedAt,
        }
        : {}),
    })
    .eq("id", userId)
    .select("id")
    .maybeSingle();
  if (updateError) {
    console.error("Could not mark profile verified:", updateError.message);
    await adminClient
      .from("oddzone_kyc_verifications")
      .update({ status: "error", reason: "profile_update_failed", completed_at: verifiedAt })
      .eq("id", audit.id);
    return failure("persist_failed", "Your identity matched but could not be saved. Please contact support.");
  }
  if (!profileClaim) {
    console.error("Could not find profile after successful identity verification.");
    await adminClient
      .from("oddzone_kyc_verifications")
      .update({ status: "error", reason: "profile_not_found", completed_at: verifiedAt })
      .eq("id", audit.id);
    return failure("persist_failed", "Your identity matched but could not be saved. Please contact support.");
  }

  return json({
    success: true,
    // Smile ID's `clear` already asserts face match + liveness + authority lookup,
    // and it publishes no score. Reporting 100 with confidence_reported: false says
    // "passed", without passing off a number the provider never gave us as a match
    // percentage. Providers that do report a score pass it through unchanged.
    confidence: score ?? 100,
    confidence_reported: score !== null,
    verified_at: verifiedAt,
    legal_name: legalName,
    withdrawal_eligible: Boolean(legalName),
  });
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

async function verifySmileWebhook(req: Request): Promise<Response> {
  const apiKey = Deno.env.get("KYC_PROVIDER_SECRET_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!apiKey || !supabaseUrl || !serviceRoleKey) {
    console.error("Smile ID webhook is missing server configuration.");
    return json({ error: "Verification callback is not configured." }, 503);
  }

  // Signature over the raw body (v3) or the legacy timestamp+partner string,
  // always HMAC-SHA256 with the API key.
  const timestamp = req.headers.get("Response-Timestamp") || "";
  const suppliedSignature = req.headers.get("Response-Signature") || "";
  const rawBody = await req.text();
  if (!timestamp || !suppliedSignature) return json({ error: "Missing webhook signature." }, 401);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const target = rawBody
    ? new TextEncoder().encode(timestamp + rawBody)
    : new TextEncoder().encode(`${timestamp}${Deno.env.get("SMILE_ID_PARTNER_ID") || ""}sid_request`);
  const signature = base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, target)));
  if (signature !== suppliedSignature) return json({ error: "Invalid webhook signature." }, 401);

  let result: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!isRecord(parsed)) return json({ error: "Invalid verification callback." }, 400);
    result = parsed;
  } catch {
    return json({ error: "Invalid verification callback JSON." }, 400);
  }

  const partnerParams = isRecord(result.partner_params) ? result.partner_params : {};
  const sessionId = partnerParams.oddzone_session_id;
  const jobId = typeof partnerParams.job_id === "string" ? partnerParams.job_id : "";
  const providerStatus = String(result.status ?? "");
  if (
    result.product !== "biometric_kyc" ||
    (typeof sessionId !== "string" && !jobId) ||
    !["clear", "attention", "block", "error"].includes(providerStatus)
  ) {
    console.error("Smile ID webhook did not contain a supported product result.");
    return json({ error: "Unsupported verification callback." }, 400);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // Our own session id when present; otherwise the provider job id, which the
  // verify_face mode records. Newest pending row wins for a repeated job id.
  let matching = adminClient
    .from("oddzone_kyc_verifications")
    .select("id,user_id,status")
    .order("created_at", { ascending: false })
    .limit(1);
  matching = typeof sessionId === "string" && /^[0-9a-f-]{36}$/i.test(sessionId)
    ? matching.eq("session_id", sessionId)
    : matching.eq("provider_job_id", jobId).eq("provider", "smile_id");
  const { data: rows, error: lookupError } = await matching;
  if (lookupError) {
    console.error("Could not find Smile ID verification session:", lookupError.message);
    return json({ error: "Could not match the verification callback." }, 500);
  }
  // `reason = 'processing'` is this function's tombstone while it finishes the
  // row; only a genuine pending row is claimable.
  const pending = ((rows || []) as Array<{ id: string; user_id: string; status: string }>)
    .find((row) => row.status === "pending");
  if (!pending) return json({ success: true, ignored: true });

  // Claim the audit row atomically: the inline verify_face call polls the
  // provider as well, so both paths can race on the same job id. Only the
  // winner updates profiles, which keeps this exactly-once per job.
  const { data: claimed, error: claimError } = await adminClient
    .from("oddzone_kyc_verifications")
    .update({ status: "error", reason: "processing", completed_at: new Date().toISOString() })
    .eq("id", pending.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (claimError) {
    console.error("Could not claim Smile ID verification:", claimError.message);
    return json({ error: "Could not save the verification result." }, 500);
  }
  if (!claimed) return json({ success: true, duplicate: true });
  const verification = pending;

  const completedAt = new Date().toISOString();
  const idFields = isRecord(result.id_fields) ? result.id_fields : {};
  const legalName = providerStatus === "clear" ? verifiedLegalName(idFields.full_name) : null;
  const status = providerStatus;
  const statusReason = typeof result.reason === "string" ? result.reason.slice(0, 160) : null;
  const maskedId = status === "clear" ? maskIdentityNumber(idFields.id_number) : null;

  if (status === "clear") {
    const { error: profileError } = await adminClient
      .from("profiles")
      .update({
        is_verified: true,
        verified_at: completedAt,
        kyc_type: "biometric",
        kyc_id_masked: maskedId,
        ...(legalName
          ? {
            legal_name: legalName,
            verified_legal_name: legalName,
            legal_name_verified_at: completedAt,
          }
          : {}),
      })
      .eq("id", verification.user_id);
    if (profileError) {
      console.error("Could not persist Smile ID verification:", profileError.message);
      return json({ error: "Could not save the verified identity." }, 500);
    }
  }

  const { error: updateError } = await adminClient
    .from("oddzone_kyc_verifications")
    .update({
      status,
      provider_job_id: jobId || req.headers.get("smileid-job-id") || null,
      reason: statusReason,
      completed_at: completedAt,
    })
        .eq("id", verification.id);
    if (updateError) {
    console.error("Could not save Smile ID result:", updateError.message);
    return json({ error: "Could not save the verification result." }, 500);
  }
  return json({ success: true });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const urlAction = new URL(req.url).searchParams.get("action");
    if (urlAction === "smile_webhook") return await verifySmileWebhook(req);

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const smileApiKey = Deno.env.get("KYC_PROVIDER_SECRET_KEY");
    const smilePartnerId = Deno.env.get("SMILE_ID_PARTNER_ID");
    const paystackSecretKey = Deno.env.get("PAYSTACK_SECRET_KEY");

    const authorization = req.headers.get("Authorization") || "";
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return json({ error: "Please sign in to continue." }, 401);

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error("Identity verification is missing Supabase environment configuration.");
      return json({ error: "Identity verification is not configured." }, 503);
    }

    let body: Record<string, unknown>;
    try {
      const payload: unknown = await req.json();
      if (!isRecord(payload)) return json({ error: "Request body must be a JSON object." }, 400);
      body = payload;
    } catch {
      return json({ error: "Request body must be valid JSON." }, 400);
    }
    const action = body.action;

    // Every mode below trusts the authenticated user, so the bearer token is
    // resolved first and nothing runs for an unverified caller.
    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Your session expired. Please sign in again." }, 401);
    const userId = authData.user.id;

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (action === "create_face_challenge") {
      return await createFaceChallenge(adminClient, userId, authData.user.email || null, String(body.id_document_type ?? ""));
    }
    if (action === "verify_face") {
      return await verifyFace(adminClient, userId, body);
    }
    // Core contract: { user_id, nin_or_bvn, selfie_base64 }. user_id is
    // cross-checked against the token, never trusted on its own.
    if (isMinimalVerifyBody(body)) {
      if (body.user_id !== userId) {
        return failure("forbidden", "You can only verify your own account.");
      }
      return await verifyFace(adminClient, userId, { ...body, consent_granted: true });
    }

    if (action === "start_biometric") {
      const partnerName = Deno.env.get("SMILE_ID_PARTNER_NAME") || "OddZone";
      const logoUrl = Deno.env.get("SMILE_ID_LOGO_URL")
        || "https://raw.githubusercontent.com/ehmhoblizz-cyber/OddZone-Bet/main/icon.png";
      const policyUrl = Deno.env.get("SMILE_ID_POLICY_URL")
        || Deno.env.get("KYC_PRIVACY_POLICY_URL")
        || "";
      const environment = Deno.env.get("SMILE_ID_ENVIRONMENT") === "production" ? "production" : "sandbox";
      if (!smileApiKey || !smilePartnerId) {
        console.error("Smile ID API key or partner ID is missing.");
        return json({
          error: "Smile ID is missing its API key or partner ID. Configure KYC_PROVIDER_SECRET_KEY and SMILE_ID_PARTNER_ID in Supabase Function Secrets.",
        }, 503);
      }
      if (!logoUrl.startsWith("https://") || !policyUrl.startsWith("https://")) {
        console.error("Smile ID logo or privacy-policy URL is missing or invalid.");
        return json({
          error: "Smile ID needs a public HTTPS privacy-policy URL. Configure KYC_PRIVACY_POLICY_URL in Supabase Function Secrets.",
        }, 503);
      }

      const sessionId = crypto.randomUUID();
      const callbackUrl = `${supabaseUrl.replace(/\/$/, "")}/functions/v1/verify-identity?action=smile_webhook`;
      const { error: insertError } = await adminClient
        .from("oddzone_kyc_verifications")
        .insert({ session_id: sessionId, user_id: userId, status: "pending" });
      if (insertError) {
        console.error("Could not create biometric verification session:", insertError.message);
        return json({ error: "Could not start biometric verification. Please retry." }, 500);
      }

      const tokenForm = new FormData();
      tokenForm.set("user_id", userId);
      tokenForm.set("product", "biometric_kyc");
      tokenForm.set("partner_params", JSON.stringify({ oddzone_session_id: sessionId }));
      tokenForm.set("payload", JSON.stringify({ callback_url: callbackUrl }));
      const tokenResponse = await fetch(`${providerBaseUrl(environment)}/v3/token`, {
        method: "POST",
        headers: {
          "SmileID-Partner-ID": smilePartnerId,
          "SmileID-API-Key": smileApiKey,
        },
        body: tokenForm,
        signal: AbortSignal.timeout(15000),
      });
      const tokenResult = await tokenResponse.json() as SmileTokenResponse;
      if (!tokenResponse.ok || typeof tokenResult.token !== "string" || !tokenResult.token) {
        await adminClient
          .from("oddzone_kyc_verifications")
          .update({ status: "error", reason: "token_request_failed", completed_at: new Date().toISOString() })
          .eq("session_id", sessionId)
          .eq("user_id", userId);
        console.error("Smile ID token request failed:", tokenResponse.status, tokenResult.message || "Unknown provider error");
        return json({ error: tokenResult.message || "Could not start secure biometric verification." }, 502);
      }

      return json({
        success: true,
        session_id: sessionId,
        token: tokenResult.token,
        callback_url: callbackUrl,
        environment,
        partner_details: {
          partner_id: smilePartnerId,
          name: partnerName,
          logo_url: logoUrl,
          policy_url: policyUrl,
          theme_color: "#22d3ee",
        },
      });
    }

    if (action === "biometric_status") {
      const sessionId = body.session_id;
      if (typeof sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
        return json({ error: "Invalid verification session." }, 400);
      }
      const { data: verification, error: statusError } = await adminClient
        .from("oddzone_kyc_verifications")
        .select("status,reason,completed_at,match_confidence")
        .eq("session_id", sessionId)
        .eq("user_id", userId)
        .maybeSingle();
      if (statusError) {
        console.error("Could not read biometric verification status:", statusError.message);
        return json({ error: "Could not check verification status." }, 500);
      }
      if (!verification) return json({ error: "Verification session not found." }, 404);

      let verifiedProfile: {
        kyc_id_masked?: string | null;
        bank_code?: string | null;
        bank_name?: string | null;
        account_number?: string | null;
        verified_legal_name?: string | null;
        legal_name_verified_at?: string | null;
      } | null = null;
      let bankNameMatches: boolean | null = null;
      let bankMatchError: string | null = null;
      if (verification.status === "clear") {
        const { data: profile, error: profileError } = await adminClient
          .from("profiles")
          .select("kyc_id_masked,bank_code,bank_name,account_number,verified_legal_name,legal_name_verified_at")
          .eq("id", userId)
          .maybeSingle();
        if (profileError) {
          console.error("Could not load verified profile status:", profileError.message);
          return json({ error: "Could not load the verified profile." }, 500);
        }
        verifiedProfile = profile;
        const legalName = verifiedLegalName(profile?.verified_legal_name);
        const bankCode = typeof profile?.bank_code === "string" ? profile.bank_code.trim() : "";
        const accountNumber = profile?.account_number;
        if (!legalName) {
          bankMatchError = "Smile ID did not return a legal name that can be matched to the bank account.";
        } else if (!validBankCode(bankCode) || !validAccountNumber(accountNumber)) {
          bankMatchError = "Link a valid bank account to finish checking your identity.";
        } else if (!paystackSecretKey) {
          bankMatchError = "The bank verification provider is not configured.";
        } else {
          const accountUrl = new URL("https://api.paystack.co/bank/resolve");
          accountUrl.searchParams.set("account_number", accountNumber);
          accountUrl.searchParams.set("bank_code", bankCode);
          try {
            const response = await fetch(accountUrl, {
              headers: { Authorization: `Bearer ${paystackSecretKey}` },
              signal: AbortSignal.timeout(15000),
            });
            const result = await response.json() as PaystackResponse;
            const accountName = verifiedLegalName(result.data?.account_name);
            if (!response.ok || !result.status || !accountName) {
              console.error("Could not verify linked bank account after KYC:", response.status, result.message || "Unknown provider error");
              bankMatchError = bankResolveErrorMessage(
                result.message,
                "Could not confirm the linked bank account name. Please retry.",
              );
            } else {
              bankNameMatches = normalizePersonName(accountName) === normalizePersonName(legalName);
            }
          } catch (error) {
            console.error("Bank-name confirmation after KYC failed:", error);
            bankMatchError = "Could not confirm the linked bank account name. Please retry.";
          }
        }
      }
      return json({
        success: true,
        status: verification.status,
        reason: verification.reason,
        confidence: verification.match_confidence,
        completed_at: verification.completed_at,
        profile: verifiedProfile
          ? {
            kyc_id_masked: verifiedProfile.kyc_id_masked || "",
            bank_code: verifiedProfile.bank_code || "",
            bank_name: verifiedProfile.bank_name || "",
            account_number: verifiedProfile.account_number || "",
            verified_legal_name: verifiedProfile.verified_legal_name || "",
            legal_name_verified_at: verifiedProfile.legal_name_verified_at || "",
          }
          : null,
        bank_name_matches: bankNameMatches,
        bank_match_error: bankMatchError,
      });
    }

    if (action === "save_payout_account") {
      if (!paystackSecretKey) {
        return json({ error: "The bank verification provider is not configured." }, 503);
      }
      const bankCode = String(body.bankCode ?? "").trim();
      const bankName = typeof body.bankName === "string" ? body.bankName.trim().slice(0, 100) : "";
      const accountNumber = body.accountNumber;
      if (!validBankCode(bankCode) || !bankName || !validAccountNumber(accountNumber)) {
        return json({ error: "Select a bank and enter its valid 10-digit account number." }, 400);
      }
      const accountUrl = new URL("https://api.paystack.co/bank/resolve");
      accountUrl.searchParams.set("account_number", accountNumber);
      accountUrl.searchParams.set("bank_code", bankCode);
      const response = await fetch(accountUrl, {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json() as PaystackResponse;
      const accountName = result.data?.account_name;
      if (!response.ok || !result.status || typeof accountName !== "string" || !accountName.trim()) {
        return json({
          error: bankResolveErrorMessage(result.message, "That payout account could not be verified."),
        }, 422);
      }
      const { data: profile, error: profileError } = await adminClient
        .from("profiles")
        .select("is_verified,verified_legal_name,legal_name_verified_at")
        .eq("id", userId)
        .maybeSingle();
      if (profileError || !profile) {
        console.error("Could not load profile before saving payout account:", profileError?.message || "Profile not found");
        return json({ error: "Could not verify your account before saving bank details." }, 500);
      }
      const legalName = profile.legal_name_verified_at
        ? verifiedLegalName(profile.verified_legal_name)
        : null;
      if (legalName
        && normalizePersonName(accountName) !== normalizePersonName(legalName)) {
        return json({ error: WITHDRAWAL_NAME_MISMATCH }, 422);
      }
      const { error: payoutError } = await adminClient
        .from("profiles")
        .update({
          bank_code: bankCode,
          bank_name: bankName,
          account_number: accountNumber,
        })
        .eq("id", userId);
      if (payoutError) {
        console.error("Could not save resolved payout account:", payoutError.message);
        return json({ error: "The account was resolved but could not be saved. Please retry." }, 500);
      }
      return json({ success: true, account_name: accountName.trim() });
    }

    if (action === "request_withdrawal") {
      if (!paystackSecretKey) {
        return json({ error: "The bank verification provider is not configured." }, 503);
      }
      const amount = body.amount;
      const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
      if (!Number.isSafeInteger(amount) || Number(amount) < 1000) {
        return json({ error: "Enter a whole-naira withdrawal amount of at least ₦1,000." }, 400);
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
        return json({ error: "A valid withdrawal request reference is required." }, 400);
      }

      const { data: profile, error: profileError } = await adminClient
        .from("profiles")
        .select("is_verified,verified_legal_name,legal_name_verified_at,bank_code,bank_name,account_number")
        .eq("id", userId)
        .maybeSingle();
      if (profileError) {
        console.error("Could not load profile for withdrawal:", profileError.message);
        return json({ error: "Could not verify your account before withdrawal." }, 500);
      }
      const legalName = profile?.legal_name_verified_at
        ? verifiedLegalName(profile.verified_legal_name)
        : null;
      if (!profile?.is_verified || !legalName) {
        return json({
          error: "Complete identity verification and confirm your provider-verified legal name before withdrawing.",
          requires_verification: true,
        }, 403);
      }

      const bankCode = typeof profile.bank_code === "string" ? profile.bank_code.trim() : "";
      const bankName = typeof profile.bank_name === "string" ? profile.bank_name.trim() : "";
      const accountNumber = profile.account_number;
      if (!validBankCode(bankCode) || !bankName || !validAccountNumber(accountNumber)) {
        return json({ error: "Link a valid bank account before requesting a withdrawal." }, 400);
      }

      const resolveUrl = new URL("https://api.paystack.co/bank/resolve");
      resolveUrl.searchParams.set("account_number", accountNumber);
      resolveUrl.searchParams.set("bank_code", bankCode);
      const bankResponse = await fetch(resolveUrl, {
        headers: {
          Authorization: `Bearer ${paystackSecretKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
      const bankResult = await bankResponse.json() as PaystackResponse;
      const accountName = verifiedLegalName(bankResult.data?.account_name);
      if (!bankResponse.ok || !bankResult.status || !accountName) {
        return json({
          error: bankResolveErrorMessage(
            bankResult.message,
            "The linked bank account could not be verified. Please retry.",
          ),
        }, 422);
      }
      if (normalizePersonName(accountName) !== normalizePersonName(legalName)) {
        return json({ error: WITHDRAWAL_NAME_MISMATCH }, 422);
      }

      const { data: withdrawal, error: withdrawalError } = await adminClient.rpc("request_withdrawal", {
        p_user_id: userId,
        p_request_id: requestId,
        p_amount: Number(amount),
        p_account_name: accountName,
      });
      if (withdrawalError) {
        console.error("Could not create the withdrawal request:", withdrawalError.message);
        return json({ error: withdrawalError.message || "Could not submit the withdrawal request." }, 400);
      }
      return json({ success: true, withdrawal });
    }

    if ((action === "list_banks" || action === "resolve_account") && !paystackSecretKey) {
      console.error("PAYSTACK_SECRET_KEY is not configured for identity verification.");
      return json({ error: "The bank verification provider is not configured." }, 503);
    }

    const paystackHeaders = {
      Authorization: `Bearer ${paystackSecretKey}`,
      "Content-Type": "application/json",
    };

    if (action === "list_banks") {
      if (!paystackSecretKey) {
        console.error("PAYSTACK_SECRET_KEY is not configured for bank list.");
        return json({ error: "The bank list provider is not configured." }, 503);
      }
      const banks: Array<{ name: string; code: string }> = [];
      let page = 1;
      let pageCount = 1;
      do {
        const response = await fetch(
          `https://api.paystack.co/bank?country=nigeria&perPage=100&page=${page}`,
          { headers: paystackHeaders, signal: AbortSignal.timeout(15000) },
        );
        const result = await response.json() as PaystackResponse;
        if (!response.ok || !result.status || !Array.isArray(result.data)) {
          console.error("Paystack bank list failed:", response.status, result.message || "Unknown provider error");
          return json({ error: result.message || "Could not load the current bank list." }, 502);
        }
        for (const bank of result.data as Array<Record<string, unknown>>) {
          const name = typeof bank.name === "string" ? bank.name.trim() : "";
          const code = String(bank.code ?? "").trim();
          if (bank.active !== false && name && validBankCode(code)) banks.push({ name, code });
        }
        pageCount = Math.min(Number(result.meta?.pageCount) || 1, 10);
        page++;
      } while (page <= pageCount);

      return json({ success: true, banks });
    }

    if (action === "resolve_account") {
      const bankCode = String(body?.bankCode ?? "").trim();
      const accountNumber = body?.accountNumber;
      if (!validBankCode(bankCode) || !validAccountNumber(accountNumber)) {
        return json({ error: "Select a valid bank and enter its 10-digit account number." }, 400);
      }
      const url = new URL("https://api.paystack.co/bank/resolve");
      url.searchParams.set("account_number", accountNumber);
      url.searchParams.set("bank_code", bankCode);
      const response = await fetch(url, {
        headers: paystackHeaders,
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json() as PaystackResponse;
      const accountName = result.data?.account_name;
      const resolvedNumber = result.data?.account_number;
      if (!response.ok || !result.status || typeof accountName !== "string" || !accountName.trim()) {
        return json({
          error: bankResolveErrorMessage(result.message, "That account could not be verified by the bank."),
        }, 422);
      }
      return json({
        success: true,
        account_name: accountName.trim(),
        account_number: typeof resolvedNumber === "string" ? resolvedNumber : accountNumber,
      });
    }

    if (action === "match_bvn") {
      return json({
        error: "BVN verification now requires the Smile ID biometric flow. Start a new biometric verification session.",
      }, 410);
    }

    if (action === "match_nin") {
      return json({ error: "NIN verification is not configured. Choose BVN or contact support." }, 501);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return json({ error: "The bank verification provider timed out. Please try again." }, 504);
    }
    console.error("Identity verification request failed:", error);
    return json({ error: "Identity verification is temporarily unavailable. Please try again." }, 500);
  }
});
