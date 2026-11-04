// ============================================================
//  EVENT MANAGER — recover-password Edge Function
//  Public endpoint (no signed-in user required).
//
//  If the email belongs to an existing account, generates a one-time
//  Supabase recovery token and emails a reset link via Brevo.
//  Always responds with the same generic success so the endpoint
//  cannot be used to discover which emails are registered.
//
//  Required secrets:
//    SUPABASE_SERVICE_ROLE_KEY
//    BREVO_API_KEY
//    FROM_EMAIL
//    FROM_NAME   (optional, defaults to "Event Manager")
//    APP_URL     e.g. "https://yourorg.github.io/event-manager"
//    SUPABASE_URL (auto-set)
//
//  Request body:  { email: string }
//  Response:      { ok: true }
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const C = {
  navy:    "#0c2340",
  gold:    "#ae9142",
  skyBlue: "#c1cddd",
  white:   "#ffffff",
  faint:   "#6b7a8d",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function recoveryEmail(resetUrl: string): { subject: string; html: string } {
  return {
    subject: "Reset your Event Manager password",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Password Reset</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:${C.white};border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
          <tr>
            <td style="background:${C.navy};padding:28px 36px">
              <div style="color:${C.gold};font-size:22px;font-weight:700;letter-spacing:-0.3px">Event Manager</div>
              <div style="color:${C.skyBlue};font-size:12px;padding-top:4px">Password Reset</div>
            </td>
          </tr>
          <tr>
            <td style="padding:36px">
              <h2 style="margin:0 0 16px;color:${C.navy};font-size:20px">Reset your password</h2>
              <p style="margin:0 0 24px;color:#333;line-height:1.6">
                We received a request to reset the password for your Event Manager account.
                Click the button below to choose a new password.
              </p>
              <a href="${resetUrl}" style="display:inline-block;background:${C.gold};color:${C.white};text-decoration:none;font-weight:700;padding:12px 28px;border-radius:6px;font-size:14px">
                Reset Password
              </a>
              <p style="margin:24px 0 0;color:${C.faint};font-size:12px;line-height:1.5">
                This link can be used once and expires soon. If you didn't request a password reset,
                you can safely ignore this email. Your password will not change.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#f8f9fa;border-top:1px solid ${C.skyBlue};padding:20px 36px;text-align:center">
              <p style="margin:0;color:${C.faint};font-size:11px;line-height:1.5">
                This message was sent by Event Manager. Do not reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body  = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (!email || !EMAIL_RE.test(email)) {
      return json({ error: "Please provide a valid email address." }, 400);
    }

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Generates a recovery token only if the user exists; errors otherwise.
    const { data: linkData, error: linkErr } = await adminClient.auth.admin.generateLink({
      type: "recovery",
      email,
    });

    if (linkErr || !linkData?.properties?.hashed_token) {
      // Unknown email (or other failure): log it, but answer the same way.
      console.log("recover-password: no recovery link generated for request:", linkErr?.message);
      return json({ ok: true });
    }

    const appUrl   = (Deno.env.get("APP_URL") ?? "http://localhost").replace(/\/+$/, "");
    const resetUrl = `${appUrl}/reset-password.html?token_hash=${encodeURIComponent(linkData.properties.hashed_token)}&type=recovery`;

    const brevoApiKey = Deno.env.get("BREVO_API_KEY");
    if (!brevoApiKey) {
      console.error("recover-password: BREVO_API_KEY not configured");
      return json({ error: "Email service is not configured." }, 500);
    }

    const { subject, html } = recoveryEmail(resetUrl);

    const brevoResp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": brevoApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        sender:      {
          email: Deno.env.get("FROM_EMAIL") ?? "noreply@example.com",
          name:  Deno.env.get("FROM_NAME")  ?? "Event Manager",
        },
        to:          [{ email }],
        subject,
        htmlContent: html,
      }),
    });

    if (!brevoResp.ok) {
      console.error("recover-password: Brevo API error:", await brevoResp.text());
      return json({ error: "We couldn't send the email. Please try again later." }, 502);
    }

    return json({ ok: true });

  } catch (err) {
    console.error("recover-password unhandled error:", err);
    return json({ error: "Internal server error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
