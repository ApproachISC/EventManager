// ============================================================
//  EVENT MANAGER — create-user Edge Function
//  Creates a Supabase Auth user with the service role key.
//  Only managers may call this function.
//
//  Required secrets (set via Supabase Dashboard → Settings → Edge Functions):
//    SUPABASE_URL              (auto-set by Supabase)
//    SUPABASE_ANON_KEY         (auto-set by Supabase)
//    SUPABASE_SERVICE_ROLE_KEY (add manually)
//
//  Request body:
//    { email: string, password: string, role: string, name?: string }
//
//  Response:
//    { user_id: string }        on success
//    { error: string }          on failure
// ============================================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ── 1. Authenticate caller ─────────────────────────────────
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing authorization header" }, 401);
    }

    const callerClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } }
    );

    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ── 2. Verify caller is a manager ──────────────────────────
    const { data: profile } = await callerClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .single();

    if (profile?.role !== "manager") {
      return json({ error: "Forbidden: only managers can create users" }, 403);
    }

    // ── 3. Parse and validate request body ─────────────────────
    const body = await req.json();
    const { email, password, role, name } = body ?? {};

    if (!email || !password || !role) {
      return json({ error: "Missing required fields: email, password, role" }, 400);
    }

    const allowedRoles = ["manager", "taker", "attendee"];
    if (!allowedRoles.includes(role)) {
      return json({ error: `Invalid role: ${role}` }, 400);
    }

    // ── 4. Create admin client with service role key ───────────
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // ── 5. Create the auth user ────────────────────────────────
    const { data: newUser, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,           // skip Supabase confirmation email
      user_metadata: { name: name ?? "" },
    });

    if (createErr) {
      // If the account already exists, return its ID rather than failing
      const alreadyExists =
        createErr.message?.toLowerCase().includes("already been registered") ||
        (createErr as any).status === 422;

      if (alreadyExists) {
        const { data: { users } } = await adminClient.auth.admin.listUsers({ perPage: 1000 });
        const existing = users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
        if (existing) {
          return json({ user_id: existing.id, existed: true });
        }
      }

      console.error("createUser error:", createErr);
      return json({ error: createErr.message ?? "Failed to create user" }, 500);
    }

    return json({ user_id: newUser.user.id });

  } catch (err) {
    console.error("create-user unhandled error:", err);
    return json({ error: (err as Error).message ?? "Internal server error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
