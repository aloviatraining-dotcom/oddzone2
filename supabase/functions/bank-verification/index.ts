import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, cache-control, pragma",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
};

type PaystackResponse = {
  status?: boolean;
  message?: string;
  data?: unknown;
  meta?: { pageCount?: number };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBankCode(value: unknown): value is string {
  return typeof value === "string" && /^\d{2,8}$/.test(value);
}

function validAccountNumber(value: unknown): value is string {
  return typeof value === "string" && /^\d{10}$/.test(value);
}

async function readPaystackResponse(response: Response): Promise<PaystackResponse> {
  try {
    const payload: unknown = await response.json();
    return isRecord(payload) ? payload as PaystackResponse : {};
  } catch {
    return {};
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ success: false, error: "Method not allowed." }, 405);
  }

  const secretKey = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secretKey) {
    console.error("PAYSTACK_SECRET_KEY is not configured for bank verification.");
    return json({ success: false, error: "Bank verification is not configured." }, 503);
  }

  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};

    if (req.method === "POST") {
      let payload: unknown;
      try {
        payload = await req.json();
      } catch {
        return json({ success: false, error: "Request body must be valid JSON." }, 400);
      }
      if (!isRecord(payload)) {
        return json({ success: false, error: "Request body must be a JSON object." }, 400);
      }
      body = payload;
    }

    const action = String(
      body.action ?? body.type ?? url.searchParams.get("action") ?? url.searchParams.get("type") ?? "",
    ).trim().toLowerCase();
    const paystackHeaders = {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    };

    if (action === "get_banks" || action === "list") {
      const banks: Array<{ name: string; code: string }> = [];
      let page = 1;
      let pageCount = 1;

      do {
        const banksUrl = new URL("https://api.paystack.co/bank");
        banksUrl.searchParams.set("currency", "NGN");
        banksUrl.searchParams.set("perPage", "100");
        banksUrl.searchParams.set("page", String(page));

        const response = await fetch(banksUrl, {
          headers: paystackHeaders,
          signal: AbortSignal.timeout(15000),
        });
        const result = await readPaystackResponse(response);
        if (!response.ok || result.status !== true || !Array.isArray(result.data)) {
          console.error("Paystack bank list request failed:", response.status, result.message || "Invalid response");
          return json({
            success: false,
            error: result.message || "Could not fetch the Nigerian bank list.",
          }, 502);
        }

        for (const item of result.data) {
          if (!isRecord(item)) continue;
          const name = typeof item.name === "string" ? item.name.trim() : "";
          const code = String(item.code ?? "").trim();
          if (item.active !== false && name && validBankCode(code)) banks.push({ name, code });
        }

        pageCount = Math.min(Math.max(Number(result.meta?.pageCount) || 1, 1), 20);
        page++;
      } while (page <= pageCount);

      return json({ success: true, data: banks });
    }

    if (action === "resolve_account" || action === "resolve") {
      const rawAccountNumber = body.account_number ?? url.searchParams.get("account_number");
      const rawBankCode = body.bank_code ?? url.searchParams.get("bank_code");
      const accountNumber = typeof rawAccountNumber === "string" ? rawAccountNumber.trim() : "";
      const bankCode = typeof rawBankCode === "string" ? rawBankCode.trim() : "";

      if (!validAccountNumber(accountNumber) || !validBankCode(bankCode)) {
        return json({
          success: false,
          error: "Enter a valid 10-digit account number and select a valid bank.",
        }, 400);
      }

      const resolveUrl = new URL("https://api.paystack.co/bank/resolve");
      resolveUrl.searchParams.set("account_number", accountNumber);
      resolveUrl.searchParams.set("bank_code", bankCode);
      const response = await fetch(resolveUrl, {
        headers: paystackHeaders,
        signal: AbortSignal.timeout(15000),
      });
      const result = await readPaystackResponse(response);
      if (!response.ok || result.status !== true || !isRecord(result.data)) {
        return json({
          success: false,
          error: result.message || "Could not resolve that bank account.",
        }, 422);
      }

      return json({ success: true, data: result.data });
    }

    return json({
      success: false,
      error: "Unknown action. Use get_banks/list or resolve_account/resolve.",
    }, 400);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return json({ success: false, error: "Paystack took too long to respond. Please try again." }, 504);
    }
    console.error("Bank verification request failed:", error);
    return json({ success: false, error: "Bank verification is temporarily unavailable." }, 502);
  }
});

// Frontend example:
// const { data, error } = await supabase.functions.invoke("bank-verification", {
//   body: { action: "get_banks" },
// });
// For account lookup, pass { action: "resolve_account", account_number: "...", bank_code: "..." }.
