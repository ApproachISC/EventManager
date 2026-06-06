// ============================================================
//  EVENT MANAGER — auth.js
//  Shared across all pages. Load this first in every HTML file.
//
//  Responsibilities:
//    • Supabase client singleton
//    • Session guard (redirect if not logged in)
//    • Role-based routing on login
//    • Profile helpers
//    • Toast notifications
//    • Email sending via Edge Function
//    • Misc shared utilities
// ============================================================

// ── Supabase config ───────────────────────────────────────────
// Replace these with your actual project values.
// Safe to commit — these are the public anon keys.
const SUPABASE_URL      = "https://yubuzqczrgyvreetwvnn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl1YnV6cWN6cmd5dnJlZXR3dm5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4OTk0NDYsImV4cCI6MjA5NTQ3NTQ0Nn0.00BeXLAOuGaBPu3JCphwX1w6GGpVMr4cta0MUTezK6s";

const _supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession:    true,
    autoRefreshToken:  true,
    detectSessionInUrl: false,
  },
});

// ── Page identifiers ──────────────────────────────────────────
const PAGES = {
  login:        "index.html",
  setup:        "setup.html",
  manager:      "manager.html",
  managerEvent: "manager-event.html",
  taker:        "taker.html",
  attendee:     "attendee.html",
};

// ── Cached session state ──────────────────────────────────────
let _currentUser    = null;
let _currentProfile = null;


// ============================================================
//  SESSION & AUTH GUARDS
// ============================================================

/**
 * Call at the top of every protected page.
 * Returns { user, profile } or redirects to login.
 *
 * @param {string[]} allowedRoles - e.g. ['manager'] or ['manager','taker']
 */
async function requireAuth(allowedRoles = []) {
  const { data: { session }, error } = await _supabase.auth.getSession();

  if (error || !session) {
    redirectTo(PAGES.login);
    return null;
  }

  _currentUser = session.user;

  const profile = await getProfile();
  if (!profile) {
    redirectTo(PAGES.login);
    return null;
  }

  // First-time setup not completed
  if (!profile.setup_done) {
    if (!window.location.pathname.endsWith(PAGES.setup)) {
      redirectTo(PAGES.setup);
      return null;
    }
  }

  // Role check
  if (allowedRoles.length && !allowedRoles.includes(profile.role)) {
    routeByRole(profile.role);
    return null;
  }

  return { user: _currentUser, profile };
}

/**
 * Call on login/setup pages.
 * If already logged in, routes to the correct dashboard.
 */
async function redirectIfLoggedIn() {
  const { data: { session } } = await _supabase.auth.getSession();
  if (!session) return;

  const profile = await getProfile(session.user.id);
  if (profile) routeByRole(profile.role, profile.setup_done);
}

/**
 * Route a user to their home page based on role.
 */
function routeByRole(role, setupDone = true) {
  if (!setupDone) { redirectTo(PAGES.setup); return; }
  switch (role) {
    case "manager":  redirectTo(PAGES.manager);  break;
    case "taker":    redirectTo(PAGES.taker);    break;
    case "attendee": redirectTo(PAGES.attendee); break;
    default:         redirectTo(PAGES.login);
  }
}

function redirectTo(page) {
  window.location.href = page;
}


// ============================================================
//  PROFILE
// ============================================================

/**
 * Fetch and cache the current user's profile.
 */
async function getProfile(userId) {
  if (_currentProfile && !userId) return _currentProfile;

  const id = userId ?? _currentUser?.id;
  if (!id) return null;

  const { data, error } = await _supabase
    .from("profiles")
    .select("*")
    .eq("id", id)
    .single();

  if (error) { console.error("getProfile error:", error); return null; }
  _currentProfile = data;
  return data;
}

/**
 * Update name and mark setup as done on first login.
 */
async function completeSetup(name, newPassword) {
  const id = _currentUser?.id;
  if (!id) throw new Error("Not authenticated");

  // Update password in Supabase Auth
  if (newPassword) {
    const { error: pwErr } = await _supabase.auth.updateUser({ password: newPassword });
    if (pwErr) throw pwErr;
  }

  // Update profile
  const { error: profErr } = await _supabase
    .from("profiles")
    .update({ name, setup_done: true })
    .eq("id", id);

  if (profErr) throw profErr;
  _currentProfile = null; // clear cache
}

/**
 * Return initials from a name string.
 */
function getInitials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Populate sidebar user widget.
 */
function populateSidebarUser(profile) {
  const nameEl   = document.getElementById("sidebar-user-name");
  const roleEl   = document.getElementById("sidebar-user-role");
  const avatarEl = document.getElementById("sidebar-avatar");

  if (nameEl)   nameEl.textContent   = profile.name ?? profile.email;
  if (roleEl)   roleEl.textContent   = profile.role;
  if (avatarEl) avatarEl.textContent = getInitials(profile.name ?? profile.email);
}


// ============================================================
//  AUTH ACTIONS
// ============================================================

/**
 * Sign in with email + password.
 * Returns { profile } on success, throws on error.
 */
async function signIn(email, password) {
  const { data, error } = await _supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;

  _currentUser = data.user;
  const profile = await getProfile(data.user.id);
  if (!profile) throw new Error("Profile not found. Please contact your administrator.");

  if (!["taker", "manager"].includes(profile.role)) {
    await _supabase.auth.signOut();
    _currentUser = null;
    throw new Error("Access denied. This portal is for staff only.");
  }

  return { user: data.user, profile };
}

/**
 * Sign out and go to login page.
 */
async function signOut() {
  await _supabase.auth.signOut();
  _currentUser    = null;
  _currentProfile = null;
  redirectTo(PAGES.login);
}


// ============================================================
//  INVITE & USER CREATION HELPERS
// ============================================================

/**
 * Generate a 6-char alphanumeric temp password (browser version).
 * The DB also has a generate_temp_password() function for server-side use.
 */
function generateTempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let result = "";
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  for (const byte of array) {
    result += chars[byte % chars.length];
  }
  return result;
}

/**
 * Create a Supabase Auth user + invite row, then send the invite email.
 * Used for manager and taker invites (single user).
 *
 * @param {object} opts
 * @param {string} opts.email
 * @param {'manager'|'taker'|'attendee'} opts.role
 * @param {string} [opts.eventId]
 * @param {string} [opts.periodId]
 * @param {string} [opts.eventName]
 * @param {string} [opts.periodName]
 * @param {string} [opts.qrToken]      - for attendees
 * @param {string} [opts.attendeeName] - for attendees
 */
async function inviteUser(opts) {
  const tempPassword = generateTempPassword();

  // 1. Check if this email already exists in the invites table.
  const { data: existing } = await _supabase
    .from("invites")
    .select("id")
    .eq("email", opts.email)
    .maybeSingle();

  let invite;

  if (existing) {
    // Email found — just update role and temp password, skip user creation.
    const { data: updated, error: updateErr } = await _supabase
      .from("invites")
      .update({
        role:          opts.role,
        temp_password: tempPassword,
        event_id:      opts.eventId  ?? null,
        period_id:     opts.periodId ?? null,
        invited_by:    _currentUser.id,
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (updateErr) throw updateErr;
    invite = updated;

    // Update the auth user's password and profile role via Edge Function.
    const { error: updateUserErr } = await _supabase.functions.invoke("create-user", {
      body: { email: opts.email, password: tempPassword, role: opts.role, update: true },
    });
    if (updateUserErr) throw updateUserErr;
  } else {
    // New email — insert invite row first so the DB trigger can read it when
    // the auth user is created to build the profile and consume the invite.
    const { data: inserted, error: inviteErr } = await _supabase
      .from("invites")
      .insert({
        email:         opts.email,
        role:          opts.role,
        temp_password: tempPassword,
        event_id:      opts.eventId   ?? null,
        period_id:     opts.periodId  ?? null,
        invited_by:    _currentUser.id,
      })
      .select()
      .single();

    if (inviteErr) throw inviteErr;
    invite = inserted;

    // Create auth user via Edge Function (uses service role key server-side).
    const { error: createErr } = await _supabase.functions.invoke("create-user", {
      body: { email: opts.email, password: tempPassword, role: opts.role },
    });
    if (createErr) throw createErr;
  }

  // 2. Send invite email via Edge Function
  const emailType = opts.role === "manager"   ? "invite_manager"
                  : opts.role === "taker"     ? "invite_taker"
                  : "invite_attendee";

  await sendEmail({
    type:          emailType,
    to:            opts.email,
    tempPassword,
    inviteId:      invite.id,
    eventName:     opts.eventName   ?? null,
    periodName:    opts.periodName  ?? null,
    qrToken:       opts.qrToken     ?? null,
    attendeeName:  opts.attendeeName ?? null,
  });

  return { invite, tempPassword };
}

/**
 * Resend an existing invite (refreshes temp password and re-sends email).
 */
async function resendInvite(inviteId) {
  const tempPassword = generateTempPassword();

  // Fetch existing invite
  const { data: invite, error: fetchErr } = await _supabase
    .from("invites")
    .select("*, events(name), periods(name)")
    .eq("id", inviteId)
    .single();

  if (fetchErr) throw fetchErr;

  // Update temp password and last_sent_at
  const { error: updateErr } = await _supabase
    .from("invites")
    .update({ temp_password: tempPassword, last_sent_at: new Date().toISOString() })
    .eq("id", inviteId);

  if (updateErr) throw updateErr;

  await sendEmail({
    type:         "resend_invite",
    to:           invite.email,
    tempPassword,
    inviteId,
    eventName:    invite.events?.name  ?? null,
    periodName:   invite.periods?.name ?? null,
  });
}

/**
 * Toggle a taker's is_active status for their event assignment.
 */
async function setTakerActive(eventTakerId, isActive) {
  const { error } = await _supabase
    .from("event_takers")
    .update({ is_active: isActive })
    .eq("id", eventTakerId);

  if (error) throw error;
}

/**
 * Revoke an invite (sets status = 'revoked').
 */
async function revokeInvite(inviteId) {
  const { error } = await _supabase
    .from("invites")
    .update({ status: "revoked" })
    .eq("id", inviteId);

  if (error) throw error;
}


// ============================================================
//  EMAIL HELPER
// ============================================================

/**
 * Call the send-email Edge Function.
 * Auth header is injected automatically by the Supabase client.
 */
async function sendEmail(payload) {
  const { data, error } = await _supabase.functions.invoke("send-email", {
    body: payload,
  });
  if (error) throw error;
  return data;
}


// ============================================================
//  TOAST NOTIFICATIONS
// ============================================================

/**
 * Show a toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} duration  ms before auto-dismiss
 */
function showToast(message, type = "success", duration = 3500) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    document.body.appendChild(container);
  }

  const icons = {
    success: "ti-circle-check",
    error:   "ti-alert-circle",
    info:    "ti-info-circle",
  };

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<i class="ti ${icons[type] ?? icons.info}"></i><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, duration);
}


// ============================================================
//  MODAL HELPERS
// ============================================================

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("open");
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("open");
}

/** Close modal on overlay click */
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal-overlay")) {
    e.target.classList.remove("open");
  }
});

/** Close modal on Escape key */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-overlay.open")
      .forEach(m => m.classList.remove("open"));
  }
});


// ============================================================
//  TAB HELPERS
// ============================================================

/**
 * Initialise a tab group.
 * Expects: .tab-btn[data-tab="panelId"] and .tab-panel[id="panelId"]
 */
function initTabs(containerSelector = "[data-tabs]") {
  document.querySelectorAll(containerSelector).forEach(container => {
    const buttons = container.querySelectorAll(".tab-btn");
    const panels  = container.querySelectorAll(".tab-panel");

    buttons.forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;
        buttons.forEach(b => b.classList.toggle("active", b === btn));
        panels.forEach(p => p.classList.toggle("active", p.id === target));
      });
    });

    // Activate first by default
    if (buttons.length) buttons[0].click();
  });
}


// ============================================================
//  MISC UTILITIES
// ============================================================

/** Format a date string for display */
function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = dateStr.includes("T") ? new Date(dateStr) : new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

/** Format a datetime string */
function formatDateTime(dateStr) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/** Escape HTML to prevent XSS */
function escHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Simple CSV export */
function exportCSV(filename, headers, rows) {
  const escape = v => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [
    headers.map(escape).join(","),
    ...rows.map(row => row.map(escape).join(",")),
  ];
  const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Parse CSV file with PapaParse */
function parseCSV(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header:        true,
      skipEmptyLines: true,
      complete: r  => resolve(r.data),
      error:    err => reject(err),
    });
  });
}

/** Debounce helper */
function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Show/hide a loading spinner inside a button */
function setButtonLoading(btn, loading, originalHTML) {
  if (loading) {
    btn.disabled = true;
    btn.dataset.originalHtml = btn.innerHTML;
    btn.innerHTML = `<span class="spinner spinner-sm"></span> Loading…`;
  } else {
    btn.disabled = false;
    btn.innerHTML = originalHTML ?? btn.dataset.originalHtml ?? btn.innerHTML;
  }
}

/** Get URL search param */
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/** Set page title */
function setPageTitle(title) {
  document.title = title ? `${title} — Event Manager` : "Event Manager";
}
