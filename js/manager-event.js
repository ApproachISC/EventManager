// ============================================================
//  EVENT MANAGER — manager-event.js
//  Event detail page: periods · takers · attendees · report
// ============================================================

let _eventId  = null;
let _event    = null;
let _profile  = null;
let _periods  = [];
let _takers   = [];
let _attendees = [];
let _report   = [];   // flat rows from attendance_report()

// ── Bootstrap ─────────────────────────────────────────────────
async function init() {
  _eventId = getParam("id");
  if (!_eventId) { window.location.href = "manager.html"; return; }

  const session = await requireAuth(["manager"]);
  if (!session) return;
  _profile = session.profile;

  populateSidebarUser(_profile);
  initTabs("[data-tabs]");

  await loadEvent();
  await Promise.all([loadPeriods(), loadTakers(), loadAttendees()]);

  renderAll();
  initForms();

  document.getElementById("signout-btn")?.addEventListener("click", signOut);
}

// ── Load helpers ──────────────────────────────────────────────
async function loadEvent() {
  const { data, error } = await _supabase
    .from("events")
    .select("*")
    .eq("id", _eventId)
    .eq("created_by", _profile.id)
    .single();

  if (error || !data) {
    showToast("Event not found.", "error");
    setTimeout(() => window.location.href = "manager.html", 1500);
    return;
  }
  _event = data;
  renderEventHeader();
}

async function loadPeriods() {
  const { data } = await _supabase
    .from("periods")
    .select("*")
    .eq("event_id", _eventId)
    .order("sort_order")
    .order("period_date");
  _periods = data ?? [];
}

async function loadTakers() {
  const { data } = await _supabase
    .from("event_takers")
    .select("*, profiles(name, email)")
    .eq("event_id", _eventId)
    .order("created_at");
  _takers = data ?? [];
}

async function loadAttendees() {
  const { data } = await _supabase
    .from("event_attendees")
    .select("*, profiles(name, email)")
    .eq("event_id", _eventId)
    .order("assigned_at");
  _attendees = data ?? [];
}

async function loadReport() {
  const { data, error } = await _supabase
    .rpc("attendance_report", { p_event_id: _eventId });
  if (error) { console.error(error); return; }
  _report = data ?? [];
  renderReport();
}

// ── Render all tabs ───────────────────────────────────────────
function renderAll() {
  renderEventHeader();
  renderPeriods();
  renderTakers();
  renderAttendees();
}

// ── Event header & status stepper ────────────────────────────
function renderEventHeader() {
  if (!_event) return;
  document.getElementById("event-name").textContent    = _event.name;
  document.getElementById("event-dates").textContent   =
    `${formatDate(_event.start_date)} — ${formatDate(_event.end_date)}`;
  document.getElementById("event-desc").textContent    = _event.description ?? "";
  setPageTitle(_event.name);

  // Status badge
  const badgeEl = document.getElementById("event-status-badge");
  const classes = { draft:"badge-draft", active:"badge-active", closed:"badge-closed" };
  badgeEl.className = `badge ${classes[_event.status]}`;
  badgeEl.textContent = _event.status.charAt(0).toUpperCase() + _event.status.slice(1);

  // Status stepper
  const steps   = ["draft", "active", "closed"];
  const current = steps.indexOf(_event.status);
  steps.forEach((s, i) => {
    const el = document.getElementById(`step-${s}`);
    if (!el) return;
    el.classList.remove("current", "completed");
    if (i < current) el.classList.add("completed");
    if (i === current) el.classList.add("current");
  });

  // Transition buttons
  const toActive = document.getElementById("btn-to-active");
  const toClosed = document.getElementById("btn-to-closed");
  const toDraft  = document.getElementById("btn-to-draft");

  if (toActive) toActive.style.display = _event.status === "draft"   ? "inline-flex" : "none";
  if (toClosed) toClosed.style.display = _event.status === "active"  ? "inline-flex" : "none";
  if (toDraft)  toDraft.style.display  = _event.status === "closed"  ? "inline-flex" : "none";
}

// ── Status transitions ────────────────────────────────────────
async function setEventStatus(newStatus) {
  const btn = document.getElementById(`btn-to-${newStatus}`);
  setButtonLoading(btn, true);
  try {
    const { error } = await _supabase
      .from("events")
      .update({ status: newStatus })
      .eq("id", _eventId);
    if (error) throw error;
    _event.status = newStatus;
    renderEventHeader();
    showToast(`Event marked as ${newStatus}.`, "success");
  } catch (err) {
    showToast(err.message ?? "Failed to update status.", "error");
    setButtonLoading(btn, false);
  }
}

// ── PERIODS TAB ───────────────────────────────────────────────
function renderPeriods() {
  const tbody = document.getElementById("periods-tbody");
  if (!tbody) return;

  if (!_periods.length) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="table-empty">
      <i class="ti ti-clock-off"></i>
      <p>No periods yet. Add a period below.</p>
    </div></td></tr>`;
    return;
  }

  tbody.innerHTML = _periods.map((p, idx) => `
    <tr>
      <td style="font-weight:600">${escHtml(p.name)}</td>
      <td>${formatDate(p.period_date)}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn-ghost btn-sm btn-icon" title="Move up"
            onclick="movePeriod('${p.id}', ${idx}, -1)"
            ${idx === 0 ? "disabled" : ""} aria-label="Move period up">
            <i class="ti ti-chevron-up"></i>
          </button>
          <button class="btn btn-ghost btn-sm btn-icon" title="Move down"
            onclick="movePeriod('${p.id}', ${idx}, 1)"
            ${idx === _periods.length - 1 ? "disabled" : ""} aria-label="Move period down">
            <i class="ti ti-chevron-down"></i>
          </button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete period"
            onclick="deletePeriod('${p.id}', '${escHtml(p.name)}')" aria-label="Delete period">
            <i class="ti ti-trash"></i>
          </button>
        </div>
      </td>
    </tr>`).join("");

  window._periods = _periods;
  document.dispatchEvent(new CustomEvent("periods-loaded"));
}

async function addPeriod(name, date) {
  const { error } = await _supabase.from("periods").insert({
    event_id:    _eventId,
    name,
    period_date: date,
    sort_order:  _periods.length,
  });
  if (error) throw error;
  await loadPeriods();
  renderPeriods();
  renderTakers(); // refresh period names in takers tab
}

async function deletePeriod(periodId, periodName) {
  if (!confirm(`Delete period "${periodName}"? All attendance logs for this period will also be deleted.`)) return;
  const { error } = await _supabase.from("periods").delete().eq("id", periodId);
  if (error) { showToast("Failed to delete period.", "error"); return; }
  await loadPeriods();
  renderPeriods();
  showToast("Period deleted.", "success");
}

async function movePeriod(periodId, idx, direction) {
  const swapIdx  = idx + direction;
  if (swapIdx < 0 || swapIdx >= _periods.length) return;
  const swapId   = _periods[swapIdx].id;

  // Swap sort_order values
  await _supabase.from("periods").update({ sort_order: swapIdx }).eq("id", periodId);
  await _supabase.from("periods").update({ sort_order: idx     }).eq("id", swapId);

  await loadPeriods();
  renderPeriods();
}

// ── TAKERS TAB ────────────────────────────────────────────────
function renderTakers() {
  const tbody = document.getElementById("takers-tbody");
  if (!tbody) return;

  if (!_takers.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="table-empty">
      <i class="ti ti-user-off"></i>
      <p>No attendance takers invited yet.</p>
    </div></td></tr>`;
    return;
  }

  tbody.innerHTML = _takers.map(t => {
    const name  = t.profiles?.name  ?? "—";
    const email = t.profiles?.email ?? "—";
    return `
    <tr>
      <td>
        <div class="flex items-center gap-3">
          <div class="avatar avatar-sm">${getInitials(name)}</div>
          <div>
            <div style="font-weight:600">${escHtml(name)}</div>
            <div class="text-xs text-faint">${escHtml(email)}</div>
          </div>
        </div>
      </td>
      <td>
        <span class="badge ${t.is_active ? "badge-active" : "badge-danger"}">
          ${t.is_active ? "● Active" : "◼ Inactive"}
        </span>
      </td>
      <td>${formatDate(t.created_at)}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn-outline btn-sm" title="Resend invite"
            onclick="handleResend('${t.id}', '${escHtml(email)}')" aria-label="Resend invite">
            <i class="ti ti-send"></i> Resend
          </button>
          <button class="btn ${t.is_active ? "btn-warning" : "btn-success"} btn-sm"
            onclick="toggleTaker('${t.id}', ${!t.is_active})"
            aria-label="${t.is_active ? "Deactivate" : "Activate"} taker">
            <i class="ti ti-${t.is_active ? "player-pause" : "player-play"}"></i>
            ${t.is_active ? "Deactivate" : "Activate"}
          </button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

async function handleResend(eventTakerId, email) {
  // Find the invite row for this taker + event
  const { data: invite } = await _supabase
    .from("invites")
    .select("id")
    .eq("email", email)
    .eq("event_id", _eventId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (!invite) { showToast("No invite record found.", "error"); return; }

  try {
    await resendInvite(invite.id);
    showToast(`Invite resent to ${email}.`, "success");
  } catch (err) {
    showToast(err.message ?? "Failed to resend invite.", "error");
  }
}

async function toggleTaker(eventTakerId, newActive) {
  try {
    await setTakerActive(eventTakerId, newActive);
    await loadTakers();
    renderTakers();
    showToast(`Taker ${newActive ? "activated" : "deactivated"}.`, "success");
  } catch (err) {
    showToast(err.message ?? "Failed to update taker.", "error");
  }
}

// ── ATTENDEES TAB ─────────────────────────────────────────────
function renderAttendees() {
  const tbody   = document.getElementById("attendees-tbody");
  const counter = document.getElementById("attendees-count");
  if (!tbody) return;

  if (counter) counter.textContent = `${_attendees.length} attendee${_attendees.length !== 1 ? "s" : ""}`;

  if (!_attendees.length) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="table-empty">
      <i class="ti ti-users-group"></i>
      <p>No attendees yet. Import a CSV file to add attendees.</p>
    </div></td></tr>`;
    return;
  }

  tbody.innerHTML = _attendees.map(a => {
    const name  = a.profiles?.name  ?? "—";
    const email = a.profiles?.email ?? "—";
    return `
    <tr>
      <td>
        <div class="flex items-center gap-3">
          <div class="avatar avatar-sm">${getInitials(name)}</div>
          <div>
            <div style="font-weight:600">${escHtml(name)}</div>
            <div class="text-xs text-faint">${escHtml(email)}</div>
          </div>
        </div>
      </td>
      <td><code style="font-size:0.72rem;background:var(--light-sky-blue);padding:2px 6px;border-radius:4px">${a.qr_token.slice(0, 8).toUpperCase()}…</code></td>
      <td>${formatDate(a.assigned_at)}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn-outline btn-sm btn-icon" title="Remove attendee"
            onclick="removeAttendee('${a.id}', '${escHtml(name)}')" aria-label="Remove attendee">
            <i class="ti ti-user-minus"></i>
          </button>
        </div>
      </td>
    </tr>`;
  }).join("");
}

async function removeAttendee(attendeeEventId, name) {
  if (!confirm(`Remove ${name} from this event?`)) return;
  const { error } = await _supabase.from("event_attendees").delete().eq("id", attendeeEventId);
  if (error) { showToast("Failed to remove attendee.", "error"); return; }
  await loadAttendees();
  renderAttendees();
  showToast(`${name} removed.`, "success");
}

// ── CSV Import ────────────────────────────────────────────────
async function handleCSVImport(file) {
  const progressEl = document.getElementById("import-progress");
  const progressBar = document.getElementById("import-bar");
  const importBtn = document.getElementById("import-btn");

  setButtonLoading(importBtn, true);

  let rows;
  try {
    rows = await parseCSV(file);
  } catch (err) {
    showToast("Failed to parse CSV file.", "error");
    setButtonLoading(importBtn, false);
    return;
  }

  // Validate columns
  const required = ["email", "name"];
  const headers  = Object.keys(rows[0] ?? {}).map(h => h.trim().toLowerCase());
  const missing  = required.filter(r => !headers.includes(r));
  if (missing.length) {
    showToast(`CSV missing columns: ${missing.join(", ")}`, "error");
    setButtonLoading(importBtn, false);
    return;
  }

  progressEl.style.display = "block";
  let done = 0, failed = 0;

  for (const row of rows) {
    const email = (row.email ?? row.Email ?? "").trim().toLowerCase();
    const name  = (row.name  ?? row.Name  ?? "").trim();
    const code  = (row.code  ?? row.Code  ?? "").trim().toLowerCase() || null;
    if (!email || !name) { failed++; done++; continue; }

    try {
      // Check if profile already exists
      const { data: existing } = await _supabase
        .from("profiles")
        .select("id")
        .eq("email", email)
        .single();

      let userId;

      if (existing) {
        userId = existing.id;
      } else {
        // Create via invite flow
        const tempPassword = generateTempPassword();

        // Insert invite row first (DB trigger needs it)
        const { data: invite, error: invErr } = await _supabase
          .from("invites")
          .insert({ email, role: "attendee", temp_password: tempPassword,
                    event_id: _eventId, invited_by: _profile.id })
          .select().single();
        if (invErr) throw invErr;

        // Create auth user via Edge Function — triggers handle_new_auth_user → creates profile
        const { data: createData, error: createErr } = await _supabase.functions.invoke("create-user", {
          body: { email, password: tempPassword, role: "attendee", name },
        });
        if (createErr) throw createErr;
        userId = createData?.user_id;

        if (!userId) throw new Error("Failed to create user account.");

        // Update profile name (trigger sets role, we set name)
        await _supabase.from("profiles").update({ name }).eq("id", userId);

        // Assign to event now so qr_token exists before the email is sent
        await _supabase.from("event_attendees").upsert(
          { event_id: _eventId, user_id: userId, ...(code ? { qr_token: code } : {}) },
          { onConflict: "event_id,user_id" }
        );

        // Get qr_token for the invite email
        const { data: ea } = await _supabase
          .from("event_attendees")
          .select("qr_token")
          .eq("event_id", _eventId)
          .eq("user_id", userId)
          .single();

        // Send invite email with QR
        await sendEmail({
          type: "invite_attendee",
          to: email,
          tempPassword,
          attendeeName: name,
          eventName: _event.name,
          qrToken: ea?.qr_token ?? "",
          inviteId: invite.id,
        });
      }

      // Assign to event (idempotent — unique constraint handles dups)
      await _supabase.from("event_attendees").upsert(
        { event_id: _eventId, user_id: userId, ...(code ? { qr_token: code } : {}) },
        { onConflict: "event_id,user_id" }
      );

    } catch (err) {
      console.warn(`Row failed (${email}):`, err.message);
      failed++;
    }

    done++;
    const pct = Math.round((done / rows.length) * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;
  }

  await loadAttendees();
  renderAttendees();
  setButtonLoading(importBtn, false);
  progressEl.style.display = "none";
  if (progressBar) progressBar.style.width = "0%";

  const ok = done - failed;
  showToast(
    `Import complete: ${ok} added${failed ? `, ${failed} skipped` : ""}.`,
    failed ? "info" : "success"
  );
}

// ── Print / Download QR sheet ─────────────────────────────────
async function downloadQRSheet() {
  if (!_attendees.length) {
    showToast("No attendees to generate QR codes for.", "info");
    return;
  }

  const btn = document.getElementById("download-qr-btn");
  setButtonLoading(btn, true);

  // Build a printable HTML page in a new tab
  const rows = _attendees.map(a => {
    const name  = a.profiles?.name  ?? a.profiles?.email ?? "Attendee";
    const email = a.profiles?.email ?? "";
    const token = a.qr_token;
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(token)}`;
    return `
      <div class="qr-print-item">
        <img src="${qrUrl}" width="160" height="160" alt="QR for ${escHtml(name)}" loading="lazy" />
        <div class="qr-print-name">${escHtml(name)}</div>
        <div class="qr-print-email">${escHtml(email)}</div>
      </div>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>QR Codes — ${escHtml(_event.name)}</title>
  <style>
    body { font-family: 'Helvetica Neue', sans-serif; margin: 0; padding: 1rem; }
    h1 { font-size: 1.2rem; color: #0c2340; border-bottom: 2px solid #ae9142; padding-bottom: 0.5rem; margin-bottom: 1rem; }
    .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
    .qr-print-item { border: 1px solid #c1cddd; border-radius: 8px; padding: 1rem; text-align: center; break-inside: avoid; }
    .qr-print-item img { margin: 0 auto 0.5rem; display: block; }
    .qr-print-name { font-weight: 600; font-size: 0.8rem; color: #0c2340; }
    .qr-print-email { font-size: 0.65rem; color: #888; margin-top: 2px; }
    @media print { body { padding: 0; } }
  </style>
</head>
<body>
  <h1>QR Codes — ${escHtml(_event.name)}</h1>
  <div class="sheet">${rows}</div>
  <script>window.onload = () => window.print();<\/script>
</body>
</html>`;

  const win = window.open("", "_blank");
  win.document.write(html);
  win.document.close();

  setButtonLoading(btn, false);
}

// ── REPORT TAB ────────────────────────────────────────────────
function renderReport() {
  const container = document.getElementById("report-container");
  if (!container) return;

  if (!_periods.length || !_attendees.length) {
    container.innerHTML = `<div class="table-empty">
      <i class="ti ti-chart-bar-off"></i>
      <p>Add periods and attendees to see the attendance report.</p>
    </div>`;
    return;
  }

  if (!_report.length) {
    container.innerHTML = `<div class="table-empty">
      <i class="ti ti-clipboard-off"></i>
      <p>No attendance data yet for this event.</p>
    </div>`;
    return;
  }

  // Group by attendee
  const byAttendee = {};
  for (const row of _report) {
    if (!byAttendee[row.attendee_id]) {
      byAttendee[row.attendee_id] = {
        name:  row.attendee_name,
        email: row.attendee_email,
        periods: {},
      };
    }
    byAttendee[row.attendee_id].periods[row.period_id] = {
      present:    row.present,
      log_id:     row.log_id,
      method:     row.method,
      overridden: row.overridden,
    };
  }

  const periodCols = _periods.map(p =>
    `<th class="period-col" scope="col" style="min-width:100px">${escHtml(p.name)}<br>
     <span class="text-xs" style="color:var(--dark-sky-blue);font-weight:400">${formatDate(p.period_date)}</span></th>`
  ).join("");

  const rows = Object.values(byAttendee).map(att => {
    const cells = _periods.map(p => {
      const rec = att.periods[p.id];
      if (!rec) {
        // No log yet — show empty
        return `<td class="period-cell">
          <span class="badge badge-pending" style="font-size:0.6rem">—</span>
        </td>`;
      }
      if (rec.present === null || rec.present === undefined) {
        return `<td class="period-cell">
          <span class="badge badge-pending" style="font-size:0.6rem">—</span>
        </td>`;
      }
      const cls  = rec.present ? "present" : "absent";
      const icon = rec.present ? "ti-check" : "ti-x";
      const tip  = rec.overridden ? "Manually overridden" : (rec.method === "manual" ? "Manual entry" : "QR scan");
      return `<td class="period-cell">
        <button
          class="attendance-toggle ${cls}"
          title="${tip}"
          data-tooltip="${tip}"
          onclick="toggleAttendanceOverride('${rec.log_id}', ${!rec.present})"
          aria-label="${rec.present ? "Present — click to mark absent" : "Absent — click to mark present"}"
        >
          <i class="ti ${icon}"></i>
        </button>
        ${rec.overridden ? `<span style="font-size:9px;color:var(--dark-sky-blue);display:block;margin-top:2px">edited</span>` : ""}
      </td>`;
    }).join("");

    return `<tr>
      <td style="white-space:nowrap">
        <div style="font-weight:600">${escHtml(att.name)}</div>
        <div class="text-xs text-faint">${escHtml(att.email)}</div>
      </td>
      ${cells}
    </tr>`;
  }).join("");

  container.innerHTML = `
    <div class="table-wrap">
      <table class="attendance-table" aria-label="Attendance report">
        <thead>
          <tr>
            <th scope="col" style="min-width:160px">Attendee</th>
            ${periodCols}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

async function toggleAttendanceOverride(logId, newPresent) {
  if (!logId) return;
  try {
    const { error } = await _supabase.rpc("toggle_attendance", {
      p_log_id: logId,
      p_present: newPresent,
    });
    if (error) throw error;
    await loadReport();
  } catch (err) {
    showToast(err.message ?? "Failed to update attendance.", "error");
  }
}

// ── Export report CSV ─────────────────────────────────────────
function exportReportCSV() {
  if (!_report.length) { showToast("No report data to export.", "info"); return; }

  const headers  = ["Name", "Email", ..._periods.map(p => `${p.name} (${p.period_date})`)];
  const byId     = {};
  for (const row of _report) {
    if (!byId[row.attendee_id]) byId[row.attendee_id] = { name: row.attendee_name, email: row.attendee_email, periods: {} };
    byId[row.attendee_id].periods[row.period_id] = row.present;
  }

  const rows = Object.values(byId).map(att => [
    att.name,
    att.email,
    ..._periods.map(p => {
      const v = att.periods[p.id];
      return v === true ? "Present" : v === false ? "Absent" : "—";
    }),
  ]);

  exportCSV(`attendance-${_event.name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0,10)}.csv`, headers, rows);
}

// ── Form initialisation ───────────────────────────────────────
function initForms() {
  // Add period form
  document.getElementById("add-period-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn  = document.getElementById("add-period-btn");
    const name = document.getElementById("period-name").value.trim();
    const date = document.getElementById("period-date").value;

    if (!name || !date) { showToast("Period name and date are required.", "error"); return; }
    setButtonLoading(btn, true);
    try {
      await addPeriod(name, date);
      e.target.reset();
      showToast(`Period "${name}" added.`, "success");
    } catch (err) {
      showToast(err.message ?? "Failed to add period.", "error");
    }
    setButtonLoading(btn, false);
  });

  // Invite taker form
  document.getElementById("invite-taker-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn   = document.getElementById("invite-taker-btn");
    const email = document.getElementById("taker-email").value.trim().toLowerCase();

    if (!email) { showToast("Email is required.", "error"); return; }

    setButtonLoading(btn, true);
    try {
      await inviteUser({
        email,
        role:      "taker",
        eventId:   _eventId,
        eventName: _event.name,
      });

      // Insert event_takers row (no period — taker selects period at scan time)
      const { data: profile } = await _supabase
        .from("profiles").select("id").eq("email", email).single();
      if (profile?.id) {
        await _supabase.from("event_takers").insert({
          event_id:  _eventId,
          user_id:   profile.id,
          is_active: true,
        });
      }

      await loadTakers();
      renderTakers();
      e.target.reset();
      showToast(`Invite sent to ${email}.`, "success");
    } catch (err) {
      showToast(err.message ?? "Failed to invite taker.", "error");
    }
    setButtonLoading(btn, false);
  });

  // CSV file input
  document.getElementById("csv-file-input")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleCSVImport(file);
    e.target.value = "";
  });

  // Download QR sheet
  document.getElementById("download-qr-btn")?.addEventListener("click", downloadQRSheet);

  // Export CSV
  document.getElementById("export-csv-btn")?.addEventListener("click", exportReportCSV);

  // Status buttons
  document.getElementById("btn-to-active")?.addEventListener("click", () => setEventStatus("active"));
  document.getElementById("btn-to-closed")?.addEventListener("click", () => setEventStatus("closed"));
  document.getElementById("btn-to-draft")?.addEventListener("click",  () => setEventStatus("draft"));

  // Sign out
  document.getElementById("signout-btn")?.addEventListener("click", signOut);
}

// ── Tab: load report on demand ────────────────────────────────
function onReportTabActivated() {
  if (!_report.length) loadReport();
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
