// ============================================================
//  EVENT MANAGER — taker.js
//  Attendance taker page: QR scan · manual entry · scan log
// ============================================================

let _profile    = null;
let _assignment = null;   // event_takers row
let _event      = null;
let _periods    = [];     // all periods for the event
let _period     = null;   // taker-selected period for current session
let _stream     = null;
let _rafId      = null;
let _scanning   = false;
let _lastToken  = "";     // debounce: ignore same token within 2s
let _scanLog    = [];     // local scan history (name, time, method, duplicate)
let _expiryInterval = null;  // checks period expiry while scanning
let _countdownInterval = null; // live countdown in session info bar

const canvas = document.createElement("canvas");
const ctx    = canvas.getContext("2d", { willReadFrequently: true });

// ── Bootstrap ─────────────────────────────────────────────────
async function init() {
  const session = await requireAuth(["taker", "manager"]);
  if (!session) return;
  _profile = session.profile;

  populateSidebarUser(_profile);
  await loadAssignment();
  initManualForm();
  initCameraControls();

  document.getElementById("signout-btn")?.addEventListener("click", signOut);
}

// ── Load taker's event assignment ─────────────────────────────
async function loadAssignment() {
  if (_profile.role === "manager") {
    await loadAssignmentForManager();
    return;
  }

  const { data, error } = await _supabase
    .from("event_takers")
    .select("id, is_active, events ( id, name, status )")
    .eq("user_id", _profile.id)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    showNoSession("You have no active session assignment.");
    return;
  }

  _assignment = data;
  _event      = data.events;

  if (_event.status !== "active") {
    showNoSession(
      _event.status === "draft"
        ? `"${_event.name}" hasn't opened for attendance yet.`
        : `"${_event.name}" is closed.`
    );
    return;
  }

  // Load all periods for this event
  const { data: periods } = await _supabase
    .from("periods")
    .select("id, name, period_date, duration_minutes, opened_at, closed_at")
    .eq("event_id", _event.id)
    .order("sort_order")
    .order("period_date");

  _periods = periods ?? [];

  if (!_periods.length) {
    showNoSession(`"${_event.name}" has no periods defined yet. Ask your manager to add periods.`);
    return;
  }

  setPageTitle(_event.name);
  showPeriodPicker();
}

// ── Manager taking attendance directly ────────────────────────
async function loadAssignmentForManager() {
  const eventId = getParam("event_id");
  if (!eventId) {
    showNoSession("No event specified.");
    return;
  }

  injectManagerBackLink(eventId);

  const { data, error } = await _supabase
    .from("events")
    .select("id, name, status")
    .eq("id", eventId)
    .single();

  if (error || !data) {
    showNoSession("Event not found or you don't have access.");
    return;
  }

  _event = data;

  if (_event.status !== "active") {
    showNoSession(
      _event.status === "draft"
        ? `"${_event.name}" hasn't opened for attendance yet.`
        : `"${_event.name}" is closed.`
    );
    return;
  }

  const { data: periods } = await _supabase
    .from("periods")
    .select("id, name, period_date, duration_minutes, opened_at, closed_at")
    .eq("event_id", _event.id)
    .order("sort_order")
    .order("period_date");

  _periods = periods ?? [];

  if (!_periods.length) {
    showNoSession(`"${_event.name}" has no periods defined yet.`);
    return;
  }

  setPageTitle(_event.name);
  showPeriodPicker();
}

function injectManagerBackLink(eventId) {
  const nav = document.querySelector(".sidebar-nav");
  if (!nav) return;
  const backLink = document.createElement("a");
  backLink.href      = `manager-event.html?id=${eventId}`;
  backLink.className = "sidebar-nav-item";
  backLink.innerHTML = `<i class="ti ti-arrow-left"></i> Back to Event`;
  nav.insertBefore(backLink, nav.firstChild);
}

// ── No active session state ───────────────────────────────────
function showNoSession(message) {
  document.getElementById("scanner-ui").style.display     = "none";
  document.getElementById("period-picker-ui").style.display = "none";
  const ns = document.getElementById("no-session-ui");
  if (ns) {
    ns.style.display = "flex";
    const msg = ns.querySelector("#no-session-msg");
    if (msg) msg.textContent = message;
  }
  setPageTitle("No Active Session");
}

// ── Period picker ─────────────────────────────────────────────
function isOpenPeriod(p) {
  return p.opened_at && new Date(p.closed_at).getTime() > Date.now();
}

function showPeriodPicker() {
  clearInterval(_expiryInterval);
  clearInterval(_countdownInterval);
  _expiryInterval    = null;
  _countdownInterval = null;

  document.getElementById("no-session-ui").style.display    = "none";
  document.getElementById("scanner-ui").style.display       = "none";
  document.getElementById("period-picker-ui").style.display = "block";

  const openPeriods = _periods.filter(isOpenPeriod);

  document.getElementById("session-info").innerHTML =
    `<span style="font-weight:600;color:var(--warm-white)">${escHtml(_event.name)}</span>
     <span style="color:var(--dark-sky-blue);margin:0 var(--space-2)">·</span>
     <span style="color:var(--dark-sky-blue)">${openPeriods.length ? "Select a period below to begin" : "Waiting for manager to open a period…"}</span>`;

  const list = document.getElementById("period-list");
  if (!list) return;

  if (!openPeriods.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:var(--space-6);color:var(--dark-sky-blue)">
        <i class="ti ti-clock-pause" style="font-size:2rem;display:block;margin-bottom:var(--space-3)"></i>
        <div style="font-weight:600;margin-bottom:var(--space-2)">No open periods</div>
        <div class="text-xs">The manager hasn't opened any period yet. This page refreshes automatically.</div>
      </div>`;
    // Poll every 15 seconds until a period opens
    const pollId = setInterval(async () => {
      const { data } = await _supabase
        .from("periods")
        .select("id, name, period_date, duration_minutes, opened_at, closed_at")
        .eq("event_id", _event.id)
        .order("sort_order").order("period_date");
      _periods = data ?? [];
      if (_periods.some(isOpenPeriod)) {
        clearInterval(pollId);
        showPeriodPicker();
      }
    }, 15000);
    return;
  }

  list.innerHTML = openPeriods.map(p => {
    const remaining = new Date(p.closed_at).getTime() - Date.now();
    const mm = String(Math.floor(remaining / 60000)).padStart(2, "0");
    const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    return `
      <button class="btn btn-outline period-pick-btn" style="justify-content:flex-start;gap:var(--space-3)"
        onclick="selectPeriod('${p.id}')">
        <i class="ti ti-calendar-event" style="color:var(--nd-gold)"></i>
        <div style="text-align:left">
          <div style="font-weight:600">${escHtml(p.name)}</div>
          <div class="text-xs text-faint">${formatDate(p.period_date)}
            &nbsp;·&nbsp;<i class="ti ti-clock" style="font-size:0.7rem"></i>
            Closes in <span data-picker-countdown="${p.closed_at}">${mm}:${ss}</span>
          </div>
        </div>
      </button>`;
  }).join("");

  // Live countdown in the picker
  const pickerTick = setInterval(() => {
    document.querySelectorAll("[data-picker-countdown]").forEach(el => {
      const remaining = new Date(el.dataset.pickerCountdown).getTime() - Date.now();
      if (remaining <= 0) {
        clearInterval(pickerTick);
        _periods = _periods.map(p => p);   // keep reference
        showPeriodPicker();                // re-render (period now expired)
        return;
      }
      el.textContent = `${String(Math.floor(remaining / 60000)).padStart(2, "0")}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`;
    });
  }, 1000);
}

function selectPeriod(periodId) {
  _period = _periods.find(p => p.id === periodId);
  if (!_period) return;
  if (!isOpenPeriod(_period)) {
    showToast("That period has just closed.", "error");
    showPeriodPicker();
    return;
  }

  _scanLog = [];
  _lastToken = "";

  renderSessionInfo();
  document.getElementById("period-picker-ui").style.display = "none";
  document.getElementById("scanner-ui").style.display       = "block";

  startExpiryWatch();
}

// ── Period expiry watch (while scanning) ─────────────────────
function startExpiryWatch() {
  clearInterval(_expiryInterval);
  clearInterval(_countdownInterval);

  // Live countdown in the session info bar
  _countdownInterval = setInterval(() => {
    const el = document.getElementById("period-countdown");
    if (!el) { clearInterval(_countdownInterval); return; }
    const remaining = new Date(_period.closed_at).getTime() - Date.now();
    if (remaining <= 0) {
      clearInterval(_countdownInterval);
      return;
    }
    el.textContent = `${String(Math.floor(remaining / 60000)).padStart(2, "0")}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`;
  }, 1000);

  // Check expiry every 5 seconds
  _expiryInterval = setInterval(async () => {
    if (!_period) { clearInterval(_expiryInterval); return; }

    // Fast client-side check first
    if (new Date(_period.closed_at).getTime() > Date.now()) return;

    // Period has expired — lock scanner and notify
    clearInterval(_expiryInterval);
    clearInterval(_countdownInterval);
    stopCamera();
    showToast(`Period "${_period.name}" has closed. No more scans accepted.`, "error");

    // Reload periods and go back to picker (might be a new one open)
    const { data } = await _supabase
      .from("periods")
      .select("id, name, period_date, duration_minutes, opened_at, closed_at")
      .eq("event_id", _event.id)
      .order("sort_order").order("period_date");
    _periods = data ?? [];
    _period  = null;

    document.getElementById("result-banner").style.display = "none";
    const counter = document.getElementById("scan-counter");
    if (counter) counter.textContent = "";
    showPeriodPicker();
  }, 5000);
}

// ── Session info bar (shown once a period is selected) ────────
function renderSessionInfo() {
  setPageTitle(_period.name);
  const subtitle = document.getElementById("topbar-subtitle");
  if (subtitle) subtitle.textContent = `${_period.name} · ${formatDate(_period.period_date)}`;

  const remaining = new Date(_period.closed_at).getTime() - Date.now();
  const mm = String(Math.floor(remaining / 60000)).padStart(2, "0");
  const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");

  const el = document.getElementById("session-info");
  if (!el) return;
  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--space-3);flex-wrap:wrap">
      <div>
        <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--dark-sky-blue)">Event</div>
        <div style="font-weight:600;color:var(--warm-white)">${escHtml(_event.name)}</div>
      </div>
      <i class="ti ti-chevron-right" style="color:var(--nd-gold);flex-shrink:0"></i>
      <div>
        <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--dark-sky-blue)">Period</div>
        <div style="font-weight:600;color:var(--warm-white)">${escHtml(_period.name)}</div>
      </div>
      <i class="ti ti-chevron-right" style="color:var(--nd-gold);flex-shrink:0"></i>
      <div>
        <div style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:var(--dark-sky-blue)">Closes in</div>
        <div style="font-weight:600;color:var(--nd-gold)" id="period-countdown">${mm}:${ss}</div>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:var(--space-3)">
        <button class="btn btn-primary btn-sm" onclick="changePeriod()" title="Switch period" aria-label="Switch period">
          <i class="ti ti-refresh"></i> Switch
        </button>
        <div class="scan-status active" id="scan-status-indicator">
          <div class="scan-status-dot"></div>
          <span style="color:var(--dark-sky-blue)">Idle</span>
        </div>
      </div>
    </div>`;
}

function changePeriod() {
  clearInterval(_expiryInterval);
  clearInterval(_countdownInterval);
  _expiryInterval    = null;
  _countdownInterval = null;
  stopCamera();
  _period = null;
  const counter = document.getElementById("scan-counter");
  if (counter) counter.textContent = "";
  const badge = document.getElementById("log-count-badge");
  if (badge) badge.textContent = "0";
  document.getElementById("result-banner").style.display = "none";
  showPeriodPicker();
}

// ── Camera ────────────────────────────────────────────────────
function initCameraControls() {
  document.getElementById("start-cam-btn")?.addEventListener("click", startCamera);
  document.getElementById("stop-cam-btn")?.addEventListener("click", stopCamera);
}

async function startCamera() {
  const constraints = [
    { video: { facingMode: { exact: "environment" } } },
    { video: { facingMode: "environment" } },
    { video: true },
  ];

  let stream = null;
  for (const c of constraints) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch (_) { /* try next */ }
  }

  if (!stream) {
    showToast("Camera access denied or unavailable.", "error");
    setScanStatus("error", "No camera");
    return;
  }

  _stream = stream;
  const video = document.getElementById("scanner-video");
  video.srcObject = stream;
  video.onloadedmetadata = async () => {
    await ensureJsQR();
    _scanning = true;
    tick();
    setScanStatus("active", "Scanning");
    document.getElementById("scanner-overlay").style.display = "none";
    document.getElementById("scan-line").classList.add("active");
    document.getElementById("start-cam-btn").style.display = "none";
    document.getElementById("stop-cam-btn").style.display  = "inline-flex";
  };
}

function stopCamera() {
  _scanning = false;
  if (_rafId) cancelAnimationFrame(_rafId);
  if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  const video = document.getElementById("scanner-video");
  if (video) video.srcObject = null;
  document.getElementById("scanner-overlay").style.display = "flex";
  document.getElementById("scan-line").classList.remove("active");
  document.getElementById("start-cam-btn").style.display = "inline-flex";
  document.getElementById("stop-cam-btn").style.display  = "none";
  setScanStatus("idle", "Idle");
}

function tick() {
  if (!_scanning) return;
  const video = document.getElementById("scanner-video");
  if (video?.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width  = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img  = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (code?.data && code.data !== _lastToken) {
      handleScan(code.data, "qr");
    }
  }
  _rafId = requestAnimationFrame(tick);
}

// ── jsQR readiness guard ──────────────────────────────────────
function ensureJsQR() {
  return new Promise((resolve, reject) => {
    if (typeof jsQR === "function") { resolve(); return; }
    let attempts = 0;
    const iv = setInterval(() => {
      if (typeof jsQR === "function") { clearInterval(iv); resolve(); }
      else if (++attempts > 40) { clearInterval(iv); reject(new Error("jsQR failed to load")); }
    }, 100);
  });
}

// ── Scan handler (QR or manual) ───────────────────────────────
async function handleScan(token, method = "qr") {
  if (!token?.trim()) return;

  // Debounce same token for 2 seconds
  if (token === _lastToken) return;
  _lastToken = token;
  setTimeout(() => { if (_lastToken === token) _lastToken = ""; }, 2000);

  flashEffect();
  setScanStatus("active", "Processing…");
  clearResultBanner();

  try {
    // 1. Resolve token → attendee
    const { data: attendees, error: lookupErr } = await _supabase
      .rpc("lookup_attendee_by_qr", { p_token: token.toLowerCase(), p_event_id: _event.id });

    if (lookupErr || !attendees?.length) {
      showResultBanner("unknown", "QR code not recognised", "This code is not registered for any attendee.", null);
      setScanStatus("error", "Unknown");
      addToLog({ name: "Unknown", method, duplicate: false, unknown: true });
      return;
    }

    const attendee = attendees[0];

    // Confirm attendee belongs to this event
    if (attendee.event_id !== _event.id) {
      showResultBanner("unknown", "Wrong event", `This QR belongs to a different event.`, attendee.name);
      setScanStatus("error", "Wrong event");
      return;
    }

    // 2. Record attendance (server function handles dupe check)
    const { data: result, error: recErr } = await _supabase
      .rpc("record_attendance", {
        p_event_id:    _event.id,
        p_period_id:   _period.id,
        p_attendee_id: attendee.attendee_id,
        p_method:      method,
      });

    if (recErr) throw recErr;

    if (result.duplicate) {
      showResultBanner("duplicate", "Already checked in", `${attendee.name} was already recorded for this period.`, attendee.name);
      setScanStatus("warning", "Duplicate");
      addToLog({ name: attendee.name, method, duplicate: true });
    } else {
      showResultBanner("success", "Checked in!", attendee.name, attendee.name);
      setScanStatus("active", "Scanning");
      addToLog({ name: attendee.name, method, duplicate: false });
    }

  } catch (err) {
    console.error("Scan error:", err);
    showResultBanner("error", "Error", err.message ?? "Failed to record attendance.", null);
    setScanStatus("error", "Error");
  }
}

// ── Flash effect ──────────────────────────────────────────────
function flashEffect() {
  const f = document.getElementById("scanner-flash");
  if (!f) return;
  f.classList.add("pop");
  setTimeout(() => f.classList.remove("pop"), 200);
}

// ── Result banner ─────────────────────────────────────────────
// type: 'success' | 'duplicate' | 'unknown' | 'error'
function showResultBanner(type, title, body, name) {
  const el = document.getElementById("result-banner");
  if (!el) return;

  const configs = {
    success:   { cls: "alert-success", icon: "ti-circle-check",    color: "var(--success-green)" },
    duplicate: { cls: "alert-warning", icon: "ti-alert-triangle",   color: "#7d5a10" },
    unknown:   { cls: "alert-danger",  icon: "ti-question-mark",    color: "var(--accent-red)" },
    error:     { cls: "alert-danger",  icon: "ti-alert-circle",     color: "var(--accent-red)" },
  };
  const cfg = configs[type] ?? configs.error;

  el.className = `alert ${cfg.cls}`;
  el.style.display = "flex";
  el.innerHTML = `
    <i class="ti ${cfg.icon}" style="font-size:22px;flex-shrink:0"></i>
    <div>
      <div style="font-weight:700;font-size:0.9rem">${escHtml(title)}</div>
      <div style="font-size:0.82rem;margin-top:2px">${escHtml(body)}</div>
    </div>`;

  // Auto-clear after 4 s for success, keep duplicate/error visible
  if (type === "success") {
    setTimeout(clearResultBanner, 4000);
  }
}

function clearResultBanner() {
  const el = document.getElementById("result-banner");
  if (el) el.style.display = "none";
}

// ── Scan status indicator ─────────────────────────────────────
function setScanStatus(state, label) {
  const el = document.getElementById("scan-status-indicator");
  if (!el) return;
  el.className = `scan-status ${state}`;
  el.innerHTML = `<div class="scan-status-dot"></div><span style="color:var(--dark-sky-blue)">${escHtml(label)}</span>`;
}

// ── Manual code entry form ────────────────────────────────────
function initManualForm() {
  const form  = document.getElementById("manual-form");
  const input = document.getElementById("manual-code-input");
  if (!form) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) return;
    input.value = "";
    handleScan(token, "manual");
  });
}

// ── Scan log ──────────────────────────────────────────────────
function addToLog(entry) {
  const { name, method, duplicate, unknown } = entry;
  const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  _scanLog.unshift({ name, method, duplicate: !!duplicate, unknown: !!unknown, time });
  if (_scanLog.length > 50) _scanLog.pop();

  renderScanLog();
  updateScanCounter();
  document.dispatchEvent(new CustomEvent("scan-logged"));
}

function renderScanLog() {
  const list = document.getElementById("scan-log-list");
  if (!list) return;

  if (!_scanLog.length) {
    list.innerHTML = `<div style="padding:var(--space-6);text-align:center;color:var(--dark-sky-blue);font-size:0.8rem">
      No scans yet. Start the camera or enter a code manually.
    </div>`;
    return;
  }

  list.innerHTML = _scanLog.map(entry => {
    const initials = getInitials(entry.name);
    const methodBadge = entry.method === "manual"
      ? `<span class="badge badge-neutral" style="font-size:0.58rem">Manual</span>`
      : `<span class="badge badge-primary" style="font-size:0.58rem">QR</span>`;

    let statusBadge = "";
    if (entry.unknown)   statusBadge = `<span class="badge badge-danger"  style="font-size:0.58rem">Unknown</span>`;
    else if (entry.duplicate) statusBadge = `<span class="badge badge-warning" style="font-size:0.58rem">Duplicate</span>`;
    else                 statusBadge = `<span class="badge badge-active"  style="font-size:0.58rem">✓ In</span>`;

    const avatarColor = entry.unknown ? "var(--accent-red)"
      : entry.duplicate ? "var(--dark-gold)"
      : "var(--success-green)";

    return `
      <div class="scan-log-item">
        <div class="scan-log-avatar" style="background:${avatarColor}">${entry.unknown ? "?" : escHtml(initials)}</div>
        <div style="flex:1;min-width:0">
          <div class="scan-log-name">${escHtml(entry.name)}</div>
          <div class="scan-log-meta">${entry.time}</div>
        </div>
        <div class="scan-log-method" style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          ${statusBadge}
          ${methodBadge}
        </div>
      </div>`;
  }).join("");
}

function updateScanCounter() {
  const total  = _scanLog.filter(e => !e.duplicate && !e.unknown).length;
  const dups   = _scanLog.filter(e =>  e.duplicate).length;
  const el     = document.getElementById("scan-counter");
  if (el) el.textContent = `${total} checked in${dups ? ` · ${dups} duplicate${dups !== 1 ? "s" : ""}` : ""}`;
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
