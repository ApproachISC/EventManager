// ============================================================
//  EVENT MANAGER — taker-presence.js
//  IN / OUT register: scan attendee → choose IN / OUT → confirm
//  Event-level: works whenever the event is active, open period or not.
//  Depends on globals from auth.js and taker.js (_event, _scanning,
//  stopCamera, ensureJsQR).
// ============================================================

let _pStream      = null;
let _pRafId       = null;
let _pScanning    = false;
let _pBusy        = false;   // a lookup or confirm is in flight
let _pIgnoreToken = "";      // token just handled — ignored for a few seconds
let _pAttendee    = null;    // { id, name, method, last: {direction, logged_at} | null }
let _pDirection   = null;    // "in" | "out" — current selection
let _pRecent      = [];      // confirmed records in this session (newest first)
let _pFeedbackSeq = 0;

const _pCanvas = document.createElement("canvas");
const _pCtx    = _pCanvas.getContext("2d", { willReadFrequently: true });

const DIR_LABEL = { in: "IN", out: "OUT" };

// ── Setup ─────────────────────────────────────────────────────
function initPresence() {
  document.getElementById("presence-open-btn")?.addEventListener("click", openPresenceModal);
  document.getElementById("presence-close-btn")?.addEventListener("click", closePresenceModal);
  document.getElementById("presence-back-btn")?.addEventListener("click", backToPresenceScan);
  document.getElementById("presence-confirm-btn")?.addEventListener("click", confirmPresence);

  document.querySelectorAll(".presence-choice").forEach(btn => {
    btn.addEventListener("click", () => selectPresenceDirection(btn.dataset.direction));
  });

  document.getElementById("presence-manual-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("presence-manual-input");
    const token = input.value.trim();
    if (!token) return;
    input.value = "";
    handlePresenceToken(token, "manual");
  });

  // auth.js closes any modal on backdrop click / Escape — make sure the camera stops too
  document.getElementById("modal-presence")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePresenceModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePresenceModal();
  });
}

function showPresenceBar(show) {
  const bar = document.getElementById("presence-bar");
  if (bar) bar.style.display = show ? "flex" : "none";
}

// ── Open / close ──────────────────────────────────────────────
async function openPresenceModal() {
  if (!_event) return;

  // Most phones allow only one camera stream at a time
  if (_scanning) stopCamera();

  backToPresenceScan(false);
  setPresenceFeedback(null);
  renderPresenceRecent();
  document.getElementById("modal-presence").classList.add("open");
  await startPresenceCamera();
}

function closePresenceModal() {
  stopPresenceCamera();
  document.getElementById("modal-presence")?.classList.remove("open");
  _pAttendee  = null;
  _pDirection = null;
}

function isPresenceModalOpen() {
  return document.getElementById("modal-presence")?.classList.contains("open");
}

// ── Camera ────────────────────────────────────────────────────
async function startPresenceCamera() {
  setPresenceOverlay(true, "Starting camera…");

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
    setPresenceOverlay(true, "Camera unavailable — enter the code below.");
    return;
  }

  // Modal closed while we were waiting for permission
  if (!isPresenceModalOpen()) {
    stream.getTracks().forEach(t => t.stop());
    return;
  }

  _pStream = stream;
  const video = document.getElementById("presence-video");
  video.srcObject = stream;
  video.onloadedmetadata = async () => {
    try { await ensureJsQR(); }
    catch (_) { setPresenceOverlay(true, "Scanner failed to load — enter the code below."); return; }
    setPresenceOverlay(false);
    // Only start scanning if we're still on the scan step
    if (!_pAttendee) resumePresenceScan();
  };
}

function stopPresenceCamera() {
  pausePresenceScan();
  if (_pStream) { _pStream.getTracks().forEach(t => t.stop()); _pStream = null; }
  const video = document.getElementById("presence-video");
  if (video) video.srcObject = null;
  setPresenceOverlay(true, "Camera off");
}

function pausePresenceScan() {
  _pScanning = false;
  if (_pRafId) cancelAnimationFrame(_pRafId);
  _pRafId = null;
  document.getElementById("presence-scan-line")?.classList.remove("active");
}

function resumePresenceScan() {
  if (!_pStream || _pScanning) return;
  _pScanning = true;
  document.getElementById("presence-scan-line")?.classList.add("active");
  presenceTick();
}

function presenceTick() {
  if (!_pScanning) return;
  const video = document.getElementById("presence-video");
  if (video?.readyState === video.HAVE_ENOUGH_DATA && typeof jsQR === "function") {
    _pCanvas.width  = video.videoWidth;
    _pCanvas.height = video.videoHeight;
    _pCtx.drawImage(video, 0, 0, _pCanvas.width, _pCanvas.height);
    const img  = _pCtx.getImageData(0, 0, _pCanvas.width, _pCanvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
    if (code?.data && code.data !== _pIgnoreToken) {
      handlePresenceToken(code.data, "qr");
      return;
    }
  }
  _pRafId = requestAnimationFrame(presenceTick);
}

function setPresenceOverlay(show, message = "") {
  const overlay = document.getElementById("presence-overlay");
  if (!overlay) return;
  overlay.style.display = show ? "flex" : "none";
  const msg = document.getElementById("presence-overlay-msg");
  if (msg && message) msg.textContent = message;
}

// ── Step 1 → 2: resolve the scanned token ─────────────────────
async function handlePresenceToken(token, method) {
  if (_pBusy || !token?.trim()) return;
  _pBusy = true;
  pausePresenceScan();

  // Ignore the same code for a few seconds so it isn't re-read on return to scan
  _pIgnoreToken = token;
  setTimeout(() => { if (_pIgnoreToken === token) _pIgnoreToken = ""; }, 3000);

  setPresenceFeedback("info", "Looking up attendee…", "");

  try {
    const { data: attendees, error: lookupErr } = await _supabase
      .rpc("lookup_attendee_by_qr", { p_token: token.trim().toLowerCase(), p_event_id: _event.id });

    if (lookupErr || !attendees?.length) {
      setPresenceFeedback("error", "QR code not recognised", "This code is not registered for this event.");
      resumePresenceScan();
      return;
    }

    const att = attendees[0];

    const { data: stateRows, error: stateErr } = await _supabase
      .rpc("presence_state", { p_event_id: _event.id, p_attendee_id: att.attendee_id });
    if (stateErr) throw stateErr;

    // Only today's records count as the "current" state
    const last = stateRows?.[0] ?? null;
    const lastToday = last && isSameLocalDay(new Date(last.logged_at), new Date()) ? last : null;

    _pAttendee = {
      id:     att.attendee_id,
      name:   att.name || att.email || "Unknown",
      method,
      last:   lastToday,
    };

    setPresenceFeedback(null);
    showPresenceChoice();

  } catch (err) {
    console.error("IN/OUT lookup error:", err);
    setPresenceFeedback("error", "Error", err.message ?? "Failed to look up attendee.");
    resumePresenceScan();
  } finally {
    _pBusy = false;
  }
}

// ── Step 2: choose IN / OUT ───────────────────────────────────
function showPresenceChoice() {
  const a = _pAttendee;
  document.getElementById("presence-avatar").textContent = getInitials(a.name);
  document.getElementById("presence-name").textContent   = a.name;

  const stateEl = document.getElementById("presence-state");
  if (a.last) {
    const dir = a.last.direction;
    stateEl.innerHTML = `Currently <span class="badge ${dir === "in" ? "badge-active" : "badge-danger"}">${DIR_LABEL[dir]}</span>
      since ${escHtml(formatTime(a.last.logged_at))}`;
  } else {
    stateEl.textContent = "No IN/OUT record today";
  }

  // Suggest the logical next action: out if in (or no record yet), in if out
  const suggested = a.last?.direction === "out" ? "in" : "out";
  document.querySelectorAll(".presence-choice").forEach(btn => {
    btn.classList.toggle("suggested", btn.dataset.direction === suggested);
  });

  clearPresenceSelection();
  document.getElementById("presence-step-scan").style.display   = "none";
  document.getElementById("presence-step-choose").style.display = "block";
}

function selectPresenceDirection(direction) {
  if (!_pAttendee || _pBusy) return;
  _pDirection = direction;

  document.querySelectorAll(".presence-choice").forEach(btn => {
    const on = btn.dataset.direction === direction;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });

  const confirmBtn = document.getElementById("presence-confirm-btn");
  confirmBtn.className = `btn w-full presence-confirm ${direction === "in" ? "btn-success" : "btn-danger"}`;
  confirmBtn.innerHTML = `<i class="ti ti-check"></i> Confirm ${DIR_LABEL[direction]}`;
  confirmBtn.style.display = "inline-flex";

  // Same direction as the current state → warn, but allow (a scan may have been missed)
  const warn = document.getElementById("presence-warning");
  const last = _pAttendee.last;
  if (last && last.direction === direction) {
    warn.innerHTML = `<i class="ti ti-alert-triangle" style="flex-shrink:0"></i>
      <span>${escHtml(_pAttendee.name)} is already marked <strong>${DIR_LABEL[direction]}</strong>
      since ${escHtml(formatTime(last.logged_at))}. You can still confirm if a scan was missed.</span>`;
    warn.style.display = "flex";
  } else {
    warn.style.display = "none";
  }
}

function clearPresenceSelection() {
  _pDirection = null;
  document.querySelectorAll(".presence-choice").forEach(btn => {
    btn.classList.remove("selected");
    btn.setAttribute("aria-pressed", "false");
  });
  const confirmBtn = document.getElementById("presence-confirm-btn");
  if (confirmBtn) confirmBtn.style.display = "none";
  const warn = document.getElementById("presence-warning");
  if (warn) warn.style.display = "none";
}

// ── Step 3: confirm ───────────────────────────────────────────
async function confirmPresence() {
  if (!_pAttendee || !_pDirection || _pBusy) return;
  _pBusy = true;

  const btn       = document.getElementById("presence-confirm-btn");
  const attendee  = _pAttendee;
  const direction = _pDirection;
  setButtonLoading(btn, true);

  try {
    const { data: result, error } = await _supabase.rpc("record_presence", {
      p_event_id:    _event.id,
      p_attendee_id: attendee.id,
      p_direction:   direction,
      p_method:      attendee.method,
    });
    if (error) throw error;

    if (!result?.success) {
      setButtonLoading(btn, false);
      _pBusy = false;
      backToPresenceScan();
      setPresenceFeedback(result?.duplicate ? "warning" : "error",
        result?.duplicate ? "Already recorded" : "Not recorded",
        `${attendee.name}: ${result?.message ?? "Failed to record."}`);
      return;
    }

    const time = formatTime(new Date().toISOString());
    _pRecent.unshift({ name: attendee.name, direction, time });
    if (_pRecent.length > 5) _pRecent.pop();

    setButtonLoading(btn, false);
    _pBusy = false;
    backToPresenceScan();
    setPresenceFeedback("success", `${attendee.name} — ${DIR_LABEL[direction]}`, `Recorded at ${time}. Ready for the next scan.`);
    renderPresenceRecent();

  } catch (err) {
    console.error("IN/OUT record error:", err);
    setButtonLoading(btn, false);
    _pBusy = false;
    showToast(err.message ?? "Failed to record IN/OUT.", "error");
  }
}

// Back to the scan step and keep scanning (camera stays on)
function backToPresenceScan(resume = true) {
  _pAttendee = null;
  clearPresenceSelection();
  document.getElementById("presence-step-choose").style.display = "none";
  document.getElementById("presence-step-scan").style.display   = "block";
  if (resume) resumePresenceScan();
}

// ── Feedback + recent list ────────────────────────────────────
// type: 'success' | 'warning' | 'error' | 'info' | null (hide)
function setPresenceFeedback(type, title = "", body = "") {
  const el = document.getElementById("presence-feedback");
  if (!el) return;
  const seq = ++_pFeedbackSeq;

  if (!type) { el.style.display = "none"; return; }

  const configs = {
    success: { cls: "alert-success", icon: "ti-circle-check" },
    warning: { cls: "alert-warning", icon: "ti-alert-triangle" },
    error:   { cls: "alert-danger",  icon: "ti-alert-circle" },
    info:    { cls: "alert-info",    icon: "ti-loader-2" },
  };
  const cfg = configs[type] ?? configs.error;

  el.className = `alert ${cfg.cls}`;
  el.style.display = "flex";
  el.style.marginBottom = "var(--space-4)";
  el.innerHTML = `
    <i class="ti ${cfg.icon}" style="font-size:22px;flex-shrink:0"></i>
    <div>
      <div style="font-weight:700;font-size:0.9rem">${escHtml(title)}</div>
      ${body ? `<div style="font-size:0.82rem;margin-top:2px">${escHtml(body)}</div>` : ""}
    </div>`;

  if (type === "success") {
    setTimeout(() => { if (seq === _pFeedbackSeq) el.style.display = "none"; }, 6000);
  }
}

function renderPresenceRecent() {
  const el = document.getElementById("presence-recent");
  if (!el) return;
  if (!_pRecent.length) { el.innerHTML = ""; return; }

  el.innerHTML = `
    <div class="presence-recent-title">Recorded this session</div>
    ${_pRecent.map(r => `
      <div class="presence-recent-item">
        <span class="badge ${r.direction === "in" ? "badge-active" : "badge-danger"}" style="min-width:44px;justify-content:center">${DIR_LABEL[r.direction]}</span>
        <span class="presence-recent-name">${escHtml(r.name)}</span>
        <span class="text-xs text-faint">${escHtml(r.time)}</span>
      </div>`).join("")}`;
}

// ── Helpers ───────────────────────────────────────────────────
function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear()
      && a.getMonth()    === b.getMonth()
      && a.getDate()     === b.getDate();
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
