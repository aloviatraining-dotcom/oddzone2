# verify-identity

Identity verification for OddZone. Two front ends share this function:

| Mode | Entry point | Provider call |
| --- | --- | --- |
| Selfie capture (webcam) | `face-verify.html` → `action: verify_face` | Smile ID Biometric KYC, Prembly, or YouVerify |
| Hosted SDK | `index.html` → `action: start_biometric` | Smile ID inline web SDK v12 |

Both write `profiles.is_verified` / `verified_at` through the service-role client.
Nothing in the browser can set those columns (see the column grant in
`20261001000000_reconcile_live_schema.sql`).

For Smile ID Biometric KYC, a clear webhook may include the authority name at
`id_fields.full_name`. When present, the function stores that value as
`profiles.verified_legal_name` with `legal_name_verified_at`. The trusted-name
column is not client-writable; `profiles.legal_name` remains a display field.
A successful identity check without this provider-returned name can still
verify the account, but is not eligible for withdrawals until the name is
confirmed. Other providers' face-match results do not establish this trusted
name. Bank-account resolution never sets or overwrites the verified legal name.

## Flow: `verify_face`

```
POST { action: "create_face_challenge", id_document_type: "nin" | "bvn" }
  -> { challenge_id, expires_at }            single-use, 10 min, max 5 per 15 min

POST { action: "verify_face",
       challenge_id, nin_or_bvn, selfie_base64,
       liveness_frames_base64?: string[6..8], consent_granted: true }
  -> { success: true, confidence: number, withdrawal_eligible: boolean }
  -> { success: false, reason: string, message: string }
```

`user_id` is never trusted from the body — the identity always comes from the
bearer token.

### Minimal contract

A body containing only the three core fields is also accepted and takes the
same path (no challenge round-trip needed):

```
POST { user_id, nin_or_bvn, selfie_base64 }        # id_document_type optional, default nin
  -> { success: true, confidence: number, withdrawal_eligible: boolean }
  -> { success: false, reason: string, message: string }
```

`user_id`, when present, must equal the token's user or the call fails with
`forbidden`. The function mints and claims the single-use challenge itself, so
validation (NIN/BVN shape, image bytes) happens **before** a challenge is spent.
Consent is recorded as granted when it is not collected by the caller.

Successful face checks are recorded server-side. The Smile ID webhook claims
its pending audit row with a status-guarded update, so duplicate webhook
deliveries cannot apply the same result twice. The trusted withdrawal name is
written only when Smile ID returns the authority name.

The challenge is what makes the capture trustworthy: the server knows which
capture the liveness frames belong to, claims it before calling the provider
(concurrent double-submits get `challenge_consumed`), and the audit row carries a
unique index on it. Without one, any caller could post somebody else's selfie
with somebody else's NIN and be marked verified.

## Secrets

| Name | Required | Notes |
| --- | --- | --- |
| `KYC_PROVIDER_SECRET_KEY` | yes | Provider API key. |
| `KYC_PROVIDER` | no | `smile_id` (default), `prembly`, `youverify`. |
| `KYC_PRIVACY_POLICY_URL` | Smile ID | Public HTTPS privacy policy URL; used by the hosted SDK consent screen. |
| `SMILE_ID_POLICY_URL` | no | Optional alias for `KYC_PRIVACY_POLICY_URL`. |
| `SMILE_ID_LOGO_URL` | no | Optional HTTPS partner logo URL; defaults to the OddZone repository icon. |
| `SMILE_ID_PARTNER_ID` | Smile ID | Numeric partner id. |
| `SMILE_ID_ENVIRONMENT` | no | `production`, otherwise sandbox. |
| `SMILE_ID_PARTNER_NAME` | no | Shown to Smile ID as the consumer's given name; they do not collect names on the ID screen. |

## The 85% threshold

- **Prembly / YouVerify** return a numeric similarity score. The score must be
  `>= 85`, or the call is recorded as `block` with `face_verification_failed`.
- **Smile ID Biometric KYC** does **not** publish a face-match score. Its result
  is `status` (`clear` / `attention` / `block` / `error`) plus a `reason`; `clear`
  already asserts "selfie matched the registered photo, liveness passed, ID found".
  So for Smile ID the threshold is enforced as "the provider must return `clear`",
  `match_confidence` is stored as `NULL`, and the response is
  `{ success: true, confidence: 100, confidence_reported: false }`.
  100 there means "passed", not "100% similar" — do not surface it as a match
  percentage. If a real score is a hard product requirement, use Prembly or
  YouVerify for this mode.

## Webhook

`?action=smile_webhook` is HMAC-SHA256 verified (`Response-Timestamp` +
`Response-Signature`) before anything is written. It is idempotent: rows move out
of `pending` once, and a duplicate delivery is acknowledged with
`{ duplicate: true }`.

Note that the required request body carries Smile ID's `202 Accepted` without
waiting for a human review; when the provider stays in `attention`, the user is
told so and the row is left for support rather than being auto-approved.

## Withdrawal checks

The KYC screen uses one identity path: the user enters their BVN/NIN and legal
names, confirms consent, and links a payout account. The hosted Smile ID SDK
receives the ID/name fields for its biometric job and captures a live face and
liveness scan. OddZone does not persist the entered ID number. After a
clear Smile ID result, `biometric_status` resolves the saved bank account again
and reports whether its holder name matches the ID-authority name. A mismatch
does not undo a valid identity check, but withdrawals remain blocked until the
user links a matching account.

The authenticated `request_withdrawal` action requires an approved profile,
the Smile ID authority-returned legal name, a linked account, and a fresh
Paystack account resolution. The resolved holder name must match the verified
name after Unicode normalization, case folding, and whitespace collapsing.
The request is then recorded and the balance held atomically by the
service-role-only `request_withdrawal` database function.

Apply `20261116000000_verified_name_withdrawals.sql` before deploying this
version of the function. Profiles verified before the provider name was saved
must complete the Smile ID biometric flow again to establish a trusted legal
name; the migration deliberately does not trust or backfill legacy `legal_name`
values.

For the hosted flow, configure `KYC_PROVIDER_SECRET_KEY`,
`SMILE_ID_PARTNER_ID`, and a public HTTPS `KYC_PRIVACY_POLICY_URL`
(`SMILE_ID_POLICY_URL` is accepted as an alias). `SMILE_ID_LOGO_URL` is
optional; the function defaults to the OddZone repository icon. The user enters
their BVN/NIN and legal names in the app before the Smile ID consent and live
face-capture steps.

## Deploy

```powershell
supabase db push                      # applies 20261019000003_*.sql
supabase secrets set KYC_PROVIDER_SECRET_KEY=... KYC_PRIVACY_POLICY_URL=https://...
supabase functions deploy verify-identity
```

`verify_jwt = false` is intentional (see `supabase/config.toml`); the function
validates the bearer token itself for every user-facing action.
