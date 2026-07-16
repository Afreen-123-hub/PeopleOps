let dataset;
let filteredEmployees = [];
let loggedInUserName = "";
let loggedInUserEmail = "";
let departmentChartBars = [];

const state = {
  search: "",
  band: "all",
  team: "all",
  confidence: 0,
  showInterns: false,
};

const DEMO_MODE = false;
const DEMO_REFRESH_MESSAGE = "Demo mode: backend refresh is disabled";

const DEPT_MERGE_MAP = {
  "AI": "AI Team",
  "AI Development": "AI Team",
  "AI Engineer": "AI Team",
  "BDM": "Business Development",
  "Backend": "Software Development",
  "Frontend": "Software Development",
  "Fullstack": "Software Development",
  "Technology & Development": "Software Development",
  "HR": "HR Team",
  "HR Team": "HR Team",
  "Quality Analyst": "Quality & Testing",
  "Testing": "Quality & Testing",
  "Testing Team": "Quality & Testing",
  "cyber security": "Cyber Security Team",
  "Cyber security": "Cyber Security Team",
  "Cyber Security": "Cyber Security Team",
};

function mergedTeam(team) {
  return DEPT_MERGE_MAP[team] || team;
}

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

const TEAMS_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes

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
    { label: "Excellent",         color: "#0f6b3a", count: 0 },
    { label: "Good",              color: "#2fb36d", count: 0 },
    { label: "Average",           color: "#3b82f6", count: 0 },
    { label: "Needs Improvement", color: "#f3a229", count: 0 },
    { label: "Critical",          color: "#db4d5c", count: 0 },
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
      <button class="donut-legend-item" type="button" data-band="${s.label}">
        <span class="donut-dot" style="background:${s.color}"></span>
        <span class="donut-legend-label">${s.label}</span>
        <span class="donut-legend-count">${s.count}</span>
        <span class="donut-pct">${Math.round((s.count / total) * 100)}%</span>
      </button>
    `).join("");
    legend.querySelectorAll("[data-band]").forEach((btn) => {
      btn.addEventListener("click", () => openBandDrawer(btn.dataset.band));
    });
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
    const team = mergedTeam(e.team || "Unassigned");
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

  const bandColors = { "Excellent": "#0f6b3a", "Good": "#2fb36d", "Average": "#3b82f6", "Needs Improvement": "#f3a229", "Critical": "#db4d5c", "Insufficient Data": "#94a3b8" };
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
    { color: "#0f6b3a", label: "Excellent" },
    { color: "#2fb36d", label: "Good" },
    { color: "#3b82f6", label: "Average" },
    { color: "#f3a229", label: "Needs Improvement" },
    { color: "#db4d5c", label: "Critical" },
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


function setupGlobalMonthPicker() {
  const input = document.getElementById("globalMonthInput");
  const btn = document.getElementById("globalMonthBtn");
  if (!input || !btn) return;
  input.max = new Date().toISOString().slice(0, 7);
  const period = dataset?.meta?.period || "";
  const m = period.match(/(\d{4}-\d{2})/);
  if (m) input.value = m[1];
  btn.addEventListener("click", () => {
    if (input.value) fetchGlobalAttendanceMonth(input.value);
  });
}

function updateGlobalMonthLabel() {
  const el = document.getElementById("globalMonthLabel");
  if (!el || !dataset?.meta?.period) return;
  const m = dataset.meta.period.match(/(\d{4}-\d{2})/);
  if (!m) return;
  const date = new Date(`${m[1]}-01T00:00:00`);
  el.textContent = `Currently showing: ${date.toLocaleDateString([], { month: "long", year: "numeric" })}`;
}

async function fetchGlobalAttendanceMonth(month) {
  const btn = document.getElementById("globalMonthBtn");
  const status = document.getElementById("globalMonthStatus");
  if (!btn || !status) return;
  btn.disabled = true;
  status.className = "graph-attendance-status loading";
  const label = new Date(`${month}-01T00:00:00`).toLocaleDateString([], { month: "long", year: "numeric" });
  status.textContent = `Fetching ${label} data…`;
  try {
    const res = await apiFetch("/api/refresh-month", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.message || payload.error || "Failed to refresh");
    // Use data returned in response — never reload the main data file
    if (payload.data && payload.data.employees) {
      dataset = payload.data;
      applyFilters();
    }
    status.className = "graph-attendance-status success";
    status.textContent = `✓ Loaded ${label} — all systems updated`;
  } catch (err) {
    status.className = "graph-attendance-status error";
    status.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function boot() {
  if (!getToken()) {
    window.location.href = "login.html";
    return;
  }
  // Validate token with server — catches expired sessions before any data loads
  const ping = await apiFetch("/api/health");
  if (!ping) return; // apiFetch already cleared token and redirected to login.html
  // Load logged-in user profile — await so loggedInUserName is set before first render
  const meRes = await apiFetch("/api/me");
  if (meRes) {
    const me = await meRes.json();
    if (me.name) {
      loggedInUserName = me.name;
      loggedInUserEmail = (me.email || "").toLowerCase();
      const initials = me.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
      const avatarEl = document.getElementById("railUserAvatar");
      const nameEl   = document.getElementById("railUserName");
      const typeEl   = document.getElementById("railUserType");
      const wrapEl   = document.getElementById("railUser");
      if (avatarEl) avatarEl.textContent = initials;
      if (nameEl)   { nameEl.textContent = me.name; nameEl.title = me.name; }
      if (typeEl)   typeEl.textContent   = me.type === "sso" ? "Microsoft account" : "Admin";
      if (wrapEl)   wrapEl.style.display = "flex";
    }
  }
  dataset = await loadDataset();
  if (!dataset) return;
  filteredEmployees = dataset.employees.filter(e => !isIntern(e)).sort((a, b) => {
    if (a.kpi == null && b.kpi == null) return 0;
    if (a.kpi == null) return 1;
    if (b.kpi == null) return -1;
    return b.kpi - a.kpi;
  });
  setupNavigation();
  setupFilters();
  setupDepartmentChartEvents();
  renderAll();
  setupGlobalMonthPicker();
  updateTeamsRefreshLabel();
  if (!DEMO_MODE) {
    setInterval(autoRefreshTeams, TEAMS_REFRESH_INTERVAL);
    setInterval(() => { if (typeof refreshGraph === "function") refreshGraph(); }, TEAMS_REFRESH_INTERVAL);
  }
}

async function autoRefreshTeams() {
  const res = await apiFetch("/api/refresh-teams", { method: "POST" });
  if (!res || !res.ok) return;
  const result = await res.json();
  if (result.status !== "refreshed" || !result.teams) return;
  // Patch teams data into dataset without re-fetching everything
  result.teams.forEach(fresh => {
    const emp = dataset.employees.find(e => e.id === fresh.id);
    if (emp) emp.teams = { status: fresh.status, isActive: fresh.isActive, isAway: fresh.isAway,
      isOffline: fresh.isOffline, isOutOfOffice: fresh.isOutOfOffice, workLocation: fresh.workLocation };
  });
  filteredEmployees = filteredEmployees.map(e => dataset.employees.find(d => d.id === e.id) || e);
  renderTeamsTable();
  updateTeamsRefreshLabel(result.teamsRefreshedAt || Date.now());
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
  const suffix = `?t=${Date.now()}`;
  const fileResponse = await fetch(`data/peopleops-data.json${suffix}`, { cache: "no-store" }).catch(() => null);
  return fileResponse?.ok ? fileResponse.json() : null;
}

function setupNavigation() {
  document.querySelectorAll(".rail-item").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".rail-item").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".view").forEach((view) => view.classList.remove("active-view"));
      button.classList.add("active");
      document.getElementById(button.dataset.view).classList.add("active-view");
      window.scrollTo({ top: 0, behavior: "instant" });
      toggleControls(button.dataset.view);
      if (button.dataset.view === "overview") drawScatter();
      if (button.dataset.view === "kpi") renderKpiPerformance();
      if (button.dataset.view === "github") renderGitHub();
      if (button.dataset.view === "graph") renderGraph();
    });
  });
}

function toggleControls(view) {
  const controls = document.querySelector(".controls");
  controls.hidden = ["attendance", "projects", "integrations", "github", "graph"].includes(view);
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
  document.getElementById("internToggle").addEventListener("change", (event) => {
    state.showInterns = event.target.checked;
    applyFilters();
  });
  document.getElementById("exportBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("exportMenu").classList.toggle("open");
  });
  document.addEventListener("click", () => {
    document.getElementById("exportMenu").classList.remove("open");
    const um = document.getElementById("railUserMenu");
    if (um) um.classList.remove("open");
  });
  const dotsBtn = document.getElementById("railUserDotsBtn");
  if (dotsBtn) dotsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("railUserMenu").classList.toggle("open");
  });
  document.getElementById("exportCsv").addEventListener("click", () => { exportCsv(); document.getElementById("exportMenu").classList.remove("open"); });
  document.getElementById("exportXlsx").addEventListener("click", () => { exportExcel(); document.getElementById("exportMenu").classList.remove("open"); });
  document.getElementById("refreshKpi").addEventListener("click", refreshKpiPerformance);
  document.getElementById("clearKpiTeam").addEventListener("click", clearKpiTeamFilter);
  document.getElementById("closeDialog").addEventListener("click", () => document.getElementById("employeeDialog").close());
  document.getElementById("closeGhContribDialog").addEventListener("click", () => document.getElementById("ghContribDialog").close());
  document.getElementById("graphRefreshButton")?.addEventListener("click", () => refreshGraph());
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
  const teams = [...new Set(dataset.employees.map((e) => mergedTeam(e.team || "Unassigned")))].sort();
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
  const meNorm = loggedInUserName.trim().toLowerCase();
  const sorted = dataset.employees
    .slice()
    .sort((a, b) => {
      const aMe = meNorm && a.name.trim().toLowerCase() === meNorm ? -1 : 0;
      const bMe = meNorm && b.name.trim().toLowerCase() === meNorm ? 1 : 0;
      return aMe + bMe || a.name.localeCompare(b.name);
    });
  attendanceSelect.innerHTML = sorted
    .map((employee) => `<option value="${employee.id}">${employee.name} (${employee.id})</option>`)
    .join("");
  if (previousEmployee && dataset.employees.some((employee) => employee.id === previousEmployee)) {
    attendanceSelect.value = previousEmployee;
  } else if (meNorm) {
    const match = dataset.employees.find(e => e.name.trim().toLowerCase() === meNorm);
    if (match) attendanceSelect.value = match.id;
  }
}

function isIntern(employee) {
  return employee.roleCategory === "intern" || employee.roleCategory === "trainee";
}

function applyFilters() {
  filteredEmployees = dataset.employees
    .filter((employee) => {
      if (!state.showInterns && isIntern(employee)) return false;
      const text = [employee.name, employee.id, employee.team, employee.designation].join(" ").toLowerCase();
      return (
        text.includes(state.search) &&
        (state.band === "all" || employee.band === state.band) &&
        (state.team === "all" || mergedTeam(employee.team || "Unassigned") === state.team) &&
        employee.sourceConfidence >= state.confidence
      );
    })
    .sort((a, b) => {
      if (a.kpi == null && b.kpi == null) return 0;
      if (a.kpi == null) return 1;
      if (b.kpi == null) return -1;
      return b.kpi - a.kpi;
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
        <span class="alert-team">${mergedTeam(e.team || "Unassigned")}</span>
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
  updateGlobalMonthLabel();
  renderTotalEmployeeBadge();
  renderMetrics();
  renderTeamsInsights();
  renderQuadrantSummary();
  renderKpiPerformance();
  renderSourceCoverage();
  renderWeights();
  renderLeadershipStrip();
  renderPeopleTable();
  renderTeamsTable();
  renderAttendanceDetail(document.getElementById("attendanceEmployee").value || dataset.employees[0]?.id);
  renderProjects();
  renderIntegrations();
  drawDonutChart();
  drawScatter();
  document.getElementById("filteredCount").textContent = `${filteredEmployees.length} employees in view`;
}

function getKpiRows() {
  return filteredEmployees.filter((employee) => employee.kpi !== null && employee.kpi !== undefined);
}

function laggingAreas(employee) {
  const d = employee.scoreDrivers || {};
  const drivers = [
    ["Productivity", d.productivity, "Review task completion, workload, and work hours logged in Worklogix."],
    ["Attendance", d.attendance, "Check attendance record — present days vs. expected working days in GreytHR."],
    ["Task Completion", d.taskCompletion, "Review completion rate and pending/blocked items in Worklogix."],
    ["Punctuality", d.punctuality, "Review biometric check-in times — arriving after 9:15 AM lowers this score."],
    ["Collaboration", d.collaboration, "Check Teams presence, availability pattern, and collaboration visibility."],
    ["GitHub", d.github, "No GitHub contributions found — verify commits or PRs in the org."],
  ];
  const weak = drivers
    .filter(([, value]) => Number(value) < 60)
    .sort((a, b) => a[1] - b[1]);
  return weak.length ? weak : [["On track", 100, "Keep monitoring all KPI drivers together."]];
}

function kpiTone(value) {
  if (value >= 80) return "good";
  if (value >= 60) return "watch";
  return "risk";
}

function teamKpiSummary(rows) {
  const teams = new Map();
  rows.forEach((employee) => {
    const team = mergedTeam(employee.team || "Unassigned");
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
  const avgProductivity = rows.length ? average(rows.map((employee) => employee.scoreDrivers?.productivity || 0)) : 0;
  const avgTaskCompletion = rows.length ? average(rows.map((employee) => employee.scoreDrivers?.taskCompletion || 0)) : 0;
  const laggingEmployees = rows.filter((employee) => laggingAreas(employee)[0][0] !== "On track");
  document.getElementById("clearKpiTeam").hidden = state.team === "all";
  renderTeamHeatmap();

  document.getElementById("kpiTeamCount").textContent = `${teamRows.length} teams`;
  document.getElementById("kpiEmployeeCount").textContent = `${rows.length} employees`;

  document.getElementById("kpiSignalSummary").innerHTML = [
    ["Overall KPI", number.format(avgKpi), `${laggingEmployees.length} employees lagging`, kpiTone(avgKpi)],
    ["Productivity", number.format(avgProductivity), "Worklogix delivery — 35% weight", kpiTone(avgProductivity)],
    ["Task Completion", number.format(avgTaskCompletion), "Work items completed — 20% weight", kpiTone(avgTaskCompletion)],
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
      const members = filteredEmployees.filter((e) => mergedTeam(e.team || "Unassigned") === team);
      showTeamMembersModal(team, members);
    });
  });

  document.getElementById("kpiEmployeeTable").innerHTML = rows
    .slice()
    .sort((a, b) => a.kpi - b.kpi || a.name.localeCompare(b.name))
    .map((employee) => `
        <tr data-id="${employee.id}">
          <td><div class="person"><strong>${employee.name}</strong><small>${employee.id} | ${employee.designation || "Unassigned"}</small></div></td>
          <td>${mergedTeam(employee.team || "Unassigned")}</td>
          <td class="numeric-cell"><span class="kpi-score ${kpiTone(employee.kpi)}">${number.format(employee.kpi)}</span> ${lowConfidenceWarning(employee)}</td>
        </tr>
      `)
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
  if (DEMO_MODE) {
    status.textContent = DEMO_REFRESH_MESSAGE;
    return;
  }
  status.textContent = "Refreshing…";
  try {
    const res = await apiFetch("/api/refresh-month", { method: "POST" });
    if (!res) return;
    if (res.ok) {
      status.textContent = "Refreshed — reloading…";
      dataset = await loadDataset();
      if (dataset) {
        filteredEmployees = dataset.employees.filter(e => !isIntern(e));
        applyFilters();
        status.textContent = "KPI data updated ✓";
      }
    } else {
      const body = await res.json().catch(() => ({}));
      status.textContent = body.message || "Refresh failed — try again";
    }
  } catch {
    status.textContent = "Refresh failed — check connection";
  }
}

function setupDepartmentChartEvents() {
  const chart = document.getElementById("scatterChart");
  if (!chart) return;
  chart.addEventListener("click", (event) => {
    const row = event.target.closest("[data-department-index]");
    if (!row) return;
    const department = departmentChartBars[Number(row.dataset.departmentIndex)];
    if (department) renderDepartmentEmployees(department);
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

function showTeamMembersModal(teamName, employees) {
  const existing = document.getElementById("teamMembersModal");
  if (existing) existing.remove();

  const sorted = [...employees].sort((a, b) => {
    if (a.kpi == null && b.kpi == null) return a.name.localeCompare(b.name);
    if (a.kpi == null) return 1;
    if (b.kpi == null) return -1;
    return b.kpi - a.kpi;
  });

  const modal = document.createElement("div");
  modal.id = "teamMembersModal";
  modal.className = "team-modal-overlay";
  modal.innerHTML = `
    <div class="team-modal-box">
      <div class="team-modal-head">
        <div>
          <p class="eyebrow">Team Members</p>
          <h3>${escapeHtml(teamName)}</h3>
        </div>
        <div class="team-modal-meta">
          <span class="pill">${employees.length} member${employees.length !== 1 ? "s" : ""}</span>
          <button class="dialog-close" id="closeTeamModal">✕</button>
        </div>
      </div>
      <ul class="team-modal-list">
        ${sorted.map((e) => {
          const initials = e.name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
          const tone = e.kpi == null ? "no-kpi" : e.kpi >= 80 ? "excellent" : e.kpi >= 70 ? "strong" : e.kpi >= 55 ? "watch" : "risk";
          return `
            <li class="team-modal-row" data-id="${escapeHtml(e.id)}">
              <div class="team-modal-avatar">${initials}</div>
              <div class="team-modal-info">
                <strong>${escapeHtml(e.name)}</strong>
                <small>${escapeHtml(e.designation || e.id)}</small>
              </div>
              <span class="team-modal-kpi ${tone}">${e.kpi != null ? number.format(e.kpi) : "—"}</span>
            </li>`;
        }).join("")}
      </ul>
      <p class="team-modal-footer">Click any member to open their full profile</p>
    </div>
  `;

  document.body.appendChild(modal);
  document.getElementById("closeTeamModal").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (evt) => { if (evt.target === modal) modal.remove(); });
  modal.querySelectorAll(".team-modal-row").forEach((row) => {
    row.addEventListener("click", () => {
      const emp = dataset.employees.find((e) => e.id === row.dataset.id);
      if (emp) { modal.remove(); showEmployee(emp); }
    });
  });
}

function renderDepartmentEmployees(department) {
  showTeamMembersModal(department.department, department.employees);
}

function renderTotalEmployeeBadge() {
  const overview = dataset.overview || {};
  const total = overview.employees || dataset.employees.length;
  document.getElementById("totalEmployeeBadge").innerHTML = `
    <button class="workforce-total-banner" type="button" data-overview-metric="employees">
      <span class="workforce-banner-watermark">${number.format(total)}</span>
      <div class="workforce-banner-content">
        <strong>${number.format(total)}</strong>
        <span>Employees</span>
      </div>
      <span class="workforce-banner-action">View all employees →</span>
    </button>
  `;
  document.querySelector("[data-overview-metric='employees']").addEventListener("click", () => {
    renderOverviewMetricEmployees("employees", "All Employees");
  });
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
    ["Employees", rows.length, "Filtered population", "people", "blue"],
    ["Active", rows.filter((e) => e.active).length, "Currently active", "pulse", "green"],
    ["Inactive", rows.filter((e) => !e.active).length, "Inactive records", "pause", "slate"],
    ["Avg KPI", scoredRows.length ? number.format(avgKpi) : "—", "75%+ confidence", "trend", "violet"],
    ["Completed", `${workItems ? Math.round((completed / workItems) * 100) : 0}%`, `${completed}/${workItems} work items`, "check", "teal"],
    ["Office Hours", number.format(officeHours), "Attendance signal", "clock", "amber"],
    ["Online Now", teamsActive, "Teams presence", "online", "cyan"],
    ["Full Fusion", fullConfidence, "All sources matched", "fusion", "indigo"],
  ];
  document.getElementById("metricGrid").innerHTML = metrics
    .map(([label, value, hint, icon, tone]) => `
      <button type="button" class="metric-card executive-metric tone-${tone}" data-overview-metric="${icon}">
        <div class="metric-card-top">
          <span class="metric-icon metric-icon-${icon}">${metricIcon(icon)}</span>
          <span class="metric-status-dot"></span>
        </div>
        <strong>${value}</strong>
        <span class="metric-label">${label}</span>
        <small>${hint}</small>
      </button>`)
    .join("");
  document.querySelectorAll("#metricGrid [data-overview-metric]").forEach((card) => {
    card.addEventListener("click", () => {
      const labels = {
        people: "Employees in Current View",
        pulse: "Active Employees",
        pause: "Inactive Employees",
        trend: "KPI-Scored Employees",
        check: "Employees with Completed Work",
        clock: "Employees with Office Hours",
        online: "Employees Online on Teams",
        fusion: "Employees with Full Data Fusion",
      };
      renderOverviewMetricEmployees(card.dataset.overviewMetric, labels[card.dataset.overviewMetric]);
    });
  });
}

function renderTeamsInsights() {
  const emps = dataset.employees || [];

  // Leaderboard: top 10 by messages + meetingCount*2 (same as collab signal)
  const licensed = emps.filter(e => e.teams?.activityMatched || (e.teams?.messagesCount || 0) > 0 || (e.teams?.meetingCount || 0) > 0 || (e.teams?.callCount || 0) > 0);
  const ranked = [...licensed]
    .filter(e => (e.teams.messagesCount || 0) + (e.teams.meetingCount || 0) > 0)
    .sort((a, b) => {
      const sa = (a.teams.messagesCount || 0) + (a.teams.meetingCount || 0) * 2;
      const sb = (b.teams.messagesCount || 0) + (b.teams.meetingCount || 0) * 2;
      return sb - sa;
    })
    .slice(0, 10);

  // Ghosts: licensed, active in Worklogix, but 0 Teams activity
  const ghosts = licensed.filter(e =>
    (e.worklogix?.workItems || 0) > 0 &&
    (e.teams.messagesCount || 0) === 0 &&
    (e.teams.meetingCount || 0) === 0 &&
    (e.teams.callCount || 0) === 0
  );

  const maxScore = ranked.length ? (ranked[0].teams.messagesCount || 0) + (ranked[0].teams.meetingCount || 0) * 2 : 1;

  const leaderboardRows = ranked.map((e, i) => {
    const score = (e.teams.messagesCount || 0) + (e.teams.meetingCount || 0) * 2;
    const pct = Math.round(score / maxScore * 100);
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
    return `
      <div class="tl-row">
        <span class="tl-rank">${medal}</span>
        <div class="tl-info">
          <span class="tl-name">${e.name}</span>
          <div class="tl-bar-wrap"><div class="tl-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="tl-stats">
          <span title="Messages">${(e.teams.messagesCount || 0).toLocaleString()} msg</span>
          <span title="Meetings">${e.teams.meetingCount || 0} mtg</span>
        </div>
      </div>`;
  }).join("");

  const ghostRows = ghosts.map(e => `
    <div class="ghost-row">
      <span class="ghost-name">${e.name}</span>
      <span class="ghost-meta">${e.worklogix?.workItems || 0} tasks in Worklogix · 0 Teams activity</span>
      <span class="ghost-badge">Ghost</span>
    </div>`).join("");

  document.getElementById("teamsInsightRow").innerHTML = `
    <div class="teams-insight-panel">
      <div class="ti-section">
        <p class="eyebrow">Teams Activity · Last 30 days</p>
        <h2 class="ti-title">Top 10 Most Active on Teams</h2>
        <div class="tl-list">${ranked.length ? leaderboardRows : '<p class="proj-empty">No Teams activity data yet.</p>'}</div>
      </div>
      <div class="ti-section">
        <p class="eyebrow">Attention needed</p>
        <h2 class="ti-title">Ghost on Teams <span class="ghost-count-badge">${ghosts.length}</span></h2>
        <p class="ti-sub">Active in Worklogix but no Teams messages, meetings or calls in 30 days.</p>
        <div class="ghost-list">${ghosts.length ? ghostRows : '<p class="proj-empty">No ghosts — everyone is active.</p>'}</div>
      </div>
    </div>`;
}

function renderOverviewMetricEmployees(metric, label) {
  const source = metric === "employees" ? dataset.employees : filteredEmployees;
  const filters = {
    employees: () => true,
    people: () => true,
    pulse: (employee) => employee.active,
    pause: (employee) => !employee.active,
    trend: (employee) => employee.kpi !== null && employee.kpi !== undefined,
    check: (employee) => Number(employee.worklogix?.completed || 0) > 0,
    clock: (employee) => Number(employee.attendance?.officeHours || 0) > 0,
    online: (employee) => Boolean(employee.teams?.isActive),
    fusion: (employee) => employee.sourceConfidence === 100,
  };
  const employees = source
    .filter(filters[metric] || filters.people)
    .sort((a, b) => {
      const aKpi = a.kpi === null || a.kpi === undefined ? -1 : a.kpi;
      const bKpi = b.kpi === null || b.kpi === undefined ? -1 : b.kpi;
      return bKpi - aKpi || a.name.localeCompare(b.name);
    });
  const panel = document.getElementById("bandEmployeesPanel");
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="overview-drilldown-head">
      <div>
        <p class="eyebrow">Overview drill-down</p>
        <h3>${escapeHtml(label)}</h3>
        <span>${employees.length} employee${employees.length === 1 ? "" : "s"}</span>
      </div>
      <button type="button" id="closeOverviewDrilldown" aria-label="Close">×</button>
    </div>
    <div class="overview-employee-grid">
      ${employees.map((employee) => `
        <button type="button" class="overview-employee-card" data-overview-employee="${escapeHtml(employee.id)}">
          <span class="overview-employee-avatar">${escapeHtml(employee.name?.[0] || "?")}</span>
          <span class="overview-employee-info">
            <strong>${escapeHtml(employee.name)}</strong>
            <small>${escapeHtml(employee.id)} · ${escapeHtml(mergedTeam(employee.team || "Unassigned"))}</small>
          </span>
          <span class="overview-employee-stats">
            <b>${formatKpi(employee.kpi)}</b>
            <small>KPI</small>
          </span>
          <span class="employee-status ${employee.active ? "active" : "inactive"}">${employee.active ? "Active" : "Inactive"}</span>
        </button>
      `).join("") || '<p class="overview-empty-result">No employees match this category.</p>'}
    </div>
  `;
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("closeOverviewDrilldown").addEventListener("click", () => {
    panel.hidden = true;
  });
  panel.querySelectorAll("[data-overview-employee]").forEach((row) => {
    row.addEventListener("click", () => {
      const employee = dataset.employees.find((item) => item.id === row.dataset.overviewEmployee);
      if (employee) showEmployee(employee);
    });
  });
}

function metricIcon(name) {
  const icons = {
    people: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M22 21v-2a4 4 0 0 0-3-3.87"/></svg>',
    pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>',
    trend: '<svg viewBox="0 0 24 24"><path d="m3 17 6-6 4 4 8-9M15 6h6v6"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    online: '<svg viewBox="0 0 24 24"><path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01"/></svg>',
    fusion: '<svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><circle cx="12" cy="17" r="3"/><path d="m9 9 2 5M15 9l-2 5M10 7h4"/></svg>',
  };
  return icons[name] || "";
}

function renderSourceCoverage() {
  const total = dataset.overview.employees;
  const labels = {
    worklogix: "Worklogix employee records",
    worklogixActivity: "Worklogix activity",
    teams: "Teams activity",
    greythr: "GreytHR muster",
    biometrics: "Biometric swipes",
    github: "GitHub contributions",
  };
  document.getElementById("sourceCoverage").innerHTML = Object.entries(dataset.overview.sourceCoverage)
    .filter(([key]) => key in labels)
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

function renderQuadrantSummary() {
  const container = document.getElementById("quadrantGrid");
  if (!container) return;
  const total = filteredEmployees.length || 1;
  const counts = { "High Performer": 0, "Ghost Worker": 0, "Present but Idle": 0, "Disengaged": 0 };
  filteredEmployees.forEach((e) => {
    if (e.quadrant && counts[e.quadrant] !== undefined) counts[e.quadrant]++;
  });
  const cards = [
    { label: "High Performer",    count: counts["High Performer"],    tone: "hp",  desc: "High productivity + high attendance" },
    { label: "Ghost Worker",      count: counts["Ghost Worker"],      tone: "gw",  desc: "High output but low physical presence" },
    { label: "Present but Idle",  count: counts["Present but Idle"],  tone: "pi",  desc: "Present in office, low work output" },
    { label: "Disengaged",        count: counts["Disengaged"],        tone: "dis", desc: "Low productivity and low attendance" },
  ];
  container.innerHTML = cards.map(({ label, count, tone, desc }) => {
    const pct = Math.round((count / total) * 100);
    return `<button class="quadrant-card qcard-${tone}" type="button" data-quadrant="${label}">
      <div class="band-card-heading"><span class="band-indicator"></span><span>${label}</span><strong>${pct}%</strong></div>
      <div class="band-card-value"><strong>${count}</strong><span>employees</span></div>
      <p>${desc}</p>
      <div class="band-progress"><span style="width:${pct}%"></span></div>
    </button>`;
  }).join("");
  container.querySelectorAll("[data-quadrant]").forEach((card) => {
    card.addEventListener("click", () => {
      const q = card.dataset.quadrant;
      const employees = filteredEmployees.filter((e) => e.quadrant === q).sort((a, b) => (b.kpi || 0) - (a.kpi || 0));
      openBandDrawer(q, employees);
    });
  });
}

function renderBandSummary() {
  const counts = {
    "Excellent": 0,
    "Good": 0,
    "Average": 0,
    "Needs Improvement": 0,
    "Critical": 0,
  };
  filteredEmployees.forEach((employee) => {
    if (!employee.band) return;
    counts[employee.band] = (counts[employee.band] || 0) + 1;
  });
  const total = filteredEmployees.length || 1;
  const cards = [
    ["Excellent",         counts["Excellent"],         "Outstanding performance across all metrics",          "excellent", "Excellent"],
    ["Good",              counts["Good"],              "Strong performance with consistent delivery",          "good-band",  "Good"],
    ["Average",           counts["Average"],           "Meets expectations with room to improve",             "average",   "Average"],
    ["Needs Improvement", counts["Needs Improvement"], "Visible gaps requiring coaching and follow-up",       "need",      "Monitor closely"],
    ["Critical",          counts["Critical"],          "Requires immediate manager attention and support",    "low",       "Action required"],
    ["Insufficient Data", counts["Insufficient Data"] || 0, "No attendance record — score cannot be calculated", "no-info",   "No data"],
  ];
  document.getElementById("bandSummary").innerHTML = cards
    .map(([label, value, hint, tone, status]) => {
      const pct = Math.round(value / total * 100);
      return `<button class="band-card ${tone}" data-band="${label}">
        <div class="band-card-heading"><span class="band-indicator"></span><span>${status}</span><strong>${pct}%</strong></div>
        <div class="band-card-value"><strong>${value}</strong><span>employees</span></div>
        <h3>${label}</h3>
        <p>${hint}</p>
        <div class="band-progress"><span style="width:${pct}%"></span></div>
      </button>`;
    })
    .join("");
  document.querySelectorAll(".band-card").forEach((card) => {
    card.addEventListener("click", () => renderBandEmployees(card.dataset.band));
  });
}

function renderBandEmployees(band) {
  const employees = filteredEmployees
    .filter((employee) => employee.band === band)
    .sort((a, b) => b.kpi - a.kpi);
  showTeamMembersModal(band, employees);
}

function renderWeights() {
  const labels = {
    productivity: "Productivity score",
    taskCompletion: "Task completion",
    attendance: "Attendance reliability",
    punctuality: "Punctuality",
    collaboration: "Collaboration activity",
    githubContribution: "GitHub contribution",
  };
  document.getElementById("weightBars").innerHTML = Object.entries(dataset.meta.weights)
    .map(([key, value]) => `<div class="weight-item">
      <strong>${labels[key] || key} ${value}%</strong>
      <div class="bar"><span style="width:${value * 2}%"></span></div>
    </div>`)
    .join("");
}

function lowConfidenceWarning(e) {
  if (e.band === "Insufficient Data") return "";
  if ((e.band === "Critical" || e.band === "Needs Improvement") && (e.sourceConfidence || 0) < 75) {
    return `<span class="low-conf-warn" title="Score based on limited data (${e.sourceConfidence}% confidence) — may not reflect actual performance">⚠ Low data</span>`;
  }
  return "";
}

function renderLeadershipStrip() {
  const strip = document.getElementById("leadershipStrip");
  if (!strip || !dataset) return;
  const executives = (dataset.employees || []).filter(e => e.band === "Executive");
  if (!executives.length) { strip.innerHTML = ""; return; }
  strip.innerHTML = `

    <div class="leadership-strip">
      <div class="leadership-strip-header">
        <span class="eyebrow">Leadership</span>
        <span class="pill">${executives.length} executives · scored by team performance</span>
      </div>
      <div class="leadership-cards">
        ${executives.map((e, i) => {
          const teamKpi   = e.scoreDrivers?.teamAvgKpi ?? null;
          const reports   = e.scoreDrivers?.reporteeCount ?? 0;
          const status    = e.teams?.presence || "";
          const statusCls = status === "Available" ? "avail" : status === "Away" ? "away" : "offline";
          const kpiBlock  = teamKpi != null
            ? `<div class="lc-kpi">${teamKpi}<span class="lc-kpi-label">Team Avg KPI</span></div>`
            : `<div class="lc-kpi lc-kpi-none">—<span class="lc-kpi-label">No team data yet</span></div>`;
          return `
          <div class="leadership-card" data-exec-index="${i}" style="cursor:pointer" title="Click for details">
            <div class="lc-top">
              <div class="lc-avatar">${e.name.trim().split(" ").map(w => w[0]).slice(0,2).join("")}</div>
              <div class="lc-info">
                <strong class="lc-name">${e.name}</strong>
                <span class="lc-title">${e.designation || ""}</span>
                ${status ? `<span class="lc-status ${statusCls}">${status}</span>` : ""}
              </div>
            </div>
            ${kpiBlock}
            ${reports ? `<div class="lc-reports">${reports} direct report${reports > 1 ? "s" : ""}</div>` : ""}
          </div>`;
        }).join("")}
      </div>
    </div>`;
  strip.querySelectorAll(".leadership-card").forEach(card => {
    card.addEventListener("click", () => {
      const exec = executives[Number(card.dataset.execIndex)];
      if (exec) showEmployee(exec);
    });
  });
}

function renderPeopleTable() {
  const meNorm = loggedInUserName.trim().toLowerCase();
  const sorted = filteredEmployees
    .filter(e => e.band !== "Executive")
    .slice()
    .sort((a, b) => {
      const aMe = meNorm && a.name.trim().toLowerCase() === meNorm ? -1 : 0;
      const bMe = meNorm && b.name.trim().toLowerCase() === meNorm ? 1 : 0;
      return aMe + bMe;
    });
  document.getElementById("peopleTable").innerHTML = sorted
    .map((e, index) => `<tr data-index="${index}"${e.kpi == null ? ' class="row-no-data"' : ""}>
      <td><div class="person"><strong>${e.name}</strong><small>${e.designation || "Unassigned"} &middot; ${mergedTeam(e.team || "Unassigned")}</small></div>${missingSourceTags(e)}</td>
      <td class="numeric-cell"><span class="score">${e.kpi != null ? e.kpi : "—"}</span></td>
      <td>${e.band ? `<span class="band ${bandClass(e.band)}">${e.band}</span>` : '<span class="band no-info">Pending Link</span>'} ${lowConfidenceWarning(e)}</td>
      <td class="numeric-cell">${e.worklogix.completed}/${e.worklogix.workItems}</td>
      <td class="numeric-cell">${e.attendance.present}</td>
      <td class="numeric-cell">${e.attendance.leave ?? 0}</td>
      <td class="numeric-cell">${e.attendance.absent}</td>
      <td>${teamsStatusBadge(e.teams)}</td>
    </tr>`)
    .join("");

  document.querySelectorAll("#peopleTable tr").forEach((row) => {
    row.addEventListener("click", () => showEmployee(sorted[Number(row.dataset.index)]));
  });
}

function teamsStatusBadge(teams, clickable = false, empIndex = -1) {
  const status = teams.status || "";
  if (!status) return '<span class="presence-badge offline">No Data</span>';
  const cls = status === "Busy" ? "busy" : teams.isActive ? "active" : teams.isOutOfOffice ? "ooo" : teams.isAway ? "away" : "offline";
  const label = status.replace(/([A-Z])/g, " $1").trim();
  if (clickable && empIndex >= 0) {
    return `<span class="presence-badge ${cls} clickable-badge" data-emp-index="${empIndex}" title="Click for details">${label} ›</span>`;
  }
  const loc = teams.workLocation ? ` · ${teams.workLocation}` : "";
  return `<span class="presence-badge ${cls}">${label}${loc}</span>`;
}

function formatCheckinHour(h) {
  if (h == null) return "—";
  const hours = Math.floor(h);
  const mins = Math.round((h - hours) * 60);
  const period = hours >= 12 ? "PM" : "AM";
  const h12 = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
  return `${h12}:${String(mins).padStart(2, "0")} ${period}`;
}

function renderTeamsTable() {
  const statusPriority = (e) =>
    e.teams.isActive ? 0 : e.teams.isAway ? 1 : e.teams.isOutOfOffice ? 2 : e.teams.isOffline ? 3 : 4;
  const rows = filteredEmployees
    .slice()
    .sort((a, b) => statusPriority(a) - statusPriority(b) || a.name.localeCompare(b.name));

  // Status summary bar
  const active = rows.filter(e => e.teams.isActive).length;
  const away   = rows.filter(e => e.teams.isAway).length;
  const ooo    = rows.filter(e => e.teams.isOutOfOffice).length;
  const offline = rows.filter(e => e.teams.isOffline).length;
  const noData  = rows.filter(e => !e.teams.status).length;
  document.getElementById("teamsStatusBar").innerHTML = `
    <span class="tsb-pill active">${active} Active</span>
    <span class="tsb-pill away">${away} Away</span>
    <span class="tsb-pill ooo">${ooo} Out of Office</span>
    <span class="tsb-pill offline">${offline} Offline</span>
    ${noData ? `<span class="tsb-pill nodata">${noData} No Data</span>` : ""}
  `;

  document.getElementById("teamsTable").innerHTML = rows
    .map((e, i) => {
      return `<tr>
        <td><div class="person"><strong>${e.name}</strong><small>${e.id} | ${mergedTeam(e.team || "Unassigned")}</small></div></td>
        <td>${e.designation || "Unassigned"}</td>
        <td>${teamsStatusBadge(e.teams, true, i)}</td>
      </tr>`;
    })
    .join("");

  document.querySelectorAll(".clickable-badge").forEach(badge => {
    badge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const emp = rows[Number(badge.dataset.empIndex)];
      if (emp) openTeamsPanel(emp);
    });
  });
}

function openTeamsPanel(e) {
  const att  = e.attendance || {};
  const tm   = e.teams || {};
  const cal  = e.graphActivity?.calendar || {};
  const plan = e.graphActivity?.planner || {};
  const sp   = e.graphActivity?.sharePoint || {};
  const calNew = e.calendar || {};
  const spNew  = e.sharepoint || {};
  const cls  = tm.status === "Busy" ? "busy" : tm.isActive ? "active" : tm.isOutOfOffice ? "ooo" : tm.isAway ? "away" : "offline";
  const statusLabel = (tm.status || "No Data").replace(/([A-Z])/g, " $1").trim();

  document.getElementById("teamsDrawerContent").innerHTML = `
    <div class="tsd-header">
      <div class="tsd-avatar">${e.name.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase()}</div>
      <div>
        <strong class="tsd-name">${e.name}</strong>
        <small class="tsd-meta">${e.designation || "Unassigned"} · ${mergedTeam(e.team || "Unassigned")}</small>
        <span class="presence-badge ${cls}" style="margin-top:6px;display:inline-flex">${statusLabel}</span>
        ${tm.workLocation ? `<span class="tsd-location">📍 ${tm.workLocation}</span>` : ""}
        ${tm.reports ? `<span class="tsd-location">👥 ${tm.reports} direct report${tm.reports > 1 ? "s" : ""}</span>` : ""}
      </div>
    </div>

    <div class="tsd-section">
      <p class="tsd-section-title">Office Presence${att.officeLocation ? ` <small style="opacity:.5">${att.officeLocation}</small>` : ""}</p>
      <div class="tsd-grid">
        <div class="tsd-stat"><span class="tsd-val">${formatCheckinHour(att.avgCheckinHour)}</span><span class="tsd-lbl">Avg Check-in</span></div>
        <div class="tsd-stat"><span class="tsd-val">${formatCheckinHour(att.avgCheckoutHour)}</span><span class="tsd-lbl">Avg Check-out</span></div>
        <div class="tsd-stat"><span class="tsd-val">${att.avgOfficeHours != null ? att.avgOfficeHours + " hrs" : "—"}</span><span class="tsd-lbl">Avg Daily Hours</span></div>
        <div class="tsd-stat"><span class="tsd-val">${att.punctualityScore != null ? att.punctualityScore + "%" : "—"}</span><span class="tsd-lbl">Punctuality</span></div>
        <div class="tsd-stat"><span class="tsd-val">${att.validOfficeDays != null ? att.validOfficeDays + " days" : "—"}</span><span class="tsd-lbl">Days Tracked</span></div>
        <div class="tsd-stat"><span class="tsd-val">${att.present} / ${att.present + att.absent + att.leave}</span><span class="tsd-lbl">Present / Working Days</span></div>
      </div>
    </div>

    ${(att.teamsAvailableHours || att.teamsAwayHours || att.teamsOfflineHours) ? `
    <div class="tsd-section">
      <p class="tsd-section-title">Teams Presence <small style="opacity:.5">(Worklogix · daily avg)</small></p>
      <div class="tsd-grid">
        <div class="tsd-stat tsd-available"><span class="tsd-val">${att.teamsAvailableHours != null ? att.teamsAvailableHours + " hrs" : "—"}</span><span class="tsd-lbl">Available</span></div>
        <div class="tsd-stat tsd-away"><span class="tsd-val">${att.teamsAwayHours != null ? att.teamsAwayHours + " hrs" : "—"}</span><span class="tsd-lbl">Away</span></div>
        <div class="tsd-stat tsd-offline"><span class="tsd-val">${att.teamsOfflineHours != null ? att.teamsOfflineHours + " hrs" : "—"}</span><span class="tsd-lbl">Offline</span></div>
      </div>
    </div>` : ""}

    <div class="tsd-section">
      <p class="tsd-section-title">Meeting Load <small style="opacity:.5">(Calendar · this period)</small></p>
      <div class="tsd-grid">
        <div class="tsd-stat"><span class="tsd-val">${calNew.invited != null ? calNew.invited : cal.events ?? "—"}</span><span class="tsd-lbl">Meetings Invited</span></div>
        <div class="tsd-stat"><span class="tsd-val">${calNew.attended != null ? calNew.attended : "—"}</span><span class="tsd-lbl">Meetings Attended</span></div>
        <div class="tsd-stat"><span class="tsd-val">${calNew.attendanceRate != null ? calNew.attendanceRate + "%" : "—"}</span><span class="tsd-lbl">Attendance Rate</span></div>
        <div class="tsd-stat"><span class="tsd-val">${cal.meetingHours != null ? cal.meetingHours + " hrs" : tm.meetingHours || "—"}</span><span class="tsd-lbl">Meeting Hours</span></div>
      </div>
    </div>

    ${(spNew.filesViewed != null || spNew.pageVisits != null) ? `
    <div class="tsd-section">
      <p class="tsd-section-title">SharePoint Activity <small style="opacity:.5">(last 30 days)</small></p>
      <div class="tsd-grid">
        <div class="tsd-stat"><span class="tsd-val">${spNew.filesViewed ?? "—"}</span><span class="tsd-lbl">Files Viewed/Edited</span></div>
        <div class="tsd-stat"><span class="tsd-val">${spNew.filesSynced ?? "—"}</span><span class="tsd-lbl">Files Synced</span></div>
        <div class="tsd-stat"><span class="tsd-val">${spNew.filesShared ?? "—"}</span><span class="tsd-lbl">Files Shared</span></div>
        <div class="tsd-stat"><span class="tsd-val">${spNew.pageVisits ?? "—"}</span><span class="tsd-lbl">Page Visits</span></div>
      </div>
    </div>` : ""}

    <div class="tsd-section">
      ${(() => {
        const hasActivity = tm.meetingHours || tm.videoCallHours || tm.messagesCount || tm.callCount;
        const activeHrs = Math.round(((tm.meetingHours || 0) + (tm.videoCallHours || 0) + (tm.screenShareHours || 0)) * 10) / 10;
        return `
        <p class="tsd-section-title">Teams Activity ${hasActivity ? "" : "<small style='opacity:.5'>(pending · Reports.Read.All)</small>"}</p>
        ${hasActivity ? `
        <div class="tsd-teams-active-banner">
          <span class="tsd-teams-active-hrs">${activeHrs}h</span>
          <span class="tsd-teams-active-lbl">Active on Teams this month</span>
        </div>` : `
        <div class="tsd-teams-active-banner tsd-teams-active-banner--na">
          <span class="tsd-teams-active-hrs">—</span>
          <span class="tsd-teams-active-lbl">Active on Teams this month · available once permission is granted</span>
        </div>`}
        <div class="tsd-grid" style="margin-top:10px">
          <div class="tsd-stat ${tm.meetingHours ? "" : "tsd-na"}"><span class="tsd-val">${tm.meetingHours || "—"}</span><span class="tsd-lbl">Meeting Hrs</span></div>
          <div class="tsd-stat ${tm.videoCallHours ? "" : "tsd-na"}"><span class="tsd-val">${tm.videoCallHours || "—"}</span><span class="tsd-lbl">Video Call Hrs</span></div>
          <div class="tsd-stat ${tm.screenShareHours ? "" : "tsd-na"}"><span class="tsd-val">${tm.screenShareHours || "—"}</span><span class="tsd-lbl">Screen Share Hrs</span></div>
          <div class="tsd-stat ${tm.callCount ? "" : "tsd-na"}"><span class="tsd-val">${tm.callCount || "—"}</span><span class="tsd-lbl">Calls Made</span></div>
          <div class="tsd-stat ${tm.messagesCount ? "" : "tsd-na"}"><span class="tsd-val">${tm.messagesCount || "—"}</span><span class="tsd-lbl">Messages Sent</span></div>
          <div class="tsd-stat ${tm.meetingCount ? "" : "tsd-na"}"><span class="tsd-val">${tm.meetingCount || "—"}</span><span class="tsd-lbl">Meetings Attended</span></div>
        </div>`;
      })()}
    </div>

    ${plan.assigned != null ? `
    <div class="tsd-section">
      <p class="tsd-section-title">Planner Tasks</p>
      <div class="tsd-grid">
        <div class="tsd-stat"><span class="tsd-val">${plan.assigned}</span><span class="tsd-lbl">Assigned</span></div>
        <div class="tsd-stat"><span class="tsd-val">${plan.completed}</span><span class="tsd-lbl">Completed</span></div>
        <div class="tsd-stat"><span class="tsd-val">${plan.overdueOpen ?? "—"}</span><span class="tsd-lbl">Overdue</span></div>
        <div class="tsd-stat"><span class="tsd-val">${plan.onTimeRate != null ? plan.onTimeRate + "%" : "—"}</span><span class="tsd-lbl">On-Time Rate</span></div>
      </div>
    </div>` : ""}

    ${e.managerName ? `
    <div class="tsd-section">
      <p class="tsd-section-title">Reports To</p>
      <div class="tsd-manager">${e.managerName}</div>
    </div>` : ""}

    ${(e.directReports && e.directReports.length) ? `
    <div class="tsd-section">
      <p class="tsd-section-title">Direct Reports <small style="opacity:.5">(${e.directReports.length})</small></p>
      <div class="tsd-reportee-list">
        ${e.directReports.map(r => `
          <div class="tsd-reportee">
            <span class="tsd-reportee-avatar">${r.name.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase()}</span>
            <span class="tsd-reportee-info"><strong>${r.name}</strong><br><small>${r.designation || ""}</small></span>
          </div>`).join("")}
      </div>
    </div>` : ""}
  `;

  document.getElementById("teamsDrawerOverlay").hidden = false;
  document.getElementById("teamsDrawer").hidden = false;
  requestAnimationFrame(() => document.getElementById("teamsDrawer").classList.add("open"));
}

function closeTeamsPanel() {
  const drawer = document.getElementById("teamsDrawer");
  drawer.classList.remove("open");
  drawer.addEventListener("transitionend", () => {
    drawer.hidden = true;
    document.getElementById("teamsDrawerOverlay").hidden = true;
  }, { once: true });
}

const QUADRANT_COLORS = {
  "High Performer":   "#2fb36d",
  "Ghost Worker":     "#3b82f6",
  "Present but Idle": "#f3a229",
  "Disengaged":       "#db4d5c",
  "Excellent":        "#0f6b3a",
  "Good":             "#2fb36d",
  "Average":          "#3b82f6",
  "Needs Improvement":"#f3a229",
  "Critical":         "#db4d5c",
  "Executive":        "#7c3aed",
};

function openBandDrawer(label, employees) {
  if (!employees) {
    employees = filteredEmployees
      .filter((e) => e.band === label)
      .sort((a, b) => (b.kpi || 0) - (a.kpi || 0));
  }
  const color = QUADRANT_COLORS[label] || "#627084";

  const content = document.getElementById("bandDrawerContent");
  content.innerHTML = `
    <div class="bd-header">
      <span class="bd-dot" style="background:${color}"></span>
      <div>
        <p class="eyebrow">Employee group</p>
        <strong class="bd-title">${escapeHtml(label)}</strong>
        <small class="bd-count">${employees.length} employee${employees.length !== 1 ? "s" : ""}</small>
      </div>
    </div>
    ${employees.length ? `
    <div class="bd-list">
      ${employees.map((e) => {
        const initials = e.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
        const kpiColor = e.kpi >= 80 ? "#2fb36d" : e.kpi >= 60 ? "#f3a229" : "#db4d5c";
        return `
          <button class="bd-emp-card" data-id="${escapeHtml(e.id)}" type="button">
            <div class="bd-avatar">${initials}</div>
            <div class="bd-info">
              <strong>${escapeHtml(e.name)}</strong>
              <small>${escapeHtml(mergedTeam(e.team || "Unassigned"))} · ${escapeHtml(e.designation || "")}</small>
              <small>${escapeHtml(e.id)}</small>
            </div>
            <div class="bd-kpi">
              <strong style="color:${e.kpi != null ? kpiColor : "#aaa"}">${e.kpi != null ? number.format(e.kpi) : "—"}</strong>
              <small>KPI</small>
            </div>
          </button>
        `;
      }).join("")}
    </div>
    ` : '<p class="bd-empty">No employees in this category.</p>'}
  `;

  content.querySelectorAll(".bd-emp-card").forEach((card) => {
    card.addEventListener("click", () => {
      const emp = dataset.employees.find((e) => e.id === card.dataset.id);
      if (emp) { closeBandDrawer(); showEmployee(emp); }
    });
  });

  document.getElementById("bandDrawerOverlay").hidden = false;
  const drawer = document.getElementById("bandDrawer");
  drawer.hidden = false;
  requestAnimationFrame(() => drawer.classList.add("open"));
}

function closeBandDrawer() {
  const drawer = document.getElementById("bandDrawer");
  drawer.classList.remove("open");
  drawer.addEventListener("transitionend", () => {
    drawer.hidden = true;
    document.getElementById("bandDrawerOverlay").hidden = true;
  }, { once: true });
}

function renderAttendanceDetail(employeeId) {
  const employee = dataset.employees.find((item) => item.id === employeeId) || dataset.employees[0];
  if (!employee) return;
  const attendance = employee.attendance;
  const workingDays = attendance.calendarDays
    ? attendance.calendarDays - attendance.off - attendance.holidays
    : attendance.present + attendance.absent + attendance.leave;
  const trackedDays = workingDays + attendance.off + attendance.holidays;
  const presentRate = workingDays ? Math.min(100, Math.round((attendance.present / workingDays) * 100)) : 0;
  const absentRate = workingDays ? Math.round((attendance.absent / workingDays) * 100) : 0;
  const biometricCoverage = attendance.present
    ? Math.min(100, Math.round((attendance.biometricDays / attendance.present) * 100))
    : 0;
  const avgOfficeHours = Number.isFinite(attendance.avgOfficeHours) ? attendance.avgOfficeHours : 0;
  const monthlyOfficeHours = Number.isFinite(attendance.officeHours) ? attendance.officeHours : 0;
  const health = presentRate >= 90 && absentRate <= 5
    ? { label: "Excellent", tone: "good", note: "Attendance is consistent for the selected period." }
    : presentRate >= 75
      ? { label: "Stable", tone: "watch", note: "Attendance is acceptable, with a few days to review." }
      : { label: "Needs Review", tone: "risk", note: "Attendance requires manager attention for the selected period." };
  const biometricStatus = employee.sources.biometrics
    ? `${attendance.biometricDays} biometric days captured`
    : "No biometric match found";
  const initials = employee.name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const attendanceBars = [
    ["Present days", attendance.present, "#2fb36d"],
    ["Absent days", attendance.absent, "#db4d5c"],
    ["Leave/status days", attendance.leave, "#f3a229"],
    ["Week off days", attendance.off, "#627084"],
    ["Holidays", attendance.holidays, "#7b55d9"],
    ["Biometric days", attendance.biometricDays, "#3366ff"],
  ];
  const maxAttendanceValue = Math.max(1, ...attendanceBars.map(([, value]) => value));
  const summaryCards = [
    ["Present", attendance.present, "days", "good"],
    ["Absent", attendance.absent, "days", attendance.absent ? "risk" : "neutral"],
    ["Leave / Status", attendance.leave, "days", "watch"],
    ["Week Off", attendance.off, "days", "neutral"],
    ["Holidays", attendance.holidays, "days", "neutral"],
    ["Biometric", attendance.biometricDays, "days", employee.sources.biometrics ? "info" : "neutral"],
  ];
  const sourceRows = [
    ["GreytHR attendance", employee.sources.greythr ? "Matched" : "Missing", employee.sources.greythr ? "good" : "risk"],
    ["Biometric presence", employee.sources.biometrics ? "Matched" : "Missing", employee.sources.biometrics ? "good" : "risk"],
    ["Source confidence", `${employee.sourceConfidence}%`, employee.sourceConfidence >= 75 ? "good" : "watch"],
    ["Performance band", employee.band || "KPI blank", employee.band ? "info" : "neutral"],
  ];

  document.getElementById("attendanceDetail").innerHTML = `
    <section class="attendance-hero attendance-hero-${health.tone}">
      <div class="attendance-person">
        <div class="attendance-avatar">${initials}</div>
        <div>
          <p class="eyebrow">${employee.id} | ${mergedTeam(employee.team || "Unassigned")}</p>
          <h1>${employee.name}</h1>
          <p class="subtle">${employee.designation || "Unassigned"} | ${trackedDays} tracked days | ${biometricStatus}</p>
        </div>
      </div>
      <div class="attendance-scorecard">
        <span class="attendance-status attendance-status-${health.tone}">${health.label}</span>
        <strong>${presentRate}%</strong>
        <span>present rate</span>
      </div>
    </section>

    <section class="attendance-explain">
      <strong>${health.note}</strong>
      <span>${attendance.present} present, ${attendance.absent} absent, ${attendance.leave} leave/status, ${attendance.off} week off, and ${attendance.holidays} holidays are recorded for this employee.</span>
    </section>

    <section class="attendance-grid">
      ${summaryCards.map(([label, value, unit, tone]) => `
        <div class="attendance-metric attendance-metric-${tone}">
          <span>${label}</span>
          <strong>${value}</strong>
          <small>${unit}</small>
        </div>
      `).join("")}
    </section>

    <section class="attendance-layout">
      <article class="attendance-chart">
        <div class="attendance-chart-head">
          <div>
            <p class="eyebrow">Status breakdown</p>
            <h2>Attendance Days</h2>
          </div>
          <span class="pill">${workingDays} working days</span>
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
      </article>

      <article class="attendance-chart attendance-facts">
        <div class="attendance-chart-head">
          <div>
            <p class="eyebrow">Workplace presence</p>
            <h2>Hours and Sources</h2>
          </div>
        </div>
        <div class="attendance-hours">
          <div><strong>${number.format(monthlyOfficeHours)} h</strong><span class="subtle">Total office hours</span></div>
          <div><strong>${number.format(avgOfficeHours)} h</strong><span class="subtle">Average office hours/day</span></div>
          <div><strong>${biometricCoverage}%</strong><span class="subtle">Biometric coverage</span></div>
          <div><strong>${absentRate}%</strong><span class="subtle">Absent rate</span></div>
        </div>
        <div class="attendance-source-list">
          ${sourceRows.map(([label, value, tone]) => `
            <div>
              <span>${label}</span>
              <strong class="attendance-source-${tone}">${value}</strong>
            </div>
          `).join("")}
        </div>
      </article>
    </section>
  `;
}

let _projSort = "completion";
let _projStatus = "all";

function renderProjects(filterText) {
  const query = (filterText !== undefined ? filterText : document.getElementById("projectSearch")?.value || "").toLowerCase().trim();
  const all = dataset.projects || [];

  const totalTasks = all.reduce((s, p) => s + (p.tasksTotal || 0), 0);
  const totalCompleted = all.reduce((s, p) => s + (p.tasksCompleted || 0), 0);
  const totalHours = all.reduce((s, p) => s + (p.hoursWorked || 0), 0);
  const overallPct = totalTasks ? Math.round(totalCompleted / totalTasks * 100) : 0;
  const atRiskCount = all.filter(p => p.tasksTotal > 0 && (p.tasksCompleted / p.tasksTotal * 100) < 40 && p.members >= 5).length;

  const statBar = `
    <div class="proj-stat-bar">
      <div class="proj-stat-item"><span class="proj-stat-val">${all.length}</span><span class="proj-stat-lbl">Projects</span></div>
      <div class="proj-stat-item"><span class="proj-stat-val">${totalTasks.toLocaleString()}</span><span class="proj-stat-lbl">Total Tasks</span></div>
      <div class="proj-stat-item"><span class="proj-stat-val">${overallPct}%</span><span class="proj-stat-lbl">Completion Rate</span></div>
      <div class="proj-stat-item"><span class="proj-stat-val">${totalHours >= 1000 ? (totalHours/1000).toFixed(1)+"K" : Math.round(totalHours)}h</span><span class="proj-stat-lbl">Hours Logged</span></div>
      ${atRiskCount ? `<div class="proj-stat-item proj-stat-item--risk"><span class="proj-stat-val proj-stat-val--risk">${atRiskCount}</span><span class="proj-stat-lbl">At Risk</span></div>` : ""}
    </div>`;

  const statusValues = [...new Set(all.map(p => p.status || ""))];
  const hasStatuses = statusValues.some(s => s.length > 0);
  const tabs = hasStatuses ? `
    <div class="proj-filter-tabs">
      ${["all", ...statusValues.filter(Boolean)].map(s =>
        `<button class="proj-filter-tab${_projStatus === s ? " proj-filter-tab--active" : ""}" onclick="_projStatus='${s}';renderProjects()">${s === "all" ? "All" : s}</button>`
      ).join("")}
    </div>` : "";

  const sortBar = `
    <div class="proj-sort-row">
      <div class="proj-sort-label">Sort by:</div>
      ${[["completion","Completion %"],["hours","Hours Logged"],["members","Members"],["name","Name"]].map(([val, lbl]) =>
        `<button class="proj-sort-btn${_projSort === val ? " proj-sort-btn--active" : ""}" onclick="_projSort='${val}';renderProjects()">${lbl}</button>`
      ).join("")}
    </div>`;

  const searchBar = `
    <div class="proj-search-row">
      <input id="projectSearch" class="proj-search" type="search" placeholder="Search by project or manager..." value="${query}" oninput="renderProjects(this.value)">
    </div>`;

  let visible = all;
  if (_projStatus !== "all") visible = visible.filter(p => (p.status || "") === _projStatus);
  if (query) visible = visible.filter(p => (p.name || "").toLowerCase().includes(query) || (p.manager || "").toLowerCase().includes(query));

  visible = [...visible].sort((a, b) => {
    if (_projSort === "completion") {
      const pa = a.tasksTotal ? a.tasksCompleted / a.tasksTotal : 0;
      const pb = b.tasksTotal ? b.tasksCompleted / b.tasksTotal : 0;
      return pb - pa;
    }
    if (_projSort === "hours") return (b.hoursWorked || 0) - (a.hoursWorked || 0);
    if (_projSort === "members") return (b.members || 0) - (a.members || 0);
    return (a.name || "").localeCompare(b.name || "");
  });

  const cards = visible.map(p => {
    const pct = p.tasksTotal ? Math.round(p.tasksCompleted / p.tasksTotal * 100) : 0;
    const approvalPct = p.tasksTotal ? Math.round(p.tasksApproved / p.tasksTotal * 100) : 0;
    const workedH = p.hoursWorked || 0;
    const statusLabel = p.status || "Active";
    const statusClass = statusLabel.toLowerCase().includes("complet") ? "proj-badge--done"
      : statusLabel.toLowerCase().includes("hold") ? "proj-badge--hold"
      : "proj-badge--active";
    const completionColor = pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
    const atRisk = p.tasksTotal > 0 && pct < 40 && p.members >= 5;
    return `
      <article class="project-card proj-card-v2" onclick="showProjDetail('${p.id}')" style="cursor:pointer">
        <div class="proj-card-top">
          <div>
            <div class="proj-card-name">${p.name || p.id}</div>
            ${p.manager ? `<div class="proj-card-pm">PM: ${p.manager}</div>` : ""}
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">
            <span class="proj-badge ${statusClass}">${statusLabel}</span>
            ${atRisk ? `<span class="proj-badge proj-badge--risk">At Risk</span>` : ""}
          </div>
        </div>

        <div class="proj-progress-section">
          <div class="proj-progress-label">
            <span>Task completion</span>
            <strong style="color:${completionColor}">${pct}%</strong>
          </div>
          <div class="proj-bar-wrap"><div class="proj-bar-fill" style="width:${pct}%;background:${completionColor}"></div></div>
          <div class="proj-progress-sub">${p.tasksCompleted} of ${p.tasksTotal} tasks done · ${approvalPct}% approved</div>
        </div>

        ${workedH > 0 ? `
        <div class="proj-progress-section">
          <div class="proj-progress-label">
            <span>Hours logged this month</span>
            <strong>${workedH >= 1000 ? (workedH/1000).toFixed(1)+"K" : workedH}h</strong>
          </div>
        </div>` : ""}

        <div class="proj-card-footer">
          <span class="proj-chip">${p.members} member${p.members !== 1 ? "s" : ""}</span>
          ${p.tasksTotal === 0 ? '<span class="proj-chip proj-chip--warn">No tasks logged</span>' : ""}
          <span class="proj-chip proj-chip--link">View members &rsaquo;</span>
        </div>
      </article>`;
  }).join("");

  document.getElementById("projectGrid").innerHTML =
    statBar + tabs + sortBar + searchBar +
    (visible.length
      ? `<div class="project-grid">${cards}</div>`
      : `<p class="proj-empty">No projects match the current filter.</p>`);
}

function showProjDetail(projId) {
  const p = (dataset.projects || []).find(x => x.id === projId);
  if (!p) return;
  const pct = p.tasksTotal ? Math.round(p.tasksCompleted / p.tasksTotal * 100) : 0;
  const completionColor = pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
  const atRisk = p.tasksTotal > 0 && pct < 40 && p.members >= 5;

  const memberRows = (p.memberStats || []).map(m => {
    const noTasks = m.tasksTotal === 0;
    const mpct = m.tasksTotal ? Math.round(m.tasksCompleted / m.tasksTotal * 100) : 0;
    const mColor = noTasks ? "#94a3b8" : mpct >= 75 ? "#22c55e" : mpct >= 40 ? "#f59e0b" : "#ef4444";
    const mH = m.hoursWorked || 0;
    return `
      <tr class="projd-member-row${noTasks ? " projd-member-idle" : ""}">
        <td class="projd-member-name">${m.name}${noTasks ? ' <span class="projd-no-tasks-badge">No tasks</span>' : ""}</td>
        <td class="projd-member-tasks" style="color:${noTasks ? "#94a3b8" : "inherit"}">${noTasks ? "—" : m.tasksTotal}</td>
        <td class="projd-member-comp">
          ${noTasks ? '<span style="color:#94a3b8;font-size:0.78rem">Not logged</span>' : `
          <div class="projd-mini-bar-wrap">
            <div class="projd-mini-bar-fill" style="width:${mpct}%;background:${mColor}"></div>
          </div>
          <span style="color:${mColor};font-weight:600">${mpct}%</span>`}
        </td>
        <td class="projd-member-hours" style="color:${noTasks ? "#94a3b8" : "inherit"}">${noTasks ? "—" : (mH >= 1000 ? (mH/1000).toFixed(1)+"K" : mH)+"h"}</td>
      </tr>`;
  }).join("");

  document.getElementById("projd-title").textContent = p.name || p.id;
  document.getElementById("projd-meta").innerHTML = `
    ${p.manager ? `<span>PM: <strong>${p.manager}</strong></span>` : ""}
    <span>${p.members} member${p.members !== 1 ? "s" : ""}</span>
    <span style="color:${completionColor};font-weight:600">${pct}% complete</span>
    ${atRisk ? `<span class="proj-badge proj-badge--risk" style="font-size:0.72rem">At Risk</span>` : ""}
  `;
  document.getElementById("projd-body").innerHTML = p.memberStats?.length ? `
    <table class="projd-table">
      <thead><tr><th>Member</th><th>Tasks</th><th>Completion</th><th>Hours</th></tr></thead>
      <tbody>${memberRows}</tbody>
    </table>` : `<p class="proj-empty">No individual task data available for this project.</p>`;

  document.getElementById("projDetailDialog").showModal();
}

function renderIntegrations() {
  const sourceFiles = dataset.meta.sourceFiles;
  const items = [
    ["Worklogix", sourceFiles.worklogix, "Live API data for users, projects, tasks, and work activity."],
    ["GreytHR", sourceFiles.greythr, "Live attendance API — present, absent, leave, and week off records."],
    ["Biometrics", sourceFiles.biometrics, "Live presence report API — office hours and biometric days per employee."],
    ["Teams", sourceFiles.teams, "Live Microsoft Graph API presence data."],
    ["Microsoft Planner", "api", "Live Microsoft Graph plans, task assignments, progress, priorities, and due dates."],
    ["Microsoft Calendar", "api", "Live employee calendar events and meeting-hour activity for the current month."],
    ["Microsoft SharePoint", "api", "Live SharePoint sites, lists, files, and reporting assets."],
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
  const chart = document.getElementById("scatterChart");
  if (!chart || !chart.offsetParent) return;
  const chartEmployees = filteredEmployees.filter((employee) => employee.active);
  const groupSource = chartEmployees.length ? chartEmployees : filteredEmployees;
  const groups = new Map();
  groupSource.forEach((employee) => {
    const department = mergedTeam(employee.team || "Unassigned");
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
    chart.innerHTML = '<div class="department-chart-empty">No department KPI available for employees with confidence 75% and above.</div>';
    departmentChartBars = [];
    return;
  }
  departmentChartBars = bars;
  const scored = bars.filter((bar) => bar.avgKpi !== null);
  const companyAverage = scored.length ? average(scored.map((bar) => bar.avgKpi)) : 0;
  const topScore = scored[0]?.avgKpi || 0;
  chart.innerHTML = `
    <div class="department-chart-summary">
      <div><span>Company average</span><strong>${number.format(companyAverage)}</strong></div>
      <div><span>Top department</span><strong>${escapeHtml(bars[0].department)}</strong></div>
      <div><span>Highest KPI</span><strong>${number.format(topScore)}</strong></div>
      <div><span>Departments</span><strong>${bars.length}</strong></div>
    </div>
    <div class="department-chart-scale">
      <span>Department ranking</span>
      <div><i>0</i><i>25</i><i>50</i><i>75</i><i>100</i></div>
    </div>
    <div class="department-ranking-list">
      ${bars.map((bar, index) => {
        const score = bar.avgKpi ?? 0;
        const tone = score >= 80 ? "excellent" : score >= 70 ? "strong" : score >= 55 ? "watch" : "risk";
        const difference = bar.avgKpi === null ? null : bar.avgKpi - companyAverage;
        return `
          <button class="department-rank-row tone-${tone}" data-department-index="${index}" type="button">
            <span class="department-rank-number">${index + 1}</span>
            <span class="department-rank-name">
              <strong>${escapeHtml(bar.department)}</strong>
              <small>${bar.employees.length} employees · ${bar.scoredEmployees.length} scored</small>
            </span>
            <span class="department-bullet-chart">
              <span class="department-benchmark" style="left:${companyAverage}%"></span>
              <span class="department-bullet-fill" style="width:${score}%"></span>
              <span class="department-score-marker" style="left:${score}%"></span>
            </span>
            <span class="department-score-block">
              <strong>${bar.avgKpi === null ? "—" : number.format(bar.avgKpi)}</strong>
              <small>${difference === null ? "No KPI" : `${difference >= 0 ? "+" : ""}${number.format(difference)} vs avg`}</small>
            </span>
            <span class="department-rank-arrow">›</span>
          </button>`;
      }).join("")}
    </div>
    <div class="department-chart-legend">
      <span><i class="excellent"></i>80+ Excellent</span>
      <span><i class="strong"></i>70–79 Strong</span>
      <span><i class="watch"></i>55–69 Watch</span>
      <span><i class="risk"></i>Below 55 Risk</span>
      <span class="benchmark-key"><i></i>Company average</span>
    </div>`;
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
  const att  = e.attendance  || {};
  const wl   = e.worklogix   || {};
  const tm   = e.teams       || {};
  const cal  = e.graphActivity?.calendar || {};
  const plan = e.graphActivity?.planner  || {};
  const gc   = e.github;

  const bandCls = e.band ? `band ${bandClass(e.band)}` : "band no-info";
  const bandLabel = e.band || "No Data";
  const initials = e.name.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();

  const sourceLabels = { worklogix: "Worklogix", greythr: "GreytHR", biometrics: "Biometrics", teams: "Teams", calendar: "Calendar", sharepoint: "SharePoint" };
  const sources = Object.entries(e.sources || {})
    .filter(([name]) => name in sourceLabels)
    .map(([name, ok]) => `<span class="source-chip ${ok ? "ok" : "missing"}">${ok ? "✓" : "✗"} ${sourceLabels[name]}</span>`)
    .join("");

  document.getElementById("employeeDetail").innerHTML = `
    <section class="detail">

      <!-- Header -->
      <div class="emp-detail-header">
        <div class="emp-detail-avatar">${initials}</div>
        <div class="emp-detail-identity">
          <h1>${e.name}</h1>
          <p>${e.designation || "Unassigned"} &middot; ${mergedTeam(e.team || "Unassigned")}${e.managerName ? ` &middot; Reports to <strong>${e.managerName}</strong>` : ""}</p>
          <div class="emp-detail-badges">
            <span class="${bandCls}">${bandLabel}</span>
            ${e.quadrant ? `<span class="quadrant-badge">${e.quadrant}</span>` : ""}
            <span class="conf-badge">${e.sourceConfidence}% confidence</span>
          </div>
        </div>
        <div class="emp-detail-kpi ${e.band ? bandClass(e.band) : "no-info"}">
          ${e.roleCategory === "executive"
            ? `<span class="emp-kpi-val">${e.scoreDrivers?.teamAvgKpi != null ? e.scoreDrivers.teamAvgKpi : "—"}</span>
               <span class="emp-kpi-lbl">Team KPI</span>`
            : e.band === "Insufficient Data"
            ? `<span class="emp-kpi-val" style="font-size:1.1rem">—</span>
               <span class="emp-kpi-lbl">No attendance data</span>`
            : `<span class="emp-kpi-val">${e.kpi != null ? e.kpi : "—"}</span>
               <span class="emp-kpi-lbl">KPI</span>`
          }
        </div>
      </div>

      <p class="detail-period">Period: <strong>${dataset.meta?.period || "May 2026"}</strong> &nbsp;·&nbsp; Teams status is live &nbsp;·&nbsp; Planner/Calendar as of Jun 24</p>
      <div class="source-chips">${sources}</div>

      <!-- Work Activity -->
      <h3 class="detail-section-title">Work Activity</h3>
      <div class="detail-grid4">
        <div class="dg-stat"><span class="dg-val">${wl.completed}/${wl.workItems}</span><span class="dg-lbl">Tasks Completed</span></div>
        <div class="dg-stat"><span class="dg-val">${wl.approved ?? "—"}</span><span class="dg-lbl">Approved</span></div>
        <div class="dg-stat ${wl.blocked ? "dg-warn" : ""}"><span class="dg-val">${wl.blocked ?? 0}</span><span class="dg-lbl">Blocked</span></div>
        <div class="dg-stat"><span class="dg-val">${wl.inProgress ?? 0}</span><span class="dg-lbl">In Progress</span></div>
      </div>

      <!-- Attendance & Biometrics -->
      <h3 class="detail-section-title">Attendance &amp; Biometrics</h3>
      ${(() => {
        // calendarDays from GreytHR is authoritative (session halves sum to calendar days).
        // att.present may be biometricDays (raw swipe count) — cap it at working days.
        const calendarDays = att.calendarDays || ((att.present ?? 0) + (att.absent ?? 0) + (att.off ?? 0) + (att.leave ?? 0) + (att.holidays ?? 0));
        const scheduledDays = Math.max(1, calendarDays - (att.off ?? 0) - (att.holidays ?? 0));
        const presentCapped  = Math.min(att.present ?? 0, scheduledDays);
        const attPct = Math.round(presentCapped / scheduledDays * 100);
        const absentWarn = (att.absent ?? 0) > 3 ? "dg-warn" : "";
        return `
        <div class="att-summary-row">
          <div class="att-summary-main">
            <span class="att-pct ${attPct >= 90 ? "att-pct--good" : attPct >= 70 ? "att-pct--warn" : "att-pct--bad"}">${attPct}%</span>
            <span class="att-pct-lbl">Attendance &nbsp;<small>${presentCapped} of ${scheduledDays} working days</small></span>
          </div>
          <div class="att-chips">
            <span class="att-chip att-chip--off">WO ${att.off ?? 0}d</span>
            <span class="att-chip att-chip--leave">Leave ${att.leave ?? 0}d</span>
            <span class="att-chip ${(att.absent ?? 0) > 0 ? "att-chip--absent" : "att-chip--off"}">Absent ${att.absent ?? 0}d</span>
            ${att.holidays ? `<span class="att-chip att-chip--off">Holiday ${att.holidays}d</span>` : ""}
          </div>
        </div>
        <div class="detail-grid4">
          <div class="dg-stat"><span class="dg-val">${formatCheckinHour(att.avgCheckinHour)}</span><span class="dg-lbl">Avg Check-in</span></div>
          <div class="dg-stat"><span class="dg-val">${formatCheckinHour(att.avgCheckoutHour)}</span><span class="dg-lbl">Avg Check-out</span></div>
          <div class="dg-stat"><span class="dg-val">${att.avgOfficeHours ?? "—"} hrs</span><span class="dg-lbl">Avg Daily Hours</span></div>
          <div class="dg-stat"><span class="dg-val">${att.officeHours ?? "—"} hrs</span><span class="dg-lbl">Total Office Hours</span></div>
          <div class="dg-stat ${att.punctualityScore < 50 ? "dg-warn" : att.punctualityScore >= 80 ? "dg-good" : ""}"><span class="dg-val">${att.punctualityScore != null ? att.punctualityScore + "%" : "—"}</span><span class="dg-lbl">Punctuality</span></div>
          <div class="dg-stat"><span class="dg-val">${att.officeLocation || "—"}</span><span class="dg-lbl">Office Location</span></div>
        </div>`;
      })()}

      <!-- Collaboration -->
      <h3 class="detail-section-title">Collaboration &amp; Meetings</h3>
      <div class="detail-grid4">
        <div class="dg-stat"><span class="dg-val">${cal.events ?? "—"}</span><span class="dg-lbl">Calendar Events</span></div>
        <div class="dg-stat"><span class="dg-val">${cal.meetingHours != null ? cal.meetingHours + " hrs" : "—"}</span><span class="dg-lbl">Meeting Hours</span></div>
        <div class="dg-stat"><span class="dg-val">${plan.assigned ?? "—"}</span><span class="dg-lbl">Planner Tasks</span></div>
        <div class="dg-stat"><span class="dg-val">${plan.completed ?? "—"}</span><span class="dg-lbl">Planner Done</span></div>
      </div>

      ${gc ? `
      <!-- GitHub -->
      <h3 class="detail-section-title">GitHub Contributions</h3>
      <div class="detail-grid4">
        <div class="dg-stat dg-good"><span class="dg-val">${gc.commits}</span><span class="dg-lbl">Commits</span></div>
        <div class="dg-stat dg-good"><span class="dg-val">${gc.prs}</span><span class="dg-lbl">Pull Requests</span></div>
        <div class="dg-stat"><span class="dg-val">${gc.done}</span><span class="dg-lbl">Issues Closed</span></div>
        <div class="dg-stat"><span class="dg-val">${gc.contributionScore}</span><span class="dg-lbl">Contribution Score</span></div>
      </div>` : ""}

      ${e.calendar ? `
      <!-- Calendar -->
      <h3 class="detail-section-title">Calendar Activity</h3>
      <div class="detail-grid4">
        <div class="dg-stat"><span class="dg-val">${e.calendar.invited}</span><span class="dg-lbl">Meetings Invited</span></div>
        <div class="dg-stat dg-good"><span class="dg-val">${e.calendar.attended}</span><span class="dg-lbl">Meetings Attended</span></div>
        <div class="dg-stat dg-good"><span class="dg-val">${e.calendar.attendanceRate}%</span><span class="dg-lbl">Attendance Rate</span></div>
        <div class="dg-stat"><span class="dg-val">${e.calendar.invited > 0 ? (e.calendar.invited - e.calendar.attended) : 0}</span><span class="dg-lbl">Missed</span></div>
      </div>` : ""}

      ${e.sharepoint ? `
      <!-- SharePoint -->
      <h3 class="detail-section-title">SharePoint Activity <small style="font-weight:400;color:var(--muted)">(last 30 days)</small></h3>
      <div class="detail-grid4">
        <div class="dg-stat"><span class="dg-val">${e.sharepoint.filesViewed}</span><span class="dg-lbl">Files Viewed/Edited</span></div>
        <div class="dg-stat"><span class="dg-val">${e.sharepoint.filesSynced}</span><span class="dg-lbl">Files Synced</span></div>
        <div class="dg-stat"><span class="dg-val">${e.sharepoint.filesShared}</span><span class="dg-lbl">Files Shared</span></div>
        <div class="dg-stat"><span class="dg-val">${e.sharepoint.pageVisits}</span><span class="dg-lbl">Page Visits</span></div>
      </div>` : ""}

      ${e.directReports?.length ? `
      <!-- Direct Reports -->
      <h3 class="detail-section-title">Direct Reports <span style="font-weight:400;color:var(--muted)">(${e.directReports.length})</span></h3>
      <div class="dr-table-wrap">
        <table class="dr-table">
          <thead><tr><th>Name</th><th>Role</th><th>KPI</th><th>Band</th></tr></thead>
          <tbody>
            ${e.directReports.map(r => {
              const bc = r.band ? `band ${bandClass(r.band)}` : "band no-info";
              return `<tr class="dr-row">
                <td class="dr-name">${r.name}</td>
                <td class="dr-role">${r.designation || "—"}</td>
                <td class="dr-kpi">${r.kpi != null ? r.kpi : "—"}</td>
                <td><span class="${bc}">${r.band || "No data"}</span></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>` : ""}

      ${e.roleCategory === "executive" ? (() => {
          const teamKpi = e.scoreDrivers?.teamAvgKpi;
          const count   = e.scoreDrivers?.reporteeCount ?? 0;
          if (teamKpi == null) return `
            <div class="exec-team-panel exec-team-no-data">
              <p>No reportee KPI data available yet. Ensure direct reports are active in the system.</p>
            </div>`;
          const tb = teamKpi >= 90 ? "Excellent" : teamKpi >= 80 ? "Good" : teamKpi >= 70 ? "Average" : teamKpi >= 60 ? "Needs Improvement" : "Critical";
          const tColor = teamKpi >= 80 ? "#22c55e" : teamKpi >= 60 ? "#f59e0b" : "#ef4444";
          return `
          <h3 class="detail-section-title">Team Performance</h3>
          <div class="exec-team-panel">
            <div class="exec-team-kpi-block" style="border-left:4px solid ${tColor}">
              <span class="exec-team-kpi-val" style="color:${tColor}">${teamKpi}</span>
              <span class="exec-team-kpi-lbl">Average team KPI across <strong>${count}</strong> direct report${count !== 1 ? "s" : ""}</span>
            </div>
            <div class="exec-team-band">
              <span class="band ${bandClass(tb)}">${tb}</span>
              <span style="font-size:0.8rem;color:var(--muted);margin-left:8px">team performance band</span>
            </div>
            <p class="exec-team-note">This executive's performance is measured by their team's average KPI. Personal attendance and collaboration are still tracked below.</p>
          </div>`;
        })() : ""}

      <!-- Score Drivers -->
      <h3 class="detail-section-title">Score Drivers</h3>
      <div class="radar-section">
        <canvas id="radarChart"></canvas>
        <div class="radar-legend">
          ${Object.entries(e.scoreDrivers)
            .filter(([key]) => key !== "reporteeCount")
            .map(([key, value]) => `
            <div class="radar-legend-row">
              <span class="radar-lbl">${title(key)}</span>
              <div class="radar-bar-wrap"><div class="radar-bar-fill" style="width:${Math.min(value,100)}%"></div></div>
              <span class="radar-val">${number.format(value)}</span>
            </div>
          `).join("")}
        </div>
      </div>

      ${e.gapReason ? `<p class="gap-reason-note">⚠ ${e.gapReason}</p>` : ""}

    </section>
  `;
  document.getElementById("employeeDialog").showModal();
  requestAnimationFrame(() => {
    const rc = document.getElementById("radarChart");
    if (rc) {
      const radarDrivers = Object.fromEntries(
        Object.entries(e.scoreDrivers).filter(([k]) => k !== "reporteeCount")
      );
      drawRadarChart(rc, radarDrivers);
    }
  });
}

function exportCsv() {
  const headers = ["id", "name", "team", "designation", "kpi", "band", "confidence", "work_items", "completed", "present", "leave", "absent", "teams_status"];
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
    e.attendance.leave ?? 0,
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

function exportExcel() {
  if (typeof XLSX === "undefined") {
    alert("Excel library not loaded. Please check your internet connection and reload the page.");
    return;
  }
  const period = dataset?.meta?.period || "export";
  const headers = ["ID", "Name", "Team", "Designation", "KPI Score", "Band", "Confidence", "Work Items", "Completed", "Present Days", "Leave Days", "Absent Days", "Teams Status"];
  const rows = filteredEmployees.map((e) => [
    e.id,
    e.name,
    e.team || "",
    e.designation || "",
    e.kpi != null ? e.kpi : "",
    e.band || "",
    e.sourceConfidence || "",
    e.worklogix.workItems,
    e.worklogix.completed,
    e.attendance.present,
    e.attendance.leave ?? 0,
    e.attendance.absent,
    e.teams.status || "",
  ]);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  // Bold header row
  const headerRange = XLSX.utils.decode_range(ws["!ref"]);
  for (let col = headerRange.s.c; col <= headerRange.e.c; col++) {
    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: col })];
    if (cell) cell.s = { font: { bold: true } };
  }
  // Column widths
  ws["!cols"] = [10, 22, 18, 22, 10, 12, 12, 12, 12, 13, 11, 13, 16].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "PeopleOPS KPI");
  XLSX.writeFile(wb, `peopleops-kpi-${period.replace(/\s+/g, "-").toLowerCase()}.xlsx`);
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

function missingSourceTags(e) {
  const s = e.sources || {};
  const tags = [];
  if (!s.worklogix) tags.push("No Worklogix");
  else if (!s.worklogixActivity) tags.push("No Tasks");
  if (!s.github) tags.push("No GitHub");
  if (!s.greythr && !s.biometrics) tags.push("No Attendance");
  if (!tags.length) return "";
  return `<div class="no-source-tags">${tags.map(t => `<span class="no-source-tag">${t}</span>`).join("")}</div>`;
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

// ======= MICROSOFT GRAPH =======

let graphData = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}


// ======= GITHUB PROJECTS =======

let githubData = null;

const STATUS_COLOR = {
  "done":        "#22c55e",
  "in progress": "#3b82f6",
  "todo":        "#f59e0b",
  "backlog":     "#94a3b8",
  "production":  "#8b5cf6",
};

function ghStatusColor(s) {
  return STATUS_COLOR[(s || "").toLowerCase()] || "#94a3b8";
}

function ghAvatarColor(login) {
  const colors = ["#3b82f6","#8b5cf6","#ec4899","#f59e0b","#10b981","#ef4444","#06b6d4","#f97316"];
  let h = 0;
  for (let i = 0; i < (login||"").length; i++) h = (h * 31 + login.charCodeAt(i)) & 0xffff;
  return colors[h % colors.length];
}

function fmtLoc(n) {
  if (!n) return "0";
  return n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
}

function showGhContributor(login) {
  const c = (githubData?.contributors || []).find(x => x.login === login);
  if (!c) return;
  const realName    = ghLoginToName(c.login);
  const displayName = realName || c.login;
  const color       = ghAvatarColor(c.login);
  const initials    = displayName.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const mergeRate   = c.prs > 0 ? Math.round((c.prsMerged || 0) / c.prs * 100) : null;
  const locTotal    = (c.additions || 0) + (c.deletions || 0);

  // Group tasks by project
  const byProject = {};
  for (const t of (c.tasks || [])) {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(t);
  }
  const taskSection = Object.entries(byProject).map(([proj, tasks]) => `
    <div class="ghcd-project-group">
      <div class="ghcd-project-name">${proj}</div>
      ${tasks.map(t => `
        <div class="ghcd-task-row">
          <span class="gh-task-dot" style="background:${ghStatusColor(t.status)}"></span>
          <span class="ghcd-task-title">${t.title}</span>
          <span class="ghcd-task-status" style="color:${ghStatusColor(t.status)}">${t.status}</span>
        </div>
      `).join("")}
    </div>
  `).join("");

  document.getElementById("ghContribDetail").innerHTML = `
    <div class="ghcd-wrap">
    <div class="ghcd-header">
      <div class="gh-contrib-avatar2 ghcd-avatar" style="background:${color}">${initials}</div>
      <div>
        <h2 class="ghcd-name">${displayName}</h2>
        ${realName ? `<p class="ghcd-login">${c.login}</p>` : ""}
        <p class="ghcd-projects">${(c.projects || []).join(" · ") || "—"}</p>
      </div>
    </div>

    <div class="ghcd-stats-row">
      ${c.commits > 0 ? `<div class="ghcd-stat"><span class="ghcd-stat-val">${c.commits}</span><span class="ghcd-stat-lbl">Code Saves</span></div>` : ""}
      ${c.prs > 0     ? `<div class="ghcd-stat"><span class="ghcd-stat-val">${c.prs}</span><span class="ghcd-stat-lbl">Code Reviews</span></div>` : ""}
      ${mergeRate !== null ? `<div class="ghcd-stat"><span class="ghcd-stat-val" style="color:#22c55e">${mergeRate}%</span><span class="ghcd-stat-lbl">Merge Rate</span></div>` : ""}
      ${c.total > 0   ? `<div class="ghcd-stat"><span class="ghcd-stat-val">${c.done}/${c.total}</span><span class="ghcd-stat-lbl">Tasks Done</span></div>` : ""}
      ${locTotal > 0  ? `<div class="ghcd-stat"><span class="ghcd-stat-val">${fmtLoc(locTotal)}</span><span class="ghcd-stat-lbl">Lines Changed</span></div>` : ""}
    </div>

    ${taskSection ? `
      <h3 class="ghcd-section-title">Tasks</h3>
      ${taskSection}
    ` : `<p style="color:var(--muted);margin-top:16px">No tasks assigned in this period.</p>`}
    </div>
  `;
  document.getElementById("ghContribDialog").showModal();
}

function switchGhTab(tab, btn) {
  document.querySelectorAll(".gh-tab").forEach(b => b.classList.remove("gh-tab--active"));
  document.querySelectorAll(".gh-tab-panel").forEach(p => p.hidden = true);
  btn.classList.add("gh-tab--active");
  document.getElementById(`gh-tab-${tab}`).hidden = false;
}

function ghLoginToName(login) {
  const employees = dataset?.employees;
  if (!login || !employees?.length) return null;
  // Strip numbers, split on hyphens/underscores, keep words ≥4 chars
  const parts = login.toLowerCase()
    .replace(/[0-9]/g, "")
    .split(/[-_]/)
    .map(p => p.trim())
    .filter(p => p.length >= 4);
  if (!parts.length) return null;
  for (const emp of employees) {
    const n = (emp.name || "").toLowerCase().replace(/[^a-z ]/g, "");
    if (parts.every(p => n.includes(p))) return emp.name;
  }
  // Single-word fallback: try if any part ≥5 chars matches start of any name word
  for (const emp of employees) {
    const nameWords = (emp.name || "").toLowerCase().replace(/[^a-z ]/g, "").split(" ");
    if (parts.some(p => p.length >= 5 && nameWords.some(w => w.startsWith(p) || p.startsWith(w)))) {
      return emp.name;
    }
  }
  return null;
}

function toggleGhProject(listId, header) {
  const list    = document.getElementById(listId);
  const chevron = header.querySelector(".gh-chevron");
  if (!list) return;
  const isOpen = list.style.display !== "none";
  list.style.display    = isOpen ? "none" : "";
  chevron?.classList.toggle("open", !isOpen);
}

function buildMonthOptions() {
  const sel = document.getElementById("ghMonthPicker");
  if (!sel || sel.options.length > 1) return;
  const now = new Date();
  for (let i = 0; i < 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const lbl = d.toLocaleString("default", { month: "long", year: "numeric" });
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = lbl;
    sel.appendChild(opt);
  }
}

async function refreshGitHub() {
  const label = document.getElementById("ghRefreshLabel");
  const month = (document.getElementById("ghMonthPicker")?.value) || "";
  label.textContent = "Refreshing…";
  try {
    const res = await apiFetch("/api/refresh-github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    });
    const json = await res.json();
    if (json.status === "refreshed") {
      githubData = json.github;
      renderGitHub(false);
      label.textContent = "Refreshed just now";
    } else {
      label.textContent = "Refresh failed";
    }
  } catch {
    label.textContent = "Refresh failed";
  }
}

async function renderGitHub(fetchFresh = true) {
  buildMonthOptions();
  if (fetchFresh) {
    try {
      const res = await apiFetch("/api/github-data");
      githubData = await res.json();
    } catch {
      document.getElementById("ghProjectsList").innerHTML =
        `<p style="color:var(--muted)">Could not load GitHub data. Click "Refresh now" to fetch.</p>`;
      return;
    }
  }

  const projects     = githubData.projects     || [];
  const contributors = githubData.contributors || [];
  const lastUpdated  = githubData.lastUpdated;
  const period       = githubData.period        || {};

  if (lastUpdated) {
    document.getElementById("ghRefreshLabel").textContent =
      "Last updated: " + new Date(lastUpdated).toLocaleString();
  }

  if (period.since && period.until) {
    const fmt = s => {
      const [y, m] = s.split("-");
      return new Date(y, m - 1, 1).toLocaleString("default", { month: "short", year: "numeric" });
    };
    const same = period.since.slice(0, 7) === period.until.slice(0, 7);
    document.getElementById("ghPeriodLabel").textContent =
      same ? `Period: ${fmt(period.since)}` : `Period: ${fmt(period.since)} – ${fmt(period.until)}`;
    const sel = document.getElementById("ghMonthPicker");
    if (sel && !sel.value) sel.value = period.since.slice(0, 7);
  }

  // ── Summary stat bar ───────────────────────────────────────────────────
  const totalTasks   = projects.reduce((s, p) => s + (p.stats?.total      || 0), 0);
  const doneTasks    = projects.reduce((s, p) => s + (p.stats?.done       || 0), 0);
  const inProg       = projects.reduce((s, p) => s + (p.stats?.inProgress || 0), 0);
  const inProd       = projects.reduce((s, p) => s + (p.stats?.production || 0), 0);
  const totalContrib = contributors.length;
  const totalCommits = contributors.reduce((s, c) => s + (c.commits || 0), 0);
  const totalLoc     = contributors.reduce((s, c) => s + (c.additions || 0) + (c.deletions || 0), 0);
  const donePct      = totalTasks > 0 ? Math.round(doneTasks / totalTasks * 100) : 0;

  document.getElementById("ghSummaryCards").innerHTML = `
    <div class="gh-stat-item gh-stat-item--accent">
      <span class="gh-stat-val">${projects.length}</span>
      <span class="gh-stat-lbl">Active Projects</span>
    </div>
    <div class="gh-stat-item">
      <span class="gh-stat-val">${doneTasks}<span class="gh-stat-sub"> / ${totalTasks}</span></span>
      <span class="gh-stat-lbl">Tasks Done &nbsp;<span style="color:#22c55e;font-weight:600">${donePct}%</span></span>
    </div>
    <div class="gh-stat-item">
      <span class="gh-stat-val" style="color:#3b82f6">${inProg}</span>
      <span class="gh-stat-lbl">In Progress</span>
    </div>
    <div class="gh-stat-item">
      <span class="gh-stat-val" style="color:#8b5cf6">${inProd}</span>
      <span class="gh-stat-lbl">In Production</span>
    </div>
    <div class="gh-stat-item">
      <span class="gh-stat-val">${totalContrib}</span>
      <span class="gh-stat-lbl">Contributors</span>
    </div>
    <div class="gh-stat-item">
      <span class="gh-stat-val">${totalCommits}</span>
      <span class="gh-stat-lbl">Total Code Saves</span>
    </div>
    ${totalLoc ? `
    <div class="gh-stat-item">
      <span class="gh-stat-val">${fmtLoc(totalLoc)}</span>
      <span class="gh-stat-lbl">Lines Changed</span>
    </div>` : ""}
  `;

  // ── Projects list ──────────────────────────────────────────────────────
  document.getElementById("ghProjectsList").innerHTML = projects.length
    ? projects.map(proj => {
        const s = proj.stats || {};
        const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
        const taskCount = (proj.items || []).length;
        const startOpen = taskCount <= 5;
        const listId = `gh-tasks-${proj.number}`;
        const items = (proj.items || []).map(item => `
          <div class="gh-task-row">
            <span class="gh-task-dot" style="background:${ghStatusColor(item.status)}"></span>
            <span class="gh-task-title">${item.title}</span>
            <span class="gh-task-badges">
              ${item.priority ? `<span class="gh-badge gh-badge--pri">${item.priority}</span>` : ""}
              ${item.size     ? `<span class="gh-badge">${item.size}</span>` : ""}
              ${(item.assignees || []).map(a => `<span class="gh-badge gh-badge--user">${a}</span>`).join("")}
            </span>
            <span class="gh-task-status" style="color:${ghStatusColor(item.status)}">${item.status}</span>
          </div>
        `).join("");

        return `
          <article class="panel gh-project-card">
            <div class="gh-project-head gh-project-toggle" onclick="toggleGhProject('${listId}', this)" style="cursor:pointer">
              <div>
                <h3 class="gh-project-name">${proj.title}</h3>
                <span class="gh-project-meta">${s.total} tasks · ${pct}% done</span>
              </div>
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                <div class="gh-status-pills">
                  ${s.done       ? `<span class="gh-pill" style="background:#dcfce7;color:#15803d">✓ ${s.done} Done</span>` : ""}
                  ${s.inProgress ? `<span class="gh-pill" style="background:#dbeafe;color:#1d4ed8">⟳ ${s.inProgress} In Progress</span>` : ""}
                  ${s.todo       ? `<span class="gh-pill" style="background:#fef9c3;color:#a16207">○ ${s.todo} Todo</span>` : ""}
                  ${s.backlog    ? `<span class="gh-pill" style="background:#f1f5f9;color:#475569">· ${s.backlog} Backlog</span>` : ""}
                  ${s.production ? `<span class="gh-pill" style="background:#ede9fe;color:#6d28d9">▲ ${s.production} Production</span>` : ""}
                </div>
                <span class="gh-chevron ${startOpen ? "open" : ""}">&#8964;</span>
              </div>
            </div>
            <div class="gh-progress-bar-wrap">
              <div class="gh-progress-bar" style="width:${pct}%"></div>
            </div>
            <div class="gh-task-list" id="${listId}" ${startOpen ? "" : 'style="display:none"'}>${items}</div>
          </article>
        `;
      }).join("")
    : `<p style="color:var(--muted)">No project data yet. Click "Refresh now".</p>`;

  // ── Contributors grid ──────────────────────────────────────────────────
  const maxCommits = Math.max(...contributors.map(c => c.commits || 0), 1);
  document.getElementById("ghContributors").innerHTML = contributors.length ? `
    <div class="gh-contrib-grid">
      ${contributors.map(c => {
        const realName  = ghLoginToName(c.login);
        const displayName = realName || c.login;
        const mergeRate = c.prs > 0 ? Math.round((c.prsMerged || 0) / c.prs * 100) : null;
        const initials  = displayName.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
        const color     = ghAvatarColor(c.login);
        const barPct    = Math.round((c.commits || 0) / maxCommits * 100);
        const locTotal  = (c.additions || 0) + (c.deletions || 0);
        return `
        <div class="gh-contrib-card" onclick="showGhContributor('${c.login}')" style="cursor:pointer">
          <div class="gh-contrib-card-header">
            <div class="gh-contrib-avatar2" style="background:${color}">${initials}</div>
            <div class="gh-contrib-card-identity">
              <div class="gh-contrib-card-name">${displayName}</div>
              ${realName ? `<div class="gh-contrib-card-login">${c.login}</div>` : ""}
            </div>
          </div>
          <div class="gh-contrib-card-projects">${(c.projects || []).join(", ") || "—"}</div>
          <div class="gh-commit-bar-wrap" title="${c.commits} code saves">
            <div class="gh-commit-bar-fill" style="width:${barPct}%;background:${color}"></div>
          </div>
          <div class="gh-contrib-card-stats">
            ${c.commits > 0 ? `<span class="gh-cs"><b>${c.commits}</b> code saves</span>` : ""}
            ${c.total  > 0 ? `<span class="gh-cs"><b>${c.done}/${c.total}</b> tasks</span>` : ""}
            ${c.prs    > 0 ? `<span class="gh-cs"><b>${c.prs}</b> review${c.prs!==1?"s":""}${mergeRate!==null?` <span class="gh-merged">${mergeRate}% merged</span>`:"" }</span>` : ""}
            ${locTotal > 0 ? `<span class="gh-cs"><b>${fmtLoc(locTotal)}</b> lines changed</span>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
  ` : `<p style="color:var(--muted);padding:24px">No contributors found for this period.</p>`;
}

// ======= TARA CHATBOT =======
let taraHistory = [];
let taraInitialized = false;
let taraLastQuestion = "";

const TARA_FOLLOWUPS = {
  performance: ["Who is in Low Performance band?", "Show their attendance", "Which team leads in KPI?"],
  attendance:  ["Who was absent most?", "Show their KPI score", "Which team attends best?"],
  availability:["Who is online right now?", "Show their task progress", "Who is away on Teams?"],
  task:        ["Who has pending tasks?", "Show their KPI score", "Who completed most tasks?"],
  efficiency:  ["Who has lowest efficiency?", "Show top performers", "Compare with attendance"],
  github:      ["Who has the most commits?", "Which project has the most pending tasks?", "Show all contributors"],
  planner:     ["Show overdue Planner tasks", "Which Planner plan has the most tasks?", "Show completed Planner tasks"],
  calendar:    ["Show today's meetings", "Which employee has the most calendar events?", "Show cancelled events"],
  sharepoint:  ["Show all SharePoint sites", "Which sites have document libraries?", "Show recently active sites"],
  employee360: ["Show their Planner tasks", "Show their calendar events", "Show their attendance"],
  general:     ["Show top 3 performers", "Who needs improvement?", "Who was absent this month?"],
};

function detectCategory(question) {
  const q = question.toLowerCase();
  if (/kpi|perform|score|band|top|bottom|rank|best|worst|rating/.test(q)) return "performance";
  if (/absent|attend|present|leave|holiday|late|half.?day|lop/.test(q))    return "attendance";
  if (/teams|online|offline|available|busy|away|status|active|presence/.test(q)) return "availability";
  if (/task|project|worklogix|complet|pending|block|deliver|deadline|progress|ticket/.test(q)) return "task";
  if (/efficien|hours|working.?hours|output|productiv|weighted|workload|volume/.test(q)) return "efficiency";
  return "general";
}

function toggleTara() {
  const panel = document.getElementById("taraPanel");
  if (panel.hidden) {
    panel.hidden = false;
    document.getElementById("taraInput").focus();
    if (!taraInitialized) {
      restoreTaraSession();
      taraInitialized = true;
    }
  } else {
    panel.hidden = true;
  }
}

function askTara(question) {
  document.getElementById("taraInput").value = question;
  sendTaraMessage();
}

function clearTara() {
  document.getElementById("taraMessages").innerHTML =
    `<div class="tara-msg tara-msg--bot">
       <p style="white-space:pre-wrap;margin:0">Hi! I'm Tara, your PeopleOps AI assistant. Ask me anything about your team's performance, attendance, or productivity.</p>
     </div>`;
  taraHistory = [];
  localStorage.removeItem("tara_history");
  document.getElementById("taraChips").hidden = false;
}

function saveTaraSession() {
  localStorage.setItem("tara_history", JSON.stringify(taraHistory));
}

function restoreTaraSession() {
  try {
    const saved = JSON.parse(localStorage.getItem("tara_history") || "[]");
    if (!saved.length) return;
    taraHistory = saved;
    saved.forEach(({ role, content }) => {
      appendTaraMessage(content, role === "assistant" ? "bot" : "user");
    });
    document.getElementById("taraChips").hidden = true;
  } catch {}
}

async function sendTaraMessage() {
  const input = document.getElementById("taraInput");
  const question = input.value.trim();
  if (!question) return;

  input.value = "";
  taraLastQuestion = question;

  // Hide chips after first message
  document.getElementById("taraChips").hidden = true;

  // Remove previous follow-ups so only the latest set shows
  document.querySelectorAll(".tara-followups").forEach(el => el.remove());

  appendTaraMessage(question, "user");
  const typing = appendTaraMessage("Tara is thinking...", "typing");

  try {
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: taraHistory }),
    });
    const data = await res.json();
    typing.remove();
    const reply = data.answer || "Sorry, I couldn't get a response.";
    appendTaraMessage(reply, "bot");
    taraHistory.push({ role: "user", content: question });
    taraHistory.push({ role: "assistant", content: reply });
    if (taraHistory.length > 20) taraHistory.splice(0, 2);
    showFollowUps(data.category || detectCategory(question));
    saveTaraSession();
  } catch {
    typing.remove();
    appendTaraMessage("Something went wrong. Please try again.", "bot");
  }
}

function showFollowUps(category) {
  const suggestions = TARA_FOLLOWUPS[category] || TARA_FOLLOWUPS.general;
  const div = document.createElement("div");
  div.className = "tara-followups";
  suggestions.slice(0, 2).forEach(q => {
    const btn = document.createElement("button");
    btn.className = "tara-followup-btn";
    btn.textContent = q;
    btn.onclick = () => askTara(q);
    div.appendChild(btn);
  });
  const msgs = document.getElementById("taraMessages");
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
}

function appendTaraMessage(text, type) {
  const messages = document.getElementById("taraMessages");

  if (type === "bot" || type === "typing") {
    const row = document.createElement("div");
    row.className = "tara-msg-row";

    const avatar = document.createElement("div");
    avatar.className = "tara-msg-row-avatar";
    avatar.textContent = "✦";

    const bubble = document.createElement("div");
    bubble.className = `tara-msg tara-msg--${type === "typing" ? "typing" : "bot"}`;

    if (type === "typing") {
      bubble.innerHTML = `<div class="tara-typing-dots"><span></span><span></span><span></span></div>`;
    } else {
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const withShowMore = escaped.replace(
        /\.\.\.and (\d+) more\./gi,
        (_, n) => {
          if (parseInt(n, 10) === 0) return "";
          const q = (taraLastQuestion || "").replace(/'/g, "\\'");
          return `<button class="tara-show-more-btn" onclick="askTara('show all ${q}')">▼ Show ${n} more</button>`;
        }
      );
      bubble.innerHTML = `<p style="white-space:pre-wrap;margin:0">${withShowMore}</p>
        <button class="tara-copy-btn" onclick="copyTaraMsg(this)">⎘ Copy</button>`;
    }

    row.appendChild(avatar);
    row.appendChild(bubble);
    messages.appendChild(row);
    messages.scrollTop = messages.scrollHeight;
    return row;
  }

  // user message
  const div = document.createElement("div");
  div.className = "tara-msg tara-msg--user";
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  div.innerHTML = `<p style="white-space:pre-wrap;margin:0">${escaped}</p>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function copyTaraMsg(btn) {
  const text = btn.previousElementSibling.innerText;
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✓ Copied";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}
