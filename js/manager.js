// ============================================================
//  EVENT MANAGER — manager.js
//  Manager dashboard: event list, stats, create/delete events
// ============================================================

let _events     = [];
let _profile    = null;
let _myEventIds = new Set(); // IDs of events I created (vs. assigned as taker only)

// ── Bootstrap ─────────────────────────────────────────────────
async function init() {
  const session = await requireAuth(["manager"]);
  if (!session) return;
  _profile = session.profile;

  populateSidebarUser(_profile);
  setPageTitle("Dashboard");

  await loadEvents();
  initCreateModal();
  initSearch();
}

// ── Load events ───────────────────────────────────────────────
async function loadEvents() {
  showTableSkeleton();

  // Find events where I'm assigned as a taker
  const { data: takerRows } = await _supabase
    .from("event_takers")
    .select("event_id")
    .eq("user_id", _profile.id);
  const takerEventIds = takerRows?.map(t => t.event_id) ?? [];

  let query = _supabase
    .from("events")
    .select(`
      id, name, description, start_date, end_date, status, created_at, created_by,
      periods(id),
      event_attendees(id),
      event_takers(id)
    `)
    .order("created_at", { ascending: false });

  if (takerEventIds.length) {
    query = query.or(`created_by.eq.${_profile.id},id.in.(${takerEventIds.join(",")})`);
  } else {
    query = query.eq("created_by", _profile.id);
  }

  const { data, error } = await query;

  if (error) {
    showToast("Failed to load events.", "error");
    console.error(error);
    return;
  }

  _events = data ?? [];
  _myEventIds = new Set(_events.filter(e => e.created_by === _profile.id).map(e => e.id));
  renderStats();
  renderTable(_events);
}

// ── Stats cards ───────────────────────────────────────────────
function renderStats() {
  const total    = _events.length;
  const active   = _events.filter(e => e.status === "active").length;
  const draft    = _events.filter(e => e.status === "draft").length;
  const closed   = _events.filter(e => e.status === "closed").length;

  setValue("stat-total",   total);
  setValue("stat-active",  active);
  setValue("stat-draft",   draft);
  setValue("stat-closed",  closed);
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ── Table ─────────────────────────────────────────────────────
function renderTable(events) {
  const tbody = document.getElementById("events-tbody");
  if (!tbody) return;

  if (!events.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6">
          <div class="table-empty">
            <i class="ti ti-calendar-off"></i>
            <p>No events yet. Create your first event to get started.</p>
            <button class="btn btn-primary btn-sm" onclick="openModal('create-modal')">
              <i class="ti ti-plus"></i> Create Event
            </button>
          </div>
        </td>
      </tr>`;
    return;
  }

  tbody.innerHTML = events.map(e => {
    const isOwner   = _myEventIds.has(e.id);
    const periods   = e.periods?.length          ?? 0;
    const attendees = e.event_attendees?.length  ?? 0;

    return `
    <tr>
      <td>
        <div style="font-weight:600;color:var(--nd-blue)">${escHtml(e.name)}</div>
        ${e.description
          ? `<div class="text-xs text-faint" style="margin-top:2px">${escHtml(e.description.slice(0, 60))}${e.description.length > 60 ? "…" : ""}</div>`
          : ""}
        ${!isOwner
          ? `<span class="badge badge-neutral" style="margin-top:4px;font-size:0.65rem"><i class="ti ti-user-scan"></i> Assigned as Taker</span>`
          : ""}
      </td>
      <td>${formatDate(e.start_date)}<br><span class="text-xs text-faint">${formatDate(e.end_date)}</span></td>
      <td><span class="badge ${statusBadge(e.status)}">${statusIcon(e.status)} ${e.status}</span></td>
      <td class="text-center">
        <span class="text-sm" style="font-weight:600">${periods}</span>
        <span class="text-xs text-faint"> periods</span>
      </td>
      <td class="text-center">
        <span class="text-sm" style="font-weight:600">${attendees}</span>
        <span class="text-xs text-faint"> attendees</span>
      </td>
      <td>
        <div class="td-actions">
          <a href="manager-event.html?id=${e.id}" class="btn btn-primary btn-sm btn-icon" title="Open event" aria-label="Open event">
            <i class="ti ti-arrow-right"></i>
          </a>
          ${isOwner ? `
          <button class="btn btn-outline btn-sm btn-icon" title="Duplicate event" aria-label="Duplicate event"
            onclick="duplicateEvent('${e.id}')">
            <i class="ti ti-copy"></i>
          </button>
          <button class="btn btn-danger btn-sm btn-icon" title="Delete event" aria-label="Delete event"
            onclick="confirmDelete('${e.id}', '${escHtml(e.name)}')">
            <i class="ti ti-trash"></i>
          </button>` : ""}
        </div>
      </td>
    </tr>`;
  }).join("");
}

function showTableSkeleton() {
  const tbody = document.getElementById("events-tbody");
  if (!tbody) return;
  tbody.innerHTML = Array.from({ length: 4 }, () => `
    <tr>
      ${Array.from({ length: 6 }, () =>
        `<td><div class="skeleton" style="height:18px;border-radius:4px;"></div></td>`
      ).join("")}
    </tr>`).join("");
}

function statusBadge(status) {
  return { draft: "badge-draft", active: "badge-active", closed: "badge-closed" }[status] ?? "badge-neutral";
}

function statusIcon(status) {
  return { draft: "✦", active: "●", closed: "◼" }[status] ?? "";
}

// ── Search / filter ───────────────────────────────────────────
function initSearch() {
  const searchIn  = document.getElementById("search-input");
  const filterSel = document.getElementById("status-filter");

  function applyFilters() {
    const q      = (searchIn?.value ?? "").toLowerCase();
    const status = filterSel?.value ?? "";
    const filtered = _events.filter(e => {
      const matchQ = !q || e.name.toLowerCase().includes(q) || (e.description ?? "").toLowerCase().includes(q);
      const matchS = !status || e.status === status;
      return matchQ && matchS;
    });
    renderTable(filtered);
  }

  searchIn?.addEventListener("input",  debounce(applyFilters, 200));
  filterSel?.addEventListener("change", applyFilters);
}

// ── Create event modal ────────────────────────────────────────
function initCreateModal() {
  const form = document.getElementById("create-form");
  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("create-submit-btn");

    const name      = document.getElementById("ev-name").value.trim();
    const desc      = document.getElementById("ev-desc").value.trim();
    const startDate = document.getElementById("ev-start").value;
    const endDate   = document.getElementById("ev-end").value;

    // Validate
    let valid = true;
    const nameErr  = document.getElementById("ev-name-error");
    const startErr = document.getElementById("ev-start-error");
    const endErr   = document.getElementById("ev-end-error");

    if (!name) {
      nameErr.style.display = "flex"; valid = false;
    } else { nameErr.style.display = "none"; }

    if (!startDate) {
      startErr.style.display = "flex"; valid = false;
    } else { startErr.style.display = "none"; }

    if (!endDate) {
      endErr.style.display = "flex"; valid = false;
    } else if (endDate < startDate) {
      endErr.textContent = "⚠ End date must be on or after start date.";
      endErr.style.display = "flex"; valid = false;
    } else { endErr.style.display = "none"; }

    if (!valid) return;

    setButtonLoading(btn, true);

    try {
      const { data, error } = await _supabase
        .from("events")
        .insert({
          name:        name,
          description: desc || null,
          start_date:  startDate,
          end_date:    endDate,
          status:      "draft",
          created_by:  _profile.id,
        })
        .select()
        .single();

      if (error) throw error;

      closeModal("create-modal");
      form.reset();
      showToast(`Event "${name}" created!`, "success");

      // Navigate directly to the new event page
      window.location.href = `manager-event.html?id=${data.id}`;
    } catch (err) {
      showToast(err.message ?? "Failed to create event.", "error");
      setButtonLoading(btn, false);
    }
  });
}

// ── Duplicate event ───────────────────────────────────────────
async function duplicateEvent(eventId) {
  const source = _events.find(e => e.id === eventId);
  if (!source) return;

  try {
    const { data, error } = await _supabase
      .from("events")
      .insert({
        name:        `${source.name} (Copy)`,
        description: source.description,
        start_date:  source.start_date,
        end_date:    source.end_date,
        status:      "draft",
        created_by:  _profile.id,
      })
      .select()
      .single();

    if (error) throw error;

    // Duplicate periods too
    const { data: periods } = await _supabase
      .from("periods")
      .select("name, period_date, sort_order")
      .eq("event_id", eventId);

    if (periods?.length) {
      await _supabase.from("periods").insert(
        periods.map(p => ({ ...p, event_id: data.id }))
      );
    }

    showToast("Event duplicated!", "success");
    await loadEvents();
  } catch (err) {
    showToast(err.message ?? "Failed to duplicate event.", "error");
  }
}

// ── Delete event ──────────────────────────────────────────────
function confirmDelete(eventId, eventName) {
  document.getElementById("delete-event-name").textContent = eventName;
  document.getElementById("delete-confirm-btn").onclick = () => deleteEvent(eventId);
  openModal("delete-modal");
}

async function deleteEvent(eventId) {
  const btn = document.getElementById("delete-confirm-btn");
  setButtonLoading(btn, true);

  try {
    const { error } = await _supabase
      .from("events")
      .delete()
      .eq("id", eventId);

    if (error) throw error;

    closeModal("delete-modal");
    showToast("Event deleted.", "success");
    await loadEvents();
  } catch (err) {
    showToast(err.message ?? "Failed to delete event.", "error");
    setButtonLoading(btn, false);
  }
}

// ── Sort table ────────────────────────────────────────────────
let _sortKey = "created_at";
let _sortAsc = false;

function sortBy(key) {
  if (_sortKey === key) { _sortAsc = !_sortAsc; }
  else { _sortKey = key; _sortAsc = true; }

  const sorted = [..._events].sort((a, b) => {
    let av = a[key] ?? "";
    let bv = b[key] ?? "";
    if (typeof av === "string") av = av.toLowerCase();
    if (typeof bv === "string") bv = bv.toLowerCase();
    if (av < bv) return _sortAsc ? -1 : 1;
    if (av > bv) return _sortAsc ?  1 : -1;
    return 0;
  });

  // Update sort indicators
  document.querySelectorAll("[data-sort]").forEach(th => {
    th.querySelector(".sort-icon")?.remove();
    if (th.dataset.sort === key) {
      th.insertAdjacentHTML("beforeend",
        `<i class="ti ti-chevron-${_sortAsc ? "up" : "down"} sort-icon" style="font-size:12px;margin-left:4px;"></i>`);
    }
  });

  renderTable(sorted);
}

// ── Sign out ──────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("signout-btn")?.addEventListener("click", signOut);
  init();
});
