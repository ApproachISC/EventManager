// ============================================================
//  EVENT MANAGER — manager-presence.js
//  IN/OUT Report tab: per-attendee daily timeline of
//  attendance taken · IN · OUT, with out-of-room intervals.
//  Depends on globals from auth.js and manager-event.js
//  (_eventId, _event, _periods, _attendees).
// ============================================================

let _presenceLogs     = [];   // presence_logs rows for the event
let _attTakenLogs     = [];   // attendance_logs rows (present = true)
let _presenceLoaded   = false;
let _presenceLoading  = false;
let _presenceDay      = null; // "YYYY-MM-DD" (local time)
let _presencePage     = 1;
let _presenceSearch   = "";
let _presenceOnlyLeft = false;
const PRESENCE_PAGE_SIZE = 15;

// ── Setup ─────────────────────────────────────────────────────
function initPresenceReport() {
  document.getElementById("presence-refresh-btn")?.addEventListener("click", loadPresenceReport);
  document.getElementById("presence-export-btn")?.addEventListener("click", exportPresenceCSV);

  document.getElementById("presence-day")?.addEventListener("change", (e) => {
    _presenceDay  = e.target.value;
    _presencePage = 1;
    renderPresenceReport();
  });
  document.getElementById("presence-search")?.addEventListener("input", (e) => {
    _presenceSearch = e.target.value.trim().toLowerCase();
    _presencePage   = 1;
    renderPresenceReport();
  });
  document.getElementById("presence-only-left")?.addEventListener("change", (e) => {
    _presenceOnlyLeft = e.target.checked;
    _presencePage     = 1;
    renderPresenceReport();
  });
}

function onPresenceTabActivated() {
  if (!_presenceLoaded && !_presenceLoading) loadPresenceReport();
}

// ── Load ──────────────────────────────────────────────────────
// Fetch every row (Supabase caps a response at 1000 rows)
async function fetchAllRows(buildQuery) {
  const PAGE = 1000;
  let all = [], from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function loadPresenceReport() {
  const container = document.getElementById("presence-container");
  _presenceLoading = true;
  if (container) container.innerHTML = `<div class="skeleton" style="height:120px"></div>`;

  try {
    const [presence, attendance] = await Promise.all([
      fetchAllRows(() => _supabase
        .from("presence_logs")
        .select("id, attendee_id, direction, method, logged_at, recorder:profiles!presence_logs_recorded_by_fkey(name)")
        .eq("event_id", _eventId)
        .order("logged_at")
        .order("id")),
      fetchAllRows(() => _supabase
        .from("attendance_logs")
        .select("id, attendee_id, period_id, method, logged_at")
        .eq("event_id", _eventId)
        .eq("present", true)
        .order("logged_at")
        .order("id")),
    ]);

    _presenceLogs   = presence;
    _attTakenLogs   = attendance;
    _presenceLoaded = true;

    buildPresenceDayOptions();
    renderPresenceReport();
  } catch (err) {
    console.error("IN/OUT report error:", err);
    if (container) container.innerHTML = `<div class="table-empty">
      <i class="ti ti-alert-circle"></i>
      <p>Failed to load IN/OUT data${err?.message ? `: ${escHtml(err.message)}` : "."}</p>
    </div>`;
  } finally {
    _presenceLoading = false;
  }
}

// ── Day selector ──────────────────────────────────────────────
function localDayKey(dateLike) {
  const d = new Date(dateLike);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function buildPresenceDayOptions() {
  const select = document.getElementById("presence-day");
  if (!select) return;

  // Every event day, plus any day that has data outside the event range
  const days = new Set();
  if (_event?.start_date && _event?.end_date) {
    const d   = new Date(_event.start_date + "T00:00:00");
    const end = new Date(_event.end_date   + "T00:00:00");
    while (d <= end) { days.add(localDayKey(d)); d.setDate(d.getDate() + 1); }
  }
  const counts = {};
  for (const l of _presenceLogs) {
    const k = localDayKey(l.logged_at);
    days.add(k);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  for (const l of _attTakenLogs) days.add(localDayKey(l.logged_at));

  const sorted = [...days].sort();
  const today  = localDayKey(new Date());

  if (!_presenceDay || !days.has(_presenceDay)) {
    const withData = sorted.filter(k => counts[k]);
    _presenceDay = days.has(today) ? today
      : withData.length ? withData[withData.length - 1]
      : sorted[0] ?? today;
  }

  select.innerHTML = sorted.map(k => {
    const n = counts[k] ?? 0;
    const label = `${formatDate(k)}${k === today ? " (today)" : ""} · ${n} IN/OUT`;
    return `<option value="${k}" ${k === _presenceDay ? "selected" : ""}>${escHtml(label)}</option>`;
  }).join("");
}

// ── Per-attendee computation ──────────────────────────────────
// Returns OUT→IN intervals. An OUT with no later IN that day stays open:
// until now if the day is today, otherwise until the end of the day.
function computeOutIntervals(dayPresence, dayEndMs, isToday) {
  const intervals = [];
  let outStart = null;
  let exits    = 0;

  for (const e of dayPresence) {
    const t = Date.parse(e.logged_at);
    if (e.direction === "out") {
      if (outStart === null) { outStart = t; exits++; }   // repeated OUTs keep the first
    } else if (outStart !== null) {
      intervals.push({ start: outStart, end: t, open: false });
      outStart = null;
    }
  }

  if (outStart !== null) {
    intervals.push({
      start: outStart,
      end:   isToday ? Math.max(Date.now(), outStart) : dayEndMs,
      open:  true,
    });
  }

  // Closed intervals always count; an open one only counts today (time out so far)
  const closedMs = intervals.filter(i => !i.open).reduce((s, i) => s + (i.end - i.start), 0);
  const openMs   = isToday ? intervals.filter(i => i.open).reduce((s, i) => s + (i.end - i.start), 0) : 0;

  return { intervals, exits, totalOutMs: closedMs + openMs, stillOut: outStart !== null };
}

function getPresenceDayData() {
  const day     = _presenceDay;
  const isToday = day === localDayKey(new Date());

  const dayPresence = _presenceLogs.filter(l => localDayKey(l.logged_at) === day);
  const dayAtt      = _attTakenLogs.filter(l => localDayKey(l.logged_at) === day);
  const dayPeriods  = _periods
    .filter(p => p.opened_at && localDayKey(p.opened_at) === day)
    .map(p => ({ name: p.name, start: Date.parse(p.opened_at), end: Date.parse(p.closed_at ?? p.opened_at) }));

  // Axis range: whole hours around all activity of the day
  const times = [
    ...dayPresence.map(l => Date.parse(l.logged_at)),
    ...dayAtt.map(l => Date.parse(l.logged_at)),
    ...dayPeriods.flatMap(p => [p.start, p.end]),
  ];
  if (!times.length) return { day, isToday, empty: true };

  const HOUR = 3600000;
  const min  = Math.min(...times);
  let   max  = Math.max(...times);

  // Today, if anyone is still out, stretch the axis up to now
  const lastByAttendee = {};
  for (const l of dayPresence) lastByAttendee[l.attendee_id] = l.direction;
  if (isToday && Object.values(lastByAttendee).includes("out")) max = Math.max(max, Date.now());

  const startD = new Date(min); startD.setMinutes(0, 0, 0);
  const endD   = new Date(max);
  if (endD.getMinutes() || endD.getSeconds() || endD.getMilliseconds()) {
    endD.setMinutes(0, 0, 0);
    endD.setHours(endD.getHours() + 1);
  }
  let start = startD.getTime();
  let end   = endD.getTime();
  if (end - start < HOUR) end = start + HOUR;

  // Group by attendee
  const presenceBy = {}, attBy = {};
  for (const l of dayPresence) (presenceBy[l.attendee_id] ??= []).push(l);
  for (const l of dayAtt)      (attBy[l.attendee_id]      ??= []).push(l);

  const rows = _attendees
    .map(a => {
      const pres = presenceBy[a.user_id] ?? [];
      const att  = attBy[a.user_id] ?? [];
      return {
        id:       a.user_id,
        name:     a.profiles?.name  ?? "—",
        email:    a.profiles?.email ?? "",
        presence: pres,
        att,
        ...computeOutIntervals(pres, end, isToday),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { day, isToday, empty: false, start, end, dayPeriods, rows };
}

// ── Render ────────────────────────────────────────────────────
function renderPresenceReport() {
  const container = document.getElementById("presence-container");
  if (!container) return;

  if (!_attendees.length) {
    container.innerHTML = `<div class="table-empty">
      <i class="ti ti-users-group"></i>
      <p>Add attendees to see the IN/OUT report.</p>
    </div>`;
    renderPresencePagination(1, 0);
    return;
  }

  const data = getPresenceDayData();
  if (data.empty) {
    container.innerHTML = `<div class="table-empty">
      <i class="ti ti-calendar-off"></i>
      <p>No attendance or IN/OUT activity recorded on ${escHtml(formatDate(data.day))}.</p>
    </div>`;
    renderPresencePagination(1, 0);
    return;
  }

  const { start, end, dayPeriods, isToday } = data;
  const span = end - start;
  const pct  = t => Math.min(100, Math.max(0, ((t - start) / span) * 100));

  // Filters
  let rows = data.rows;
  if (_presenceOnlyLeft) rows = rows.filter(r => r.exits > 0);
  if (_presenceSearch)   rows = rows.filter(r =>
    r.name.toLowerCase().includes(_presenceSearch) || r.email.toLowerCase().includes(_presenceSearch));

  if (!rows.length) {
    container.innerHTML = `<div class="table-empty">
      <i class="ti ti-search-off"></i>
      <p>${_presenceOnlyLeft && !_presenceSearch
        ? "No attendee left the room on this day."
        : "No attendees match your filters."}</p>
    </div>`;
    renderPresencePagination(1, 0);
    return;
  }

  const totalPages = Math.ceil(rows.length / PRESENCE_PAGE_SIZE);
  if (_presencePage > totalPages) _presencePage = totalPages;
  const pageRows = rows.slice((_presencePage - 1) * PRESENCE_PAGE_SIZE, _presencePage * PRESENCE_PAGE_SIZE);

  // Hour ticks (every 2h when the day is long)
  const HOUR  = 3600000;
  const step  = span > 12 * HOUR ? 2 * HOUR : HOUR;
  const ticks = [];
  for (let t = start; t <= end; t += step) ticks.push(t);

  const gridLines = ticks.map(t => `<div class="tl-gridline" style="left:${pct(t)}%"></div>`).join("");

  const periodBands = dayPeriods.map(p =>
    `<div class="tl-period" style="left:${pct(p.start)}%;width:${Math.max(0.4, pct(p.end) - pct(p.start))}%"
       title="${escHtml(p.name)}: ${escHtml(fmtTime(p.start))} – ${escHtml(fmtTime(p.end))}"></div>`
  ).join("");

  const header = `
    <div class="tl-row tl-head">
      <div class="tl-name">Attendee</div>
      <div class="tl-track tl-axis">
        ${ticks.map(t => `<span class="tl-tick" style="left:${pct(t)}%">${escHtml(fmtTime(t))}</span>`).join("")}
        ${dayPeriods.map(p => `<span class="tl-period-label" style="left:${pct(p.start)}%;max-width:${Math.max(4, pct(p.end) - pct(p.start))}%"
            title="${escHtml(p.name)}">${escHtml(p.name)}</span>`).join("")}
      </div>
      <div class="tl-num">Exits</div>
      <div class="tl-num">Time out</div>
    </div>`;

  const body = pageRows.map(r => {
    const outs = r.intervals.map(i => {
      const label = i.open
        ? (isToday ? `Still out since ${fmtTime(i.start)}` : `Out from ${fmtTime(i.start)} until end of day`)
        : `Out ${fmtTime(i.start)} – ${fmtTime(i.end)} (${fmtDuration(i.end - i.start)})`;
      return `<div class="tl-out ${i.open ? "open" : ""}" style="left:${pct(i.start)}%;width:${Math.max(0.4, pct(i.end) - pct(i.start))}%"
        title="${escHtml(label)}"></div>`;
    }).join("");

    const periodName = id => _periods.find(p => p.id === id)?.name ?? "Period";
    const attMarks = r.att.map(l =>
      `<span class="tl-mark att" style="left:${pct(Date.parse(l.logged_at))}%"
        title="${escHtml(`Attendance taken — ${periodName(l.period_id)} at ${fmtTime(l.logged_at)}`)}"></span>`
    ).join("");

    const presMarks = r.presence.map(l => {
      const by = l.recorder?.name ? ` by ${l.recorder.name}` : "";
      return `<span class="tl-mark ${l.direction}" style="left:${pct(Date.parse(l.logged_at))}%"
        title="${escHtml(`${l.direction.toUpperCase()} at ${fmtTime(l.logged_at)}${by}${l.method === "manual" ? " (manual)" : ""}`)}"></span>`;
    }).join("");

    let timeOut = r.exits ? fmtDuration(r.totalOutMs) : "—";
    if (r.stillOut) {
      timeOut += isToday
        ? ` <span class="badge badge-danger" style="font-size:0.58rem">Still out</span>`
        : ` <span class="badge badge-warning" style="font-size:0.58rem">Didn't return</span>`;
    }

    return `
      <div class="tl-row">
        <div class="tl-name">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.name)}</div>
          <div class="text-xs text-faint" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(r.email)}</div>
        </div>
        <div class="tl-track">
          ${gridLines}
          ${periodBands}
          ${outs}
          ${attMarks}
          ${presMarks}
        </div>
        <div class="tl-num">${r.exits || "—"}</div>
        <div class="tl-num">${timeOut}</div>
      </div>`;
  }).join("");

  container.innerHTML = `
    <div class="table-wrap">
      <div class="tl" role="table" aria-label="IN/OUT timeline">
        ${header}
        ${body}
      </div>
    </div>`;

  renderPresencePagination(_presencePage, totalPages);
}

function renderPresencePagination(current, total) {
  const el = document.getElementById("presence-pagination");
  if (!el) return;
  if (total <= 1) { el.innerHTML = ""; return; }

  const pages = [];
  if (total <= 7) {
    for (let i = 1; i <= total; i++) pages.push(i);
  } else {
    pages.push(1);
    if (current > 3) pages.push("…");
    for (let i = Math.max(2, current - 1); i <= Math.min(total - 1, current + 1); i++) pages.push(i);
    if (current < total - 2) pages.push("…");
    pages.push(total);
  }

  el.innerHTML = `
    <button class="page-btn" onclick="setPresencePage(${current - 1})" ${current === 1 ? "disabled" : ""} aria-label="Previous page">
      <i class="ti ti-chevron-left"></i>
    </button>
    ${pages.map(p => p === "…"
      ? `<span style="width:30px;text-align:center;font-size:0.78rem;color:var(--color-text-muted)">…</span>`
      : `<button class="page-btn ${p === current ? "active" : ""}" onclick="setPresencePage(${p})" aria-label="Page ${p}">${p}</button>`
    ).join("")}
    <button class="page-btn" onclick="setPresencePage(${current + 1})" ${current === total ? "disabled" : ""} aria-label="Next page">
      <i class="ti ti-chevron-right"></i>
    </button>`;
}

function setPresencePage(page) {
  _presencePage = page;
  renderPresenceReport();
}

// ── CSV export (all days, one row per event) ──────────────────
function exportPresenceCSV() {
  if (!_presenceLoaded) { showToast("Load the IN/OUT report first.", "info"); return; }
  if (!_presenceLogs.length && !_attTakenLogs.length) { showToast("No IN/OUT data to export.", "info"); return; }

  const attById    = Object.fromEntries(_attendees.map(a => [a.user_id, a]));
  const periodById = Object.fromEntries(_periods.map(p => [p.id, p]));

  const events = [
    ..._attTakenLogs.map(l => ({
      attendee_id: l.attendee_id,
      at:     l.logged_at,
      type:   "Attendance taken",
      detail: periodById[l.period_id]?.name ?? "",
      method: l.method ?? "",
      by:     "",
    })),
    ..._presenceLogs.map(l => ({
      attendee_id: l.attendee_id,
      at:     l.logged_at,
      type:   l.direction.toUpperCase(),
      detail: "",
      method: l.method ?? "",
      by:     l.recorder?.name ?? "",
    })),
  ];

  const nameOf = id => attById[id]?.profiles?.name ?? "";
  events.sort((a, b) => nameOf(a.attendee_id).localeCompare(nameOf(b.attendee_id)) || Date.parse(a.at) - Date.parse(b.at));

  const headers = ["Name", "Email", "Code", "Date", "Time", "Event", "Period", "Method", "Recorded by"];
  const rows = events.map(e => {
    const a = attById[e.attendee_id];
    const d = new Date(e.at);
    return [
      a?.profiles?.name  ?? "",
      a?.profiles?.email ?? "",
      a?.qr_token        ?? "",
      localDayKey(d),
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      e.type,
      e.detail,
      e.method,
      e.by,
    ];
  });

  exportCSV(`in-out-${_event.name.replace(/\s+/g, "-")}-${localDayKey(new Date())}.csv`, headers, rows);
}

// ── Helpers ───────────────────────────────────────────────────
function fmtTime(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}

document.addEventListener("DOMContentLoaded", initPresenceReport);
