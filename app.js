let dataset;
let filteredEmployees = [];
let departmentChartBars = [];

const state = {
  search: "",
  band: "all",
  team: "all",
  confidence: 0,
};

const DEMO_MODE = false;
const DEMO_REFRESH_MESSAGE = "Demo mode: backend refresh is disabled";

const money = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

const bandClass = (band) => band.replace(/\s+/g, "-");

// --- Auth helpers ---
function getToken() {
  return localStorage.getItem("po_token") || "";
}

function authHeaders() {
  const token = getToken();
  return token ? { "Authorization": `Bearer ${token}` } : {};
}

async function apiFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  if (res.status === 401) {
    localStorage.removeItem("po_token");
    window.location.href = "login.html";
    return null;
  }
  return res;
}

function logout() {
  localStorage.removeItem("po_token");
  window.location.href = "login.html";
}

const TEAMS_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes

function drawDonutChart() {
  const canvas = document.getElementById("donutChart");
  if (!canvas) return;
  const SIZE = 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = SIZE + "px";
  canvas.style.height = SIZE + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = SIZE / 2, cy = SIZE / 2;
  const outerR = 80, innerR = 50;
  const total = filteredEmployees.length || 1;

  const segments = [
    { label: "High Performance",  color: "#2fb36d", count: 0 },
    { label: "Need Improvement",  color: "#f3a229", count: 0 },
    { label: "Low Performance",   color: "#db4d5c", count: 0 },
    { label: "Insufficient Data", color: "#dfe6ee", count: 0 },
  ];
  filteredEmployees.forEach((e) => {
    const seg = segments.find((s) => s.label === (e.band || "Insufficient Data"));
    if (seg) seg.count++;
  });

  let startAngle = -Math.PI / 2;
  segments.filter((s) => s.count > 0).forEach((s) => {
    const angle = (s.count / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, outerR, startAngle, startAngle + angle);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    startAngle += angle;
  });

  ctx.beginPath();
  ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
  ctx.fillStyle = "white";
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#172033";
  ctx.font = "900 28px Segoe UI,sans-serif";
  ctx.fillText(filteredEmployees.length, cx, cy - 8);
  ctx.font = "700 11px Segoe UI,sans-serif";
  ctx.fillStyle = "#627084";
  ctx.fillText("employees", cx, cy + 12);

  const legend = document.getElementById("donutLegend");
  if (legend) {
    legend.innerHTML = segments.filter((s) => s.count > 0).map((s) => `
      <div class="donut-legend-item">
        <span class="donut-dot" style="background:${s.color}"></span>
        <div class="donut-legend-info">
          <strong>${s.count}</strong>
          <span>${s.label}</span>
        </div>
        <span class="donut-pct">${Math.round((s.count / total) * 100)}%</span>
      </div>
    `).join("");
  }
}

function drawRadarChart(canvas, drivers) {
  const dpr = window.devicePixelRatio || 1;
  const SIZE = 260;
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  canvas.style.width = SIZE + "px";
  canvas.style.height = SIZE + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const cx = SIZE / 2, cy = SIZE / 2, radius = 88;
  const keys = Object.keys(drivers);
  const n = keys.length;
  const step = (Math.PI * 2) / n;

  for (let lvl = 1; lvl <= 5; lvl++) {
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i * step - Math.PI / 2, r = (lvl / 5) * radius;
      i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
              : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.closePath();
    ctx.strokeStyle = lvl === 5 ? "#c8d4e0" : "#e8edf4";
    ctx.lineWidth = lvl === 5 ? 1.5 : 1;
    ctx.stroke();
  }

  for (let i = 0; i < n; i++) {
    const a = i * step - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + radius * Math.cos(a), cy + radius * Math.sin(a));
    ctx.strokeStyle = "#dfe6ee"; ctx.lineWidth = 1; ctx.stroke();
  }

  ctx.beginPath();
  keys.forEach((key, i) => {
    const a = i * step - Math.PI / 2;
    const r = (Math.min(100, Math.max(0, drivers[key])) / 100) * radius;
    i === 0 ? ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
            : ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
  });
  ctx.closePath();
  ctx.fillStyle = "rgba(0,169,157,0.14)"; ctx.fill();
  ctx.strokeStyle = "#00a99d"; ctx.lineWidth = 2; ctx.stroke();

  keys.forEach((key, i) => {
    const a = i * step - Math.PI / 2;
    const r = (Math.min(100, Math.max(0, drivers[key])) / 100) * radius;
    ctx.beginPath();
    ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), 4, 0, Math.PI * 2);
    ctx.fillStyle = "#00a99d"; ctx.fill();
    ctx.strokeStyle = "white"; ctx.lineWidth = 1.5; ctx.stroke();
  });

  keys.forEach((key, i) => {
    const a = i * step - Math.PI / 2;
    const lx = cx + (radius + 26) * Math.cos(a);
    const ly = cy + (radius + 26) * Math.sin(a);
    ctx.textAlign = Math.abs(Math.cos(a)) < 0.15 ? "center" : Math.cos(a) > 0 ? "left" : "right";
    ctx.fillStyle = "#172033"; ctx.font = "700 10px Segoe UI,sans-serif";
    ctx.fillText(title(key), lx, ly - 3);
    ctx.fillStyle = "#00a99d"; ctx.font = "700 11px Segoe UI,sans-serif";
    ctx.fillText(number.format(drivers[key]), lx, ly + 10);
  });
}

function renderTeamHeatmap() {
  const container = document.getElementById("teamHeatmap");
  if (!container) return;
  const rows = getKpiRows();
  const drivers = [
    { key: "delivery",      label: "Delivery" },
    { key: "attendance",    label: "Attendance" },
    { key: "collaboration", label: "Collaboration" },
    { key: "efficiency",    label: "Efficiency" },
  ];

  const teamMap = {};
  rows.forEach((e) => {
    const team = e.team || "Unassigned";
    if (!teamMap[team]) teamMap[team] = [];
    teamMap[team].push(e);
  });
  const teams = Object.keys(teamMap).sort();

  const heatColor = (v) => {
    if (v >= 70) return { bg: "rgba(47,179,109,0.15)", color: "#1a7a47" };
    if (v >= 40) return { bg: "rgba(243,162,41,0.15)", color: "#a05c00" };
    return { bg: "rgba(219,77,92,0.18)", color: "#a0202e" };
  };
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const companyAvg = {};
  drivers.forEach((d) => {
    const vals = rows.map((e) => e.scoreDrivers[d.key]).filter((v) => v != null);
    companyAvg[d.key] = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  });

  container.innerHTML = `
    <div class="heatmap-grid" style="grid-template-columns:170px repeat(${drivers.length},1fr);">
      <div class="heatmap-corner"></div>
      ${drivers.map((d) => `<div class="heatmap-head">${d.label}<span class="heatmap-cavg">co. avg ${companyAvg[d.key] ?? "—"}</span></div>`).join("")}
      ${teams.map((team) => {
        const members = teamMap[team];
        const cells = drivers.map((d) => {
          const vals = members.map((e) => e.scoreDrivers[d.key]).filter((v) => v != null);
          const score = avg(vals);
          if (score === null) return `<div class="heatmap-cell heatmap-na">—</div>`;
          const { bg, color } = heatColor(score);
          return `<div class="heatmap-cell heatmap-clickable" style="background:${bg};color:${color};" data-team="${encodeURIComponent(team)}" data-driver="${d.key}" title="Click for breakdown"><strong>${score}</strong></div>`;
        }).join("");
        return `<div class="heatmap-team">${team}<span class="heatmap-count">${members.length} people</span></div>${cells}`;
      }).join("")}
    </div>
  `;

  container.querySelectorAll(".heatmap-clickable").forEach((cell) => {
    cell.addEventListener("click", () => {
      const team = decodeURIComponent(cell.dataset.team);
      const driverKey = cell.dataset.driver;
      const driver = drivers.find((d) => d.key === driverKey);
      showHeatmapDetail(team, driver, teamMap[team], companyAvg);
    });
  });
}

function showHeatmapDetail(teamName, driver, members, companyAvg) {
  const overlay = document.getElementById("heatmapPopup");
  const content = document.getElementById("heatmapPopupContent");
  if (!overlay || !content) return;

  const driverKey = driver.key;
  const sorted = [...members].sort((a, b) => (b.scoreDrivers[driverKey] || 0) - (a.scoreDrivers[driverKey] || 0));
  const teamAvg = Math.round(sorted.reduce((s, e) => s + (e.scoreDrivers[driverKey] || 0), 0) / sorted.length);
  const compAvg = companyAvg[driverKey];
  const diff = compAvg != null ? teamAvg - compAvg : null;

  const dotColor = (v) => v >= 70 ? "#2fb36d" : v >= 40 ? "#f3a229" : "#db4d5c";

  const realValue = (e) => {
    switch (driverKey) {
      case "delivery":      return `${e.worklogix.completed} / ${e.worklogix.workItems} tasks completed`;
      case "attendance":    return `${number.format(e.attendance.officeHours)} hrs · ${e.attendance.biometricDays} biometric days`;
      case "collaboration": return e.teams.isActive ? "Active on Teams" : e.teams.isAway ? "Away" : "Offline";
      case "efficiency":    return `${number.format(e.worklogix.weightedPointsCompleted)} weighted pts · ${number.format(e.worklogix.efficiencyHours)} hrs`;
      default: return "";
    }
  };

  content.innerHTML = `
    <div class="hmp-header">
      <div>
        <p class="eyebrow">${teamName}</p>
        <h2>${driver.label} Breakdown</h2>
        <p class="hmp-avg">Team avg <strong>${teamAvg}</strong> &nbsp;·&nbsp; Company avg <strong>${compAvg ?? "—"}</strong>
          ${diff != null ? `<span class="hmp-diff ${diff >= 0 ? "hmp-pos" : "hmp-neg"}">${diff >= 0 ? "+" : ""}${diff} vs company</span>` : ""}
        </p>
      </div>
      <button class="dialog-close" id="closeHeatmapPopup">x</button>
    </div>
    <div class="hmp-list">
      ${sorted.map((e) => {
        const score = e.scoreDrivers[driverKey] || 0;
        const color = dotColor(score);
        return `
          <div class="hmp-row" data-id="${e.id}">
            <div class="hmp-dot" style="background:${color}"></div>
            <div class="hmp-info">
              <span class="hmp-name">${e.name}</span>
              <span class="hmp-real">${realValue(e)}</span>
            </div>
            <div class="hmp-bar-wrap">
              <div class="hmp-bar-fill" style="width:${score}%;background:${color}"></div>
            </div>
            <span class="hmp-score" style="color:${color}">${score}</span>
          </div>
        `;
      }).join("")}
    </div>
    <p class="hmp-footer">Click any employee to open their full profile</p>
  `;

  overlay.hidden = false;
  document.getElementById("closeHeatmapPopup").addEventListener("click", () => { overlay.hidden = true; });
  overlay.addEventListener("click", (evt) => { if (evt.target === overlay) overlay.hidden = true; });
  content.querySelectorAll(".hmp-row").forEach((row) => {
    row.addEventListener("click", () => {
      const emp = dataset.employees.find((e) => e.id === row.dataset.id);
      if (emp) { overlay.hidden = true; showEmployee(emp); }
    });
  });
}

function drawEfficiencyScatter() {
  const canvas = document.getElementById("efficiencyScatter");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  const height = 300;
  canvas.width = rect.width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const width = rect.width;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8fafc"; ctx.fillRect(0, 0, width, height);

  const pad = { top: 30, right: 24, bottom: 58, left: 54 };
  const cw = width - pad.left - pad.right;
  const ch = height - pad.top - pad.bottom;
  const rows = getKpiRows().filter((e) => e.scoreDrivers.efficiency !== undefined);

  const quads = [
    { x: 0.5, y: 0,   w: 0.5, h: 0.5, color: "rgba(47,179,109,0.12)",  label: "Star Performers",  sub: "Efficient & delivering" },
    { x: 0,   y: 0,   w: 0.5, h: 0.5, color: "rgba(51,102,255,0.08)",  label: "Has Capacity",     sub: "Efficient, needs more work" },
    { x: 0.5, y: 0.5, w: 0.5, h: 0.5, color: "rgba(243,162,41,0.12)",  label: "Working Hard",     sub: "Delivering but slow" },
    { x: 0,   y: 0.5, w: 0.5, h: 0.5, color: "rgba(219,77,92,0.12)",   label: "Needs Attention",  sub: "Low on both — act now" },
  ];
  quads.forEach((q) => {
    ctx.fillStyle = q.color;
    ctx.fillRect(pad.left + q.x * cw, pad.top + q.y * ch, q.w * cw, q.h * ch);
    const qcx = pad.left + (q.x + q.w / 2) * cw;
    const qcy = pad.top + (q.y + q.h / 2) * ch;
    ctx.fillStyle = "#8fa4b8"; ctx.font = "bold 11px Segoe UI,sans-serif"; ctx.textAlign = "center";
    ctx.fillText(q.label, qcx, qcy - 7);
    ctx.fillStyle = "#b2c4d4"; ctx.font = "9px Segoe UI,sans-serif";
    ctx.fillText(q.sub, qcx, qcy + 7);
  });

  ctx.setLineDash([4, 4]); ctx.strokeStyle = "#dfe6ee"; ctx.lineWidth = 1;
  const mx = pad.left + cw * 0.5, my = pad.top + ch * 0.5;
  ctx.beginPath(); ctx.moveTo(mx, pad.top); ctx.lineTo(mx, pad.top + ch); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(pad.left, my); ctx.lineTo(pad.left + cw, my); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#8a96a8"; ctx.font = "10px Segoe UI,sans-serif";
  [0, 25, 50, 75, 100].forEach((tick) => {
    const x = pad.left + (tick / 100) * cw;
    const y = pad.top + (1 - tick / 100) * ch;
    ctx.textAlign = "center"; ctx.fillText(tick, x, pad.top + ch + 14);
    ctx.textAlign = "right";  ctx.fillText(tick, pad.left - 6, y + 3);
  });

  ctx.fillStyle = "#627084"; ctx.font = "bold 10px Segoe UI,sans-serif"; ctx.textAlign = "center";
  ctx.fillText("Delivery score  (tasks completed & approved)  →", pad.left + cw / 2, pad.top + ch + 28);
  ctx.save(); ctx.translate(14, pad.top + ch / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("Efficiency score  →", 0, 0); ctx.restore();

  const sorted = [...rows].sort((a, b) =>
    (b.scoreDrivers.delivery + b.scoreDrivers.efficiency) - (a.scoreDrivers.delivery + a.scoreDrivers.efficiency)
  );
  const labelSet = new Set([
    ...sorted.slice(0, 3).map((e) => e.id),
    ...sorted.slice(-3).map((e) => e.id),
  ]);

  const bandColors = { "High Performance": "#2fb36d", "Need Improvement": "#f3a229", "Low Performance": "#db4d5c" };
  efficiencyScatterDots = [];
  rows.forEach((e) => {
    const x = pad.left + (e.scoreDrivers.delivery / 100) * cw;
    const y = pad.top + (1 - e.scoreDrivers.efficiency / 100) * ch;
    const r = labelSet.has(e.id) ? 6 : 5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = bandColors[e.band] || "#627084"; ctx.fill();
    ctx.strokeStyle = "white"; ctx.lineWidth = 1.5; ctx.stroke();
    efficiencyScatterDots.push({ x, y, employee: e });

    if (labelSet.has(e.id)) {
      const firstName = e.name.split(" ")[0];
      ctx.fillStyle = "#2a3a4a"; ctx.font = "bold 9px Segoe UI,sans-serif"; ctx.textAlign = "center";
      ctx.fillText(firstName, x, y - 10);
    }
  });

  const legendItems = [
    { color: "#2fb36d", label: "High Performance" },
    { color: "#f3a229", label: "Needs Improvement" },
    { color: "#db4d5c", label: "Low Performance" },
  ];
  let lx = pad.left;
  const ly = pad.top + ch + 46;
  ctx.font = "10px Segoe UI,sans-serif";
  legendItems.forEach((item) => {
    ctx.beginPath(); ctx.arc(lx + 5, ly, 5, 0, Math.PI * 2);
    ctx.fillStyle = item.color; ctx.fill();
    ctx.fillStyle = "#627084"; ctx.textAlign = "left";
    ctx.fillText(item.label, lx + 13, ly + 3.5);
    lx += ctx.measureText(item.label).width + 28;
  });
}


async function boot() {
  if (!getToken()) {
    window.location.href = "login.html";
    return;
  }
  dataset = await loadDataset();
  if (!dataset) return;
  filteredEmployees = dataset.employees.slice();
  setupNavigation();
  setupFilters();
  setupDepartmentChartEvents();
  renderAll();
  updateTeamsRefreshLabel();
  if (!DEMO_MODE) setInterval(autoRefreshTeams, TEAMS_REFRESH_INTERVAL);
}

async function autoRefreshTeams() {
  updateTeamsRefreshLabel();
}

function updateTeamsRefreshLabel(ts) {
  const el = document.getElementById("teamsRefreshLabel");
  if (!el) return;
  if (DEMO_MODE) {
    el.textContent = DEMO_REFRESH_MESSAGE;
    return;
  }
  el.textContent = ts ? `Status as of ${new Date(ts).toLocaleTimeString()}` : "";
}

async function loadDataset({ fresh = false } = {}) {
  const suffix = fresh ? `?t=${Date.now()}` : "";
  const fileResponse = await fetch(`data/peopleops-data.json${suffix}`, { cache: fresh ? "no-store" : "default" }).catch(() => null);
  return fileResponse?.ok ? fileResponse.json() : null;
}

function setupNavigation() {
  document.querySelectorAll(".rail-item").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".rail-item").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active-view"));
      button.classList.add("active");
      document.getElementById(button.dataset.view).classList.add("active-view");
      toggleControls(button.dataset.view);
      if (button.dataset.view === "overview") drawScatter();
      if (button.dataset.view === "kpi") renderKpiPerformance();
      if (button.dataset.view === "insights") drawInsightsChart();
    });
  });
}

function toggleControls(view) {
  const controls = document.querySelector(".controls");
  controls.hidden = ["attendance", "projects", "integrations"].includes(view);
}

function setupFilters() {
  populateFilterOptions();

  document.getElementById("searchInput").addEventListener("input", (event) => {
    state.search = event.target.value.toLowerCase();
    applyFilters();
  });
  document.getElementById("bandFilter").addEventListener("change", (event) => {
    state.band = event.target.value;
    applyFilters();
  });
  document.getElementById("teamFilter").addEventListener("change", (event) => {
    state.team = event.target.value;
    applyFilters();
  });
  document.getElementById("confidenceFilter").addEventListener("change", (event) => {
    state.confidence = Number(event.target.value);
    applyFilters();
  });
  document.getElementById("exportCsv").addEventListener("click", exportCsv);
  document.getElementById("refreshKpi").addEventListener("click", refreshKpiPerformance);
  document.getElementById("clearKpiTeam").addEventListener("click", clearKpiTeamFilter);
  document.getElementById("closeDialog").addEventListener("click", () => document.getElementById("employeeDialog").close());
  populateAttendanceOptions();
  document.getElementById("attendanceEmployee").addEventListener("change", () => renderAttendanceDetail(document.getElementById("attendanceEmployee").value));
  window.addEventListener("resize", () => { drawScatter(); drawDonutChart(); });
}

function populateFilterOptions() {
  const bandFilter = document.getElementById("bandFilter");
  const teamFilter = document.getElementById("teamFilter");
  const previousBand = state.band;
  const previousTeam = state.team;
  const bands = [...new Set(dataset.employees.map((e) => e.band).filter(Boolean))];
  const teams = [...new Set(dataset.employees.map((e) => e.team || "Unassigned"))].sort();
  bandFilter.innerHTML = `<option value="all">All performance bands</option>${bands.map((b) => `<option>${b}</option>`).join("")}`;
  teamFilter.innerHTML = `<option value="all">All teams</option>${teams.map((t) => `<option>${t}</option>`).join("")}`;
  state.band = bands.includes(previousBand) ? previousBand : "all";
  state.team = teams.includes(previousTeam) ? previousTeam : "all";
  bandFilter.value = state.band;
  teamFilter.value = state.team;
}

function populateAttendanceOptions() {
  const attendanceSelect = document.getElementById("attendanceEmployee");
  const previousEmployee = attendanceSelect.value;
  attendanceSelect.innerHTML = dataset.employees
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((employee) => `<option value="${employee.id}">${employee.name} (${employee.id})</option>`)
    .join("");
  if (dataset.employees.some((employee) => employee.id === previousEmployee)) {
    attendanceSelect.value = previousEmployee;
  }
}

function applyFilters() {
  filteredEmployees = dataset.employees.filter((employee) => {
    const text = [employee.name, employee.id, employee.team, employee.designation].join(" ").toLowerCase();
    return (
      text.includes(state.search) &&
      (state.band === "all" || employee.band === state.band) &&
      (state.team === "all" || employee.team === state.team) &&
      employee.sourceConfidence >= state.confidence
    );
  });
  renderAll();
}

function computeAlerts(employees) {
  const alerts = [];
  employees.forEach((e) => {
    if (e.kpi === null || e.kpi === undefined) return;
    const d = e.scoreDrivers;
    const att = e.attendance;
    if (att.biometricDays > 12 && d.delivery < 40) {
      alerts.push({ employee: e, level: "red", reason: "In office but not delivering" });
    } else if (e.teams.isActive && d.delivery < 30) {
      alerts.push({ employee: e, level: "red", reason: "Active on Teams but no work output" });
    } else if (e.kpi < 35) {
      alerts.push({ employee: e, level: "red", reason: "Disengaged across all signals" });
    } else if (d.attendance > 60 && d.delivery < 45) {
      alerts.push({ employee: e, level: "amber", reason: "Attendance strong, delivery lagging" });
    }
  });
  return alerts.sort((a, b) => (a.level === b.level ? a.employee.kpi - b.employee.kpi : a.level === "red" ? -1 : 1));
}

function renderAlerts() {
  const container = document.getElementById("alertsPanel");
  if (!container) return;
  const alerts = computeAlerts(filteredEmployees).slice(0, 8);
  if (!alerts.length) {
    container.innerHTML = `<div class="alerts-clear">All clear — no flags for the current filter.</div>`;
    return;
  }
  container.innerHTML = alerts.map(({ employee: e, level, reason }) => `
    <div class="alert-row alert-${level}" data-id="${e.id}">
      <div class="alert-info">
        <span class="alert-name">${e.name}</span>
        <span class="alert-team">${e.team || "Unassigned"}</span>
      </div>
      <span class="alert-reason">${reason}</span>
      <span class="alert-kpi">${number.format(e.kpi)}</span>
    </div>
  `).join("");
  container.querySelectorAll(".alert-row").forEach((row) => {
    row.addEventListener("click", () => {
      const emp = dataset.employees.find((e) => e.id === row.dataset.id);
      if (emp) showEmployee(emp);
    });
  });
}

function renderAll() {
  renderTotalEmployeeBadge();
  renderMetrics();
  renderBandSummary();
  renderKpiPerformance();
  renderSourceCoverage();
  renderWeights();
  renderPeopleTable();
  renderTeamsTable();
  renderAttendanceDetail(document.getElementById("attendanceEmployee").value || dataset.employees[0]?.id);
  renderProjects();
  renderIntegrations();
  renderInsights();
  renderAlerts();
  drawDonutChart();
  drawScatter();
  document.getElementById("filteredCount").textContent = `${filteredEmployees.length} employees in view`;
}

function getKpiRows() {
  return filteredEmployees.filter((employee) => employee.kpi !== null && employee.kpi !== undefined);
}

function laggingAreas(employee) {
  const drivers = [
    ["Worklogix delivery", employee.scoreDrivers.delivery, "Review task completion, approval status, blocked work, and workload quality."],
    ["Weighted efficiency", employee.scoreDrivers.efficiency, "Low weighted output per hour — check if high-priority or primary tasks are being completed vs. rework."],
    ["Worklogix workload", employee.scoreDrivers.volume, "Check workload allocation and whether enough work items are assigned."],
    ["Worklogix quality", employee.scoreDrivers.quality, "Review completion quality and repeated rework or pending approvals."],
    ["Teams collaboration", employee.scoreDrivers.collaboration, "Check Teams presence, availability pattern, and collaboration visibility."],
  ];
  const weak = drivers
    .filter(([, value]) => Number(value) < 60)
    .sort((a, b) => a[1] - b[1]);
  return weak.length ? weak : [["On track", 100, "Keep monitoring Worklogix delivery and Teams collaboration together."]];
}

function kpiTone(value) {
  if (value >= 70) return "good";
  if (value >= 55) return "watch";
  return "risk";
}

function teamKpiSummary(rows) {
  const teams = new Map();
  rows.forEach((employee) => {
    const team = employee.team || "Unassigned";
    if (!teams.has(team)) teams.set(team, []);
    teams.get(team).push(employee);
  });
  return [...teams.entries()]
    .map(([team, employees]) => {
      const kpis = employees.map((employee) => employee.kpi);
      const delivery = employees.map((employee) => employee.scoreDrivers.delivery);
      const collaboration = employees.map((employee) => employee.scoreDrivers.collaboration);
      return {
        team,
        employees,
        avgKpi: average(kpis),
        avgDelivery: average(delivery),
        avgCollaboration: average(collaboration),
        laggingCount: employees.filter((employee) => laggingAreas(employee)[0][0] !== "On track").length,
      };
    })
    .sort((a, b) => b.avgKpi - a.avgKpi);
}

function renderKpiPerformance() {
  const rows = getKpiRows();
  const teamRows = teamKpiSummary(rows);
  const maxKpi = Math.max(100, ...teamRows.map((team) => team.avgKpi));
  const avgKpi = rows.length ? average(rows.map((employee) => employee.kpi)) : 0;
  const avgDelivery = rows.length ? average(rows.map((employee) => employee.scoreDrivers.delivery)) : 0;
  const avgCollaboration = rows.length ? average(rows.map((employee) => employee.scoreDrivers.collaboration)) : 0;
  const laggingEmployees = rows.filter((employee) => laggingAreas(employee)[0][0] !== "On track");
  document.getElementById("clearKpiTeam").hidden = state.team === "all";
  renderTeamHeatmap();

  document.getElementById("kpiTeamCount").textContent = `${teamRows.length} teams`;
  document.getElementById("kpiEmployeeCount").textContent = `${rows.length} employees`;

  document.getElementById("kpiSignalSummary").innerHTML = [
    ["Overall KPI", number.format(avgKpi), `${laggingEmployees.length} employees lagging`, kpiTone(avgKpi)],
    ["Worklogix", number.format(avgDelivery), "delivery, workload, quality", kpiTone(avgDelivery)],
    ["Teams", number.format(avgCollaboration), "collaboration presence", kpiTone(avgCollaboration)],
  ].map(([label, value, hint, tone]) => `
    <div class="kpi-signal-card ${tone}">
      <strong>${value}</strong>
      <span>${label}</span>
      <small>${hint}</small>
    </div>
  `).join("");

  document.getElementById("kpiTeamBars").innerHTML = teamRows.map((team) => {
    const width = Math.max(4, (team.avgKpi / maxKpi) * 100);
    return `
      <button class="kpi-team-row" data-team="${encodeURIComponent(team.team)}">
        <span class="kpi-team-name">${team.team}</span>
        <span class="kpi-bar-track">
          <span class="kpi-bar-fill ${kpiTone(team.avgKpi)}" style="width:${width}%"></span>
        </span>
        <span class="kpi-team-score">${number.format(team.avgKpi)}</span>
        <span class="kpi-team-meta">${team.employees.length} employees | ${team.laggingCount} lagging</span>
      </button>
    `;
  }).join("");

  document.querySelectorAll(".kpi-team-row").forEach((row) => {
    row.addEventListener("click", () => {
      const team = decodeURIComponent(row.dataset.team);
      state.team = team;
      document.getElementById("teamFilter").value = team;
      applyFilters();
    });
  });

  document.getElementById("kpiEmployeeTable").innerHTML = rows
    .slice()
    .sort((a, b) => a.kpi - b.kpi || a.name.localeCompare(b.name))
    .map((employee) => {
      const [area,, action] = laggingAreas(employee)[0];
      return `
        <tr data-id="${employee.id}">
          <td><div class="person"><strong>${employee.name}</strong><small>${employee.id} | ${employee.designation || "Unassigned"}</small></div></td>
          <td>${employee.team || "Unassigned"}</td>
          <td class="numeric-cell"><span class="kpi-score ${kpiTone(employee.kpi)}">${number.format(employee.kpi)}</span></td>
          <td>
            <div class="mini-driver"><span>Delivery ${number.format(employee.scoreDrivers.delivery)}</span><span>Quality ${number.format(employee.scoreDrivers.quality)}</span></div>
          </td>
          <td>${number.format(employee.scoreDrivers.collaboration)}</td>
          <td><span class="lag-chip ${area === "On track" ? "good" : kpiTone(employee.kpi)}">${area}</span></td>
          <td class="kpi-action">${action}</td>
        </tr>
      `;
    })
    .join("");

  document.querySelectorAll("#kpiEmployeeTable tr").forEach((row) => {
    row.addEventListener("click", () => {
      const employee = dataset.employees.find((item) => item.id === row.dataset.id);
      if (employee) showEmployee(employee);
    });
  });
}

function clearKpiTeamFilter() {
  state.team = "all";
  document.getElementById("teamFilter").value = "all";
  applyFilters();
}

async function refreshKpiPerformance() {
  const status = document.getElementById("kpiRefreshStatus");
  status.textContent = DEMO_REFRESH_MESSAGE;
}

function setupDepartmentChartEvents() {
  const canvas = document.getElementById("scatterChart");
  if (!canvas) return;
  const tooltip = document.getElementById("departmentTooltip");
  canvas.addEventListener("mousemove", (event) => {
    const hit = findDepartmentBar(event);
    if (!hit) {
      tooltip.hidden = true;
      canvas.style.cursor = "default";
      return;
    }
    canvas.style.cursor = "pointer";
    tooltip.hidden = false;
    tooltip.style.left = `${canvas.offsetLeft + event.offsetX + 18}px`;
    tooltip.style.top = `${canvas.offsetTop + event.offsetY + 18}px`;
    tooltip.innerHTML = `<strong>${hit.department}</strong><span>${hit.avgKpi === null ? "No KPI" : `${number.format(hit.avgKpi)} KPI`} | ${hit.employees.length} employees</span>`;
  });
  canvas.addEventListener("mouseleave", () => {
    tooltip.hidden = true;
    canvas.style.cursor = "default";
  });
  canvas.addEventListener("click", (event) => {
    const hit = findDepartmentBar(event);
    if (hit) {
      renderDepartmentEmployees(hit);
    }
  });
}

function findDepartmentBar(event) {
  return departmentChartBars.find((bar) => (
    event.offsetX >= bar.x &&
    event.offsetX <= bar.x + bar.width &&
    event.offsetY >= bar.y &&
    event.offsetY <= bar.y + bar.height
  ));
}

function renderDepartmentEmployees(department) {
  const panel = document.getElementById("departmentEmployeesPanel");
  const rows = department.employees
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((employee) => `<li><strong>${employee.name}</strong><span>${employee.id}</span></li>`)
    .join("");
  panel.hidden = false;
  panel.innerHTML = `
    <div class="department-panel-head">
      <div>
        <p class="eyebrow">Department employees</p>
        <h3>${department.department}</h3>
      </div>
      <span class="pill">${department.employees.length} employees</span>
    </div>
    <ul>${rows}</ul>
  `;
}

function renderTotalEmployeeBadge() {
  document.getElementById("totalEmployeeBadge").innerHTML = `
    <div class="employee-count-circle">
      <strong>${dataset.overview.employees}</strong>
      <span>Total<br>Employees</span>
    </div>
  `;
}

function renderMetrics() {
  const rows = filteredEmployees;
  const scoredRows = rows.filter((e) => e.kpi !== null && e.kpi !== undefined);
  const avgKpi = average(scoredRows.map((e) => e.kpi));
  const workItems = sum(rows.map((e) => e.worklogix.workItems));
  const completed = sum(rows.map((e) => e.worklogix.completed));
  const officeHours = sum(rows.map((e) => e.attendance.officeHours));
  const teamsActive = rows.filter((e) => e.teams.isActive).length;
  const fullConfidence = rows.filter((e) => e.sourceConfidence === 100).length;
  const metrics = [
    ["Employees", rows.length, "filtered population"],
    ["Active", rows.filter((e) => e.active).length, "active employees"],
    ["Inactive", rows.filter((e) => !e.active).length, "inactive employees"],
    ["Avg KPI", scoredRows.length ? number.format(avgKpi) : "", "confidence 75% and above"],
    ["Completed", `${workItems ? Math.round((completed / workItems) * 100) : 0}%`, `${completed}/${workItems} work items`],
    ["Office Hours", number.format(officeHours), "attendance signal"],
    ["Online Now", teamsActive, "Teams presence signal"],
    ["Full Fusion", fullConfidence, "API sources matched"],
  ];
  document.getElementById("metricGrid").innerHTML = metrics
    .map(([label, value, hint]) => `<article class="metric-card ${label === "Total Employees" ? "total-employees-card" : ""}"><strong>${value}</strong><span>${label}<br>${hint}</span></article>`)
    .join("");
}

function renderSourceCoverage() {
  const total = dataset.overview.employees;
  const labels = {
    worklogix: "Worklogix employee records",
    teams: "Teams activity",
    greythr: "GreytHR muster",
    biometrics: "Biometric swipes",
  };
  document.getElementById("sourceCoverage").innerHTML = Object.entries(dataset.overview.sourceCoverage)
    .map(([key, value]) => {
      const pct = Math.round((value / total) * 100);
      return `<div class="coverage-item">
        <strong>${labels[key]}</strong>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <span class="subtle">${value} of ${total} employees matched (${pct}%)</span>
      </div>`;
    })
    .join("");
}

function renderBandSummary() {
  const counts = {
    "High Performance": 0,
    "Need Improvement": 0,
    "Low Performance": 0,
  };
  filteredEmployees.forEach((employee) => {
    if (!employee.band) return;
    counts[employee.band] = (counts[employee.band] || 0) + 1;
  });
  const cards = [
    ["High Performance", counts["High Performance"], "Consistent delivery and healthy attendance/collaboration signals", "high"],
    ["Need Improvement", counts["Need Improvement"], "Good signals with visible gaps to review", "need"],
    ["Low Performance", counts["Low Performance"], "Needs manager attention and support", "low"],
  ];
  document.getElementById("bandSummary").innerHTML = cards
    .map(([label, value, hint, tone]) => `<button class="band-card ${tone}" data-band="${label}"><strong>${value}</strong><span>${label}</span><span>${hint}</span></button>`)
    .join("");
  document.querySelectorAll(".band-card").forEach((card) => {
    card.addEventListener("click", () => renderBandEmployees(card.dataset.band));
  });
}

function renderBandEmployees(band) {
  const employees = filteredEmployees
    .filter((employee) => employee.band === band)
    .sort((a, b) => b.kpi - a.kpi);
  const panel = document.getElementById("bandEmployeesPanel");
  panel.hidden = false;
  panel.innerHTML = `
    <div class="department-panel-head">
      <div>
        <p class="eyebrow">Performance group</p>
        <h3>${band}</h3>
      </div>
      <span class="pill">${employees.length} employees</span>
    </div>
    <ul>
      ${employees.map((employee) => `<li><strong>${employee.name}</strong><span>${employee.id} | ${formatKpi(employee.kpi)} KPI</span></li>`).join("")}
    </ul>
  `;
}

function renderWeights() {
  const labels = {
    worklogixDelivery: "Delivery score",
    attendance: "Attendance reliability",
    teamsCollaboration: "Collaboration activity",
    workloadVolume: "Workload volume",
    completionQuality: "Completion quality",
  };
  document.getElementById("weightBars").innerHTML = Object.entries(dataset.meta.weights)
    .map(([key, value]) => `<div class="weight-item">
      <strong>${labels[key]} ${value}%</strong>
      <div class="bar"><span style="width:${value * 2}%"></span></div>
    </div>`)
    .join("");
}

function renderPeopleTable() {
  document.getElementById("peopleTable").innerHTML = filteredEmployees
    .map((e, index) => `<tr data-index="${index}">
      <td><div class="person"><strong>${e.name}</strong><small>${e.id} | ${e.designation || "Unassigned"} | ${e.team || "Unassigned"}</small></div></td>
      <td class="numeric-cell"><span class="score">${formatKpi(e.kpi)}</span></td>
      <td>${e.band ? `<span class="band ${bandClass(e.band)}">${e.band}</span>` : '<span class="band no-info">Need more information</span>'}</td>
      <td><span class="employee-status ${e.active ? "active" : "inactive"}">${e.active ? "Active" : "Inactive"}</span></td>
      <td class="numeric-cell">${e.sourceConfidence}%</td>
      <td class="numeric-cell">${e.worklogix.completed}/${e.worklogix.workItems}</td>
      <td class="numeric-cell">${e.attendance.present}</td>
      <td class="numeric-cell">${e.attendance.absent}</td>
      <td>${teamsStatusBadge(e.teams)}</td>
    </tr>`)
    .join("");

  document.querySelectorAll("#peopleTable tr").forEach((row) => {
    row.addEventListener("click", () => showEmployee(filteredEmployees[Number(row.dataset.index)]));
  });
}

function teamsStatusBadge(teams) {
  const status = teams.status || "";
  if (!status) return '<span class="presence-badge offline">No Data</span>';
  const cls = status === "Busy" ? "busy" : teams.isActive ? "active" : teams.isOutOfOffice ? "ooo" : teams.isAway ? "away" : "offline";
  const label = status.replace(/([A-Z])/g, " $1").trim();
  const loc = teams.workLocation ? ` · ${teams.workLocation}` : "";
  return `<span class="presence-badge ${cls}">${label}${loc}</span>`;
}

function renderTeamsTable() {
  const rows = filteredEmployees
    .slice()
    .sort((a, b) => (b.teams.isActive || 0) - (a.teams.isActive || 0));
  document.getElementById("teamsTable").innerHTML = rows
    .map((e) => `<tr>
      <td><div class="person"><strong>${e.name}</strong><small>${e.id} | ${e.designation || "Unassigned"}</small></div></td>
      <td>${e.team || "Unassigned"}</td>
      <td>${teamsStatusBadge(e.teams)}</td>
      <td>${e.teams.workLocation || "-"}</td>
      <td>${e.teams.reports || 0}</td>
      <td>${e.sources.teams ? `${e.sourceConfidence}%` : "No Teams match"}</td>
    </tr>`)
    .join("");
}

// ── Insights: Work Pattern Analysis ──────────────────────────────────────────

function insightsQuadrant(delivery, collab) {
  const high_d = delivery >= 50, high_c = collab >= 50;
  if (high_d && high_c) return { key: "high_performer", label: "High Performer",   color: "#2fb36d", bg: "#e8f7ef", border: "#b7e8ce" };
  if (high_d && !high_c) return { key: "ghost_worker",  label: "Ghost Worker",     color: "#c07f10", bg: "#fff8e1", border: "#f3d9a0" };
  if (!high_d && high_c) return { key: "present_idle",  label: "Present but Idle", color: "#3366ff", bg: "#eef2ff", border: "#c0cfff" };
  return                        { key: "disengaged",     label: "Disengaged",       color: "#db4d5c", bg: "#fff0f1", border: "#f5c0c6" };
}

function insightsAvatar(name, color) {
  const initials = name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<div class="ins-avatar" style="background:${color}22;color:${color};border:1.5px solid ${color}44">${initials}</div>`;
}

function renderInsights() {
  const employees = filteredEmployees.filter((e) => e.kpi !== null && e.sources.teams);

  const sections = [
    { key: "disengaged",     label: "Disengaged",       color: "#db4d5c", bg: "#fff0f1", tag: "Urgent",     tagBg: "#db4d5c",
      desc: "Low output AND rarely online — needs a manager conversation now." },
    { key: "ghost_worker",   label: "Ghost Workers",    color: "#c07f10", bg: "#fffbf0", tag: "Watch",      tagBg: "#f3a229",
      desc: "Good output in Worklogix but barely visible on Teams — mismatch worth investigating." },
    { key: "present_idle",   label: "Present but Idle", color: "#3366ff", bg: "#f0f4ff", tag: "Coaching",   tagBg: "#3366ff",
      desc: "Always online on Teams but task delivery is low — being busy isn't the same as being productive." },
    { key: "high_performer", label: "High Performers",  color: "#2fb36d", bg: "#f0fbf5", tag: "On Track",   tagBg: "#2fb36d",
      desc: "Delivering well and active on Teams — both signals align perfectly." },
  ];

  const grouped = {};
  sections.forEach((s) => { grouped[s.key] = []; });
  employees.forEach((e) => {
    const q = insightsQuadrant(e.scoreDrivers.delivery, e.scoreDrivers.collaboration);
    grouped[q.key].push(e);
  });

  // Summary cards
  document.getElementById("insightsSummaryCards").innerHTML = sections.map((s) => `
    <div class="insights-card" style="border-top:3px solid ${s.color}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div class="insights-card-count" style="color:${s.color}">${grouped[s.key].length}</div>
        <span style="background:${s.tagBg};color:white;font-size:0.65rem;font-weight:800;padding:3px 8px;border-radius:99px;letter-spacing:0.05em;">${s.tag}</span>
      </div>
      <div class="insights-card-label">${s.label}</div>
    </div>`).join("");

  // Section panels
  const visibleSections = sections.filter((s) => grouped[s.key].length > 0);
  document.getElementById("insightsBody").innerHTML = visibleSections.map((s) => `
    <article class="panel ins-section" style="border-left:4px solid ${s.color}">
      <div class="ins-section-head">
        <div>
          <span class="ins-section-tag" style="background:${s.tagBg}22;color:${s.tagBg}">${s.tag}</span>
          <h2 class="ins-section-title" style="color:${s.color}">${s.label} <span class="ins-section-count">${grouped[s.key].length}</span></h2>
          <p class="ins-section-desc">${s.desc}</p>
        </div>
      </div>
      <div class="ins-rows">
        ${grouped[s.key].map((e) => {
          const d = e.scoreDrivers.delivery, c = e.scoreDrivers.collaboration;
          return `<div class="ins-row" data-id="${e.id}">
            ${insightsAvatar(e.name, s.color)}
            <div class="ins-row-name">
              <strong>${e.name}</strong>
              <small>${e.team || "Unassigned"} · ${e.designation || ""}</small>
            </div>
            <div class="ins-row-bars">
              <div class="ins-bar-line">
                <span class="ins-bar-lbl">Delivery</span>
                <div class="ins-bar-track"><div class="ins-bar-fill" style="width:${d}%;background:#00a99d"></div></div>
                <span class="ins-bar-val">${number.format(d)}</span>
              </div>
              <div class="ins-bar-line">
                <span class="ins-bar-lbl">Teams</span>
                <div class="ins-bar-track"><div class="ins-bar-fill" style="width:${c}%;background:#7b55d9"></div></div>
                <span class="ins-bar-val">${number.format(c)}</span>
              </div>
            </div>
            <div class="ins-row-meta">
              ${teamsStatusBadge(e.teams)}
              <span class="ins-tasks">${e.worklogix.completed}/${e.worklogix.workItems} tasks</span>
            </div>
          </div>`;
        }).join("")}
      </div>
    </article>`).join("");

  document.querySelectorAll(".ins-row").forEach((row) => {
    row.addEventListener("click", () => {
      const emp = dataset.employees.find((e) => e.id === row.dataset.id);
      if (emp) showEmployee(emp);
    });
  });
}

function drawInsightsChart() { /* replaced by HTML grid */ }

function renderAttendanceDetail(employeeId) {
  const employee = dataset.employees.find((item) => item.id === employeeId) || dataset.employees[0];
  if (!employee) return;
  const attendance = employee.attendance;
  const workingDays = attendance.present + attendance.absent + attendance.leave;
  const presentRate = workingDays ? Math.round((attendance.present / workingDays) * 100) : 0;
  const biometricStatus = employee.sources.biometrics
    ? `${attendance.biometricDays} biometric days captured`
    : "No biometric match found";
  const attendanceBars = [
    ["Present days", attendance.present, "#2fb36d"],
    ["Absent days", attendance.absent, "#db4d5c"],
    ["Leave/status days", attendance.leave, "#f3a229"],
    ["Off days", attendance.off, "#627084"],
    ["Holidays", attendance.holidays, "#7b55d9"],
    ["Biometric days", attendance.biometricDays, "#3366ff"],
  ];
  const maxAttendanceValue = Math.max(1, ...attendanceBars.map(([, value]) => value));
  document.getElementById("attendanceDetail").innerHTML = `
    <section class="attendance-hero">
      <div>
        <p class="eyebrow">${employee.id} | ${employee.team || "Unassigned"}</p>
        <h1>${employee.name}</h1>
        <p class="subtle">${employee.designation || "Unassigned"} | ${employee.band || "KPI blank"} | Source confidence ${employee.sourceConfidence}%</p>
        <p>${attendance.present} present days, ${attendance.absent} absent days, ${attendance.leave} leave/status days, and ${attendance.off} off days are available from the attendance systems.</p>
      </div>
      <div class="attendance-score">${presentRate}%</div>
    </section>
    <section class="attendance-chart">
      <div class="attendance-chart-head">
        <div>
          <p class="eyebrow">Attendance breakdown</p>
          <h2>Attendance Status Chart</h2>
        </div>
        <span class="pill">${biometricStatus}</span>
      </div>
      <div class="attendance-bars">
        ${attendanceBars.map(([label, value, color]) => `
          <div class="attendance-bar-row">
            <span class="attendance-bar-label">${label}</span>
            <span class="attendance-bar-track">
              <span class="attendance-bar-fill" style="width:${Math.max(3, (value / maxAttendanceValue) * 100)}%; background:${color}"></span>
            </span>
            <strong>${value}</strong>
          </div>
        `).join("")}
      </div>
      <div class="attendance-hours">
        <div><strong>${number.format(attendance.officeHours)} h</strong><span class="subtle">Office hours</span></div>
        <div><strong>${number.format(attendance.avgOfficeHours)} h</strong><span class="subtle">Avg office hours</span></div>
      </div>
    </section>
  `;
}

function renderProjects() {
  document.getElementById("projectGrid").innerHTML = dataset.projects.slice(0, 18).map((project) => `
    <article class="project-card">
      <p class="eyebrow">${project.status || "unknown"} project</p>
      <strong>${project.name || project.id}</strong>
      <p class="subtle">${project.id}</p>
      <div class="project-meta">
        <span>${project.members}<br>members</span>
        <span>${number.format(project.estimatedHours)}<br>est. hours</span>
      </div>
    </article>
  `).join("");
}

function renderIntegrations() {
  const sourceFiles = dataset.meta.sourceFiles;
  const items = [
    ["Worklogix", sourceFiles.worklogix, "Live API data for users, projects, tasks, and work activity."],
    ["GreytHR", sourceFiles.greythr, "Live attendance API — present, absent, leave, and week off records."],
    ["Biometrics", sourceFiles.biometrics, "Live presence report API — office hours and biometric days per employee."],
    ["Teams", sourceFiles.teams, "Live Microsoft Graph API presence data."],
  ];
  document.getElementById("integrationGrid").innerHTML = items.map(([name, files, detail]) => `
    <article class="integration-card">
      <p class="eyebrow">${files === "api" ? "Live API" : `${files} file${files === 1 ? "" : "s"}`}</p>
      <h2>${name}</h2>
      <p class="subtle">${detail}</p>
    </article>
  `).join("");
}

function drawScatter() {
  const canvas = document.getElementById("scatterChart");
  if (!canvas || !canvas.offsetParent) return;
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  const width = rect.width;
  const chartEmployees = filteredEmployees.filter((employee) => employee.active);
  const groupSource = chartEmployees.length ? chartEmployees : filteredEmployees;
  const departmentNames = new Set(groupSource.map((employee) => employee.team || "Unassigned"));
  const height = Math.max(420, departmentNames.size * 44 + 70);
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);

  const groups = new Map();
  groupSource.forEach((employee) => {
    const department = employee.team || "Unassigned";
    if (!groups.has(department)) {
      groups.set(department, []);
    }
    groups.get(department).push(employee);
  });
  const bars = [...groups.entries()]
    .map(([department, employees]) => {
      const scoredEmployees = employees.filter((employee) => employee.kpi !== null && employee.kpi !== undefined);
      return {
        department,
        avgKpi: scoredEmployees.length ? average(scoredEmployees.map((employee) => employee.kpi)) : null,
        employees,
        scoredEmployees,
      };
    })
    .sort((a, b) => (b.avgKpi ?? -1) - (a.avgKpi ?? -1));
  if (!bars.length) {
    ctx.fillStyle = "#627084";
    ctx.font = "14px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("No department KPI available for employees with confidence 75% and above.", width / 2, height / 2);
    departmentChartBars = [];
    return;
  }

  const chartLeft = Math.min(260, Math.max(150, width * 0.26));
  const chartRight = width - 72;
  const chartTop = 28;
  const chartBottom = height - 34;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;
  const rowHeight = chartHeight / Math.max(1, bars.length);
  const barHeight = Math.min(26, rowHeight * 0.52);
  departmentChartBars = [];

  ctx.strokeStyle = "#dfe6ee";
  ctx.lineWidth = 1;
  ctx.font = "11px Segoe UI, sans-serif";
  ctx.fillStyle = "#8a96a8";
  ctx.textAlign = "center";
  [0, 25, 50, 75, 100].forEach((tick) => {
    const x = chartLeft + (tick / 100) * chartWidth;
    ctx.beginPath();
    ctx.moveTo(x, chartTop - 8);
    ctx.lineTo(x, chartBottom);
    ctx.stroke();
    ctx.fillText(String(tick), x, height - 10);
  });

  bars.forEach((bar) => {
    const index = bars.indexOf(bar);
    const y = chartTop + index * rowHeight + rowHeight / 2;
    const barWidth = ((bar.avgKpi ?? 0) / 100) * chartWidth;
    const gradient = ctx.createLinearGradient(chartLeft, 0, chartLeft + barWidth, 0);
    gradient.addColorStop(0, "#00a99d");
    gradient.addColorStop(1, "#3366ff");

    ctx.fillStyle = "#172033";
    ctx.font = "700 13px Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(shortLabel(bar.department, 28), chartLeft - 14, y + 4);

    ctx.fillStyle = "#e8edf4";
    roundRect(ctx, chartLeft, y - barHeight / 2, chartWidth, barHeight, 7);
    ctx.fill();

    ctx.fillStyle = gradient;
    roundRect(ctx, chartLeft, y - barHeight / 2, barWidth, barHeight, 7);
    ctx.fill();

    ctx.fillStyle = "#172033";
    ctx.font = "700 12px Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(bar.avgKpi === null ? "No KPI" : `${number.format(bar.avgKpi)} KPI`, chartLeft + barWidth + 10, y - 2);
    ctx.fillStyle = "#627084";
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.fillText(`${bar.employees.length} employees | ${bar.scoredEmployees.length} scored`, chartLeft + barWidth + 10, y + 14);
    departmentChartBars.push({
      department: bar.department,
      avgKpi: bar.avgKpi,
      employees: bar.employees,
      x: chartLeft,
      y: y - barHeight / 2,
      width: chartWidth,
      height: barHeight,
    });
  });
}

function shortLabel(value, limit = 18) {
  return value.length > limit ? `${value.slice(0, limit - 1)}...` : value;
}

function roundRect(ctx, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function showEmployee(e) {
  const sources = Object.entries(e.sources)
    .filter(([, available]) => available)
    .map(([name]) => `<span>${name}</span>`)
    .join("");
  document.getElementById("employeeDetail").innerHTML = `
    <section class="detail">
      <p class="eyebrow">${e.id} | ${e.team || "Unassigned"}</p>
      <h1>${e.name}</h1>
      <p class="subtle">${e.designation || "Unassigned"} | Source confidence ${e.sourceConfidence}%</p>
      <div class="source-chips">${sources || "<span>No matched source</span>"}</div>
      <div class="detail-grid">
        <div><strong>${formatKpi(e.kpi)}</strong><br><span class="subtle">KPI</span></div>
        <div><strong>${e.worklogix.completed}/${e.worklogix.workItems}</strong><br><span class="subtle">Delivery</span></div>
        <div><strong>${e.attendance.present}</strong><br><span class="subtle">Present days</span></div>
        <div><strong>${number.format(e.attendance.officeHours)}</strong><br><span class="subtle">Office hours</span></div>
        <div><strong>${teamsStatusBadge(e.teams)}</strong><br><span class="subtle">Teams status</span></div>
      </div>
      <h2>Score drivers</h2>
      <div class="radar-section">
        <canvas id="radarChart"></canvas>
        <div class="radar-legend">
          ${Object.entries(e.scoreDrivers).map(([key, value]) => `
            <div class="radar-legend-row">
              <span class="radar-lbl">${title(key)}</span>
              <span class="radar-val">${number.format(value)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </section>
  `;
  document.getElementById("employeeDialog").showModal();
  requestAnimationFrame(() => {
    const rc = document.getElementById("radarChart");
    if (rc) drawRadarChart(rc, e.scoreDrivers);
  });
}

function exportCsv() {
  const headers = ["id", "name", "team", "designation", "kpi", "band", "confidence", "work_items", "completed", "present", "absent", "teams_status"];
  const rows = filteredEmployees.map((e) => [
    e.id,
    e.name,
    e.team,
    e.designation,
    formatKpi(e.kpi),
    e.band,
    e.sourceConfidence,
    e.worklogix.workItems,
    e.worklogix.completed,
    e.attendance.present,
    e.attendance.absent,
    e.teams.status || "",
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "peopleops-sample-kpi.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function formatKpi(value) {
  return value === null || value === undefined ? "-" : value;
}

function formatList(values) {
  return values?.length ? values.join(", ") : "-";
}

function missingSource(employee, source) {
  return employee.sources[source] ? '<span class="available-source">-</span>' : '<span class="missing-source">Missing</span>';
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function average(values) {
  return values.length ? sum(values) / values.length : 0;
}

function title(value) {
  return value.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

boot().catch((error) => {
  document.body.innerHTML = `<main class="workspace"><article class="panel"><h1>Unable to load dashboard data</h1><p>${error.message}</p></article></main>`;
});
