const graphExplorerState = {
  section: "plans", search: "", filter: "all", sort: "name",
  page: 1, pageSize: 24, calendarView: "month", employeeView: "table",
  calendarDate: null,
  fromOverview: null, // { section, label, meetingKey?, scrolled } when opened from the Overview "Today" strip
};

const graphEmployeeState = {
  query: "",
  employeeId: null,
  tab: "overview",
  calendarDate: null,
};

function graphTasks() {
  return (graphData?.planner?.plans || []).flatMap(plan =>
    (plan.tasks || []).map(task => ({ ...task, plan }))
  );
}

function graphEvents() {
  return (graphData?.employees || []).flatMap(employee =>
    (employee.calendar?.items || []).map(event => ({ ...event, employee }))
  );
}

// Graph gives each attendee their own copy of a meeting (own id, own mailbox), so there's no
// shared meeting id to group on. Organizer+start+end+subject is the practical key to recognize
// "this is the same meeting" across everyone's separately-synced calendars.
function graphNameKey(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Outlook can store one attendee's personal copy of a meeting with a prefixed subject
// ("Following: Team Sync") instead of the real title — strip that so it still groups with
// everyone else's copy of the same meeting instead of showing up as its own 1-person meeting.
const GRAPH_SUBJECT_PREFIX_RE = /^(Following|Canceled|Cancelled|Declined|Tentative|Accepted|Updated|FW|Fwd):\s*/i;
function graphCleanSubject(subject) {
  return String(subject || "").replace(GRAPH_SUBJECT_PREFIX_RE, "").trim();
}

function graphMeetingGroups() {
  const groups = new Map();
  graphEvents().forEach(event => {
    if (event.isCancelled || event.isAllDay) return;
    const cleanSubject = graphCleanSubject(event.subject);
    const isPrefixed = cleanSubject !== event.subject;
    const key = `${event.organizer}|${event.start}|${event.end}|${cleanSubject}`;
    if (!groups.has(key)) {
      groups.set(key, {
        subject: event.subject, subjectIsClean: !isPrefixed, start: event.start, end: event.end,
        organizer: event.organizer, location: event.location,
        meetingLink: event.meetingLink, webLink: event.webLink,
        attendees: event.attendees || [], entries: [],
      });
    }
    const group = groups.get(key);
    group.entries.push(event);
    if ((event.attendees || []).length > group.attendees.length) group.attendees = event.attendees;
    if (!group.subjectIsClean && !isPrefixed) {
      group.subject = event.subject;
      group.subjectIsClean = true;
    }
  });
  return [...groups.values()];
}

function graphLiveMeetings() {
  const now = Date.now();
  return graphMeetingGroups()
    .map(group => ({ ...group, startMs: new Date(group.start).getTime(), endMs: new Date(group.end).getTime() }))
    .filter(group => group.startMs <= now && now <= group.endMs)
    .sort((a, b) => a.endMs - b.endMs);
}

// Each attendee's own status comes from cross-referencing their own calendar copy of this same
// meeting (matched by name). Anyone invited but not tracked in the system shows as "unknown"
// rather than a guessed status.
function graphMeetingAttendeeRows(meeting, allLiveMeetings) {
  const statusByKey = new Map();
  meeting.entries.forEach(entry => {
    const key = graphNameKey(entry.employee?.name);
    if (key) statusByKey.set(key, { status: entry.showAs || "unknown", employee: entry.employee });
  });
  const doubleBookedKeys = new Set();
  allLiveMeetings.forEach(other => {
    if (other === meeting) return;
    other.entries.forEach(entry => {
      const key = graphNameKey(entry.employee?.name);
      if (statusByKey.has(key) && (entry.showAs === "busy" || entry.showAs === "tentative")) {
        doubleBookedKeys.add(key);
      }
    });
  });
  return (meeting.attendees.length ? meeting.attendees : [...statusByKey.values()].map(v => v.employee?.name)).map(name => {
    const key = graphNameKey(name);
    const own = statusByKey.get(key);
    return {
      name,
      status: own ? own.status : "unknown",
      employee: own?.employee || null,
      doubleBooked: doubleBookedKeys.has(key),
    };
  });
}

function graphLiveTimeLeft(endMs) {
  const mins = Math.max(0, Math.round((endMs - Date.now()) / 60000));
  if (mins < 1) return "ending now";
  if (mins < 60) return `${mins} min left`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m left`;
}

function graphInitials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase();
}

function graphLiveNameToken(row) {
  return row.employee
    ? `<button type="button" class="graph-live-flag-name" data-graph-employee="${escapeHtml(row.employee.id)}">${escapeHtml(row.name)}</button>`
    : `<span class="graph-live-flag-name-plain">${escapeHtml(row.name)}</span>`;
}

// Stable id for a meeting: same subject + start time on the Overview and the Graph page.
function graphMeetingKey(meeting) {
  return `${meeting.subject}|${new Date(meeting.start).getTime()}`;
}

function renderGraphLiveCard(meeting, allLiveMeetings) {
  const rows = graphMeetingAttendeeRows(meeting, allLiveMeetings);
  const notAttending = rows.filter(row => row.status === "free");
  const doubleBooked = rows.filter(row => row.doubleBooked);
  const counts = { busy: 0, tentative: 0, free: 0, unknown: 0 };
  rows.forEach(row => { counts[row.status] = (counts[row.status] || 0) + 1; });
  const startLabel = new Date(meeting.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const endLabel = new Date(meeting.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const key = graphMeetingKey(meeting);
  const isTarget = graphExplorerState.fromOverview?.meetingKey === key;
  return `<div class="graph-live-card${isTarget ? " graph-from-target" : ""}" data-meeting-key="${escapeHtml(key)}" role="button" tabindex="0" title="Show meeting details">
    <div class="graph-live-top">
      <div>
        <p class="graph-live-subject">${escapeHtml(meeting.subject)}${isTarget ? `<span class="graph-from-badge">You clicked this</span>` : ""}</p>
        <div class="graph-live-meta">
          <span>Organizer: ${escapeHtml(meeting.organizer)}</span>
          <span>${startLabel} – ${endLabel}</span>
          ${meeting.meetingLink ? `<a href="${escapeHtml(meeting.meetingLink)}" target="_blank" rel="noopener noreferrer">Join in Teams →</a>` : ""}
        </div>
      </div>
      <span class="graph-live-timeleft">${graphLiveTimeLeft(meeting.endMs)}</span>
    </div>
    ${notAttending.length ? `<div class="graph-live-flag not-attending">
      <span aria-hidden="true">🚩</span><b>Not attending:</b>
      <span class="graph-live-flag-names">${notAttending.map(graphLiveNameToken).join("")}</span>
      <span class="graph-live-flag-note">marked free despite the invite</span>
    </div>` : ""}
    ${doubleBooked.length ? `<div class="graph-live-flag double-booked">
      <span aria-hidden="true">⚠️</span><b>Double-booked:</b>
      <span class="graph-live-flag-names">${doubleBooked.map(graphLiveNameToken).join("")}</span>
      <span class="graph-live-flag-note">also invited to another meeting happening now</span>
    </div>` : ""}
    <div class="graph-live-summary">
      <span><b>${counts.busy}</b> busy</span>
      <span><b>${counts.tentative}</b> tentative</span>
      <span><b>${counts.free}</b> marked free</span>
      <span><b>${counts.unknown}</b> not tracked</span>
    </div>
    <div class="graph-live-attendees">
      ${rows.map(row => `<button type="button" class="graph-live-chip status-${row.status}"
          ${row.employee ? `data-graph-employee="${escapeHtml(row.employee.id)}"` : "disabled"}>
          <span class="graph-live-avatar">${escapeHtml(graphInitials(row.name))}</span>${escapeHtml(row.name)}
          ${row.doubleBooked ? `<i class="graph-live-conflict" aria-hidden="true">⚠️</i>` : ""}
          <i class="graph-live-dot-status" aria-hidden="true"></i>
        </button>`).join("")}
    </div>
  </div>`;
}

function renderGraphLive() {
  const allLive = graphLiveMeetings();
  const matching = allLive.filter(meeting => graphSearch(meeting.subject, meeting.organizer));
  const rows = matching.filter(meeting => {
    if (graphExplorerState.filter !== "flagged") return true;
    const attendeeRows = graphMeetingAttendeeRows(meeting, allLive);
    return attendeeRows.some(row => row.status === "free" || row.doubleBooked);
  });
  document.getElementById("graphPagination").innerHTML =
    `<span>${rows.length} meeting${rows.length === 1 ? "" : "s"} in progress</span>`;
  if (!rows.length) {
    document.getElementById("graphWorkspace").innerHTML = `
      <div class="graph-empty-state">
        <span aria-hidden="true">◷</span>
        <h3>Nothing live right now</h3>
        <p>No meetings are currently in progress across the calendars this system tracks.</p>
      </div>`;
    return;
  }
  document.getElementById("graphWorkspace").innerHTML =
    `<div class="graph-live-list">${rows.map(meeting => renderGraphLiveCard(meeting, allLive)).join("")}</div>`;
  document.querySelectorAll("[data-graph-employee]").forEach(el => {
    el.onclick = (event) => { event.stopPropagation(); openGraphEmployeeDrawer(el.dataset.graphEmployee); };
  });
  // Clicking anywhere else on a live meeting card opens its details (time, organizer, location,
  // Join in Teams / Outlook, and everyone invited with their status). Links keep working as links.
  document.querySelectorAll(".graph-live-card[data-meeting-key]").forEach(card => {
    const meeting = rows.find(m => graphMeetingKey(m) === card.dataset.meetingKey);
    if (!meeting) return;
    card.onclick = (event) => { if (!event.target.closest("a")) openMeetingDetailsDrawer(meeting); };
    card.onkeydown = (event) => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openMeetingDetailsDrawer(meeting); }
    };
  });
}


function graphHue(index) {
  return `hsl(${(index * 137.508 + 205) % 360} 68% 46%)`;
}

function graphEmpty(titleText, message) {
  document.getElementById("graphPagination").innerHTML = "";
  document.getElementById("graphWorkspace").innerHTML = `
    <div class="graph-empty-state">
      <span aria-hidden="true">⌕</span>
      <h3>${escapeHtml(titleText)}</h3>
      <p>${escapeHtml(message)}</p>
    </div>`;
}

function handleGraphKeyboard(event) {
  if (event.key === "Escape" && !document.getElementById("graphDrawerOverlay")?.hidden) closeGraphDrawer();
  const graphOpen = document.getElementById("graph")?.classList.contains("active-view");
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  if (event.key === "/" && graphOpen && !typing) {
    event.preventDefault();
    document.getElementById("graphEmployeeSearch")?.focus();
  }
}

function graphCalendarBase() {
  const value = graphExplorerState.calendarDate || graphData?.meta?.periodStart || new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function graphDate(value) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

function graphDateTime(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function graphStatus(task) {
  const raw = String(task.status || "").toLowerCase();
  const status = raw === "completed" || Number(task.percentComplete) === 100 ? "Completed"
    : raw.includes("progress") || Number(task.percentComplete) > 0 ? "In Progress" : "Not Started";
  return status !== "Completed" && task.dueDateTime && new Date(task.dueDateTime) < new Date()
    ? "Overdue" : status;
}

function graphPriority(value) {
  const priority = Number(value);
  if (priority <= 2) return "Urgent";
  if (priority <= 4) return "High";
  if (priority <= 6) return "Medium";
  return "Low";
}

function graphSearch(...values) {
  const query = graphExplorerState.search.trim().toLowerCase();
  return !query || values.some(value => String(value || "").toLowerCase().includes(query));
}

function graphSkeleton() {
  document.getElementById("graphSummaryCards").innerHTML =
    Array.from({ length: 7 }, () => '<div class="graph-skeleton gx-skel-item"></div>').join("");
  document.getElementById("graphWorkspace").innerHTML =
    Array.from({ length: 8 }, () => '<div class="graph-skeleton graph-skeleton-row"></div>').join("");
}

async function renderGraph() {
  graphSkeleton();
  try {
    const response = await apiFetch("/api/graph-data");
    // /api/graph-data isn't scoped on the server yet; keep the 360° search to this user's people.
    graphData = scopeGraphData(await response.json());
    setupGraphExplorer();
    renderGraphExplorer();
    if (typeof renderTodayBriefing === "function") renderTodayBriefing();
    // Auto-open logged-in user's profile in Matched Employees
    const email = (typeof loggedInUserEmail !== "undefined" ? loggedInUserEmail : "").toLowerCase();
    const meNorm = (typeof loggedInUserName !== "undefined" ? loggedInUserName : "").trim().toLowerCase();
    const match = (graphData?.employees || []).find(e =>
      (email && (e.email || "").toLowerCase() === email) ||
      (meNorm && e.name.trim().toLowerCase() === meNorm)
    );
    if (match) showEmployeeWorkspace(match);
  } catch {
    document.getElementById("graphRefreshLabel").textContent = "Graph data is not available yet";
  }
}

async function refreshGraph() {
  const label = document.getElementById("graphRefreshLabel");
  const button = document.getElementById("graphRefreshButton");
  const picker = document.getElementById("graphMonthPicker");
  const month = picker?.value || "";
  label.textContent = month ? `Fetching ${month}...` : "Refreshing Microsoft Graph...";
  if (button) button.disabled = true;
  try {
    const body = month ? JSON.stringify({ month }) : "{}";
    const response = await apiFetch("/api/refresh-graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!response || !response.ok) throw new Error("Graph refresh failed");
    const result = await response.json();
    if (result.status !== "refreshed") throw new Error(result.stderr || "Refresh failed");
    graphData = scopeGraphData(result.graph);
    renderGraphExplorer();
    if (typeof renderTodayBriefing === "function") renderTodayBriefing();
    label.innerHTML = result.generatedAt ? CLOCK_SVG + formatRefreshTimestamp(result.generatedAt, "Updated") : "Updated";
  } catch (error) {
    label.textContent = `Refresh failed: ${error.message}`;
  } finally {
    if (button) button.disabled = false;
  }
}

function setupGraphExplorer() {
  document.querySelectorAll(".graph-subnav-item").forEach(button => {
    button.onclick = () => setGraphSection(button.dataset.graphSection);
  });
  document.getElementById("graphDrawerClose").onclick = closeGraphDrawer;
  document.getElementById("graphDrawerOverlay").onclick = event => {
    if (event.target.id === "graphDrawerOverlay") closeGraphDrawer();
  };
  const employeeSearch = document.getElementById("graphEmployeeSearch");
  const employeeClear = document.getElementById("graphEmployeeSearchClear");
  employeeSearch.oninput = () => renderEmployeeSearchSuggestions(employeeSearch.value);
  employeeSearch.onkeydown = event => {
    if (event.key === "Enter") {
      const matches = findGraphEmployees(employeeSearch.value);
      graphEmployeeState.query = employeeSearch.value.trim();
      if (matches.length === 1) showEmployeeWorkspace(matches[0]);
      else showEmployeeSearchResults(graphEmployeeState.query);
    }
  };
  employeeClear.onclick = clearEmployeeWorkspaceSearch;
  document.removeEventListener("keydown", handleGraphKeyboard);
  document.addEventListener("keydown", handleGraphKeyboard);
}

function findGraphEmployees(query) {
  const wanted = String(query || "").trim().toLowerCase();
  if (!wanted) return [];
  return [...(graphData?.employees || [])]
    .filter(employee => [employee.name, employee.id, employee.email, employee.team]
      .some(value => String(value || "").toLowerCase().includes(wanted)))
    .sort((a, b) => {
      const aExact = [a.id, a.email, a.name].some(value => String(value || "").toLowerCase() === wanted);
      const bExact = [b.id, b.email, b.name].some(value => String(value || "").toLowerCase() === wanted);
      return Number(bExact) - Number(aExact) || a.name.localeCompare(b.name);
    });
}

function renderEmployeeSearchSuggestions(query) {
  const suggestions = document.getElementById("graphEmployeeSuggestions");
  const clear = document.getElementById("graphEmployeeSearchClear");
  clear.hidden = !query;
  if (String(query).trim().length < 2) {
    suggestions.hidden = true;
    return;
  }
  const matches = findGraphEmployees(query).slice(0, 8);
  suggestions.innerHTML = matches.length ? matches.map(employee => `
    <button type="button" data-search-employee="${escapeHtml(employee.id)}">
      <span class="graph-person-avatar">${escapeHtml(employee.name?.[0] || "?")}</span>
      <span><strong>${escapeHtml(employee.name)}</strong><small>${escapeHtml(employee.id)} · ${escapeHtml(employee.team)} · ${escapeHtml(employee.email || "No Microsoft 365 email")}</small></span>
      <i class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Matched" : "Unmatched"}</i>
    </button>`).join("") : '<p>No employee found. Try the employee ID or email.</p>';
  suggestions.hidden = false;
  suggestions.querySelectorAll("[data-search-employee]").forEach(button => {
    button.onclick = () => {
      const employee = (graphData?.employees || []).find(item => item.id === button.dataset.searchEmployee);
      graphEmployeeState.query = query.trim();
      if (employee) showEmployeeWorkspace(employee);
    };
  });
}

function clearEmployeeWorkspaceSearch() {
  document.getElementById("graphEmployeeSearch").value = "";
  document.getElementById("graphEmployeeSearchClear").hidden = true;
  document.getElementById("graphEmployeeSuggestions").hidden = true;
  renderGraphExplorer();
}

function employeeRelevantSites(employee) {
  const team = String(employee.team || "").toLowerCase();
  const terms = team.split(/[^a-z0-9]+/).filter(term => term.length > 2);
  const sites = graphData?.sharePoint?.sites || [];
  const relevant = sites.filter(site => {
    const haystack = `${site.displayName} ${site.webUrl}`.toLowerCase();
    return terms.some(term => haystack.includes(term));
  });
  return (relevant.length ? relevant : sites).slice(0, 6);
}

function graphEmployeeManager(employee) {
  const sourceEmployee = (typeof dataset !== "undefined" ? dataset?.employees : [])
    ?.find(item => item.id === employee.id);
  return sourceEmployee?.managerName || employee.managerName || "Not available";
}

function employeePlans(employee) {
  const tasks = employee.planner?.tasks || [];
  const planIds = new Set(tasks.map(task => task.planId).filter(Boolean));
  return (graphData?.planner?.plans || [])
    .filter(plan => planIds.has(plan.id))
    .map(plan => ({
      ...plan,
      tasks: tasks.filter(task => task.planId === plan.id),
    }));
}

function renderEmployeeContextHeader(employee, titleText = "Employee 360°") {
  document.getElementById("graphSectionHeader").innerHTML = `
    <div class="graph-section-icon graph-section-employees" aria-hidden="true">${escapeHtml(employee.name?.[0] || "E")}</div>
    <div>
      <p class="eyebrow">Microsoft 365 employee workspace</p>
      <h2>${escapeHtml(titleText)}</h2>
      <p>All records shown below are scoped to ${escapeHtml(employee.name)}.</p>
    </div>
    <span class="graph-live-badge"><i></i>Employee filtered</span>`;
}

function employeeProfileHeader(employee) {
  const initials = String(employee.name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const status = employee.teams?.status || "";
  const tone = /available/i.test(status) ? "ok" : /away|brb/i.test(status) ? "away" : /busy|dnd|call|meeting/i.test(status) ? "busy" : "off";
  return `
    <header class="graph-profile-hero e360-prof">
      <div class="e360-avatar" aria-hidden="true">${escapeHtml(initials)}</div>
      <div class="e360-who">
        <h2>${escapeHtml(employee.name)}
          <span class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Microsoft 365 matched" : "Unmatched"}</span></h2>
        <div class="e360-facts">
          <span>ID <b>${escapeHtml(employee.id)}</b></span>
          <span><b>${escapeHtml(employee.designation || "Designation not available")}</b></span>
          <span>${escapeHtml(employee.team || "Department not available")}</span>
          <span>${escapeHtml(employee.email || "No Microsoft 365 email")}</span>
          <span>Reports to <b>${escapeHtml(graphEmployeeManager(employee))}</b></span>
        </div>
      </div>
      ${status ? `<span class="e360-presence ${tone}"><i></i>Teams · ${escapeHtml(status)}</span>` : ""}
    </header>`;
}

function employeeTabs(employee, activeTab) {
  const tasks = employee.planner?.tasks || [];
  const tabs = [
    ["overview", "Overview", null],
    ["plans", "Plans", employeePlans(employee).length],
    ["tasks", "Tasks", tasks.length],
    ["completed", "Completed", tasks.filter(task => graphStatus(task) === "Completed").length],
    ["calendar", "Calendar", employee.calendar?.items?.length || 0],
    ["sites", "SharePoint", employeeRelevantSites(employee).length],
  ];
  return `<nav class="graph-employee-tabs e360-tabs" aria-label="Employee Microsoft 365 data">${tabs.map(([id, label, count]) => `
    <button type="button" data-employee-tab="${id}" class="${activeTab === id ? "active" : ""}">
      ${escapeHtml(label)}${count != null ? `<small>${count}</small>` : ""}
    </button>`).join("")}</nav>`;
}

function bindEmployeeTabs(employee) {
  document.querySelectorAll("[data-employee-tab]").forEach(button => {
    button.onclick = () => button.dataset.employeeTab === "overview"
      ? showEmployeeWorkspace(employee)
      : renderEmployeeOption(employee, button.dataset.employeeTab);
  });
}

function attendancePeriod() {
  return graphData?.meta?.attendancePeriod
    || (typeof dataset !== "undefined" ? dataset?.meta?.period : "")
    || "";
}

function attendanceMonthValue() {
  return attendancePeriod().match(/\d{4}-\d{2}/)?.[0]
    || new Date().toISOString().slice(0, 7);
}

function attendanceMonthLabel() {
  const month = attendanceMonthValue();
  const date = new Date(`${month}-01T00:00:00`);
  return Number.isNaN(date.getTime())
    ? attendancePeriod() || "Period unavailable"
    : date.toLocaleDateString([], { month: "long", year: "numeric" });
}

async function loadEmployeeAttendanceMonth(employee) {
  const input = document.getElementById("graphAttendanceMonth");
  const button = document.getElementById("graphAttendanceLoad");
  const status = document.getElementById("graphAttendanceStatus");
  const month = input?.value;
  if (!month || !button || !status) return;
  button.disabled = true;
  input.disabled = true;
  status.className = "graph-attendance-status loading";
  status.textContent = `Fetching attendance for ${new Date(`${month}-01T00:00:00`).toLocaleDateString([], { month: "long", year: "numeric" })}…`;
  try {
    const response = await apiFetch("/api/attendance-month", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month, employeeId: employee.id }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || payload.error || "Attendance refresh failed");
    employee.attendance = payload.employee?.attendance || {};
    employee.kpi = payload.employee?.kpi;
    employee.band = payload.employee?.band;
    graphData.meta.attendancePeriod = payload.period;
    if (typeof dataset !== "undefined" && dataset?.meta) dataset.meta.period = payload.period;
    status.className = "graph-attendance-status success";
    status.textContent = `Loaded ${attendanceMonthLabel()} attendance successfully.`;
    showEmployeeWorkspace(employee);
  } catch (error) {
    status.className = "graph-attendance-status error";
    status.textContent = error.message;
    button.disabled = false;
    input.disabled = false;
  }
}

function showEmployeeSearchResults(query = graphEmployeeState.query) {
  const matches = findGraphEmployees(query);
  graphEmployeeState.query = query;
  graphEmployeeState.employeeId = null;
  document.getElementById("graphEmployeeSuggestions").hidden = true;
  document.getElementById("graphBreadcrumbs").textContent = `Microsoft Graph / Employee 360° / Search results`;
  document.querySelectorAll(".graph-subnav-item, .gx-rail-item").forEach(button => button.classList.remove("active"));
  document.getElementById("graphToolbar").innerHTML = `
    <div class="graph-profile-toolbar">
      <span>${matches.length} matching employee${matches.length === 1 ? "" : "s"} for “${escapeHtml(query)}”</span>
      <button type="button" id="backToGraphExplorer">Back to explorer</button>
    </div>`;
  document.getElementById("graphPagination").innerHTML = "";
  document.getElementById("graphSectionHeader").innerHTML = `
    <div class="graph-section-icon graph-section-employees">E</div>
    <div><p class="eyebrow">Employee 360° search</p><h2>Matching employees</h2>
    <p>Select an employee to open their filtered Microsoft 365 workspace.</p></div>`;
  document.getElementById("graphWorkspace").innerHTML = matches.length ? `
    <div class="graph-search-result-grid">${matches.map(employee => `
      <button type="button" class="graph-search-result-card" data-result-employee="${escapeHtml(employee.id)}">
        <span class="graph-person-avatar">${escapeHtml(employee.name?.[0] || "?")}</span>
        <span><strong>${escapeHtml(employee.name)}</strong>
          <small>${escapeHtml(employee.id)} · ${escapeHtml(employee.designation || "Designation unavailable")}</small>
          <small>${escapeHtml(employee.team || "Department unavailable")} · ${escapeHtml(employee.email || "No Microsoft 365 email")}</small>
        </span>
        <i class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Matched" : "Unmatched"}</i>
      </button>`).join("")}</div>` : `
    <div class="graph-empty-state"><span>⌕</span><h3>No employee found</h3>
    <p>Try a full or partial employee name, employee ID, or Microsoft 365 email.</p></div>`;
  document.getElementById("backToGraphExplorer").onclick = clearEmployeeWorkspaceSearch;
  document.querySelectorAll("[data-result-employee]").forEach(button => {
    button.onclick = () => {
      const employee = (graphData?.employees || []).find(item => item.id === button.dataset.resultEmployee);
      if (employee) showEmployeeWorkspace(employee);
    };
  });
}

function graphDataCoverage(employee) {
  const sources = [
    { name: "Planner", has: (employee.planner?.assigned || 0) > 0 },
    { name: "Calendar", has: (employee.calendar?.events || 0) > 0 },
    { name: "Attendance", has: (employee.attendance?.present || 0) > 0 || (employee.attendance?.absent || 0) > 0 },
    { name: "Teams", has: (employee.teams?.messagesCount || 0) > 0 || (employee.teams?.meetingCount || 0) > 0 },
  ];
  const matched = sources.filter(s => s.has).map(s => s.name);
  const missing = sources.filter(s => !s.has).map(s => s.name);
  return { matchedCount: matched.length, total: sources.length, matched, missing };
}

// Employee 360° Overview: four KPI tiles + two report-style panels + a sources footer.
// Keeps the attendance-month fetch (same element IDs as before, used by loadEmployeeAttendanceMonth).
function employeeOverviewHtml(employee) {
  const a = employee.attendance || {}, p = employee.planner || {}, t = employee.teams || {}, c = employee.calendar || {};
  const coverage = graphDataCoverage(employee);
  const clock = h => (h == null ? "—" : (typeof formatCheckinHour === "function" ? formatCheckinHour(h) : String(h)));
  const working = Math.max(1, (a.calendarDays || 0) - (a.off || 0) - (a.holidays || 0)
    || (a.present || 0) + (a.absent || 0) + (a.leave || 0));
  const attPct = Math.min(100, Math.round(((a.present || 0) / working) * 100));
  const donePct = p.assigned ? Math.round(((p.completed || 0) / p.assigned) * 100) : 0;
  const tile = (label, value, sub, pct) => `<div class="e360-tile"><div class="e360-label">${label}</div>
    <div class="e360-value">${value}</div><div class="e360-sub">${sub}</div>
    ${pct != null ? `<div class="e360-meter"><i style="width:${pct}%"></i></div>` : ""}</div>`;
  const row = (label, value, cls = "") => `<div class="e360-row ${cls}"><span>${label}</span><b>${value}</b></div>`;
  const sources = [["Planner"], ["Calendar"], ["Attendance"], ["Teams"]]
    .map(([name]) => `<em class="${coverage.matched.includes(name) ? "" : "off"}">${name}</em>`).join(", ");
  return `
      <section class="graph-employee-overview e360">
        <div class="e360-head">
          <div>
            <h3>Overview</h3>
            <p>Attendance period: ${escapeHtml(attendanceMonthLabel())}${attendancePeriod() ? ` (${escapeHtml(attendancePeriod())})` : ""} · Microsoft 365 activity: current month</p>
          </div>
          <div class="e360-month">
            <input id="graphAttendanceMonth" type="month" value="${attendanceMonthValue()}" max="${new Date().toISOString().slice(0, 7)}" aria-label="Attendance month">
            <button type="button" id="graphAttendanceLoad">Fetch month</button>
          </div>
        </div>
        <span id="graphAttendanceStatus" class="graph-attendance-status" aria-live="polite"></span>
        <div class="e360-tiles">
          ${tile("Attendance rate", `${attPct}%`, `${a.present || 0} of ${working} working days present`, attPct)}
          ${tile("Average check-in", escapeHtml(clock(a.avgCheckinHour)), `Check-out ${escapeHtml(clock(a.avgCheckoutHour))} · biometric`)}
          ${tile("Task completion", `${donePct}%`, `${p.completed || 0} of ${p.assigned || 0} Planner tasks${p.overdueOpen ? ` · <span class="e360-bad">${p.overdueOpen} overdue</span>` : ""}`, donePct)}
          ${tile("Meeting time", `${c.meetingHours || 0} h`, `${c.events || 0} calendar meetings this month`)}
        </div>
        <div class="e360-panels">
          <section class="e360-panel">
            <h4>Attendance &amp; time</h4>
            ${row("Present", `${a.present || 0} days`)}
            ${row("Absent", `${a.absent || 0} day${a.absent === 1 ? "" : "s"}`, a.absent ? "warn" : "")}
            ${row("Leave", `${a.leave || 0} days`)}
            ${row("Week off / holidays", `${a.off || 0} / ${a.holidays || 0}`)}
            ${row("Biometric days", a.biometricDays ?? "—")}
            ${row("Average office hours", a.avgOfficeHours != null ? `${a.avgOfficeHours} h per day` : "—")}
            ${row("Office location", escapeHtml(a.officeLocation || "—"))}
          </section>
          <section class="e360-panel">
            <h4>Work &amp; collaboration</h4>
            ${row("Planner tasks", `${p.assigned || 0} assigned · ${p.completed || 0} completed`)}
            ${row("In progress / not started", `${p.inProgress || 0} / ${p.notStarted || 0}`)}
            ${row("Overdue (open)", p.overdueOpen || 0, p.overdueOpen ? "bad" : "")}
            ${row("On-time completion", p.onTimeRate != null ? `${p.onTimeRate}%` : "—")}
            ${row("Teams messages", Number(t.messagesCount || 0).toLocaleString())}
            ${row("Teams meetings / calls", `${t.meetingCount || 0} / ${t.callCount || 0}`)}
            ${row("Teams status", escapeHtml(t.status || "Unknown"))}
          </section>
        </div>
        <div class="e360-foot">
          <span><b>Performance band:</b> ${escapeHtml(employee.band || "—")} · KPI ${employee.kpi ?? "not scored"}</span>
          <span><b>Data sources:</b> ${coverage.matchedCount} of ${coverage.total} matched — ${sources}</span>
        </div>
      </section>`;
}

function showEmployeeWorkspace(employee) {
  graphEmployeeState.employeeId = employee.id;
  graphEmployeeState.tab = "overview";
  document.getElementById("graphEmployeeSuggestions").hidden = true;
  document.getElementById("graphEmployeeSearch").value = employee.name;
  document.getElementById("graphEmployeeSearchClear").hidden = false;
  document.getElementById("graphBreadcrumbs").textContent = `Microsoft Graph / Employee 360° / ${employee.name}`;
  document.querySelectorAll(".graph-subnav-item, .gx-rail-item").forEach(button => button.classList.remove("active"));
  renderEmployeeContextHeader(employee);
  document.getElementById("graphToolbar").innerHTML = `
    <div class="graph-profile-toolbar">
      <button type="button" id="employeeSearchBack">← Back to search results</button>
      <span>Unified Microsoft 365 employee record</span>
    </div>`;
  document.getElementById("graphPagination").innerHTML = "";
  document.getElementById("graphWorkspace").innerHTML = `
    <article class="graph-employee-profile">
      ${employeeProfileHeader(employee)}
      ${employeeTabs(employee, "overview")}
      ${employeeOverviewHtml(employee)}
    </article>`;
  document.getElementById("employeeSearchBack").onclick = () =>
    showEmployeeSearchResults(graphEmployeeState.query || employee.name);
  document.getElementById("graphAttendanceLoad").onclick = () => loadEmployeeAttendanceMonth(employee);
  bindEmployeeTabs(employee);
}

function renderEmployeeOption(employee, tab, dateKey = null) {
  graphEmployeeState.tab = tab;
  renderEmployeeContextHeader(employee, `${employee.name} / ${({
    plans: "Planner Plans", tasks: "Planner Tasks", completed: "Completed Tasks",
    calendar: "Calendar", sites: "SharePoint Sites",
  })[tab]}`);
  document.getElementById("graphBreadcrumbs").textContent =
    `Microsoft Graph / Employee 360° / ${employee.name} / ${tab === "sites" ? "SharePoint Sites" : title(tab)}`;
  document.getElementById("graphToolbar").innerHTML = `
    <div class="graph-profile-toolbar">
      <button type="button" id="employeeOptionBack">← Back to employee profile</button>
      <span>${escapeHtml(employee.name)} · employee-filtered records</span>
    </div>`;
  document.getElementById("graphPagination").innerHTML = "";
  const workspace = document.getElementById("graphWorkspace");
  workspace.innerHTML = `
    <article class="graph-employee-profile graph-employee-option">
      ${employeeProfileHeader(employee)}
      ${employeeTabs(employee, tab)}
      <section id="graphEmployeeOptionContent" class="graph-employee-option-content"></section>
    </article>`;
  document.getElementById("employeeOptionBack").onclick = () => showEmployeeWorkspace(employee);
  bindEmployeeTabs(employee);
  if (tab === "plans") renderEmployeePlans(employee);
  if (tab === "tasks") renderEmployeeTasks(employee, false);
  if (tab === "completed") renderEmployeeTasks(employee, true);
  if (tab === "calendar") renderEmployeeCalendar(employee, dateKey);
  if (tab === "sites") renderEmployeeSites(employee);
}

function employeeOptionEmpty(message) {
  return `<div class="graph-empty-state compact"><span>⌕</span><h3>${escapeHtml(message)}</h3>
    <p>No employee-specific records are available from Microsoft Graph.</p></div>`;
}

function renderEmployeePlans(employee) {
  const plans = employeePlans(employee);
  document.getElementById("graphEmployeeOptionContent").innerHTML = plans.length
    ? `<div class="gx-list">${plans.map(plan => {
      const tasks = plan.tasks || [];
      const completed = tasks.filter(task => graphStatus(task) === "Completed").length;
      const pct = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
      return `<button type="button" class="gx-row" data-employee-plan="${escapeHtml(plan.id)}" style="--tone:${planTierColor(pct)}">
        <span class="gx-row-main"><b>${escapeHtml(plan.title)}</b>
          <small>${escapeHtml(plan.groupName || "Planner")} · ${tasks.length} assigned task${tasks.length === 1 ? "" : "s"} · ${completed} completed</small></span>
        <span class="gx-bar e360-bar"><i style="width:${pct}%"></i></span>
        <strong class="gx-pct">${pct}%</strong>
        <span class="e360-chev" aria-hidden="true">›</span>
      </button>`;
    }).join("")}</div>` : employeeOptionEmpty("No Planner plans found for this employee.");
  document.querySelectorAll("[data-employee-plan]").forEach(button => {
    button.onclick = () => openEmployeePlanDrawer(employee, button.dataset.employeePlan);
  });
}

function openEmployeePlanDrawer(employee, planId) {
  const plan = employeePlans(employee).find(item => item.id === planId);
  if (!plan) return;
  const tasks = plan.tasks || [];
  const completed = tasks.filter(task => graphStatus(task) === "Completed").length;
  const open = tasks.length - completed;
  const pct = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const ringColor = planTierColor(pct);
  const summary = {};
  tasks.forEach(task => { const status = graphStatus(task); summary[status] = (summary[status] || 0) + 1; });
  const sortedTasks = [...tasks].sort((a, b) =>
    (GRAPH_STATUS_SORT_RANK[graphStatus(a).toLowerCase()] ?? 9) - (GRAPH_STATUS_SORT_RANK[graphStatus(b).toLowerCase()] ?? 9));

  openGraphDrawer(plan.title, `${employee.name} · Planner plan`, `
    <div class="graphd-stat-strip">
      <div class="graphd-ring" style="--pct:${pct};--c:${ringColor}"><div class="graphd-ring-inner" style="color:${ringColor}">${pct}%</div></div>
      <div class="graphd-stat-tiles">
        <div><strong>${tasks.length}</strong><span>Tasks</span></div>
        <div><strong>${open}</strong><span>Open</span></div>
        <div><strong>${completed}</strong><span>Completed</span></div>
      </div>
    </div>
    <div class="graph-detail-stack">
      ${graphDetail("Owner / Group", plan.owner || plan.groupName || "Not provided")}
    </div>
    ${Object.keys(summary).length ? `<div class="graphd-status-badges">${Object.entries(summary).map(([name, count]) =>
      `<span class="graphd-status-badge" style="background:color-mix(in srgb, ${graphTaskStatusColor(name)} 16%, white);color:${graphTaskStatusColor(name)}">${escapeHtml(name)}: ${escapeHtml(count)}</span>`
    ).join("")}</div>` : ""}
    <h3>${escapeHtml(employee.name)}'s tasks in this plan</h3>
    <div class="graph-mini-list">${sortedTasks.map(task => {
      const status = graphStatus(task);
      const isOverdue = status === "Overdue";
      return `<button class="graphd-task-row${isOverdue ? " graphd-task-row--overdue" : ""}" data-employee-plan-task="${escapeHtml(task.id)}">
        <span class="graphd-task-dot" style="background:${graphTaskStatusColor(status)}"></span>
        <span class="graphd-task-title">${escapeHtml(task.title)}</span>
        <span class="graphd-task-status" style="color:${graphTaskStatusColor(status)}">${escapeHtml(status)}</span>
      </button>`;
    }).join("") || "<p>No assigned tasks.</p>"}</div>
    <details class="graphd-tech-details">
      <summary>Technical details</summary>
      <div class="graph-detail-stack">${graphDetail("Plan ID", plan.id)}${graphDetail("Group ID", plan.groupId)}</div>
    </details>`);
  document.querySelectorAll("[data-employee-plan-task]").forEach(button => {
    button.onclick = () => openTaskDrawer(button.dataset.employeePlanTask);
  });
}

function renderEmployeeTasks(employee, completedOnly) {
  const state = { search: "", filter: "all", sort: "name" };
  const filters = completedOnly
    ? [["all", "All completed"]]
    : [["all", "All statuses"], ["Completed", "Completed"], ["In Progress", "In progress"], ["Not Started", "Not started"], ["Overdue", "Overdue"], ["Unassigned", "Unassigned"], ["Orphaned", "No owner + no deadline"], ["Priority", "High/Urgent priority"]];

  const content = document.getElementById("graphEmployeeOptionContent");
  content.innerHTML = `
    <div class="graph-toolbar e360-tasktools">
      <input id="empTaskSearch" class="graph-toolbar-search" type="search" placeholder="Search tasks..." aria-label="Search this employee's tasks">
      <div id="empTaskFilter" class="gx-pills" role="group" aria-label="Filter tasks">${filters.map(([value, name]) =>
        `<button type="button" class="gx-pill${value === "all" ? " on" : ""}" data-emp-task-filter="${value}">${escapeHtml(name)}</button>`).join("")}</div>
      <select id="empTaskSort">
        ${!completedOnly ? '<option value="attention">Needs Attention</option>' : ""}
        <option value="name" selected>Name A-Z</option>
        <option value="newest">Newest first</option>
      </select>
    </div>
    <div id="empTaskResults"></div>`;

  function renderResults() {
    let matching = (employee.planner?.tasks || []).filter(task => !completedOnly || graphStatus(task) === "Completed");
    if (state.search) {
      const query = state.search.toLowerCase();
      matching = matching.filter(task => [task.title, task.planTitle, task.groupName, ...(task.assignees || [])]
        .some(value => String(value || "").toLowerCase().includes(query)));
    }
    const rows = matching.filter(task => {
      const filter = state.filter;
      if (filter === "all") return true;
      if (filter === "Unassigned") return !(task.assignees || []).length;
      if (filter === "Orphaned") return !(task.assignees || []).length && !task.dueDateTime;
      if (filter === "Priority") return Number(task.priority) <= 4 && graphStatus(task) !== "Completed";
      return graphStatus(task) === filter;
    });
    rows.sort((a, b) => {
      if (state.sort === "attention") return graphDaysOverdue(b) - graphDaysOverdue(a);
      if (state.sort === "newest") return new Date(b.completedDateTime || b.dueDateTime || 0) - new Date(a.completedDateTime || a.dueDateTime || 0);
      return a.title.localeCompare(b.title);
    });
    const statStrip = completedOnly ? "" : graphTaskStatStrip(matching);
    const results = document.getElementById("empTaskResults");
    results.innerHTML = statStrip + (rows.length
      ? `<div class="gx-list">${rows.map(task => graphTaskCard(task, completedOnly)).join("")}</div>`
      : `<div class="graph-empty-state"><span aria-hidden="true">⌕</span><h3>No tasks found</h3><p>Try changing the search or status filter.</p></div>`);
    bindGraphTaskCards();
    document.querySelectorAll("[data-stat-filter]").forEach(tile => {
      tile.onclick = () => {
        state.filter = tile.dataset.statFilter;
        markEmpTaskFilter();
        renderResults();
      };
    });
  }

  let searchTimer;
  document.getElementById("empTaskSearch").oninput = event => {
    clearTimeout(searchTimer);
    const value = event.target.value;
    searchTimer = setTimeout(() => { state.search = value; renderResults(); }, 180);
  };
  function markEmpTaskFilter() {
    document.querySelectorAll("[data-emp-task-filter]").forEach(pill => pill.classList.toggle("on", pill.dataset.empTaskFilter === state.filter));
  }
  document.querySelectorAll("[data-emp-task-filter]").forEach(pill => {
    pill.onclick = () => { state.filter = pill.dataset.empTaskFilter; markEmpTaskFilter(); renderResults(); };
  });
  document.getElementById("empTaskSort").onchange = event => { state.sort = event.target.value; renderResults(); };
  renderResults();
}

function employeeCalendarKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderEmployeeCalendar(employee, selectedDate = null, showCancelled = false) {
  const allEvents = employee.calendar?.items || [];
  const cancelledCount = allEvents.filter(event => event.isCancelled).length;
  const events = showCancelled ? allEvents.filter(event => event.isCancelled) : allEvents.filter(event => !event.isCancelled);
  const content = document.getElementById("graphEmployeeOptionContent");
  const base = new Date(graphData?.meta?.periodStart || allEvents[0]?.start || new Date());
  const year = base.getFullYear(), month = base.getMonth();
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const first = new Date(year, month, 1), daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = {};
  events.forEach(event => {
    const key = employeeCalendarKey(event.start);
    if (key.startsWith(prefix)) (byDay[key] ||= []).push(event);
  });
  const maxCount = Math.max(1, ...Object.values(byDay).map(list => list.length));
  const todayKey = employeeCalendarKey(new Date());
  const selected = selectedDate && selectedDate.startsWith(prefix) ? selectedDate
    : (byDay[todayKey] ? todayKey : Object.keys(byDay).sort().find(key => key >= todayKey) || Object.keys(byDay).sort()[0] || `${prefix}-01`);

  let cells = "";
  for (let i = 0; i < first.getDay(); i++) cells += '<span class="gcal-cell blank"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${prefix}-${String(day).padStart(2, "0")}`;
    const count = (byDay[key] || []).length;
    const dow = new Date(year, month, day).getDay();
    const classes = ["gcal-cell"];
    if (dow === 0 || dow === 6) classes.push("weekend");
    if (key === todayKey) classes.push("today");
    if (key === selected) classes.push("sel");
    cells += `<button type="button" class="${classes.join(" ")}" data-employee-date="${key}" title="${count} meeting${count === 1 ? "" : "s"}">
      <span class="gcal-num">${day}</span>${count ? `<span class="gcal-bar" style="--r:${(count / maxCount).toFixed(2)}"></span>` : ""}</button>`;
  }

  const meetings = (byDay[selected] || []).sort((a, b) => new Date(a.start) - new Date(b.start));
  const day = new Date(`${selected}T00:00:00`);
  const firstName = String(employee.name || "").split(" ")[0];
  const color = event => event.isCancelled ? GCAL_COLORS.cancelled : GCAL_COLORS[event.showAs] || GCAL_COLORS.busy;
  content.innerHTML = `
    <div class="gcal e360-cal">
      <div class="e360-cal-head">
        <b>${escapeHtml(base.toLocaleString([], { month: "long", year: "numeric" }))}</b>
        ${cancelledCount ? `<button type="button" id="employeeCancelledToggle" class="e360-link">
          ${showCancelled ? "Back to real meetings" : `${cancelledCount} cancelled hidden · show`}</button>` : ""}
      </div>
      <div class="gcal-split">
        <div>
          <div class="gcal-week">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span>${d}</span>`).join("")}</div>
          <div class="gcal-dots">${cells}</div>
        </div>
        <div class="gcal-agenda">
          <h3>${escapeHtml(day.toLocaleDateString([], { weekday: "long" }))}, ${escapeHtml(day.toLocaleDateString([], { day: "numeric", month: "long" }))}</h3>
          <p class="gcal-sub">${meetings.length ? `${meetings.length} ${showCancelled ? "cancelled " : ""}meeting${meetings.length === 1 ? "" : "s"} for ${escapeHtml(firstName)}` : "Nothing scheduled"}</p>
          ${meetings.map(event => `
            <button type="button" class="gcal-row${event.isCancelled ? " cancelled" : ""}" data-employee-event="${escapeHtml(event.id)}" style="--c:${color(event)}">
              <span class="gcal-time">${event.isAllDay ? "All day" : escapeHtml(gcalTime(event.start))}<small>${event.isAllDay ? "" : `${event.durationMinutes || 0} min`}</small></span>
              <span class="gcal-mark"></span>
              <span class="gcal-text"><b>${escapeHtml(event.subject)}</b><small>${escapeHtml(event.organizer || "Organizer unavailable")}</small></span>
            </button>`).join("") || '<p class="gcal-empty">No meetings on this day.</p>'}
        </div>
      </div>
    </div>`;
  content.querySelectorAll("[data-employee-date]").forEach(button => {
    button.onclick = () => renderEmployeeCalendar(employee, button.dataset.employeeDate, showCancelled);
  });
  content.querySelectorAll("[data-employee-event]").forEach(button => {
    button.onclick = () => openEventDrawer(button.dataset.employeeEvent, employee.id);
  });
  const cancelledToggle = document.getElementById("employeeCancelledToggle");
  if (cancelledToggle) cancelledToggle.onclick = () => renderEmployeeCalendar(employee, null, !showCancelled);
}

function renderEmployeeSites(employee) {
  const sites = employeeRelevantSites(employee);
  const dupMap = graphSiteDuplicateMap(graphData?.sharePoint?.sites || []);
  const lastActive = employee.sharePoint?.lastActivityDate;
  document.getElementById("graphEmployeeOptionContent").innerHTML = `
    <p class="graph-profile-note e360-note">Microsoft Graph does not expose direct per-user site membership with the current permissions. These resources are matched from the employee's department and tenant activity.${lastActive ? ` Last SharePoint activity: <b>${escapeHtml(graphDate(lastActive))}</b>.` : ""}</p>
    ${sites.length ? `<div class="gx-list">${sites.map((site, index) => {
      const isEmpty = graphSiteIsEmpty(site);
      const isStale = graphSiteIsStale(site);
      const isDup = dupMap.has(site.id);
      const flags = isEmpty || isStale || isDup
        ? `<span class="graph-site-flags">${isEmpty ? '<span class="graph-warn-pill graph-warn-pill--muted">Empty</span>' : ""}${isStale ? '<span class="graph-warn-pill graph-warn-pill--muted">Inactive</span>' : ""}${isDup ? '<span class="graph-warn-pill">Possible duplicate</span>' : ""}</span>`
        : "";
      return `<article class="gx-row gx-site" style="--site:${graphHue(index + 2)}">
        <button type="button" data-employee-site="${escapeHtml(site.id)}">
          <span class="graph-site-icon">${escapeHtml((site.displayName || "S").trim()[0] || "S")}</span>
          <span class="gx-row-main"><b>${escapeHtml(site.displayName)}</b><small>${site.lists?.length || 0} lists · ${site.files?.length || 0} files/folders · ${site.lastActivity ? `Active ${graphDate(site.lastActivity)}` : "Activity unavailable"}</small></span>
          ${flags}
        </button>
        <a href="${escapeHtml(site.webUrl)}" target="_blank" rel="noopener noreferrer">Quick access ↗</a>
      </article>`;
    }).join("")}</div>` : employeeOptionEmpty("No SharePoint sites found for this employee.")}`;
  document.querySelectorAll("[data-employee-site]").forEach(button => {
    button.onclick = () => openSiteDrawer(button.dataset.employeeSite);
  });
}

function profileFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

let graphLiveTicker = null;

function setGraphSection(section) {
  graphExplorerState.fromOverview = null;
  graphExplorerState.section = section;
  graphExplorerState.page = 1;
  graphExplorerState.search = "";
  graphExplorerState.filter = "all";
  if (section === "calendar" && !graphExplorerState.calendarDate) {
    graphExplorerState.calendarDate = graphData?.meta?.periodStart || new Date().toISOString();
  }
  clearInterval(graphLiveTicker);
  graphLiveTicker = section === "live" ? setInterval(() => {
    if (graphExplorerState.section === "live") renderGraphSection();
  }, 30000) : null;
  renderGraphExplorer();
  if (section === "employees") {
    const email = (typeof loggedInUserEmail !== "undefined" ? loggedInUserEmail : "").toLowerCase();
    const meNorm = (typeof loggedInUserName !== "undefined" ? loggedInUserName : "").trim().toLowerCase();
    const match = (graphData?.employees || []).find(e =>
      (email && (e.email || "").toLowerCase() === email) ||
      (meNorm && e.name.trim().toLowerCase() === meNorm)
    );
    if (match) showEmployeeWorkspace(match);
  }
}

const GRAPH_KPI_ICONS = {
  live: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>`,
  plans: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4M2 12l3 3L15 5"/></svg>`,
  completed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>`,
  sites: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`,
  employees: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M2 21v-1a5 5 0 015-5h1M14 21v-1a5 5 0 015-5h-1"/></svg>`,
};

function renderGraphExplorer() {
  const overview = graphData?.overview || {};
  const meta = graphData?.meta || {};
  // Show the month the data covers instead of an empty "------, ----" picker.
  const monthPicker = document.getElementById("graphMonthPicker");
  if (monthPicker && !monthPicker.value && meta.periodStart) monthPicker.value = String(meta.periodStart).slice(0, 7);
  document.getElementById("graphRefreshLabel").innerHTML = meta.generatedAt
    ? CLOCK_SVG + formatRefreshTimestamp(meta.generatedAt, "Updated") : "Not refreshed yet";

  const totalEmployees = meta.totalEmployees || 0;
  const eyebrowEl = document.getElementById("graphSummaryEyebrow");
  // Leads/managers get Graph data trimmed to their people (scopeGraphData in app.js), so say so.
  if (eyebrowEl) eyebrowEl.textContent = typeof isCompanyScope === "function" && !isCompanyScope()
    ? `Your team${totalEmployees ? ` · ${totalEmployees} ${totalEmployees === 1 ? "person" : "people"}` : ""}`
    : `Organization Overview${totalEmployees ? ` · All ${totalEmployees} Employees` : ""}`;

  const cards = [
    ["live", "Live meetings", graphLiveMeetings().length, "Happening right now"],
    ["plans", "Planner plans", overview.plans || 0, "Organized workspaces"],
    ["tasks", "Planner tasks", overview.plannerTasks || 0, "Across every plan"],
    ["completed", "Completed tasks", overview.completedPlannerTasks || 0, "Delivered work"],
    ["calendar", "Calendar events", overview.calendarEvents || 0, "Current month"],
    ["sites", "SharePoint sites", overview.sharePointSites || 0, "Lists and files"],
    ["employees", "Matched employees", `${meta.matchedEmployees || 0}/${meta.totalEmployees || 0}`, "Microsoft 365 identities"],
  ];
  // Left section list: one row per section with its count; the note shows as a tooltip.
  // Live meetings gets a pulsing dot while anything is in progress.
  document.getElementById("graphSummaryCards").innerHTML = cards.map(([section, name, value, note]) => `
    <button type="button" class="gx-rail-item ${graphExplorerState.section === section ? "active" : ""}"
      data-graph-kpi="${section}" title="${escapeHtml(note)}">
      <span class="gx-rail-icon">${section === "live" && Number(value) > 0 ? '<i class="gx-live-dot"></i>' : GRAPH_KPI_ICONS[section]}</span>
      <span class="gx-rail-name">${escapeHtml(name)}<small>${escapeHtml(note)}</small></span>
      <strong>${escapeHtml(value)}</strong>
    </button>`).join("");
  document.querySelectorAll("[data-graph-kpi]").forEach(card => {
    card.onclick = () => setGraphSection(card.dataset.graphKpi);
  });
  document.querySelectorAll(".graph-subnav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.graphSection === graphExplorerState.section);
  });
  const name = cards.find(([section]) => section === graphExplorerState.section)?.[1] || "Overview";
  document.getElementById("graphBreadcrumbs").textContent = `Microsoft Graph / ${name}`;
  renderGraphSectionHeader(cards);
  renderGraphToolbar();
  renderGraphSection();
}

function renderGraphSectionHeader(cards) {
  const details = {
    live: ["●", "Live Meetings", "Meetings in progress right now, who's invited, and each person's status pulled from their own calendar."],
    plans: ["P", "Planner Plans", "Explore every plan workspace, ownership group, task volume, and delivery progress."],
    tasks: ["T", "Planner Tasks", "Review assignments across all plans with status, priority, assignee, and due-date controls."],
    completed: ["✓", "Completed Tasks", "Inspect delivered work, completion dates, ownership, and full task metadata."],
    calendar: ["C", "Calendar Events", "Navigate month, week, and day schedules, then drill into meeting details."],
    sites: ["S", "SharePoint Sites", "Open tenant sites, lists, files, owners, and recent activity from one workspace."],
    employees: ["E", "Matched Employees", "Compare identity matches and open a unified Microsoft 365 Employee 360° record."],
  };
  const [icon, titleText, description] = details[graphExplorerState.section];
  const count = cards.find(([section]) => section === graphExplorerState.section)?.[2] ?? 0;
  document.getElementById("graphSectionHeader").innerHTML = `
    <div class="graph-section-icon graph-section-${graphExplorerState.section}" aria-hidden="true">${icon}</div>
    <div>
      <p class="eyebrow">Interactive data explorer</p>
      <h2>${escapeHtml(titleText)} <span>${escapeHtml(count)} live records</span></h2>
      <p>${escapeHtml(description)}</p>
    </div>
    <span class="graph-live-badge"><i></i> Live data</span>`;
}

function renderGraphToolbar() {
  const filters = {
    live: [["all", "All live meetings"], ["flagged", "Has flags"]],
    plans: [["all", "All plans"], ["active", "Has open tasks"], ["complete", "100% complete"]],
    tasks: [["all", "All statuses"], ["due-today", "Due today (not done)"], ["due-week", "Due in next 7 days (not done)"], ["Completed", "Completed"], ["In Progress", "In progress"], ["Not Started", "Not started"], ["Overdue", "Overdue"], ["Unassigned", "Unassigned"], ["Orphaned", "No owner + no deadline"], ["Priority", "High/Urgent priority"]],
    completed: [["all", "All completed"]],
    calendar: [["all", "All events"], ["busy", "Busy"], ["tentative", "Tentative"], ["free", "Free"], ["cancelled", "Cancelled"]],
    sites: [["all", "All sites"], ["files", "Has files"], ["lists", "Has lists"], ["Empty", "Empty sites"], ["Stale", "Inactive 180+ days"], ["Duplicate", "Possible duplicate"], ["Archival", "Archival candidate"]],
    employees: [["all", "All employees"], ["matched", "Matched"], ["unmatched", "Unmatched"]],
  }[graphExplorerState.section];
  const viewSwitch = graphExplorerState.section === "calendar" && graphExplorerState.calendarView !== "month" ? `
    <div class="graph-calendar-nav">
      <button type="button" data-calendar-move="-1" aria-label="Previous period">‹</button>
      <button type="button" data-calendar-today>Today</button>
      <button type="button" data-calendar-move="1" aria-label="Next period">›</button>
    </div>
    <div class="graph-view-switch">${["month"].map(view =>
      `<button data-calendar-view="${view}" class="${graphExplorerState.calendarView === view ? "active" : ""}">${title(view)}</button>`
    ).join("")}</div>` : "";
  const employeeSwitch = graphExplorerState.section === "employees" ? `
    <div class="graph-view-switch">${["table", "cards"].map(view =>
      `<button type="button" data-employee-view="${view}" class="${graphExplorerState.employeeView === view ? "active" : ""}">${title(view)}</button>`
    ).join("")}</div>` : "";
  document.getElementById("graphToolbar").dataset.section = graphExplorerState.section;
  document.getElementById("graphToolbar").innerHTML = `
    <input id="graphGlobalSearch" class="graph-toolbar-search" type="search" value="${escapeHtml(graphExplorerState.search)}"
      placeholder="Search ${graphExplorerState.section}..." aria-label="Search current Graph records">
    <div id="graphFilter" class="gx-pills" role="group" aria-label="Filter">${filters.map(([value, name]) =>
      `<button type="button" class="gx-pill${graphExplorerState.filter === value ? " on" : ""}" data-graph-filter="${value}">${name}</button>`
    ).join("")}</div>
    <select id="graphSort">
      ${graphExplorerState.section === "plans" || graphExplorerState.section === "tasks" ? `<option value="attention" ${graphExplorerState.sort === "attention" ? "selected" : ""}>Needs Attention</option>` : ""}
      <option value="name" ${graphExplorerState.sort === "name" ? "selected" : ""}>Name A-Z</option>
      <option value="newest" ${graphExplorerState.sort === "newest" ? "selected" : ""}>Newest first</option>
      <option value="count" ${graphExplorerState.sort === "count" ? "selected" : ""}>Highest activity</option>
    </select>${viewSwitch}${employeeSwitch}`;
  let searchTimer;
  document.getElementById("graphGlobalSearch").oninput = event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      graphExplorerState.search = event.target.value;
      graphExplorerState.page = 1;
      renderGraphSection();
    }, 180);
  };
  document.querySelectorAll("[data-graph-filter]").forEach(pill => {
    pill.onclick = () => {
      graphExplorerState.fromOverview = null;
      graphExplorerState.filter = pill.dataset.graphFilter; graphExplorerState.page = 1;
      document.querySelectorAll("[data-graph-filter]").forEach(p => p.classList.toggle("on", p === pill));
      renderGraphSection();
    };
  });
  document.getElementById("graphSort").onchange = event => {
    graphExplorerState.sort = event.target.value; renderGraphSection();
  };
  document.querySelectorAll("[data-calendar-view]").forEach(button => {
    button.onclick = () => {
      graphExplorerState.calendarView = button.dataset.calendarView;
      renderGraphExplorer();
    };
  });
  document.querySelectorAll("[data-calendar-move]").forEach(button => {
    button.onclick = () => {
      const date = graphCalendarBase();
      const direction = Number(button.dataset.calendarMove);
      if (graphExplorerState.calendarView === "month") date.setMonth(date.getMonth() + direction);
      else date.setDate(date.getDate() + direction * (graphExplorerState.calendarView === "week" ? 7 : 1));
      graphExplorerState.calendarDate = date.toISOString();
      graphExplorerState.page = 1;
      renderGraphExplorer();
    };
  });
  document.querySelector("[data-calendar-today]")?.addEventListener("click", () => {
    graphExplorerState.calendarDate = new Date().toISOString();
    graphExplorerState.page = 1;
    renderGraphExplorer();
  });
  document.querySelectorAll("[data-employee-view]").forEach(button => {
    button.onclick = () => {
      graphExplorerState.employeeView = button.dataset.employeeView;
      renderGraphExplorer();
    };
  });
}

function graphPage(rows) {
  const pages = Math.max(1, Math.ceil(rows.length / graphExplorerState.pageSize));
  graphExplorerState.page = Math.min(graphExplorerState.page, pages);
  const start = (graphExplorerState.page - 1) * graphExplorerState.pageSize;
  document.getElementById("graphPagination").innerHTML = `
    <span>${rows.length} records</span>
    <button ${graphExplorerState.page <= 1 ? "disabled" : ""} data-graph-page="${graphExplorerState.page - 1}">Previous</button>
    <strong>Page ${graphExplorerState.page} of ${pages}</strong>
    <button ${graphExplorerState.page >= pages ? "disabled" : ""} data-graph-page="${graphExplorerState.page + 1}">Next</button>`;
  document.querySelectorAll("[data-graph-page]").forEach(button => {
    button.onclick = () => { graphExplorerState.page = Number(button.dataset.graphPage); renderGraphSection(); };
  });
  return rows.slice(start, start + graphExplorerState.pageSize);
}

function renderGraphSection() {
  renderGraphSectionInner();
  renderGraphFromOverview();
}

// Shown when the page was opened from the Overview "Today" strip: why you're here, Clear, and a way back.
function renderGraphFromOverview() {
  const from = graphExplorerState.fromOverview;
  const workspace = document.getElementById("graphWorkspace");
  if (!from || !workspace || from.section !== graphExplorerState.section) return;
  workspace.insertAdjacentHTML("afterbegin", `<div class="graph-from-bar" role="status">
    <span aria-hidden="true">↪</span><span>From Overview: <b>${escapeHtml(from.label)}</b></span>
    <button type="button" data-from-clear>Clear ✕</button>
    <button type="button" data-from-back>← Back to Overview</button>
  </div>`);
  workspace.querySelector("[data-from-clear]").onclick = () => {
    graphExplorerState.fromOverview = null;
    graphExplorerState.filter = "all";
    graphExplorerState.page = 1;
    renderGraphToolbar();
    renderGraphSection();
  };
  workspace.querySelector("[data-from-back]").onclick = () => {
    graphExplorerState.fromOverview = null;
    document.querySelector('.rail-item[data-view="overview"]')?.click();
  };
  if (!from.scrolled) { // bring the target into view once, not on every 30s live refresh
    from.scrolled = true;
    const target = workspace.querySelector(".graph-from-target") || workspace.querySelector(".graph-from-bar");
    setTimeout(() => target?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }
}

// Called by the Overview "Today" strip: open the Graph page on one section, filtered, marked "From Overview".
function graphOpenFromOverview({ section, filter = "all", label, meetingKey = null }) {
  graphExplorerState.section = section;
  graphExplorerState.filter = filter;
  graphExplorerState.search = "";
  graphExplorerState.page = 1;
  if (section === "calendar" && !graphExplorerState.calendarDate) graphExplorerState.calendarDate = new Date().toISOString();
  graphExplorerState.fromOverview = { section, label, meetingKey, scrolled: false };
  clearInterval(graphLiveTicker);
  graphLiveTicker = section === "live" ? setInterval(() => {
    if (graphExplorerState.section === "live") renderGraphSection();
  }, 30000) : null;
  document.querySelector('.rail-item[data-view="graph"]')?.click(); // loads Graph data and renders this state
}

function renderGraphSectionInner() {
  ({
    live: renderGraphLive,
    plans: renderGraphPlans,
    tasks: () => renderGraphTasks(false),
    completed: () => renderGraphTasks(true),
    calendar: renderGraphCalendar,
    sites: renderGraphSites,
    employees: renderGraphEmployees,
  }[graphExplorerState.section])();
}

function planPct(plan) {
  const tasks = plan.tasks || [];
  const completed = tasks.filter(task => graphStatus(task) === "Completed").length;
  return tasks.length ? Math.round(completed / tasks.length * 100) : 0;
}

function planTierColor(pct) {
  return pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
}

function renderGraphPlans() {
  let matching = [...(graphData?.planner?.plans || [])].filter(plan => graphSearch(plan.title, plan.groupName, plan.id));
  matching = matching.filter(plan => {
    const tasks = plan.tasks || [];
    if (graphExplorerState.filter === "active") return tasks.some(task => graphStatus(task) !== "Completed");
    if (graphExplorerState.filter === "complete") return tasks.length && tasks.every(task => graphStatus(task) === "Completed");
    return true;
  });

  const dormant = matching.filter(plan => (plan.tasks || []).length === 0);
  let rows = matching.filter(plan => (plan.tasks || []).length > 0);
  const stalled = rows.filter(plan => planPct(plan) === 0);

  rows.sort((a, b) => {
    if (graphExplorerState.sort === "attention") return planPct(a) - planPct(b) || (b.tasks?.length || 0) - (a.tasks?.length || 0);
    if (graphExplorerState.sort === "count") return (b.tasks?.length || 0) - (a.tasks?.length || 0);
    return a.title.localeCompare(b.title);
  });

  if (!rows.length && !dormant.length) return graphEmpty("No plans found", "Try changing the search or plan filter.");

  const warnSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>`;
  const folderSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`;

  const attnBanner = stalled.length ? `
    <div class="graph-attn-banner">
      <div class="graph-attn-icon">${warnSvg}</div>
      <div><b>${stalled.length} plan${stalled.length !== 1 ? "s" : ""} have real tasks assigned but 0% completion</b> — ${stalled.map(p => `${escapeHtml(p.title)} (${p.tasks.length} tasks)`).join(", ")}.</div>
    </div>` : "";

  const page = rows.length ? graphPage(rows) : (() => { document.getElementById("graphPagination").innerHTML = ""; return []; })();

  const cardsHtml = page.map(plan => {
    const tasks = plan.tasks || [], completed = tasks.filter(task => graphStatus(task) === "Completed").length;
    const pct = planPct(plan);
    const tier = planTierColor(pct);
    const isStalled = pct === 0;
    return `<button type="button" class="gx-row" data-plan-id="${escapeHtml(plan.id)}" style="--tone:${tier}">
      <span class="gx-row-main"><b>${escapeHtml(plan.title)}</b><small>${escapeHtml(plan.groupName)} · ${tasks.length} tasks · ${completed} completed</small></span>
      ${isStalled ? `<span class="graph-warn-pill">${warnSvg}${tasks.length} tasks stalled</span>` : ""}
      <span class="gx-bar"><i style="width:${pct}%"></i></span>
      <strong class="gx-pct">${pct}%</strong>
    </button>`;
  }).join("");

  const dormantHtml = dormant.length ? `
    <div class="graph-dormant-group">
      <div class="graph-dormant-label">${folderSvg}${dormant.length} plan${dormant.length !== 1 ? "s" : ""} with no tasks logged</div>
      <div class="graph-dormant-chips">${dormant.map(p => `<span class="graph-dormant-chip">${escapeHtml(p.title)}</span>`).join("")}</div>
    </div>` : "";

  document.getElementById("graphWorkspace").innerHTML = `${attnBanner}<div class="gx-list">${cardsHtml}</div>${dormantHtml}`;
  document.querySelectorAll("[data-plan-id]").forEach(card => card.onclick = () => openPlanDrawer(card.dataset.planId));
}

function graphDaysOverdue(task) {
  if (!task.dueDateTime) return 0;
  const diff = Math.floor((Date.now() - new Date(task.dueDateTime).getTime()) / 86400000);
  return diff > 0 ? diff : 0;
}

// Not completed, due from today up to `days` days ahead (0 = today only). Dates compared as local days.
function graphTaskDueSoon(task, days) {
  if (!task.dueDateTime || graphStatus(task) === "Completed") return false;
  const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const due = String(task.dueDateTime).slice(0, 10);
  const today = new Date();
  const until = new Date(); until.setDate(until.getDate() + days);
  return due >= key(today) && due <= key(until);
}

function graphTaskStats(tasks) {
  const overdue = tasks.filter(task => graphStatus(task) === "Overdue");
  const chronic = overdue.filter(task => graphDaysOverdue(task) > 90);
  const unassigned = tasks.filter(task => !(task.assignees || []).length);
  const orphaned = unassigned.filter(task => !task.dueDateTime);
  const priorityTasks = tasks.filter(task => Number(task.priority) <= 4);
  const openPriority = priorityTasks.filter(task => graphStatus(task) !== "Completed");
  return { overdue: overdue.length, chronic: chronic.length, unassigned: unassigned.length,
    orphaned: orphaned.length, openPriority: openPriority.length, totalPriority: priorityTasks.length };
}

function graphTaskStatStrip(tasks) {
  if (!tasks.length) return "";
  const s = graphTaskStats(tasks);
  const pct = tasks.length ? Math.round(s.unassigned / tasks.length * 100) : 0;
  const dueToday = tasks.filter(task => graphTaskDueSoon(task, 0)).length;
  const dueWeek = tasks.filter(task => graphTaskDueSoon(task, 7)).length;
  return `<div class="graph-task-stat-strip">
    <button type="button" class="graph-stat-tile stat-due${graphExplorerState.filter === "due-today" ? " is-active" : ""}" data-stat-filter="due-today">
      <b>${dueToday}</b><span class="label">Due today</span><span class="sub">not done yet</span>
    </button>
    <button type="button" class="graph-stat-tile stat-due${graphExplorerState.filter === "due-week" ? " is-active" : ""}" data-stat-filter="due-week">
      <b>${dueWeek}</b><span class="label">Due in next 7 days</span><span class="sub">not done yet</span>
    </button>
    <button type="button" class="graph-stat-tile stat-overdue" data-stat-filter="Overdue">
      <b>${s.overdue}</b><span class="label">Overdue</span><span class="sub">${s.chronic} over 90 days chronic</span>
    </button>
    <button type="button" class="graph-stat-tile stat-unassigned" data-stat-filter="Unassigned">
      <b>${s.unassigned}</b><span class="label">Unassigned</span><span class="sub">${pct}% of these tasks</span>
    </button>
    <button type="button" class="graph-stat-tile stat-orphan" data-stat-filter="Orphaned">
      <b>${s.orphaned}</b><span class="label">No owner, no deadline</span><span class="sub">invisible to any report</span>
    </button>
    <button type="button" class="graph-stat-tile stat-priority" data-stat-filter="Priority">
      <b>${s.openPriority}</b><span class="label">Open · High/Urgent</span><span class="sub">of ${s.totalPriority} total</span>
    </button>
  </div>`;
}

function bindGraphTaskStatTiles() {
  document.querySelectorAll("[data-stat-filter]").forEach(tile => {
    tile.onclick = () => {
      graphExplorerState.fromOverview = null;
      graphExplorerState.filter = tile.dataset.statFilter;
      graphExplorerState.page = 1;
      renderGraphToolbar();
      renderGraphSection();
    };
  });
}

function renderGraphTasks(completedOnly) {
  let matching = graphTasks().filter(task => !completedOnly || graphStatus(task) === "Completed");
  matching = matching.filter(task => graphSearch(task.title, task.planTitle, task.groupName, ...(task.assignees || [])));
  const rows = matching.filter(task => {
    const filter = graphExplorerState.filter;
    if (filter === "all") return true;
    if (filter === "Unassigned") return !(task.assignees || []).length;
    if (filter === "Orphaned") return !(task.assignees || []).length && !task.dueDateTime;
    if (filter === "Priority") return Number(task.priority) <= 4 && graphStatus(task) !== "Completed";
    if (filter === "due-today" || filter === "due-week") return graphTaskDueSoon(task, filter === "due-today" ? 0 : 7);
    return graphStatus(task) === filter;
  });
  rows.sort((a, b) => {
    if (graphExplorerState.sort === "attention") return graphDaysOverdue(b) - graphDaysOverdue(a);
    if (graphExplorerState.sort === "newest") return new Date(b.completedDateTime || b.dueDateTime || 0) - new Date(a.completedDateTime || a.dueDateTime || 0);
    if (graphExplorerState.sort === "count") return (b.percentComplete || 0) - (a.percentComplete || 0);
    return a.title.localeCompare(b.title);
  });
  const statStrip = completedOnly ? "" : graphTaskStatStrip(matching);
  if (!rows.length) {
    document.getElementById("graphPagination").innerHTML = "";
    document.getElementById("graphWorkspace").innerHTML = `${statStrip}<div class="graph-empty-state"><span aria-hidden="true">⌕</span><h3>No tasks found</h3><p>Try changing the search or status filter.</p></div>`;
    bindGraphTaskStatTiles();
    return;
  }
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML =
    `${statStrip}<div class="gx-list">${page.map(task => graphTaskCard(task, completedOnly)).join("")}</div>`;
  bindGraphTaskCards();
  bindGraphTaskStatTiles();
}

function graphTaskCard(task, completedOnly = false) {
  const status = graphStatus(task);
  const isOverdue = status === "Overdue";
  const overdueDays = isOverdue ? graphDaysOverdue(task) : 0;
  const statusLabel = isOverdue ? `Overdue · ${overdueDays}d` : status;
  const priority = graphPriority(task.priority);
  const showPriority = priority === "Urgent" || priority === "High";
  const priorityColor = GRAPH_PRIORITY_COLOR[priority.toLowerCase()] || "#94a3b8";
  const hasOwner = (task.assignees || []).length > 0;
  return `<button type="button" class="gx-row gx-task status-${status.toLowerCase().replace(/\s/g, "-")}" data-task-id="${escapeHtml(task.id)}">
    <div class="graph-task-top"><span class="graph-status">${escapeHtml(statusLabel)}</span>${showPriority ? `<span class="graph-task-priority" style="background:color-mix(in srgb, ${priorityColor} 16%, white);color:${priorityColor}">${escapeHtml(priority)}</span>` : ""}</div>
    <h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.planTitle)}</p>
    <div class="graph-task-meta"><span class="${hasOwner ? "" : "graph-task-gap"}">${hasOwner ? escapeHtml(task.assignees.join(", ")) : "No owner"}</span>
    <span>${task.dueDateTime ? `Due ${graphDate(task.dueDateTime)}` : "No due date"}</span></div>
    ${completedOnly ? `<p class="graph-completed-date">✓ Completed ${graphDate(task.completedDateTime)}</p>` : ""}
    <div class="graph-progress"><span style="width:${task.percentComplete || 0}%"></span></div>
  </button>`;
}

function bindGraphTaskCards() {
  document.querySelectorAll("[data-task-id]").forEach(card => {
    card.onclick = () => openTaskDrawer(card.dataset.taskId);
  });
}

function renderGraphCalendar() {
  if (graphExplorerState.calendarView === "month") return renderGraphMonth();
  const matching = graphEvents().filter(event => graphSearch(event.subject, event.organizer, event.employee?.name, event.location));
  const cancelledCount = matching.filter(event => event.isCancelled).length;
  let rows = matching.filter(event => {
    if (graphExplorerState.filter === "cancelled") return event.isCancelled;
    if (event.isCancelled) return false;
    return graphExplorerState.filter === "all" || event.showAs === graphExplorerState.filter;
  });
  rows.sort((a, b) => new Date(a.start) - new Date(b.start));
  const base = graphCalendarBase();
  if (graphExplorerState.calendarView === "week") base.setDate(base.getDate() - base.getDay());
  const span = graphExplorerState.calendarView === "week" ? 7 : 1;
  const visibleRows = rows.filter(event => {
    const eventDay = new Date(event.start); eventDay.setHours(0, 0, 0, 0);
    const baseDay = new Date(base); baseDay.setHours(0, 0, 0, 0);
    const difference = Math.floor((eventDay - baseDay) / 86400000);
    return difference >= 0 && difference < span;
  });
  const page = graphPage(visibleRows);
  document.getElementById("graphWorkspace").innerHTML = `<div class="graph-agenda">${page.map(event => `
    <button class="graph-event-row event-${event.showAs || "busy"}" data-event-id="${escapeHtml(event.id)}" data-event-user="${escapeHtml(event.employee?.id)}">
      <time>${graphDateTime(event.start)}</time><div><strong>${escapeHtml(event.subject)}</strong>
      <span>${escapeHtml(event.employee?.name)} · ${escapeHtml(event.organizer)}</span></div><span>${event.durationMinutes || 0} min</span>
    </button>`).join("")}</div>`;
  bindGraphEvents();
}

// ── Calendar month view: "dot calendar" + day agenda ──
// Every attendee has their own copy of a meeting in Graph, so copies are grouped into one meeting
// (same organizer, start, end and subject). Counts are real meetings, not one per invitee.
// Unlike graphMeetingGroups (used by Live), this keeps cancelled and all-day meetings so the
// Cancelled tab and all-day events still show up.
function graphCalendarMeetings() {
  const groups = new Map();
  graphEvents().forEach(event => {
    const clean = graphCleanSubject(event.subject) || event.subject || "Untitled meeting";
    const key = `${graphNameKey(event.organizer)}|${event.start}|${event.end}|${clean.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, {
        subject: clean, start: event.start, end: event.end, organizer: event.organizer,
        location: event.location, meetingLink: event.meetingLink, webLink: event.webLink,
        isAllDay: event.isAllDay, attendees: event.attendees || [], entries: [],
      });
    }
    const group = groups.get(key);
    group.entries.push(event);
    if ((event.attendees || []).length > group.attendees.length) group.attendees = event.attendees;
    group.location = group.location || event.location;
    group.meetingLink = group.meetingLink || event.meetingLink;
    group.webLink = group.webLink || event.webLink;
  });
  return [...groups.values()].map(group => {
    // One status per meeting so the tabs add up: the organizer's own copy when we track them,
    // otherwise the status most invitees show.
    const active = group.entries.filter(entry => !entry.isCancelled);
    const tally = {};
    active.forEach(entry => { const s = entry.showAs || "busy"; tally[s] = (tally[s] || 0) + 1; });
    const organizerCopy = active.find(entry => graphNameKey(entry.employee?.name) === graphNameKey(group.organizer));
    const majority = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] || "busy";
    const status = !active.length ? "cancelled" : organizerCopy?.showAs || majority;
    return { ...group, cancelled: !active.length, status };
  });
}

const GCAL_COLORS = { busy: "#2563eb", tentative: "#e08a00", free: "#16a34a", cancelled: "#a3adbb" };
let graphCalendarShown = []; // meetings in the current agenda, so a row click can find its meeting

function gcalDateKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function gcalTime(value) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function gcalMinutes(meeting) {
  return Math.max(0, Math.round((new Date(meeting.end) - new Date(meeting.start)) / 60000));
}

function renderGraphMonth() {
  const base = graphCalendarBase();
  const year = base.getFullYear(), month = base.getMonth();
  const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}`;
  const first = new Date(year, month, 1), daysInMonth = new Date(year, month + 1, 0).getDate();
  const filter = graphExplorerState.filter;
  const passes = meeting => filter === "all" ? !meeting.cancelled : meeting.status === filter;

  const inMonth = graphCalendarMeetings()
    .filter(meeting => gcalDateKey(meeting.start).startsWith(monthPrefix))
    .filter(meeting => graphSearch(meeting.subject, meeting.organizer, meeting.location, ...meeting.entries.map(entry => entry.employee?.name)));
  const visible = inMonth.filter(passes).sort((a, b) => new Date(a.start) - new Date(b.start));
  const byDay = {};
  visible.forEach(meeting => { (byDay[gcalDateKey(meeting.start)] ||= []).push(meeting); });
  const maxCount = Math.max(1, ...Object.values(byDay).map(list => list.length));

  // Selected day: keep the user's pick while it's in this month, else today, else the first busy day.
  const todayKey = gcalDateKey(new Date());
  let selected = graphExplorerState.calendarSelected;
  if (!selected || !selected.startsWith(monthPrefix)) {
    selected = todayKey.startsWith(monthPrefix) ? todayKey : (Object.keys(byDay).sort()[0] || `${monthPrefix}-01`);
  }
  graphExplorerState.calendarSelected = selected;

  const busiest = Object.entries(byDay).sort((a, b) => b[1].length - a[1].length)[0];
  const totalHours = visible.reduce((sum, meeting) => sum + gcalMinutes(meeting), 0) / 60;
  const tabCount = key => inMonth.filter(meeting => key === "all" ? !meeting.cancelled : meeting.status === key).length;
  const tabs = [["all", "All"], ["busy", "Busy"], ["tentative", "Tentative"], ["free", "Free"], ["cancelled", "Cancelled"]];
  const meta = graphData?.meta || {};

  let cells = "";
  for (let i = 0; i < first.getDay(); i++) cells += '<span class="gcal-cell blank"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${monthPrefix}-${String(day).padStart(2, "0")}`;
    const count = (byDay[key] || []).length;
    const ratio = count / maxCount;
    const dow = new Date(year, month, day).getDay();
    const classes = ["gcal-cell"];
    if (dow === 0 || dow === 6) classes.push("weekend");
    if (key === todayKey) classes.push("today");
    if (key === selected) classes.push("sel");
    cells += `<button type="button" class="${classes.join(" ")}" data-gcal-day="${key}"
      title="${escapeHtml(new Date(year, month, day).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))} · ${count} meeting${count === 1 ? "" : "s"}">
      <span class="gcal-num">${day}</span>
      ${count ? `<span class="gcal-bar" style="--r:${ratio.toFixed(2)}"></span>` : ""}</button>`;
  }

  document.getElementById("graphPagination").innerHTML =
    `<span>${visible.length} meeting${visible.length === 1 ? "" : "s"} in ${escapeHtml(base.toLocaleString([], { month: "long", year: "numeric" }))}</span>`;
  document.getElementById("graphWorkspace").innerHTML = `
    <div class="gcal">
      <div class="gcal-head">
        <div>
          <div class="gcal-title">
            <h2><b>${escapeHtml(base.toLocaleString([], { month: "long" }))}</b> ${year}</h2>
            <span class="gcal-arrows">
              <button type="button" data-gcal-move="-1" aria-label="Previous month">‹</button>
              <button type="button" data-gcal-move="1" aria-label="Next month">›</button>
            </span>
            <button type="button" class="gcal-today" data-gcal-today>Today</button>
          </div>
          <p class="gcal-line"><b>${visible.length}</b> meetings · <b>${Math.round(totalHours)} h</b> in meetings${busiest
            ? ` · busiest <b>${escapeHtml(new Date(busiest[0] + "T00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }))}</b> (${busiest[1].length})` : ""}
            · ${escapeHtml(meta.calendarTimeZone || "Local time")}</p>
          <p class="gcal-period">Reporting period ${escapeHtml(graphDate(meta.periodStart))} – ${escapeHtml(graphDate(meta.periodEnd))}</p>
        </div>
      </div>
      <div class="gcal-tabs" role="tablist">${tabs.map(([key, label]) => `
        <button type="button" role="tab" class="${filter === key ? "on" : ""}" data-gcal-filter="${key}">
          ${key !== "all" ? `<i style="background:${GCAL_COLORS[key]}"></i>` : ""}${label}<small>${tabCount(key)}</small>
        </button>`).join("")}
      </div>
      <div class="gcal-split">
        <div>
          <div class="gcal-week">${["S", "M", "T", "W", "T", "F", "S"].map(d => `<span>${d}</span>`).join("")}</div>
          <div class="gcal-dots">${cells}</div>
        </div>
        <div class="gcal-agenda" id="gcalAgenda"></div>
      </div>
    </div>`;
  renderGraphCalendarAgenda(byDay[selected] || [], selected);

  const workspace = document.getElementById("graphWorkspace");
  workspace.querySelectorAll("[data-gcal-day]").forEach(cell => {
    cell.onclick = () => {
      graphExplorerState.calendarSelected = cell.dataset.gcalDay;
      graphExplorerState.calendarShowAll = false;
      workspace.querySelectorAll("[data-gcal-day]").forEach(c => c.classList.toggle("sel", c === cell));
      renderGraphCalendarAgenda(byDay[cell.dataset.gcalDay] || [], cell.dataset.gcalDay);
    };
  });
  workspace.querySelectorAll("[data-gcal-filter]").forEach(tab => {
    tab.onclick = () => {
      graphExplorerState.fromOverview = null;
      graphExplorerState.filter = tab.dataset.gcalFilter;
      graphExplorerState.calendarShowAll = false;
      renderGraphToolbar();
      renderGraphSection();
    };
  });
  workspace.querySelectorAll("[data-gcal-move]").forEach(button => {
    button.onclick = () => {
      const date = graphCalendarBase();
      date.setDate(1);
      date.setMonth(date.getMonth() + Number(button.dataset.gcalMove));
      graphExplorerState.calendarDate = date.toISOString();
      graphExplorerState.calendarSelected = null;
      graphExplorerState.calendarShowAll = false;
      renderGraphExplorer();
    };
  });
  workspace.querySelector("[data-gcal-today]").onclick = () => {
    graphExplorerState.calendarDate = new Date().toISOString();
    graphExplorerState.calendarSelected = gcalDateKey(new Date());
    graphExplorerState.calendarShowAll = false;
    renderGraphExplorer();
  };
}

function renderGraphCalendarAgenda(list, dateKey) {
  const agenda = document.getElementById("gcalAgenda");
  if (!agenda) return;
  const sorted = [...list].sort((a, b) => new Date(a.start) - new Date(b.start));
  const shown = graphExplorerState.calendarShowAll ? sorted : sorted.slice(0, 10);
  graphCalendarShown = shown;
  const day = new Date(dateKey + "T00:00");
  const totalMinutes = sorted.reduce((sum, meeting) => sum + gcalMinutes(meeting), 0);
  const now = Date.now();
  let lastPart = null;
  const rows = shown.map((meeting, index) => {
    const hour = new Date(meeting.start).getHours();
    const part = meeting.isAllDay ? "ALL DAY" : hour < 12 ? "MORNING" : hour < 17 ? "AFTERNOON" : "EVENING";
    const heading = part !== lastPart ? `<div class="gcal-part">${part}</div>` : "";
    lastPart = part;
    const isLive = !meeting.cancelled && new Date(meeting.start) <= now && now <= new Date(meeting.end);
    const invited = meeting.attendees?.length || 0;
    return `${heading}<button type="button" class="gcal-row${meeting.cancelled ? " cancelled" : ""}" data-gcal-meeting="${index}" style="--c:${GCAL_COLORS[meeting.status] || GCAL_COLORS.busy}">
      <span class="gcal-time">${meeting.isAllDay ? "All day" : escapeHtml(gcalTime(meeting.start))}<small>${meeting.isAllDay ? "" : `${gcalMinutes(meeting)} min`}</small></span>
      <span class="gcal-mark"></span>
      <span class="gcal-text"><b>${escapeHtml(meeting.subject)}${isLive ? '<span class="gcal-live">LIVE</span>' : ""}</b>
        <small>${escapeHtml(meeting.organizer || "Unknown organizer")} · ${invited} invited${meeting.cancelled ? " · cancelled" : ""}</small></span>
    </button>`;
  }).join("");
  agenda.innerHTML = `
    <h3>${escapeHtml(day.toLocaleDateString([], { weekday: "long" }))}, ${escapeHtml(day.toLocaleDateString([], { day: "numeric", month: "long" }))}</h3>
    <p class="gcal-sub">${sorted.length
      ? `${sorted.length} meeting${sorted.length === 1 ? "" : "s"} · ${Math.round(totalMinutes / 6) / 10} h · ${escapeHtml(gcalTime(sorted[0].start))} to ${escapeHtml(gcalTime(sorted[sorted.length - 1].end))}`
      : "A free day"}</p>
    ${rows || '<p class="gcal-empty">Nothing scheduled.</p>'}
    ${sorted.length > shown.length ? `<button type="button" class="gcal-more" data-gcal-more>Show ${sorted.length - shown.length} more</button>` : ""}`;
  agenda.querySelectorAll("[data-gcal-meeting]").forEach(row => {
    row.onclick = () => openMeetingDetailsDrawer(graphCalendarShown[Number(row.dataset.gcalMeeting)]);
  });
  const more = agenda.querySelector("[data-gcal-more]");
  if (more) more.onclick = () => { graphExplorerState.calendarShowAll = true; renderGraphCalendarAgenda(list, dateKey); };
}

function bindGraphEvents() {
  document.querySelectorAll("[data-event-id]").forEach(card => {
    card.onclick = () => openEventDrawer(card.dataset.eventId, card.dataset.eventUser);
  });
}

function graphSiteDaysInactive(site) {
  if (!site.lastActivity) return null;
  return Math.floor((Date.now() - new Date(site.lastActivity).getTime()) / 86400000);
}

function graphSiteIsEmpty(site) {
  return !(site.files || []).length && (site.lists || []).length <= 1;
}

function graphSiteIsStale(site) {
  const days = graphSiteDaysInactive(site);
  return days !== null && days > 180;
}

function graphSiteNameKey(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function graphSiteDuplicateMap(sites) {
  const groups = {};
  sites.forEach(site => {
    const key = graphSiteNameKey(site.displayName);
    (groups[key] = groups[key] || []).push(site);
  });
  const map = new Map();
  Object.values(groups).filter(group => group.length > 1).forEach(group => {
    group.forEach(site => map.set(site.id, group));
  });
  return map;
}

function graphSiteStatStrip(sites, dupMap) {
  if (!sites.length) return "";
  const empty = sites.filter(graphSiteIsEmpty);
  const stale = sites.filter(graphSiteIsStale);
  const archival = sites.filter(site => graphSiteIsEmpty(site) && graphSiteIsStale(site));
  const dupGroups = new Set(Array.from(dupMap.values()).map(group => group.map(site => site.id).sort().join(",")));
  const pct = Math.round(empty.length / sites.length * 100);
  return `<div class="graph-task-stat-strip">
    <button type="button" class="graph-stat-tile stat-unassigned" data-site-stat-filter="Empty">
      <b>${empty.length}</b><span class="label">Empty sites</span><span class="sub">${pct}% have no files uploaded</span>
    </button>
    <button type="button" class="graph-stat-tile stat-priority" data-site-stat-filter="Stale">
      <b>${stale.length}</b><span class="label">Inactive 180+ days</span><span class="sub">no recent activity</span>
    </button>
    <button type="button" class="graph-stat-tile stat-orphan" data-site-stat-filter="Duplicate">
      <b>${dupMap.size}</b><span class="label">Possible duplicates</span><span class="sub">${dupGroups.size} name group${dupGroups.size !== 1 ? "s" : ""} split work</span>
    </button>
    <button type="button" class="graph-stat-tile stat-overdue" data-site-stat-filter="Archival">
      <b>${archival.length}</b><span class="label">Archival candidates</span><span class="sub">empty and inactive</span>
    </button>
  </div>`;
}

function graphSiteDupBanner(dupMap) {
  if (!dupMap.size) return "";
  const seen = new Set();
  const groups = [];
  dupMap.forEach(group => {
    const key = group.map(site => site.id).sort().join(",");
    if (seen.has(key)) return;
    seen.add(key);
    groups.push(group);
  });
  const warnSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>`;
  return `<div class="graph-attn-banner">
    <div class="graph-attn-icon">${warnSvg}</div>
    <div><b>${groups.length} site name group${groups.length !== 1 ? "s" : ""} may be splitting the same work</b> — ${groups.map(group => {
      const totalFiles = group.reduce((sum, site) => sum + (site.files || []).length, 0);
      return `${escapeHtml(group.map(site => site.displayName).join(" / "))} (${group.length} sites, ${totalFiles} files total)`;
    }).join("; ")}.</div>
  </div>`;
}

function bindGraphSiteStatTiles() {
  document.querySelectorAll("[data-site-stat-filter]").forEach(tile => {
    tile.onclick = () => {
      graphExplorerState.filter = tile.dataset.siteStatFilter;
      graphExplorerState.page = 1;
      renderGraphToolbar();
      renderGraphSection();
    };
  });
}

function renderGraphSites() {
  const matching = [...(graphData?.sharePoint?.sites || [])].filter(site => graphSearch(site.displayName, site.webUrl, site.owner));
  const dupMap = graphSiteDuplicateMap(matching);
  const rows = matching.filter(site => {
    const filter = graphExplorerState.filter;
    if (filter === "all") return true;
    if (filter === "files") return site.files?.length;
    if (filter === "lists") return site.lists?.length;
    if (filter === "Empty") return graphSiteIsEmpty(site);
    if (filter === "Stale") return graphSiteIsStale(site);
    if (filter === "Archival") return graphSiteIsEmpty(site) && graphSiteIsStale(site);
    if (filter === "Duplicate") return dupMap.has(site.id);
    return true;
  });
  rows.sort((a, b) => graphExplorerState.sort === "newest"
    ? new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0) : a.displayName.localeCompare(b.displayName));
  const statStrip = graphSiteStatStrip(matching, dupMap);
  const dupBanner = graphSiteDupBanner(dupMap);
  if (!rows.length) {
    document.getElementById("graphPagination").innerHTML = "";
    document.getElementById("graphWorkspace").innerHTML = `${statStrip}${dupBanner}<div class="graph-empty-state"><span aria-hidden="true">⌕</span><h3>No SharePoint sites found</h3><p>Try changing the search or site filter.</p></div>`;
    bindGraphSiteStatTiles();
    return;
  }
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML = `${statStrip}${dupBanner}<div class="gx-list">${page.map((site, index) => {
    const isEmpty = graphSiteIsEmpty(site);
    const isStale = graphSiteIsStale(site);
    const isDup = dupMap.has(site.id);
    const flags = isEmpty || isStale || isDup
      ? `<span class="graph-site-flags">${isEmpty ? '<span class="graph-warn-pill graph-warn-pill--muted">Empty</span>' : ""}${isStale ? '<span class="graph-warn-pill graph-warn-pill--muted">Inactive</span>' : ""}${isDup ? '<span class="graph-warn-pill">Possible duplicate</span>' : ""}</span>`
      : "";
    return `<article class="gx-row gx-site" style="--site:${graphHue(index + 2)}"><button type="button" data-site-id="${escapeHtml(site.id)}">
      <span class="graph-site-icon">${escapeHtml((site.displayName || "S").trim()[0] || "S")}</span>
      <span class="gx-row-main"><b>${escapeHtml(site.displayName)}</b><small>${site.lists?.length || 0} lists · ${site.files?.length || 0} files/folders · ${site.lastActivity ? `Active ${graphDate(site.lastActivity)}` : "Activity unavailable"}</small></span>
      ${flags}
    </button><a href="${escapeHtml(site.webUrl)}" target="_blank" rel="noreferrer">Open site ↗</a></article>`;
  }).join("")}</div>`;
  document.querySelectorAll("[data-site-id]").forEach(card => card.onclick = () => openSiteDrawer(card.dataset.siteId));
  bindGraphSiteStatTiles();
}

function renderGraphEmployees() {
  let rows = [...(graphData?.employees || [])].filter(employee => graphSearch(employee.name, employee.id, employee.team, employee.email));
  rows = rows.filter(employee => graphExplorerState.filter === "all" ||
    (graphExplorerState.filter === "matched" ? employee.matched : !employee.matched));
  const meNorm = (typeof loggedInUserName !== "undefined" ? loggedInUserName : "").trim().toLowerCase();
  rows.sort((a, b) => {
    const aMe = meNorm && a.name.trim().toLowerCase() === meNorm ? -1 : 0;
    const bMe = meNorm && b.name.trim().toLowerCase() === meNorm ? 1 : 0;
    if (aMe + bMe !== 0) return aMe + bMe;
    return graphExplorerState.sort === "count"
      ? (b.calendar?.events || 0) - (a.calendar?.events || 0) : a.name.localeCompare(b.name);
  });
  if (!rows.length) return graphEmpty("No employees found", "Try changing the search or match filter.");
  const page = graphPage(rows);
  if (graphExplorerState.employeeView === "cards") {
    document.getElementById("graphWorkspace").innerHTML = `<div class="graph-employee-card-grid">${page.map(employee => `
      <button class="graph-employee-card" data-graph-employee="${escapeHtml(employee.id)}">
        <span class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Matched" : "Unmatched"}</span>
        <h3>${escapeHtml(employee.name)}</h3>
        <p>${escapeHtml(employee.designation || "Designation unavailable")}</p>
        <small>${escapeHtml(employee.id)} · ${escapeHtml(employee.team || "Department unavailable")}</small>
        <div class="graph-task-meta"><span>${employee.planner?.assigned || 0} tasks</span><span>${employee.calendar?.events || 0} events</span><span>KPI ${employee.kpi ?? "—"}</span></div>
      </button>`).join("")}</div>`;
    document.querySelectorAll("[data-graph-employee]").forEach(row => row.onclick = () => openGraphEmployeeDrawer(row.dataset.graphEmployee));
    return;
  }
  document.getElementById("graphWorkspace").innerHTML = `<div class="graph-employee-table">
    <div class="graph-table-head"><span>Employee</span><span>Match</span><span>Planner</span><span>Calendar</span><span>KPI</span></div>
    ${page.map(employee => `<button class="graph-employee-row" data-graph-employee="${escapeHtml(employee.id)}">
      <span><b>${escapeHtml(employee.name)}</b><small>${escapeHtml(employee.id)} · ${escapeHtml(employee.team)}</small></span>
      <span class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Matched" : "Unmatched"}</span>
      <span>${employee.planner?.assigned || 0} tasks</span><span>${employee.calendar?.events || 0} events</span><span>${employee.kpi ?? "—"}</span>
    </button>`).join("")}</div>`;
  document.querySelectorAll("[data-graph-employee]").forEach(row => row.onclick = () => openGraphEmployeeDrawer(row.dataset.graphEmployee));
}

function graphDetail(label, value) {
  return `<div class="graph-detail-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "—")}</strong></div>`;
}

function openGraphDrawer(titleText, eyebrow, body) {
  document.getElementById("graphDrawerContent").innerHTML =
    `<p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(titleText)}</h2>${body}`;
  const overlay = document.getElementById("graphDrawerOverlay");
  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add("open"));
  document.getElementById("graphDrawerClose").focus();
  document.body.classList.add("graph-drawer-open");
}

function closeGraphDrawer() {
  const overlay = document.getElementById("graphDrawerOverlay");
  overlay.classList.remove("open");
  document.body.classList.remove("graph-drawer-open");
  setTimeout(() => { overlay.hidden = true; }, 180);
}

const GRAPH_TASK_STATUS_COLOR = {
  "completed": "#22c55e",
  "in progress": "#3b82f6",
  "not started": "#94a3b8",
  "overdue": "#ef4444",
};
function graphTaskStatusColor(status) {
  return GRAPH_TASK_STATUS_COLOR[(status || "").toLowerCase()] || "#94a3b8";
}
const GRAPH_STATUS_SORT_RANK = { "overdue": 0, "in progress": 1, "not started": 2, "completed": 3 };

function openPlanDrawer(id) {
  const plan = (graphData?.planner?.plans || []).find(item => item.id === id);
  if (!plan) return;
  const tasks = plan.tasks || [], completed = tasks.filter(task => graphStatus(task) === "Completed").length;
  const open = tasks.length - completed;
  const pct = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  const ringColor = planTierColor(pct);
  const summary = plan.summary || {};
  const sortedTasks = [...tasks].sort((a, b) =>
    (GRAPH_STATUS_SORT_RANK[graphStatus(a).toLowerCase()] ?? 9) - (GRAPH_STATUS_SORT_RANK[graphStatus(b).toLowerCase()] ?? 9));

  openGraphDrawer(plan.title, "Planner plan", `
    <div class="graphd-stat-strip">
      <div class="graphd-ring" style="--pct:${pct};--c:${ringColor}"><div class="graphd-ring-inner" style="color:${ringColor}">${pct}%</div></div>
      <div class="graphd-stat-tiles">
        <div><strong>${tasks.length}</strong><span>Tasks</span></div>
        <div><strong>${open}</strong><span>Open</span></div>
        <div><strong>${completed}</strong><span>Completed</span></div>
      </div>
    </div>
    <div class="graph-detail-stack">
      ${graphDetail("Owner / Group", plan.owner || plan.groupName || "Not provided")}
      ${graphDetail("Created date", plan.createdDateTime ? graphDate(plan.createdDateTime) : "Not provided by Graph")}
    </div>
    ${Object.keys(summary).length ? `<div class="graphd-status-badges">${Object.entries(summary).map(([name, count]) =>
      `<span class="graphd-status-badge" style="background:color-mix(in srgb, ${graphTaskStatusColor(name)} 16%, white);color:${graphTaskStatusColor(name)}">${escapeHtml(name)}: ${escapeHtml(count)}</span>`
    ).join("")}</div>` : ""}
    <h3>Tasks</h3>
    <div class="graph-mini-list">${sortedTasks.map(task => {
      const status = graphStatus(task);
      const isOverdue = status === "Overdue";
      return `<button class="graphd-task-row${isOverdue ? " graphd-task-row--overdue" : ""}" data-drawer-task="${escapeHtml(task.id)}">
        <span class="graphd-task-dot" style="background:${graphTaskStatusColor(status)}"></span>
        <span class="graphd-task-title">${escapeHtml(task.title)}</span>
        <span class="graphd-task-status" style="color:${graphTaskStatusColor(status)}">${escapeHtml(status)}</span>
      </button>`;
    }).join("")}</div>
    <details class="graphd-tech-details">
      <summary>Technical details</summary>
      <div class="graph-detail-stack">${graphDetail("Plan ID", plan.id)}${graphDetail("Group ID", plan.groupId)}</div>
    </details>`);
  document.querySelectorAll("[data-drawer-task]").forEach(button => button.onclick = () => openTaskDrawer(button.dataset.drawerTask));
}

const GRAPH_PRIORITY_COLOR = { "urgent": "#ef4444", "high": "#f59e0b", "medium": "#94a3b8", "low": "#94a3b8" };

function openTaskDrawer(id) {
  const task = graphTasks().find(item => item.id === id);
  if (!task) return;
  const checklist = Array.isArray(task.checklist) ? task.checklist : Object.values(task.checklist || {});
  const comments = Array.isArray(task.comments) ? task.comments : Object.values(task.comments || {});
  const hasDescription = !!(task.description && task.description.trim());
  const status = graphStatus(task);
  const statusColor = graphTaskStatusColor(status);
  const priority = graphPriority(task.priority);
  const priorityColor = GRAPH_PRIORITY_COLOR[priority.toLowerCase()] || "#94a3b8";
  const showPriority = priority === "Urgent" || priority === "High";
  const isOverdue = status === "Overdue";
  const overdueDays = isOverdue ? graphDaysOverdue(task) : 0;
  const hasOwner = (task.assignees || []).length > 0;
  const warnSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>`;

  openGraphDrawer(task.title, "Planner task", `
    <div class="graphd-badge-row">
      <span class="graphd-status-badge" style="background:color-mix(in srgb, ${statusColor} 16%, white);color:${statusColor}">${isOverdue ? warnSvg : ""}${escapeHtml(isOverdue ? `Overdue · ${overdueDays}d` : status)}</span>
      ${showPriority ? `<span class="graphd-status-badge" style="background:color-mix(in srgb, ${priorityColor} 16%, white);color:${priorityColor}">${escapeHtml(priority)} priority</span>` : ""}
    </div>
    ${isOverdue ? `<div class="graphd-overdue-banner">${warnSvg}<div><b>${overdueDays} day${overdueDays !== 1 ? "s" : ""} overdue</b>${hasOwner ? "" : " and no one is assigned"} — due ${escapeHtml(graphDateTime(task.dueDateTime))}.</div></div>` : ""}
    <div class="graph-detail-stack">
      ${hasOwner ? graphDetail("Assigned user", task.assignees.join(", ")) : `<div class="graph-detail-row"><span>Assigned user</span><strong style="color:#b45309">No owner assigned</strong></div>`}
      ${graphDetail("Plan", task.planTitle)}
      ${graphDetail("Group", task.groupName)}
      ${graphDetail("Due date", task.dueDateTime ? graphDateTime(task.dueDateTime) : "Not set")}
      ${graphDetail("Start date", task.startDateTime ? graphDateTime(task.startDateTime) : "Not set")}
      ${graphDetail("Progress", `${task.percentComplete || 0}%`)}
      ${task.completedDateTime ? graphDetail("Completion date", graphDateTime(task.completedDateTime)) : ""}
    </div>
    ${hasDescription ? `<div class="graph-detail-stack">${graphDetail("Description", task.description)}</div>` : ""}
    ${checklist.length ? `<h3>Checklist</h3><div class="graph-mini-list">${checklist.map(item =>
      `<div>${item.isChecked || item.completed ? "✓" : "○"} ${escapeHtml(item.title || item.name || "Checklist item")}</div>`
    ).join("")}</div>` : ""}
    ${comments.length ? `<h3>Comments</h3><div class="graph-mini-list">${comments.map(comment =>
      `<div><strong>${escapeHtml(comment.author || comment.createdBy || "User")}</strong><p>${escapeHtml(comment.text || comment.content || comment.body || "")}</p></div>`
    ).join("")}</div>` : ""}
    <details class="graphd-tech-details">
      <summary>Technical details</summary>
      <div class="graph-detail-stack">${graphDetail("Task ID", task.id)}${graphDetail("Plan ID", task.planId)}${graphDetail("Assignee IDs", (task.assigneeIds || []).join(", ") || "—")}</div>
    </details>`);
}

function openEventDrawer(id, employeeId) {
  const event = graphEvents().find(item => item.id === id && item.employee?.id === employeeId);
  if (!event) return;
  const start = new Date(event.start);
  const end = new Date(event.end);
  openGraphDrawer(event.subject, "Calendar event", `<div class="graph-detail-stack">
    ${graphDetail("Organizer", event.organizer)}${graphDetail("Employee calendar", event.employee?.name)}
    ${graphDetail("Date", graphDate(event.start))}
    ${graphDetail("Start time", start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
    ${graphDetail("End time", end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}
    ${graphDetail("Duration", `${event.durationMinutes || Math.max(0, Math.round((end - start) / 60000))} minutes`)}
    ${graphDetail("Attendees", (event.attendees || []).join(", ") || "Not available")}
    ${graphDetail("Location", event.location || "Not specified")}${graphDetail("Description", event.description || "No description")}
    ${graphDetail("Category", (event.categories || []).join(", ") || "General")}${graphDetail("All-day event", event.isAllDay ? "Yes" : "No")}
    ${graphDetail("Status", event.isCancelled ? "Cancelled" : event.showAs)}
  </div>${event.meetingLink ? `<a class="button graph-open-link" href="${escapeHtml(event.meetingLink)}" target="_blank" rel="noopener noreferrer">Join meeting</a>` : ""}
  ${event.webLink ? `<a class="button secondary-button graph-open-link" href="${escapeHtml(event.webLink)}" target="_blank" rel="noopener noreferrer">Open in Outlook</a>` : ""}`);
}

// Details of one meeting (all attendees' calendar copies grouped), opened from the Overview "Today" card.
// Works for meetings that haven't started yet; shows each invitee's own calendar status.
function openMeetingDetailsDrawer(meeting, { onRemind, reminderSet } = {}) {
  if (!meeting) return;
  const start = new Date(meeting.start), end = new Date(meeting.end);
  const time = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const mins = Math.max(0, Math.round((end - start) / 60000));
  const untilMin = Math.round((start - Date.now()) / 60000);
  const when = untilMin > 0
    ? `Starts in ${untilMin >= 60 ? `${Math.floor(untilMin / 60)}h ${untilMin % 60}m` : `${untilMin} min`}`
    : Date.now() <= end ? "In progress" : "Ended";
  const rows = graphMeetingAttendeeRows(meeting, [meeting]);
  const said = { busy: "Busy · attending", tentative: "Tentative", free: "Marked free", unknown: "Not tracked" };
  const counts = { busy: 0, tentative: 0, free: 0, unknown: 0 };
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  const people = rows.length ? `<div class="graph-mini-list">${rows.map(r => `
      <button type="button" ${r.employee ? `data-meeting-person="${escapeHtml(r.employee.id)}"` : "disabled"}>
        <span>${escapeHtml(r.name || "—")}</span><span class="graph-meeting-status status-${r.status}">${said[r.status] || r.status}</span>
      </button>`).join("")}</div>` : `<p class="graph-meeting-empty">No attendee list on this invite.</p>`;
  openGraphDrawer(meeting.subject, `Meeting · ${when}`, `
    <div class="graph-detail-stack">
      ${graphDetail("Date", start.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" }))}
      ${graphDetail("Time", `${time(start)} – ${time(end)} (${mins} min)`)}
      ${graphDetail("Organizer", meeting.organizer || "—")}
      ${graphDetail("Location", meeting.location || (meeting.meetingLink ? "Microsoft Teams" : "Not specified"))}
    </div>
    <div class="graph-meeting-actions">
      ${meeting.meetingLink ? `<a class="button graph-open-link" href="${escapeHtml(meeting.meetingLink)}" target="_blank" rel="noopener noreferrer">Join in Teams</a>` : ""}
      ${meeting.webLink ? `<a class="button secondary-button graph-open-link" href="${escapeHtml(meeting.webLink)}" target="_blank" rel="noopener noreferrer">Open in Outlook</a>` : ""}
      ${onRemind && untilMin > 0 ? `<button type="button" class="button secondary-button" data-meeting-remind ${reminderSet ? "disabled" : ""}>${reminderSet ? "Reminder set ✓" : "Remind me"}</button>` : ""}
      <button type="button" class="button secondary-button" data-meeting-calendar>Open in calendar ›</button>
    </div>
    <h3 class="graph-meeting-h">Invited · ${rows.length}</h3>
    <p class="graph-meeting-sum"><b>${counts.busy}</b> attending · <b>${counts.tentative}</b> tentative · <b>${counts.free}</b> marked free · <b>${counts.unknown}</b> not tracked</p>
    ${people}`);
  const content = document.getElementById("graphDrawerContent");
  content.querySelectorAll("[data-meeting-person]").forEach(b => { b.onclick = () => openGraphEmployeeDrawer(b.dataset.meetingPerson); });
  const remind = content.querySelector("[data-meeting-remind]");
  if (remind) remind.onclick = () => { onRemind(); remind.disabled = true; remind.textContent = "Reminder set ✓"; };
  content.querySelector("[data-meeting-calendar]").onclick = () => {
    closeGraphDrawer();
    graphOpenFromOverview({ section: "calendar", label: `${meeting.subject} at ${time(start)}` });
  };
}

function openCalendarDayDrawer(dateKey) {
  const events = graphEvents()
    .filter(event => {
      const date = new Date(event.start);
      const eventKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return eventKey === dateKey;
    })
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  const label = new Date(`${dateKey}T00:00:00`).toLocaleDateString([], {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  openGraphDrawer(label, "Calendar day", `
    <div class="graph-day-summary">
      <strong>${events.length}</strong>
      <span>events scheduled</span>
    </div>
    <div class="graph-day-event-list">
      ${events.map(event => `
        <button class="graph-day-event event-${event.showAs || "busy"}"
          data-day-event="${escapeHtml(event.id)}"
          data-day-user="${escapeHtml(event.employee?.id)}">
          <time>${new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <span>
            <strong>${escapeHtml(event.subject)}</strong>
            <small>${escapeHtml(event.employee?.name || "")}${event.organizer ? ` · ${escapeHtml(event.organizer)}` : ""}</small>
          </span>
          <i>${event.durationMinutes || 0} min</i>
        </button>
      `).join("") || '<p class="subtle">No events scheduled.</p>'}
    </div>`);
  document.querySelectorAll("[data-day-event]").forEach(button => {
    button.onclick = () => openEventDrawer(button.dataset.dayEvent, button.dataset.dayUser);
  });
}

function openSiteDrawer(id) {
  const allSites = graphData?.sharePoint?.sites || [];
  const site = allSites.find(item => item.id === id);
  if (!site) return;
  const dupMap = graphSiteDuplicateMap(allSites);
  const siblings = (dupMap.get(id) || []).filter(item => item.id !== id);
  const isEmpty = graphSiteIsEmpty(site);
  const isStale = graphSiteIsStale(site);
  const daysInactive = graphSiteDaysInactive(site);
  const warnSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>`;
  openGraphDrawer(site.displayName, "SharePoint site", `
    ${isEmpty || isStale || siblings.length ? `<div class="graphd-badge-row">
      ${isEmpty ? `<span class="graphd-status-badge" style="background:#fef3c7;color:#b45309">No files uploaded</span>` : ""}
      ${isStale ? `<span class="graphd-status-badge" style="background:#eff6ff;color:#1d4ed8">Inactive ${daysInactive}d</span>` : ""}
      ${siblings.length ? `<span class="graphd-status-badge" style="background:#fee2e2;color:#b91c1c">Possible duplicate</span>` : ""}
    </div>` : ""}
    ${siblings.length ? `<div class="graphd-overdue-banner" style="background:#fff7ed;border-color:#fed7aa;color:#9a3412">${warnSvg}<div>${siblings.length} other site${siblings.length !== 1 ? "s" : ""} share a near-identical name and may be splitting this work: ${siblings.map(item => `<b>${escapeHtml(item.displayName)}</b> (${(item.files || []).length} files)`).join(", ")}.</div></div>` : ""}
    <div class="graph-detail-stack">
    ${graphDetail("Last activity", site.lastActivity ? graphDateTime(site.lastActivity) : "No recorded activity")}${graphDetail("Lists", site.lists?.length || 0)}
    ${graphDetail("Files / folders", site.files?.length || 0)}
  </div><h3>Lists</h3><div class="graph-mini-list">${(site.lists || []).map(item =>
    `<a href="${escapeHtml(item.webUrl)}" target="_blank">${escapeHtml(item.displayName)}<span>${escapeHtml(item.template)}</span></a>`
  ).join("") || "No lists"}</div><h3>Files and folders</h3><div class="graph-mini-list">${(site.files || []).map(item =>
    `<a href="${escapeHtml(item.webUrl)}" target="_blank">${escapeHtml(item.name)}<span>${escapeHtml(item.type)}</span></a>`
  ).join("") || "No files"}</div><a class="button graph-open-link" href="${escapeHtml(site.webUrl)}" target="_blank" rel="noopener noreferrer">Open SharePoint site</a>
  <details class="graphd-tech-details">
    <summary>Technical details</summary>
    <div class="graph-detail-stack">${graphDetail("Site ID", site.id)}${graphDetail("Owner", site.owner || "Not provided by Graph")}${graphDetail("URL", site.webUrl)}</div>
  </details>`);
}

function openGraphEmployeeDrawer(id) {
  const employee = (graphData?.employees || []).find(item => item.id === id);
  if (!employee) return;
  openGraphDrawer(employee.name, "Employee match", `<div class="graph-detail-stack">
    ${graphDetail("Employee ID", employee.id)}${graphDetail("Department", employee.team)}
    ${graphDetail("Designation", employee.designation)}${graphDetail("Match status", employee.matched ? "Matched" : "Unmatched")}
    ${graphDetail("Microsoft 365 email", employee.email)}${graphDetail("Teams status", employee.teams?.status || "Unknown")}
    ${graphDetail("KPI", employee.kpi ?? "Not scored")}${graphDetail("Performance band", employee.band || "—")}
    ${graphDetail("Attendance present", employee.attendance?.present || 0)}${graphDetail("Attendance absent", employee.attendance?.absent || 0)}
    ${graphDetail("Planner tasks", employee.planner?.assigned || 0)}${graphDetail("Calendar events", employee.calendar?.events || 0)}
    ${graphDetail("Meeting hours", employee.calendar?.meetingHours || 0)}
    ${graphDetail("SharePoint pages visited", employee.sharePoint?.pagesVisited || 0)}
    ${graphDetail("SharePoint files viewed / edited", employee.sharePoint?.filesViewedEdited || 0)}
  </div><button type="button" class="button graph-open-link" id="graphOpenEmployee360">Open full Employee 360°</button>`);
  document.getElementById("graphOpenEmployee360").onclick = () => {
    closeGraphDrawer();
    showEmployeeWorkspace(employee);
  };
}
