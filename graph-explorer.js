const graphExplorerState = {
  section: "plans", search: "", filter: "all", sort: "name",
  page: 1, pageSize: 24, calendarView: "month",
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
  return `hsl(${(index * 57 + 205) % 360} 72% 48%)`;
}

function graphDate(value) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

function graphDateTime(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function graphStatus(task) {
  return task.status !== "Completed" && task.dueDateTime && new Date(task.dueDateTime) < new Date()
    ? "Overdue" : task.status;
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
    const response = await apiFetch("/api/refresh-graph", { method: "POST" });
    const result = await response.json();
    if (!response.ok || result.status !== "refreshed") {
      throw new Error(result.stderr || result.error || "Graph refresh failed");
    }
    graphData = result.graph;
    dataset = await loadDataset({ fresh: true }) || dataset;
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
      if (matches.length) showEmployeeWorkspace(matches[0]);
    }
  };
  employeeClear.onclick = clearEmployeeWorkspaceSearch;
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

function showEmployeeWorkspace(employee) {
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
  renderGraphToolbar();
  renderGraphSection();
}

function renderGraphToolbar() {
  const filters = {
    plans: [["all", "All plans"], ["active", "Has open tasks"], ["complete", "100% complete"]],
    tasks: [["all", "All statuses"], ["Completed", "Completed"], ["In progress", "In progress"], ["Not started", "Not started"], ["Overdue", "Overdue"]],
    completed: [["all", "All completed"]],
    calendar: [["all", "All events"], ["busy", "Busy"], ["tentative", "Tentative"], ["free", "Free"]],
    sites: [["all", "All sites"], ["files", "Has files"], ["lists", "Has lists"]],
    employees: [["all", "All employees"], ["matched", "Matched"], ["unmatched", "Unmatched"]],
  }[graphExplorerState.section];
  const viewSwitch = graphExplorerState.section === "calendar" ? `
    <div class="graph-view-switch">${["month", "week", "day"].map(view =>
      `<button data-calendar-view="${view}" class="${graphExplorerState.calendarView === view ? "active" : ""}">${title(view)}</button>`
    ).join("")}</div>` : "";
  document.getElementById("graphToolbar").innerHTML = `
    <select id="graphFilter">${filters.map(([value, name]) =>
      `<option value="${value}" ${graphExplorerState.filter === value ? "selected" : ""}>${name}</option>`
    ).join("")}</select>
    <select id="graphSort">
      <option value="name" ${graphExplorerState.sort === "name" ? "selected" : ""}>Name A-Z</option>
      <option value="newest" ${graphExplorerState.sort === "newest" ? "selected" : ""}>Newest first</option>
      <option value="count" ${graphExplorerState.sort === "count" ? "selected" : ""}>Highest activity</option>
    </select>${viewSwitch}`;
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
    if (graphExplorerState.filter === "active") return tasks.some(task => task.status !== "Completed");
    if (graphExplorerState.filter === "complete") return tasks.length && tasks.every(task => task.status === "Completed");
    return true;
  });
  rows.sort((a, b) => graphExplorerState.sort === "count"
    ? (b.tasks?.length || 0) - (a.tasks?.length || 0) : a.title.localeCompare(b.title));
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML = `<div class="graph-plan-grid">${page.map((plan, index) => {
    const tasks = plan.tasks || [], completed = tasks.filter(task => task.status === "Completed").length;
    const pct = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
    return `<button class="graph-plan-card" data-plan-id="${escapeHtml(plan.id)}" style="--plan:${graphHue(index + 1)}">
      <span class="graph-plan-mark"></span><small>${escapeHtml(plan.groupName)}</small><h3>${escapeHtml(plan.title)}</h3>
      <p>${tasks.length} tasks · ${completed} completed</p><div class="graph-progress"><span style="width:${pct}%"></span></div><strong>${pct}%</strong>
    </button>`;
  }).join("")}</div>`;
  document.querySelectorAll("[data-plan-id]").forEach(card => card.onclick = () => openPlanDrawer(card.dataset.planId));
}

function renderGraphTasks(completedOnly) {
  let rows = graphTasks().filter(task => !completedOnly || task.status === "Completed");
  rows = rows.filter(task => graphSearch(task.title, task.planTitle, task.groupName, ...(task.assignees || [])));
  rows = rows.filter(task => graphExplorerState.filter === "all" || graphStatus(task) === graphExplorerState.filter);
  rows.sort((a, b) => {
    if (graphExplorerState.sort === "newest") return new Date(b.completedDateTime || b.dueDateTime || 0) - new Date(a.completedDateTime || a.dueDateTime || 0);
    if (graphExplorerState.sort === "count") return (b.percentComplete || 0) - (a.percentComplete || 0);
    return a.title.localeCompare(b.title);
  });
  if (!completedOnly) {
    document.getElementById("graphPagination").innerHTML = `<span>${rows.length} tasks grouped by status</span>`;
    const columns = [
      {
        title: "Not Started",
        className: "not-started",
        rows: rows.filter(task => ["Not started", "In progress"].includes(graphStatus(task))),
      },
      {
        title: "Completed",
        className: "completed",
        rows: rows.filter(task => graphStatus(task) === "Completed"),
      },
      {
        title: "Overdue",
        className: "overdue",
        rows: rows.filter(task => graphStatus(task) === "Overdue"),
      },
    ];
    document.getElementById("graphWorkspace").innerHTML = `
      <div class="graph-status-board">
        ${columns.map(column => `
          <section class="graph-status-column column-${column.className}">
            <header>
              <span class="graph-column-dot"></span>
              <h3>${column.title}</h3>
              <strong>${column.rows.length}</strong>
            </header>
            <div class="graph-status-column-body">
              ${column.rows.map(task => graphTaskCard(task)).join("") ||
                '<p class="graph-empty-column">No tasks</p>'}
            </div>
          </section>
        `).join("")}
      </div>`;
    bindGraphTaskCards();
    return;
  }
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML =
    `<div class="graph-task-grid">${page.map(graphTaskCard).join("")}</div>`;
  bindGraphTaskCards();
}

function graphTaskCard(task) {
  const status = graphStatus(task);
  return `<button class="graph-task-card status-${status.toLowerCase().replace(/\s/g, "-")}" data-task-id="${escapeHtml(task.id)}">
    <div class="graph-task-top"><span class="graph-status">${escapeHtml(status)}</span><span>${graphPriority(task.priority)}</span></div>
    <h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.planTitle)}</p>
    <div class="graph-task-meta"><span>${escapeHtml((task.assignees || []).join(", ") || "Unassigned")}</span>
    <span>${task.dueDateTime ? `Due ${graphDate(task.dueDateTime)}` : "No due date"}</span></div>
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
  const page = graphPage(rows);
  document.getElementById("graphWorkspace").innerHTML = `<div class="graph-agenda">${page.map(event => `
    <button class="graph-event-row event-${event.showAs || "busy"}" data-event-id="${escapeHtml(event.id)}" data-event-user="${escapeHtml(event.employee?.id)}">
      <time>${graphDateTime(event.start)}</time><div><strong>${escapeHtml(event.subject)}</strong>
      <span>${escapeHtml(event.employee?.name)} · ${escapeHtml(event.organizer)}</span></div><span>${event.durationMinutes || 0} min</span>
    </button>`).join("")}</div>`;
  bindGraphEvents();
}

function renderGraphMonth(events) {
  const base = new Date(graphData?.meta?.periodStart || new Date());
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
  const page = graphPage(rows);
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
}

function closeGraphDrawer() {
  const overlay = document.getElementById("graphDrawerOverlay");
  overlay.classList.remove("open");
  setTimeout(() => { overlay.hidden = true; }, 180);
}

function openPlanDrawer(id) {
  const plan = (graphData?.planner?.plans || []).find(item => item.id === id);
  if (!plan) return;
  const tasks = plan.tasks || [], completed = tasks.filter(task => task.status === "Completed").length;
  openGraphDrawer(plan.title, "Planner plan", `<div class="graph-detail-stack">
    ${graphDetail("Plan ID", plan.id)}${graphDetail("Owner / Group", plan.groupName)}
    ${graphDetail("Created date", graphDate(plan.createdDateTime))}${graphDetail("Tasks", tasks.length)}
    ${graphDetail("Completion", `${tasks.length ? Math.round(completed / tasks.length * 100) : 0}%`)}
  </div><h3>Tasks</h3><div class="graph-mini-list">${tasks.map(task =>
    `<button data-drawer-task="${escapeHtml(task.id)}">${escapeHtml(task.title)}<span>${escapeHtml(graphStatus(task))}</span></button>`
  ).join("")}</div>`);
  document.querySelectorAll("[data-drawer-task]").forEach(button => button.onclick = () => openTaskDrawer(button.dataset.drawerTask));
}

function openTaskDrawer(id) {
  const task = graphTasks().find(item => item.id === id);
  if (!task) return;
  openGraphDrawer(task.title, "Planner task", `<div class="graph-detail-stack">
    ${graphDetail("Status", graphStatus(task))}${graphDetail("Assigned user", (task.assignees || []).join(", ") || "Unassigned")}
    ${graphDetail("Due date", graphDateTime(task.dueDateTime))}${graphDetail("Priority", graphPriority(task.priority))}
    ${graphDetail("Progress", `${task.percentComplete || 0}%`)}${graphDetail("Completion date", graphDateTime(task.completedDateTime))}
    ${graphDetail("Plan", task.planTitle)}${graphDetail("Description", task.description || "Not returned by the current Graph response")}
    ${graphDetail("Checklist items", task.checklist?.length || 0)}${graphDetail("Comments", task.comments?.length || "Not available")}
  </div>`);
}

function openEventDrawer(id, employeeId) {
  const event = graphEvents().find(item => item.id === id && item.employee?.id === employeeId);
  if (!event) return;
  openGraphDrawer(event.subject, "Calendar event", `<div class="graph-detail-stack">
    ${graphDetail("Organizer", event.organizer)}${graphDetail("Employee calendar", event.employee?.name)}
    ${graphDetail("Start", graphDateTime(event.start))}${graphDetail("End", graphDateTime(event.end))}
    ${graphDetail("Attendees", (event.attendees || []).join(", ") || "Not available")}
    ${graphDetail("Location", event.location || "Not specified")}${graphDetail("Description", event.description || "No description")}
    ${graphDetail("Status", event.isCancelled ? "Cancelled" : event.showAs)}
  </div>${event.meetingLink ? `<a class="button graph-open-link" href="${escapeHtml(event.meetingLink)}" target="_blank">Join meeting</a>` : ""}
  ${event.webLink ? `<a class="button secondary-button graph-open-link" href="${escapeHtml(event.webLink)}" target="_blank">Open in Outlook</a>` : ""}`);
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
    ${graphDetail("Owner", site.owner || "Not available")}${graphDetail("Last activity", graphDateTime(site.lastActivity))}
    ${graphDetail("URL", site.webUrl)}${graphDetail("Lists", site.lists?.length || 0)}${graphDetail("Files / folders", site.files?.length || 0)}
  </div><h3>Lists</h3><div class="graph-mini-list">${(site.lists || []).map(item =>
    `<a href="${escapeHtml(item.webUrl)}" target="_blank">${escapeHtml(item.displayName)}<span>${escapeHtml(item.template)}</span></a>`
  ).join("") || "No lists"}</div><h3>Files and folders</h3><div class="graph-mini-list">${(site.files || []).map(item =>
    `<a href="${escapeHtml(item.webUrl)}" target="_blank">${escapeHtml(item.name)}<span>${escapeHtml(item.type)}</span></a>`
  ).join("") || "No files"}</div><a class="button graph-open-link" href="${escapeHtml(site.webUrl)}" target="_blank">Open SharePoint site</a>`);
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
    ${graphDetail("Meeting hours", employee.calendar?.meetingHours || 0)}${graphDetail("SharePoint activity", "Available in the SharePoint explorer")}
  </div>`);
}
