// ============================================================
//  EVENT MANAGER — send-email Edge Function
//  Sends transactional email via Brevo.
//  Only authenticated managers may trigger email sends.
//
//  Required secrets:
//    BREVO_API_KEY    (from brevo.com → Settings → API Keys)
//    FROM_EMAIL       e.g. "noreply@youremail.com"
//    FROM_NAME        e.g. "Event Manager"  (optional, defaults to "Event Manager")
//    APP_URL          e.g. "https://yourorg.github.io/event-manager"
//    SUPABASE_URL     (auto-set)
//    SUPABASE_ANON_KEY (auto-set)
//
//  Request body shape:
//    {
//      type:         'invite_manager' | 'invite_taker' | 'invite_attendee' | 'resend_invite'
//      to:           string          recipient email
//      tempPassword: string
//      inviteId?:    string          if provided, updates invites.last_sent_at
//      eventName?:   string
//      periodName?:  string
//      qrToken?:     string          for invite_attendee
//      attendeeName? string          for invite_attendee
//    }
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Colour tokens ─────────────────────────────────────────────
const C = {
  navy:     "#0c2340",
  gold:     "#ae9142",
  skyBlue:  "#c1cddd",
  white:    "#ffffff",
  faint:    "#6b7a8d",
};

// ── Shared HTML email shell ───────────────────────────────────
function emailShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 0">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:${C.white};border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
          <!-- Header -->
          <tr>
            <td style="background:${C.navy};padding:28px 36px">
              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="color:${C.gold};font-size:22px;font-weight:700;letter-spacing:-0.3px">
                    Event Manager
                  </td>
                </tr>
                <tr>
                  <td style="color:${C.skyBlue};font-size:12px;margin-top:4px;padding-top:4px">
                    ${title}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding:36px">
              ${bodyHtml}
            </td>
          </tr>
          <!-- Footer -->
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
</html>`;
}

// ── Email templates ───────────────────────────────────────────

function inviteManagerEmail(opts: {
  to: string; tempPassword: string; appUrl: string;
}): { subject: string; html: string } {
  return {
    subject: "You've been invited as an Event Manager",
    html: emailShell("Manager Invitation", `
      <h2 style="margin:0 0 16px;color:${C.navy};font-size:20px">Welcome to Event Manager</h2>
      <p style="margin:0 0 16px;color:#333;line-height:1.6">
        You have been invited to manage events. Use the credentials below to sign in for the first time.
        You will be prompted to set a new password on your first login.
      </p>
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#f0f4f8;border-radius:8px;padding:20px;margin-bottom:24px">
        <tr>
          <td>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Email</p>
            <p style="margin:0 0 16px;color:${C.navy};font-weight:600">${opts.to}</p>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Temporary Password</p>
            <p style="margin:0;font-family:monospace;font-size:20px;font-weight:700;color:${C.navy};letter-spacing:0.1em">${opts.tempPassword}</p>
          </td>
        </tr>
      </table>
      <a href="${opts.appUrl}" style="display:inline-block;background:${C.gold};color:${C.white};text-decoration:none;font-weight:700;padding:12px 28px;border-radius:6px;font-size:14px">
        Sign In Now
      </a>
      <p style="margin:24px 0 0;color:${C.faint};font-size:12px;line-height:1.5">
        This temporary password expires when you complete your first login and set a new password.
      </p>`),
  };
}

function inviteTakerEmail(opts: {
  to: string; tempPassword: string; eventName: string;
  periodName: string; appUrl: string;
}): { subject: string; html: string } {
  return {
    subject: `You've been assigned as an Attendance Taker — ${opts.eventName}`,
    html: emailShell("Attendance Taker Invitation", `
      <h2 style="margin:0 0 16px;color:${C.navy};font-size:20px">You've been assigned!</h2>
      <p style="margin:0 0 16px;color:#333;line-height:1.6">
        You have been assigned as an attendance taker for the following session:
      </p>
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#f0f4f8;border-radius:8px;padding:20px;margin-bottom:24px">
        <tr>
          <td>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Event</p>
            <p style="margin:0 0 16px;color:${C.navy};font-weight:600">${opts.eventName}</p>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Period</p>
            <p style="margin:0 0 16px;color:${C.navy};font-weight:600">${opts.periodName}</p>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Email</p>
            <p style="margin:0 0 8px;color:${C.navy};font-weight:600">${opts.to}</p>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Temporary Password</p>
            <p style="margin:0;font-family:monospace;font-size:20px;font-weight:700;color:${C.navy};letter-spacing:0.1em">${opts.tempPassword}</p>
          </td>
        </tr>
      </table>
      <a href="${opts.appUrl}" style="display:inline-block;background:${C.gold};color:${C.white};text-decoration:none;font-weight:700;padding:12px 28px;border-radius:6px;font-size:14px">
        Go to Scanner
      </a>
      <p style="margin:24px 0 0;color:${C.faint};font-size:12px;line-height:1.5">
        You will be prompted to set a permanent password on first login.
      </p>`),
  };
}

function inviteAttendeeEmail(opts: {
  to: string; tempPassword: string; eventName: string;
  attendeeName: string; qrToken: string; appUrl: string;
}): { subject: string; html: string } {
  const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=0c2340&data=${encodeURIComponent(opts.qrToken)}`;
  return {
    subject: `Your QR Code for ${opts.eventName}`,
    html: emailShell(`Attendance QR Code — ${opts.eventName}`, `
      <h2 style="margin:0 0 8px;color:${C.navy};font-size:20px">Hello, ${opts.attendeeName}!</h2>
      <p style="margin:0 0 20px;color:#333;line-height:1.6">
        You have been registered for <strong>${opts.eventName}</strong>.
        Your QR code is below — present it when checking in for attendance.
      </p>

      <!-- QR code block -->
      <table cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:24px">
        <tr>
          <td align="center" style="background:#f0f4f8;border-radius:12px;padding:24px">
            <img src="${qrImageUrl}" width="200" height="200"
              alt="Your attendance QR code"
              style="display:block;margin:0 auto 12px;border-radius:8px"/>
            <p style="margin:0 0 4px;color:${C.faint};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Token (for manual entry)</p>
            <p style="margin:0;font-family:monospace;font-size:13px;color:${C.navy};word-break:break-all">${opts.qrToken}</p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 16px;color:#333;line-height:1.6">
        You can also view and download your QR code by logging in to the attendee portal:
      </p>
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#f0f4f8;border-radius:8px;padding:20px;margin-bottom:24px">
        <tr>
          <td>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Email</p>
            <p style="margin:0 0 16px;color:${C.navy};font-weight:600">${opts.to}</p>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Temporary Password</p>
            <p style="margin:0;font-family:monospace;font-size:20px;font-weight:700;color:${C.navy};letter-spacing:0.1em">${opts.tempPassword}</p>
          </td>
        </tr>
      </table>
      <a href="${opts.appUrl}" style="display:inline-block;background:${C.gold};color:${C.white};text-decoration:none;font-weight:700;padding:12px 28px;border-radius:6px;font-size:14px">
        View My QR Code
      </a>
      <p style="margin:24px 0 0;color:${C.faint};font-size:12px;line-height:1.5">
        Keep this email safe — your QR code is unique to you and this event.
      </p>`),
  };
}

function resendInviteEmail(opts: {
  to: string; tempPassword: string;
  eventName?: string; periodName?: string; appUrl: string;
}): { subject: string; html: string } {
  const context = opts.eventName
    ? `<p style="margin:0 0 16px;color:#333;line-height:1.6">
        This resend is for: <strong>${opts.eventName}${opts.periodName ? ` — ${opts.periodName}` : ""}</strong>
       </p>`
    : "";
  return {
    subject: "Your Event Manager invitation (resent)",
    html: emailShell("Invitation Resent", `
      <h2 style="margin:0 0 16px;color:${C.navy};font-size:20px">Updated sign-in credentials</h2>
      <p style="margin:0 0 16px;color:#333;line-height:1.6">
        Your invitation has been resent with a new temporary password.
      </p>
      ${context}
      <table cellpadding="0" cellspacing="0" width="100%" style="background:#f0f4f8;border-radius:8px;padding:20px;margin-bottom:24px">
        <tr>
          <td>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Email</p>
            <p style="margin:0 0 16px;color:${C.navy};font-weight:600">${opts.to}</p>
            <p style="margin:0 0 8px;color:${C.faint};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">New Temporary Password</p>
            <p style="margin:0;font-family:monospace;font-size:20px;font-weight:700;color:${C.navy};letter-spacing:0.1em">${opts.tempPassword}</p>
          </td>
        </tr>
      </table>
      <a href="${opts.appUrl}" style="display:inline-block;background:${C.gold};color:${C.white};text-decoration:none;font-weight:700;padding:12px 28px;border-radius:6px;font-size:14px">
        Sign In Now
      </a>`),
  };
}

// ── Main handler ──────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // 1. Authenticate caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization" }, 401);

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { data: profile } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "manager") {
      return json({ error: "Forbidden: only managers can send invites" }, 403);
    }

    // 2. Parse body
    const body = await req.json();
    const {
      type, to, tempPassword, inviteId,
      eventName, periodName, qrToken, attendeeName,
    } = body ?? {};

    if (!type || !to || !tempPassword) {
      return json({ error: "Missing required fields: type, to, tempPassword" }, 400);
    }

    const appUrl = Deno.env.get("APP_URL") ?? "http://localhost";

    // 3. Build email from template
    let email: { subject: string; html: string };

    switch (type) {
      case "invite_manager":
        email = inviteManagerEmail({ to, tempPassword, appUrl });
        break;
      case "invite_taker":
        email = inviteTakerEmail({
          to, tempPassword, appUrl,
          eventName:  eventName  ?? "Event",
          periodName: periodName ?? "Period",
        });
        break;
      case "invite_attendee":
        email = inviteAttendeeEmail({
          to, tempPassword, appUrl,
          eventName:    eventName    ?? "Event",
          attendeeName: attendeeName ?? to,
          qrToken:      qrToken      ?? "",
        });
        break;
      case "resend_invite":
        email = resendInviteEmail({ to, tempPassword, appUrl, eventName, periodName });
        break;
      default:
        return json({ error: `Unknown email type: ${type}` }, 400);
    }

    // 4. Send via Brevo
    const brevoApiKey = Deno.env.get("BREVO_API_KEY");
    if (!brevoApiKey) return json({ error: "BREVO_API_KEY not configured" }, 500);

    const fromEmail = Deno.env.get("FROM_EMAIL") ?? "noreply@example.com";
    const fromName  = Deno.env.get("FROM_NAME")  ?? "Event Manager";

    const brevoResp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key":      brevoApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender:      { email: fromEmail, name: fromName },
        to:          [{ email: to }],
        subject:     email.subject,
        htmlContent: email.html,
      }),
    });

    if (!brevoResp.ok) {
      const errBody = await brevoResp.text();
      console.error("Brevo API error:", errBody);
      return json({ error: `Email delivery failed: ${brevoResp.status}` }, 502);
    }

    // 5. Update invites.last_sent_at if inviteId was provided
    if (inviteId) {
      await callerClient
        .from("invites")
        .update({ last_sent_at: new Date().toISOString() })
        .eq("id", inviteId);
    }

    return json({ ok: true });

  } catch (err) {
    console.error("send-email unhandled error:", err);
    return json({ error: (err as Error).message ?? "Internal server error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
