// ============================================================
//  EVENT MANAGER — attendee.js
//  Attendee page: view enrolled events and download QR code
// ============================================================

let _profile     = null;
let _enrollments = [];   // [{ id, qr_token, event }]
let _current     = null; // selected enrollment

// ── Bootstrap ─────────────────────────────────────────────────
async function init() {
  const session = await requireAuth(["attendee"]);
  if (!session) return;
  _profile = session.profile;

  populateSidebarUser(_profile);
  await loadEnrollments();

  document.getElementById("signout-btn")?.addEventListener("click", signOut);
  document.getElementById("download-qr-btn")?.addEventListener("click", downloadQR);
}

// ── Load enrolled events ──────────────────────────────────────
async function loadEnrollments() {
  const { data, error } = await _supabase
    .from("event_attendees")
    .select(`
      id, qr_token,
      events ( id, name, description, start_date, end_date, status )
    `)
    .eq("user_id", _profile.id)
    .order("assigned_at", { ascending: false });

  document.getElementById("loading-ui").style.display = "none";

  if (error || !data?.length) {
    document.getElementById("no-events-ui").style.display = "flex";
    return;
  }

  _enrollments = data.map(ea => ({
    id:       ea.id,
    qr_token: ea.qr_token,
    event:    ea.events,
  }));

  document.getElementById("attendee-ui").style.display = "block";

  if (_enrollments.length > 1) {
    buildEventSelector();
  }

  selectEnrollment(_enrollments[0]);
}

// ── Event selector (shown only when enrolled in multiple events) ─
function buildEventSelector() {
  const wrap = document.getElementById("event-selector-wrap");
  const sel  = document.getElementById("event-select");
  wrap.style.display = "flex";

  _enrollments.forEach((enr, i) => {
    sel.appendChild(new Option(enr.event.name, String(i)));
  });

  sel.addEventListener("change", () => {
    selectEnrollment(_enrollments[parseInt(sel.value, 10)]);
  });
}

// ── Select and render an enrollment ──────────────────────────
function selectEnrollment(enrollment) {
  _current = enrollment;
  renderQR(enrollment.qr_token);
  renderEventInfo(enrollment.event);

  const subtitle = document.getElementById("topbar-subtitle");
  if (subtitle) subtitle.textContent = enrollment.event.name;
  setPageTitle(enrollment.event.name);
}

// ── QR code rendering ─────────────────────────────────────────
async function renderQR(token) {
  const canvas  = document.getElementById("qr-canvas");
  const tokenEl = document.getElementById("qr-token-display");

  try {
    await QRCode.toCanvas(canvas, token, {
      width:  256,
      margin: 2,
      color: {
        dark:  "#0c2340",
        light: "#ffffff",
      },
    });
  } catch (err) {
    console.error("QR render error:", err);
    showToast("Failed to render QR code.", "error");
  }

  if (tokenEl) tokenEl.textContent = token;
}

// ── Download QR as PNG ────────────────────────────────────────
function downloadQR() {
  const canvas = document.getElementById("qr-canvas");
  if (!canvas) return;

  const eventName = (_current?.event?.name ?? "qr")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  const link = document.createElement("a");
  link.download = `qr-${eventName}.png`;
  link.href     = canvas.toDataURL("image/png");
  link.click();
}

// ── Event info card ───────────────────────────────────────────
function renderEventInfo(event) {
  const body = document.getElementById("event-info-body");
  if (!body) return;

  const statusCls = {
    draft:  "badge-draft",
    active: "badge-active",
    closed: "badge-closed",
  };
  const statusLabel = event.status.charAt(0).toUpperCase() + event.status.slice(1);

  const dateRange = event.end_date && event.end_date !== event.start_date
    ? `${formatDate(event.start_date)} — ${formatDate(event.end_date)}`
    : formatDate(event.start_date);

  body.innerHTML = `
    <dl class="event-detail-grid">
      <dt class="event-detail-label">Event</dt>
      <dd style="font-weight:600;font-size:1rem;margin:0">${escHtml(event.name)}</dd>

      ${event.description ? `
      <dt class="event-detail-label">Description</dt>
      <dd style="font-size:0.875rem;color:var(--text-secondary);margin:0;line-height:1.6">${escHtml(event.description)}</dd>` : ""}

      <dt class="event-detail-label">Dates</dt>
      <dd style="font-size:0.875rem;margin:0">${dateRange}</dd>

      <dt class="event-detail-label">Status</dt>
      <dd style="margin:0"><span class="badge ${statusCls[event.status] ?? "badge-neutral"}">${escHtml(statusLabel)}</span></dd>
    </dl>`;
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
