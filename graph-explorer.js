const graphExplorerState = {
  section: "plans", search: "", filter: "all", sort: "name",
  page: 1, pageSize: 24, calendarView: "month", employeeView: "table",
  calendarDate: null,
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
    Array.from({ length: 6 }, () => '<div class="graph-skeleton graph-skeleton-card"></div>').join("");
  document.getElementById("graphWorkspace").innerHTML =
    Array.from({ length: 8 }, () => '<div class="graph-skeleton graph-skeleton-row"></div>').join("");
}

async function renderGraph() {
  graphSkeleton();
  try {
    const response = await apiFetch("/api/graph-data");
    graphData = await response.json();
    setupGraphExplorer();
    renderGraphExplorer();
  } catch {
    document.getElementById("graphRefreshLabel").textContent = "Graph data is not available yet";
  }
}

async function refreshGraph() {
  const label = document.getElementById("graphRefreshLabel");
  const button = document.getElementById("graphRefreshButton");
  label.textContent = "Refreshing Microsoft Graph...";
  button.disabled = true;
  try {
    const response = await apiFetch("/api/graph-data");
    if (!response.ok) throw new Error("Graph data could not be loaded");
    graphData = await response.json();
    renderGraphExplorer();
  } catch (error) {
    label.textContent = `Refresh failed: ${error.message}`;
  } finally {
    button.disabled = false;
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

function showEmployeeWorkspaceLegacy(employee) {
  document.getElementById("graphEmployeeSuggestions").hidden = true;
  document.getElementById("graphEmployeeSearch").value = employee.name;
  document.getElementById("graphEmployeeSearchClear").hidden = false;
  document.getElementById("graphBreadcrumbs").textContent = `Microsoft Graph / Employee 360° / ${employee.name}`;
  document.querySelectorAll(".graph-subnav-item").forEach(button => button.classList.remove("active"));
  const tasks = employee.planner?.tasks || [];
  const events = employee.calendar?.items || [];
  const sites = employeeRelevantSites(employee);
  document.getElementById("graphToolbar").innerHTML = `
    <div class="graph-profile-toolbar">
      <span>Unified Microsoft 365 employee record</span>
      <button type="button" id="backToGraphExplorer">Back to explorer</button>
    </div>`;
  document.getElementById("graphPagination").innerHTML = "";
  document.getElementById("graphWorkspace").innerHTML = `
    <article class="graph-employee-profile">
      <header class="graph-profile-hero">
        <div class="graph-profile-avatar">${escapeHtml(employee.name?.[0] || "?")}</div>
        <div>
          <div class="graph-profile-name-row">
            <h2>${escapeHtml(employee.name)}</h2>
            <span class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Microsoft 365 matched" : "Unmatched"}</span>
          </div>
          <p>${escapeHtml(employee.designation || "Designation unavailable")} · ${escapeHtml(employee.team || "Department unavailable")}</p>
          <span>${escapeHtml(employee.id)} · ${escapeHtml(employee.email || "No Microsoft 365 email")}</span>
        </div>
      </header>

      <div class="graph-profile-metrics">
        ${profileMetric("KPI", employee.kpi ?? "—", employee.band || "Performance")}
        ${profileMetric("Planner", employee.planner?.assigned || 0, `${employee.planner?.completed || 0} completed`)}
        ${profileMetric("Calendar", employee.calendar?.events || 0, `${employee.calendar?.meetingHours || 0} meeting hours`)}
        ${profileMetric("Attendance", employee.attendance?.present || 0, `${employee.attendance?.absent || 0} absent days`)}
        ${profileMetric("Teams", employee.teams?.status || "Unknown", employee.teams?.workLocation || "Location unknown")}
        ${profileMetric("Confidence", `${employee.sourceConfidence || 0}%`, "Data source match")}
      </div>

      <div class="graph-profile-grid">
        ${employeeProfilePanel("Planner assignments", "planner", `
          <div class="graph-profile-list">${tasks.length ? tasks.slice(0, 12).map(task => `
            <button data-profile-task="${escapeHtml(task.id)}">
              <span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.planTitle)} · ${escapeHtml(graphStatus(task))}</small></span>
              <i>${task.dueDateTime ? graphDate(task.dueDateTime) : "No due date"}</i>
            </button>`).join("") : profileEmpty("No Planner tasks assigned")}</div>
          ${tasks.length > 12 ? `<p class="graph-profile-more">Showing 12 of ${tasks.length} assignments</p>` : ""}`)}

        ${employeeProfilePanel("Calendar activity", "calendar", `
          <div class="graph-profile-list">${events.length ? events.slice(0, 12).map(event => `
            <button data-profile-event="${escapeHtml(event.id)}">
              <span><strong>${escapeHtml(event.subject)}</strong><small>${graphDateTime(event.start)} · ${escapeHtml(event.organizer)}</small></span>
              <i>${event.durationMinutes || 0} min</i>
            </button>`).join("") : profileEmpty("No calendar events in this period")}</div>
          ${events.length > 12 ? `<p class="graph-profile-more">Showing 12 of ${events.length} events</p>` : ""}`)}

        ${employeeProfilePanel("SharePoint resources", "sharepoint", `
          <p class="graph-profile-note">Department-relevant and tenant SharePoint resources. Per-user SharePoint activity is not exposed by the current API permissions.</p>
          <div class="graph-profile-sites">${sites.map(site => `
            <button data-profile-site="${escapeHtml(site.id)}">
              <span class="graph-site-icon">S</span>
              <span><strong>${escapeHtml(site.displayName)}</strong><small>${site.lists?.length || 0} lists · ${site.files?.length || 0} files/folders</small></span>
            </button>`).join("")}</div>`)}

        ${employeeProfilePanel("Attendance & presence", "attendance", `
          <div class="graph-profile-facts">
            ${profileFact("Present days", employee.attendance?.present || 0)}
            ${profileFact("Absent days", employee.attendance?.absent || 0)}
            ${profileFact("Leave days", employee.attendance?.leave || 0)}
            ${profileFact("Office hours", employee.attendance?.officeHours || 0)}
            ${profileFact("Teams status", employee.teams?.status || "Unknown")}
            ${profileFact("Work location", employee.teams?.workLocation || "Unknown")}
          </div>`)}
      </div>
    </article>`;
  document.getElementById("backToGraphExplorer").onclick = clearEmployeeWorkspaceSearch;
  document.querySelectorAll("[data-profile-task]").forEach(button => button.onclick = () => openTaskDrawer(button.dataset.profileTask));
  document.querySelectorAll("[data-profile-event]").forEach(button => button.onclick = () => openEventDrawer(button.dataset.profileEvent, employee.id));
  document.querySelectorAll("[data-profile-site]").forEach(button => button.onclick = () => openSiteDrawer(button.dataset.profileSite));
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
    <span class="graph-live-badge"><i></i> Employee filtered</span>`;
}

function employeeProfileHeader(employee) {
  return `
    <header class="graph-profile-hero">
      <div class="graph-profile-avatar">${escapeHtml(employee.name?.[0] || "?")}</div>
      <div class="graph-profile-identity">
        <div class="graph-profile-name-row">
          <h2>${escapeHtml(employee.name)}</h2>
          <span class="graph-match ${employee.matched ? "yes" : "no"}">${employee.matched ? "Microsoft 365 matched" : "Unmatched"}</span>
        </div>
        <div class="graph-identity-grid">
          ${profileFact("Employee ID", employee.id)}
          ${profileFact("Designation", employee.designation || "Not available")}
          ${profileFact("Department", employee.team || "Not available")}
          ${profileFact("Microsoft 365 email", employee.email || "Not available")}
          ${profileFact("Reporting manager", graphEmployeeManager(employee))}
        </div>
      </div>
    </header>`;
}

function employeeTabs(employee, activeTab) {
  const tasks = employee.planner?.tasks || [];
  const tabs = [
    ["plans", "Planner Plans", employeePlans(employee).length],
    ["tasks", "Planner Tasks", tasks.length],
    ["completed", "Completed Tasks", tasks.filter(task => graphStatus(task) === "Completed").length],
    ["calendar", "Calendar", employee.calendar?.items?.length || 0],
    ["sites", "SharePoint Sites", employeeRelevantSites(employee).length],
  ];
  return `<nav class="graph-employee-tabs" aria-label="Employee Microsoft 365 data">${tabs.map(([id, label, count]) => `
    <button type="button" data-employee-tab="${id}" class="${activeTab === id ? "active" : ""}">
      <span>${escapeHtml(label)}</span><strong>${count}</strong>
    </button>`).join("")}</nav>`;
}

function bindEmployeeTabs(employee) {
  document.querySelectorAll("[data-employee-tab]").forEach(button => {
    button.onclick = () => renderEmployeeOption(employee, button.dataset.employeeTab);
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
  document.querySelectorAll(".graph-subnav-item").forEach(button => button.classList.remove("active"));
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

function showEmployeeWorkspace(employee) {
  graphEmployeeState.employeeId = employee.id;
  graphEmployeeState.tab = "overview";
  document.getElementById("graphEmployeeSuggestions").hidden = true;
  document.getElementById("graphEmployeeSearch").value = graphEmployeeState.query || employee.name;
  document.getElementById("graphEmployeeSearchClear").hidden = false;
  document.getElementById("graphBreadcrumbs").textContent = `Microsoft Graph / Employee 360° / ${employee.name}`;
  document.querySelectorAll(".graph-subnav-item").forEach(button => button.classList.remove("active"));
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
      <section class="graph-employee-overview">
        <div class="graph-attendance-period">
          <div>
            <p class="eyebrow">Attendance reporting month</p>
            <strong>Currently showing: ${escapeHtml(attendanceMonthLabel())}</strong>
            <small>${escapeHtml(attendancePeriod() || "Attendance period has not been generated yet")}</small>
          </div>
          <label for="graphAttendanceMonth">Choose month
            <input id="graphAttendanceMonth" type="month" value="${attendanceMonthValue()}" max="${new Date().toISOString().slice(0, 7)}">
          </label>
          <button type="button" id="graphAttendanceLoad">Fetch selected month</button>
          <span id="graphAttendanceStatus" class="graph-attendance-status" aria-live="polite"></span>
        </div>
        <div class="graph-profile-metrics">
          ${profileMetric("KPI", employee.kpi ?? "—", employee.band || "Performance")}
          ${profileMetric("Planner", employee.planner?.assigned || 0, `${employee.planner?.completed || 0} completed`)}
          ${profileMetric("Calendar", employee.calendar?.events || 0, `${employee.calendar?.meetingHours || 0} meeting hours`)}
          ${profileMetric(`Attendance · ${attendanceMonthLabel()}`, employee.attendance?.present || 0, `${employee.attendance?.absent || 0} absent days`)}
          ${profileMetric("Teams", employee.teams?.status || "Unknown", employee.teams?.workLocation || "Location unknown")}
          ${profileMetric("Confidence", `${employee.sourceConfidence || 0}%`, "Data source match")}
        </div>
        <div class="graph-profile-callout">
          <strong>Choose a Microsoft 365 data area</strong>
          <p>Use the tabs above to view records connected only to this employee.</p>
        </div>
      </section>
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
    ? `<div class="graph-plan-grid">${plans.map((plan, index) => {
      const tasks = plan.tasks || [];
      const completed = tasks.filter(task => graphStatus(task) === "Completed").length;
      const pct = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
      return `<button class="graph-plan-card" data-employee-plan="${escapeHtml(plan.id)}" style="--plan:${graphHue(index)}">
        <span class="graph-plan-mark"></span><small>${escapeHtml(plan.groupName || "Planner")}</small>
        <h3>${escapeHtml(plan.title)}</h3><p>${tasks.length} employee tasks · ${completed} completed</p>
        <div class="graph-progress"><span style="width:${pct}%"></span></div><strong>${pct}%</strong>
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
  openGraphDrawer(plan.title, `${employee.name} · Planner plan`, `<div class="graph-detail-stack">
    ${graphDetail("Plan ID", plan.id)}${graphDetail("Owner / Group", plan.owner || plan.groupName || "Not provided")}
    ${graphDetail("Group ID", plan.groupId)}${graphDetail("Employee tasks", tasks.length)}
    ${graphDetail("Completed", completed)}${graphDetail("Completion", `${tasks.length ? Math.round(completed / tasks.length * 100) : 0}%`)}
  </div><h3>${escapeHtml(employee.name)}'s tasks in this plan</h3>
  <div class="graph-mini-list">${tasks.map(task => `
    <button data-employee-plan-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}
    <span>${escapeHtml(graphStatus(task))}</span></button>`).join("") || "<p>No assigned tasks.</p>"}</div>`);
  document.querySelectorAll("[data-employee-plan-task]").forEach(button => {
    button.onclick = () => openTaskDrawer(button.dataset.employeePlanTask);
  });
}

function renderEmployeeTasks(employee, completedOnly) {
  let tasks = employee.planner?.tasks || [];
  if (completedOnly) tasks = tasks.filter(task => graphStatus(task) === "Completed");
  document.getElementById("graphEmployeeOptionContent").innerHTML = tasks.length
    ? `<div class="graph-task-grid">${tasks.map(task => graphTaskCard(task, completedOnly)).join("")}</div>`
    : employeeOptionEmpty(completedOnly ? "No completed tasks found for this employee." : "No Planner tasks found for this employee.");
  bindGraphTaskCards();
}

function employeeCalendarKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function renderEmployeeCalendar(employee, selectedDate = null) {
  const events = employee.calendar?.items || [];
  const content = document.getElementById("graphEmployeeOptionContent");
  if (selectedDate) {
    const meetings = events.filter(event => employeeCalendarKey(event.start) === selectedDate)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    const label = new Date(`${selectedDate}T00:00:00`).toLocaleDateString([], {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    content.innerHTML = `
      <div class="graph-calendar-selection-header">
        <button type="button" id="employeeCalendarBack">← Back to monthly calendar</button>
        <div><p class="eyebrow">Selected date</p><h3>${escapeHtml(label)}</h3></div>
      </div>
      ${meetings.length ? `<div class="graph-day-event-list">${meetings.map(event => `
        <button class="graph-day-event event-${event.showAs || "busy"}" data-employee-event="${escapeHtml(event.id)}">
          <time>${new Date(event.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
          <span><strong>${escapeHtml(event.subject)}</strong><small>${escapeHtml(event.organizer || "Organizer unavailable")}</small></span>
          <i>${event.durationMinutes || 0} min</i>
        </button>`).join("")}</div>` : employeeOptionEmpty("No calendar meetings found for this date.")}`;
    document.getElementById("employeeCalendarBack").onclick = () => renderEmployeeCalendar(employee);
    document.querySelectorAll("[data-employee-event]").forEach(button => {
      button.onclick = () => openEventDrawer(button.dataset.employeeEvent, employee.id);
    });
    return;
  }
  const base = new Date(graphData?.meta?.periodStart || events[0]?.start || new Date());
  const year = base.getFullYear(), month = base.getMonth();
  const first = new Date(year, month, 1), last = new Date(year, month + 1, 0), cells = [];
  for (let index = 0; index < first.getDay(); index++) cells.push(null);
  for (let day = 1; day <= last.getDate(); day++) cells.push(new Date(year, month, day));
  content.innerHTML = `
    <div class="graph-employee-calendar-heading">
      <div><p class="eyebrow">Employee calendar</p>
      <h3>${base.toLocaleString([], { month: "long", year: "numeric" })}</h3></div>
      <span>Choose a date to see only that day's meetings</span>
    </div>
    <div class="graph-calendar-head">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(day => `<span>${day}</span>`).join("")}</div>
    <div class="graph-calendar-grid graph-employee-calendar">${cells.map(date => {
      if (!date) return '<div class="graph-calendar-day empty"></div>';
      const key = employeeCalendarKey(date);
      const count = events.filter(event => employeeCalendarKey(event.start) === key).length;
      return `<button type="button" class="graph-calendar-day ${count ? "has-events" : ""}" data-employee-date="${key}">
        <span class="graph-day-number">${date.getDate()}</span>
        ${count ? `<strong>${count}</strong><small>${count === 1 ? "meeting" : "meetings"}</small>` : "<small>No meetings</small>"}
      </button>`;
    }).join("")}</div>`;
  document.querySelectorAll("[data-employee-date]").forEach(button => {
    button.onclick = () => renderEmployeeCalendar(employee, button.dataset.employeeDate);
  });
}

function renderEmployeeSites(employee) {
  const sites = employeeRelevantSites(employee);
  document.getElementById("graphEmployeeOptionContent").innerHTML = `
    <p class="graph-profile-note">Microsoft Graph does not expose direct per-user site membership with the current permissions. These resources are matched from the employee's department and tenant activity.</p>
    ${sites.length ? `<div class="graph-site-grid">${sites.map((site, index) => `
      <article class="graph-site-card" style="--site:${graphHue(index + 2)}">
        <button data-employee-site="${escapeHtml(site.id)}"><span class="graph-site-icon">S</span>
        <h3>${escapeHtml(site.displayName)}</h3><p>${site.lists?.length || 0} lists · ${site.files?.length || 0} files/folders</p>
        <small>${site.lastActivity ? `Active ${graphDate(site.lastActivity)}` : "Activity unavailable"}</small></button>
        <a href="${escapeHtml(site.webUrl)}" target="_blank" rel="noopener noreferrer">Quick access ↗</a>
      </article>`).join("")}</div>` : employeeOptionEmpty("No SharePoint sites found for this employee.")}`;
  document.querySelectorAll("[data-employee-site]").forEach(button => {
    button.onclick = () => openSiteDrawer(button.dataset.employeeSite);
  });
}

function profileMetric(label, value, note) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(note)}</small></div>`;
}

function employeeProfilePanel(titleText, type, body) {
  return `<section class="graph-profile-panel graph-profile-${type}"><header><span>${type[0].toUpperCase()}</span><h3>${titleText}</h3></header>${body}</section>`;
}

function profileFact(label, value) {
  return `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function profileEmpty(message) {
  return `<div class="graph-profile-empty">${escapeHtml(message)}</div>`;
}

function setGraphSection(section) {
  graphExplorerState.section = section;
  graphExplorerState.page = 1;
  graphExplorerState.search = "";
  graphExplorerState.filter = "all";
  if (section === "calendar" && !graphExplorerState.calendarDate) {
    graphExplorerState.calendarDate = graphData?.meta?.periodStart || new Date().toISOString();
  }
  renderGraphExplorer();
}

function renderGraphExplorer() {
  const overview = graphData?.overview || {};
  const meta = graphData?.meta || {};
  document.getElementById("graphRefreshLabel").textContent = meta.generatedAt
    ? `Updated ${new Date(meta.generatedAt).toLocaleString()}` : "Not refreshed yet";

  const cards = [
    ["plans", "Planner plans", overview.plans || 0, "Organized workspaces"],
    ["tasks", "Planner tasks", overview.plannerTasks || 0, "Across every plan"],
    ["completed", "Completed tasks", overview.completedPlannerTasks || 0, "Delivered work"],
    ["calendar", "Calendar events", overview.calendarEvents || 0, "Current month"],
    ["sites", "SharePoint sites", overview.sharePointSites || 0, "Lists and files"],
    ["employees", "Matched employees", `${meta.matchedEmployees || 0}/${meta.totalEmployees || 0}`, "Microsoft 365 identities"],
  ];
  document.getElementById("graphSummaryCards").innerHTML = cards.map(([section, name, value, note], index) => `
    <button class="graph-kpi-card ${graphExplorerState.section === section ? "active" : ""}"
      data-graph-kpi="${section}" style="--accent:${graphHue(index)}">
      <span class="graph-kpi-icon">${index + 1}</span><strong>${escapeHtml(value)}</strong>
      <span>${escapeHtml(name)}</span><small>${escapeHtml(note)}</small>
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
    plans: [["all", "All plans"], ["active", "Has open tasks"], ["complete", "100% complete"]],
    tasks: [["all", "All statuses"], ["Completed", "Completed"], ["In Progress", "In progress"], ["Not Started", "Not started"], ["Overdue", "Overdue"]],
    completed: [["all", "All completed"]],
    calendar: [["all", "All events"], ["busy", "Busy"], ["tentative", "Tentative"], ["free", "Free"]],
    sites: [["all", "All sites"], ["files", "Has files"], ["lists", "Has lists"]],
    employees: [["all", "All employees"], ["matched", "Matched"], ["unmatched", "Unmatched"]],
  }[graphExplorerState.section];
  const viewSwitch = graphExplorerState.section === "calendar" ? `
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
      `<button data-employee-view="${view}" class="${graphExplorerState.employeeView === view ? "active" : ""}>${title(view)}</button>`
    ).join("")}</div>` : "";
  document.getElementById("graphToolbar").innerHTML = `
    <input id="graphGlobalSearch" class="graph-toolbar-search" type="search" value="${escapeHtml(graphExplorerState.search)}"
      placeholder="Search ${graphExplorerState.section}..." aria-label="Search current Graph records">
    <select id="graphFilter">${filters.map(([value, name]) =>
      `<option value="${value}" ${graphExplorerState.filter === value ? "selected" : ""}>${name}</option>`
    ).join("")}</select>
    <select id="graphSort">
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
  document.getElementById("graphFilter").onchange = event => {
    graphExplorerState.filter = event.target.value; graphExplorerState.page = 1; renderGraphSection();
  };
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
  ({
    plans: renderGraphPlans,
    tasks: () => renderGraphTasks(false),
    completed: () => renderGraphTasks(true),
    calendar: renderGraphCalendar,
    sites: renderGraphSites,
    employees: renderGraphEmployees,
  }[graphExplorerState.section])();
}

function renderGraphPlans() {
  let rows = [...(graphData?.planner?.plans || [])].filter(plan => graphSearch(plan.title, plan.groupName, plan.id));
  rows = rows.filter(plan => {
    const tasks = plan.tasks || [];
    if (graphExplorerState.filter === "active") return tasks.some(task => graphStatus(task) !== "Completed");
    if (graphExplorerState.filter === "complete") return tasks.length && tasks.every(task => graphStatus(task) === "Completed");
    return true;
  });
  rows.sort((a, b) => graphExplorerState.sort === "count"
    ? (b.tasks?.length || 0) - (a.tasks?.length || 0) : a.title.localeCompare(b.title));
  if (!rows.length) return graphEmpty("No plans found", "Try changing the search or plan filter.");
  const page = graphPage(rows);
  const allPlans = graphData?.planner?.plans || [];
  document.getElementById("graphWorkspace").innerHTML = `<div class="graph-plan-grid">${page.map(plan => {
    const tasks = plan.tasks || [], completed = tasks.filter(task => graphStatus(task) === "Completed").length;
    const pct = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
    const colorIndex = Math.max(0, allPlans.findIndex(item => item.id === plan.id));
    return `<button class="graph-plan-card" data-plan-id="${escapeHtml(plan.id)}" style="--plan:${graphHue(colorIndex)}">
      <span class="graph-plan-mark"></span><small>${escapeHtml(plan.groupName)}</small><h3>${escapeHtml(plan.title)}</h3>
      <p>${tasks.length} tasks · ${completed} completed</p><div class="graph-progress"><span style="width:${pct}%"></span></div><strong>${pct}%</strong>
    </button>`;
  }).join("")}</div>`;
  document.querySelectorAll("[data-plan-id]").forEach(card => card.onclick = () => openPlanDrawer(card.dataset.planId));
}

function renderGraphTasks(completedOnly) {
  let rows = graphTasks().filter(task => !completedOnly || graphStatus(task) === "Completed");
  rows = rows.filter(task => graphSearch(task.title, task.planTitle, task.groupName, ...(task.assignees || [])));
  rows = rows.filter(task => graphExplorerState.filter === "all" || graphStatus(task) === graphExplorerState.filter);
  rows.sort((a, b) => {
    if (graphExplorerState.sort === "newest") return new Date(b.completedDateTime || b.dueDateTime || 0) - new Date(a.completedDateTime || a.dueDateTime || 0);
    if (graphExplorerState.sort === "count") return (b.percentComplete || 0) - (a.percentComplete || 0);
    return a.title.localeCompare(b.title);
  });
  if (!rows.length) return graphEmpty("No tasks found", "Try changing the search or status filter.");
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML =
    `<div class="graph-task-grid">${page.map(task => graphTaskCard(task, completedOnly)).join("")}</div>`;
  bindGraphTaskCards();
}

function graphTaskCard(task, completedOnly = false) {
  const status = graphStatus(task);
  return `<button class="graph-task-card status-${status.toLowerCase().replace(/\s/g, "-")}" data-task-id="${escapeHtml(task.id)}">
    <div class="graph-task-top"><span class="graph-status">${escapeHtml(status)}</span><span>${graphPriority(task.priority)}</span></div>
    <h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.planTitle)}</p>
    <div class="graph-task-meta"><span>${escapeHtml((task.assignees || []).join(", ") || "Unassigned")}</span>
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
  let rows = graphEvents().filter(event => graphSearch(event.subject, event.organizer, event.employee?.name, event.location));
  rows = rows.filter(event => graphExplorerState.filter === "all" || event.showAs === graphExplorerState.filter);
  rows.sort((a, b) => new Date(a.start) - new Date(b.start));
  if (graphExplorerState.calendarView === "month") return renderGraphMonth(rows);
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

function renderGraphMonth(events) {
  const base = graphCalendarBase();
  const year = base.getFullYear(), month = base.getMonth();
  const first = new Date(year, month, 1), last = new Date(year, month + 1, 0), cells = [];
  const monthLabel = base.toLocaleString([], { month: "long", year: "numeric" });
  for (let i = 0; i < first.getDay(); i++) cells.push(null);
  for (let day = 1; day <= last.getDate(); day++) cells.push(new Date(year, month, day));
  document.getElementById("graphPagination").innerHTML = `<span>${events.length} events in ${monthLabel}</span>`;
  document.getElementById("graphWorkspace").innerHTML = `
    <div class="graph-calendar-titlebar">
      <div>
        <p class="eyebrow">Calendar reporting period</p>
        <h2>${monthLabel}</h2>
        <span>${graphDate(graphData?.meta?.periodStart)} – ${graphDate(graphData?.meta?.periodEnd)} · ${escapeHtml(graphData?.meta?.calendarTimeZone || "Local time")}</span>
      </div>
      <div class="graph-calendar-legend" aria-label="Calendar event status legend">
        <span><i class="legend-busy"></i> Busy</span>
        <span><i class="legend-tentative"></i> Tentative</span>
        <span><i class="legend-free"></i> Free</span>
      </div>
    </div>
    <div class="graph-calendar-head">${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day => `<span>${day}</span>`).join("")}</div>
    <div class="graph-calendar-grid">${cells.map(date => {
      if (!date) return '<div class="graph-calendar-day empty"></div>';
      const daily = events.filter(event => {
        const d = new Date(event.start);
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === date.getDate();
      });
      const isToday = date.toDateString() === new Date().toDateString();
      const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      return `<div class="graph-calendar-day ${isToday ? "today" : ""}">
        <button class="graph-day-number" data-calendar-day="${dateKey}" title="View all ${daily.length} events">${date.getDate()}</button>
        ${daily.slice(0, 4).map(event =>
        `<button class="graph-calendar-event event-${event.showAs || "busy"}" data-event-id="${escapeHtml(event.id)}" data-event-user="${escapeHtml(event.employee?.id)}">${escapeHtml(event.subject)}</button>`
      ).join("")}${daily.length > 4 ? `<button class="graph-more" data-calendar-day="${dateKey}">+${daily.length - 4} more</button>` : ""}</div>`;
    }).join("")}</div>`;
  bindGraphEvents();
  document.querySelectorAll("[data-calendar-day]").forEach(button => {
    button.onclick = () => openCalendarDayDrawer(button.dataset.calendarDay);
  });
}

function bindGraphEvents() {
  document.querySelectorAll("[data-event-id]").forEach(card => {
    card.onclick = () => openEventDrawer(card.dataset.eventId, card.dataset.eventUser);
  });
}

function renderGraphSites() {
  let rows = [...(graphData?.sharePoint?.sites || [])].filter(site => graphSearch(site.displayName, site.webUrl, site.owner));
  rows = rows.filter(site => graphExplorerState.filter === "all" ||
    (graphExplorerState.filter === "files" ? site.files?.length : site.lists?.length));
  rows.sort((a, b) => graphExplorerState.sort === "newest"
    ? new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0) : a.displayName.localeCompare(b.displayName));
  if (!rows.length) return graphEmpty("No SharePoint sites found", "Try changing the search or site filter.");
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML = `<div class="graph-site-grid">${page.map((site, index) => `
    <article class="graph-site-card" style="--site:${graphHue(index + 2)}"><button data-site-id="${escapeHtml(site.id)}">
      <span class="graph-site-icon">S</span><h3>${escapeHtml(site.displayName)}</h3>
      <p>${site.lists?.length || 0} lists · ${site.files?.length || 0} files/folders</p>
      <small>${site.lastActivity ? `Active ${graphDate(site.lastActivity)}` : "Activity unavailable"}</small>
    </button><a href="${escapeHtml(site.webUrl)}" target="_blank" rel="noreferrer">Open site ↗</a></article>`).join("")}</div>`;
  document.querySelectorAll("[data-site-id]").forEach(card => card.onclick = () => openSiteDrawer(card.dataset.siteId));
}

function renderGraphEmployees() {
  let rows = [...(graphData?.employees || [])].filter(employee => graphSearch(employee.name, employee.id, employee.team, employee.email));
  rows = rows.filter(employee => graphExplorerState.filter === "all" ||
    (graphExplorerState.filter === "matched" ? employee.matched : !employee.matched));
  rows.sort((a, b) => graphExplorerState.sort === "count"
    ? (b.calendar?.events || 0) - (a.calendar?.events || 0) : a.name.localeCompare(b.name));
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

function openPlanDrawer(id) {
  const plan = (graphData?.planner?.plans || []).find(item => item.id === id);
  if (!plan) return;
  const tasks = plan.tasks || [], completed = tasks.filter(task => graphStatus(task) === "Completed").length;
  const open = tasks.length - completed;
  const summary = plan.summary || {};
  openGraphDrawer(plan.title, "Planner plan", `<div class="graph-detail-stack">
    ${graphDetail("Plan ID", plan.id)}${graphDetail("Owner / Group", plan.owner || plan.groupName || "Not provided")}
    ${graphDetail("Group ID", plan.groupId)}${graphDetail("Created date", plan.createdDateTime ? graphDate(plan.createdDateTime) : "Not provided by Graph")}
    ${graphDetail("Tasks", tasks.length)}${graphDetail("Open tasks", open)}
    ${graphDetail("Completed tasks", completed)}${graphDetail("Completion", `${tasks.length ? Math.round(completed / tasks.length * 100) : 0}%`)}
    ${graphDetail("Reported statuses", Object.entries(summary).map(([name, count]) => `${name}: ${count}`).join(", ") || "Not provided")}
  </div><h3>Tasks</h3><div class="graph-mini-list">${tasks.map(task =>
    `<button data-drawer-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}<span>${escapeHtml(graphStatus(task))}</span></button>`
  ).join("")}</div>`);
  document.querySelectorAll("[data-drawer-task]").forEach(button => button.onclick = () => openTaskDrawer(button.dataset.drawerTask));
}

function openTaskDrawer(id) {
  const task = graphTasks().find(item => item.id === id);
  if (!task) return;
  const checklist = Array.isArray(task.checklist) ? task.checklist : Object.values(task.checklist || {});
  const comments = Array.isArray(task.comments) ? task.comments : Object.values(task.comments || {});
  openGraphDrawer(task.title, "Planner task", `<div class="graph-detail-stack">
    ${graphDetail("Task ID", task.id)}${graphDetail("Status", graphStatus(task))}
    ${graphDetail("Assigned user", (task.assignees || []).join(", ") || "Unassigned")}${graphDetail("Assignee IDs", (task.assigneeIds || []).join(", ") || "—")}
    ${graphDetail("Start date", graphDateTime(task.startDateTime))}
    ${graphDetail("Due date", graphDateTime(task.dueDateTime))}${graphDetail("Priority", graphPriority(task.priority))}
    ${graphDetail("Progress", `${task.percentComplete || 0}%`)}${graphDetail("Completion date", graphDateTime(task.completedDateTime))}
    ${graphDetail("Plan", task.planTitle)}${graphDetail("Plan ID", task.planId)}
    ${graphDetail("Group", task.groupName)}${graphDetail("Description", task.description || "Not returned by the current Graph response")}
    ${graphDetail("Checklist items", checklist.length)}${graphDetail("Comments", comments.length || "Not available")}
  </div>
  <h3>Checklist</h3><div class="graph-mini-list">${checklist.map(item =>
    `<div>${item.isChecked || item.completed ? "✓" : "○"} ${escapeHtml(item.title || item.name || "Checklist item")}</div>`
  ).join("") || "<p>No checklist items available.</p>"}</div>
  <h3>Comments</h3><div class="graph-mini-list">${comments.map(comment =>
    `<div><strong>${escapeHtml(comment.author || comment.createdBy || "User")}</strong><p>${escapeHtml(comment.text || comment.content || comment.body || "")}</p></div>`
  ).join("") || "<p>No comments available.</p>"}</div>`);
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
  const site = (graphData?.sharePoint?.sites || []).find(item => item.id === id);
  if (!site) return;
  openGraphDrawer(site.displayName, "SharePoint site", `<div class="graph-detail-stack">
    ${graphDetail("Site ID", site.id)}${graphDetail("Owner", site.owner || "Not provided by Graph")}${graphDetail("Last activity", graphDateTime(site.lastActivity))}
    ${graphDetail("URL", site.webUrl)}${graphDetail("Lists", site.lists?.length || 0)}${graphDetail("Files / folders", site.files?.length || 0)}
  </div><h3>Lists</h3><div class="graph-mini-list">${(site.lists || []).map(item =>
    `<a href="${escapeHtml(item.webUrl)}" target="_blank">${escapeHtml(item.displayName)}<span>${escapeHtml(item.template)}</span></a>`
  ).join("") || "No lists"}</div><h3>Files and folders</h3><div class="graph-mini-list">${(site.files || []).map(item =>
    `<a href="${escapeHtml(item.webUrl)}" target="_blank">${escapeHtml(item.name)}<span>${escapeHtml(item.type)}</span></a>`
  ).join("") || "No files"}</div><a class="button graph-open-link" href="${escapeHtml(site.webUrl)}" target="_blank" rel="noopener noreferrer">Open SharePoint site</a>`);
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
