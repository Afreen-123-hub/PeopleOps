let dataset;
let filteredEmployees = [];
let loggedInUserName = "";
let loggedInUserEmail = "";
let departmentChartBars = [];
let teamsStatusFilter = "all";
let teamsSearchQuery = "";

const state = {
  search: "",
  band: "all",
  team: "all",
  confidence: 0,
  showInterns: true,
};

const DEMO_MODE = false;
const DEMO_REFRESH_MESSAGE = "Demo mode: backend refresh is disabled";

const BAND_COLORS = {
  "Excellent":         "#0f6b3a",
  "Good":              "#22a06b",
  "Average":           "#3b82f6",
  "Needs Improvement": "#e28a0d",
  "Critical":          "#d92d20",
  "Insufficient Data": "#94a3b8",
  "Executive":         "#444ce7",
};

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
  "Project Management Team": "Project Management",
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

  const segments = [
    { label: "Excellent",         color: "#0f6b3a", count: 0 },
    { label: "Good",              color: "#2fb36d", count: 0 },
    { label: "Average",           color: "#3b82f6", count: 0 },
    { label: "Needs Improvement", color: "#f3a229", count: 0 },
    { label: "Critical",          color: "#db4d5c", count: 0 },
  ];
  let insufficientCount = 0;
  filteredEmployees.forEach((e) => {
    if (!e.band || e.band === "Insufficient Data") { insufficientCount++; return; }
    const seg = segments.find((s) => s.label === e.band);
    if (seg) seg.count++;
  });
  const scoredTotal = segments.reduce((sum, s) => sum + s.count, 0) || 1;
  const total = scoredTotal;

  const note = document.getElementById("donutInsufficientNote");
  if (note) {
    const pct = filteredEmployees.length ? Math.round((insufficientCount / filteredEmployees.length) * 100) : 0;
    note.innerHTML = insufficientCount ? `<button type="button" class="donut-insufficient-note"><strong>${insufficientCount} employee${insufficientCount === 1 ? "" : "s"} (${pct}%)</strong> have insufficient data to assess and are excluded from the ring above so it reflects the real spread among the ${scoredTotal} employees who can be scored.</button>` : "";
    const noteBtn = note.querySelector(".donut-insufficient-note");
    if (noteBtn) {
      noteBtn.addEventListener("click", () => {
        const employees = filteredEmployees.filter((e) => !e.band || e.band === "Insufficient Data");
        openBandDrawer("Insufficient Data", employees);
      });
    }
  }

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
  ctx.fillText(scoredTotal, cx, cy - 8);
  ctx.font = "700 11px Segoe UI,sans-serif";
  ctx.fillStyle = "#627084";
  ctx.fillText("scored", cx, cy + 12);

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

function renderTeamHeatmap() {
  const container = document.getElementById("teamHeatmap");
  if (!container) return;
  const rows = getKpiRows();
  const drivers = [
    { key: "delivery",      label: "Delivery",       source: "Worklogix",          noData: "No tasks assigned in Worklogix" },
    { key: "attendance",    label: "Attendance",     source: "GreytHR / Biometrics", noData: "No attendance records found"   },
    { key: "collaboration", label: "Collaboration",  source: "Microsoft Teams",    noData: "Teams not connected"             },
    { key: "efficiency",    label: "Efficiency",     source: "GitHub",             noData: "No GitHub contributions"         },
  ];

  const teamMap = {};
  rows.forEach((e) => {
    const team = mergedTeam(e.team || "Unassigned");
    if (!teamMap[team]) teamMap[team] = [];
    teamMap[team].push(e);
  });
  const teams = Object.keys(teamMap).sort();

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;

  const companyAvg = {};
  drivers.forEach((d) => {
    const vals = rows.map((e) => e.scoreDrivers[d.key]).filter((v) => v != null);
    companyAvg[d.key] = vals.length ? avg(vals) : null;
  });
  const companyAvgKpi = rows.length ? avg(rows.map((e) => e.kpi)) : 0;

  const driverTone = (v) => v >= 70 ? "good" : v >= 40 ? "watch" : "risk";
  const healthClass = (kpi) => kpi >= 80 ? "good" : kpi >= 65 ? "watch" : "risk";
  const healthLabel = (kpi) => kpi >= 80 ? "Excellent" : kpi >= 65 ? "Watch" : "At Risk";

  const focusMessage = (driverScores, teamKpi) => {
    const available = driverScores.filter((d) => d.score !== null);
    const missing   = driverScores.filter((d) => d.score === null);
    if (!available.length) return { icon: "⚠", title: "No data", msg: "Connect data sources to unlock KPI drivers" };

    const weakest = [...available].sort((a, b) => a.score - b.score)[0];
    const diff = companyAvg[weakest.key] != null ? weakest.score - companyAvg[weakest.key] : null;

    const watchMsg = {
      delivery:      "Check pending Worklogix tasks and completion rate",
      attendance:    "Review scheduling and leave patterns",
      collaboration: diff !== null ? `${Math.abs(diff)} pts below avg — review Teams engagement` : "Low Teams activity",
      efficiency:    "Review GitHub contributions and PR activity",
    };

    // At risk: KPI is critically low
    if (teamKpi < 65) {
      const gap = companyAvgKpi ? Math.abs(Math.round(teamKpi - companyAvgKpi)) : "";
      return { icon: "🚨", title: "Action needed", msg: `KPI ${gap ? gap + " pts" : ""} below avg — review ${weakest.label.toLowerCase()} & workload` };
    }

    // Any driver is red (< 40) regardless of overall KPI
    if (weakest.score < 40) {
      return { icon: "⚠", title: `Watch: ${weakest.label}`, msg: watchMsg[weakest.key] || `Score: ${weakest.score}` };
    }

    // Good KPI but all available drivers are genuinely healthy (>= 70)
    if (teamKpi >= 80 && available.every((d) => d.score >= 70)) {
      if (missing.length) return { icon: "✦", title: "On track", msg: `Note: ${missing[0].noData} for this team` };
      return { icon: "✦", title: "All clear", msg: "All drivers healthy — no action needed" };
    }

    // Watch zone or good KPI with amber drivers — highlight weakest
    return { icon: "⚠", title: `Watch: ${weakest.label}`, msg: watchMsg[weakest.key] || `Score: ${weakest.score}` };
  };

  const cards = teams.map((team) => {
    const members = teamMap[team];
    const teamKpi = avg(members.map((e) => e.kpi).filter((v) => v != null));
    const hClass  = healthClass(teamKpi ?? 0);
    const hLabel  = healthLabel(teamKpi ?? 0);

    const driverScores = drivers.map((d) => {
      const vals = members.map((e) => e.scoreDrivers[d.key]).filter((v) => v != null);
      return { ...d, score: avg(vals) };
    });

    const focus = focusMessage(driverScores, teamKpi ?? 0);

    const driverRows = driverScores.map((d) => {
      if (d.score === null) {
        return `<div class="tpc-driver-row tpc-no-source">
          <span class="tpc-driver-name">${d.label}</span>
          <span class="tpc-no-source-text">${d.noData}</span>
        </div>`;
      }
      const tone = driverTone(d.score);
      return `<div class="tpc-driver-row" data-team="${encodeURIComponent(team)}" data-driver="${d.key}"
          role="button" tabindex="0" title="Click for ${d.label} breakdown">
          <span class="tpc-driver-name">${d.label}</span>
          <span class="tpc-bar-track"><span class="tpc-bar-fill tpc-${tone}" style="width:${d.score}%"></span></span>
          <span class="tpc-driver-val tpc-${tone}">${d.score}</span>
        </div>`;
    }).join("");

    return `<div class="tpc-card tpc-health-${hClass}" data-team="${encodeURIComponent(team)}" role="button" tabindex="0" title="Click to view team members">
      <div class="tpc-header">
        <div>
          <div class="tpc-team-name">${escapeHtml(team)}</div>
          <div class="tpc-headcount">${members.length} ${members.length === 1 ? "person" : "people"} · ${members.filter(e => e.kpi != null && e.band !== "Insufficient Data").length} scored</div>
        </div>
        <div class="tpc-kpi-badge">
          <span class="tpc-kpi-val">${teamKpi != null ? number.format(teamKpi) : "—"}</span>
          <span class="tpc-kpi-lbl">KPI</span>
          <span class="tpc-health-pill">${hLabel}</span>
        </div>
      </div>
      <div class="tpc-divider"></div>
      <div class="tpc-drivers">${driverRows}</div>
      <div class="tpc-footer">
        <span class="tpc-footer-icon">${focus.icon}</span>
        <span class="tpc-footer-text"><strong>${focus.title}</strong>${focus.msg}</span>
      </div>
    </div>`;
  }).join("");

  container.innerHTML = `<div class="tpc-grid">${cards}</div>`;

  container.querySelectorAll(".tpc-driver-row[data-team]").forEach((row) => {
    const open = (event) => {
      event?.stopPropagation();
      const team      = decodeURIComponent(row.dataset.team);
      const driverKey = row.dataset.driver;
      const driver    = drivers.find((d) => d.key === driverKey);
      showHeatmapDetail(team, driver, teamMap[team], companyAvg);
    };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(); });
  });

  container.querySelectorAll(".tpc-card[data-team]").forEach((card) => {
    const openMembers = () => {
      const team = decodeURIComponent(card.dataset.team);
      showTeamMembersModal(team, teamMap[team] || []);
    };
    card.addEventListener("click", (event) => {
      if (!event.target.closest(".tpc-driver-row")) openMembers();
    });
    card.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !event.target.closest(".tpc-driver-row")) {
        event.preventDefault();
        openMembers();
      }
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
  const periodEl = document.getElementById("heroPeriodLabel");
  if (!dataset?.meta?.period) return;
  const m = dataset.meta.period.match(/(\d{4}-\d{2})/);
  if (!m) return;
  const date = new Date(`${m[1]}-01T00:00:00`);
  const label = date.toLocaleDateString([], { month: "long", year: "numeric" });
  if (el) el.textContent = `Currently showing: ${label}`;
  if (periodEl) periodEl.textContent = date.toLocaleDateString([], { month: "short", year: "numeric" });

  const generatedEl = document.getElementById("heroGeneratedLabel");
  if (generatedEl && dataset.meta.generatedAt) {
    const generated = new Date(dataset.meta.generatedAt);
    generatedEl.textContent = generated.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
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
    if (!res.ok || payload.status === "failed" || payload.status === "busy") {
      const detail = payload.message || payload.error || "Failed to refresh";
      const diag = payload.stdout ? `\n\nDiagnostic: ${payload.stdout.split("\n").slice(-6).join(" | ")}` : "";
      throw new Error(detail + diag);
    }
    if (!payload.data || !payload.data.employees || payload.data.employees.length === 0) {
      throw new Error(`No employee data returned for ${label}. Try the current month instead.`);
    }

    // Preserve Teams live data (presence + activity) before replacing dataset.
    // Historical month loads only update KPI/attendance — Teams stays live.
    const teamsCache = new Map();
    (dataset?.employees || []).forEach(e => { if (e.id) teamsCache.set(e.id, e.teams); });

    dataset = payload.data;

    // Re-inject Teams live data so the leaderboard and presence stay current.
    dataset.employees.forEach(e => {
      const live = teamsCache.get(e.id);
      if (live) e.teams = { ...(e.teams || {}), ...live };
    });

    applyFilters(); // rebuilds filteredEmployees + calls renderAll() — updates every section
    updateGlobalMonthLabel();

    const actualPeriod = payload.period || label;
    status.className = "graph-attendance-status success";
    status.textContent = `✓ Showing ${actualPeriod} data (${payload.employees} employees) — Teams presence stays live`;
  } catch (err) {
    status.className = "graph-attendance-status error";
    status.textContent = `✗ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function updateAvailableMonthsBadge() {
  try {
    const res = await apiFetch("/api/available-months");
    if (!res) return;
    const { months } = await res.json();
    const el = document.getElementById("taraAvailableMonths");
    if (!el || !months || months.length === 0) return;
    const labels = months.map(m => {
      const d = new Date(`${m}-01T00:00:00`);
      return d.toLocaleDateString([], { month: "short", year: "numeric" });
    });
    el.textContent = `Tara has data for: ${labels.join(", ")}`;
    el.style.display = "inline";
  } catch (_) {}
}

async function boot() {
  if (!getToken()) {
    window.location.href = "login.html";
    return;
  }
  // Validate token with server — catches expired sessions before any data loads
  const ping = await apiFetch("/api/health");
  if (!ping) return; // apiFetch already cleared token and redirected to login.html
  document.body.style.visibility = "visible"; // auth confirmed — reveal the app
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
  filteredEmployees = dataset.employees.filter(e => state.showInterns || !isIntern(e)).sort((a, b) => {
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
  updateAvailableMonthsBadge();
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

const CLOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;flex-shrink:0;vertical-align:-2px;margin-right:5px"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`;

// Shows time-only when `ts` falls on today's date, otherwise "Mon D, h:mm AM/PM".
function formatRefreshTimestamp(ts, prefix) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const timeStr = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? `${prefix} ${timeStr}` : `${prefix} ${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${timeStr}`;
}

function updateTeamsRefreshLabel(ts) {
  const el = document.getElementById("teamsRefreshLabel");
  if (!el) return;
  if (DEMO_MODE) {
    el.textContent = DEMO_REFRESH_MESSAGE;
    return;
  }
  el.innerHTML = ts ? CLOCK_SVG + formatRefreshTimestamp(ts, "Status as of") : "";
}

async function loadDataset({ fresh = false } = {}) {
  const suffix = `?t=${Date.now()}`;
  const fileResponse = await apiFetch(`/api/data${suffix}`).catch(() => null);
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
  document.getElementById("kpiSearchInput")?.addEventListener("input", (event) => {
    state.search = event.target.value.toLowerCase();
    applyFilters();
  });
  document.getElementById("peopleSearchInput")?.addEventListener("input", (event) => {
    state.search = event.target.value.toLowerCase();
    applyFilters();
  });
  document.querySelectorAll(".band-select-trigger").forEach((trigger) => {
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const wrap = trigger.closest(".band-select-wrap");
      const panel = wrap.querySelector(".band-select-panel");
      const isOpen = !panel.hidden;
      document.querySelectorAll(".band-select-panel:not([hidden])").forEach((p) => {
        if (p !== panel) {
          p.hidden = true;
          p.closest(".band-select-wrap")?.querySelector(".band-select-trigger")?.setAttribute("aria-expanded", "false");
        }
      });
      panel.hidden = isOpen;
      trigger.setAttribute("aria-expanded", String(!isOpen));
    });
  });
  ["teamFilter", "kpiTeamFilter", "peopleTeamFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (event) => {
      state.team = event.target.value;
      applyFilters();
    });
  });
  ["confidenceFilter", "kpiConfidenceFilter", "peopleConfidenceFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", (event) => {
      state.confidence = Number(event.target.value);
      applyFilters();
    });
  });
  document.getElementById("internToggle").addEventListener("change", (event) => {
    state.showInterns = event.target.checked;
    applyFilters();
  });
  document.getElementById("exportBtn").addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("exportMenu").classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    document.getElementById("exportMenu").classList.remove("open");
    const um = document.getElementById("railUserMenu");
    if (um) um.classList.remove("open");
    const opt = e.target.closest(".band-select-opt");
    if (opt) {
      const wrap = opt.closest(".band-select-wrap");
      if (wrap) {
        state.band = opt.dataset.value;
        updateBandDropdowns(state.band);
        wrap.querySelector(".band-select-panel").hidden = true;
        wrap.querySelector(".band-select-trigger")?.setAttribute("aria-expanded", "false");
        applyFilters();
      }
      return;
    }
    if (!e.target.closest(".band-select-wrap")) {
      document.querySelectorAll(".band-select-panel:not([hidden])").forEach((p) => {
        p.hidden = true;
        p.closest(".band-select-wrap")?.querySelector(".band-select-trigger")?.setAttribute("aria-expanded", "false");
      });
    }
  });
  const dotsBtn = document.getElementById("railUserDotsBtn");
  if (dotsBtn) dotsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("railUserMenu").classList.toggle("open");
  });
  document.getElementById("exportCsv").addEventListener("click", () => { exportCsv(); document.getElementById("exportMenu").classList.remove("open"); });
  document.getElementById("exportXlsx").addEventListener("click", () => { exportExcel(); document.getElementById("exportMenu").classList.remove("open"); });
  document.getElementById("refreshKpi").addEventListener("click", refreshKpiPerformance);

  const teamsSearchInput = document.getElementById("teamsSearch");
  const teamsSearchRow = document.getElementById("teamsSearchRow");
  teamsSearchInput.addEventListener("input", () => {
    teamsSearchQuery = teamsSearchInput.value.trim().toLowerCase();
    teamsSearchRow.classList.toggle("has-value", !!teamsSearchQuery);
    renderTeamsTable();
  });
  document.getElementById("teamsSearchClear").addEventListener("click", () => {
    teamsSearchInput.value = "";
    teamsSearchQuery = "";
    teamsSearchRow.classList.remove("has-value");
    teamsSearchInput.focus();
    renderTeamsTable();
  });
  document.getElementById("clearKpiTeam").addEventListener("click", clearKpiTeamFilter);
  document.getElementById("awaitingDataToggle")?.addEventListener("click", () => {
    const body = document.getElementById("awaitingDataBody");
    const label = document.getElementById("awaitingDataToggleLabel");
    const isHidden = body.hidden;
    body.hidden = !isHidden;
    label.textContent = isHidden ? "Hide ▴" : "Show ▾";
  });
  document.getElementById("closeDialog").addEventListener("click", () => document.getElementById("employeeDialog").close());
  document.getElementById("employeeDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  document.getElementById("projDetailDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  document.getElementById("ghContribDialog").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  document.getElementById("closeGhContribDialog").addEventListener("click", () => document.getElementById("ghContribDialog").close());
  document.getElementById("graphRefreshButton")?.addEventListener("click", () => refreshGraph());
  populateAttendanceOptions();
  document.getElementById("attendanceEmployee").addEventListener("change", () => renderAttendanceDetail(document.getElementById("attendanceEmployee").value));
  document.getElementById("attendanceSearch").addEventListener("input", function () {
    const q = this.value.trim().toLowerCase();
    const sel = document.getElementById("attendanceEmployee");
    Array.from(sel.options).forEach(opt => {
      opt.hidden = q && !opt.text.toLowerCase().includes(q);
    });
    const firstVisible = Array.from(sel.options).find(o => !o.hidden);
    if (firstVisible && (q && !sel.options[sel.selectedIndex]?.text.toLowerCase().includes(q))) {
      sel.value = firstVisible.value;
      renderAttendanceDetail(sel.value);
    }
  });
  window.addEventListener("resize", () => { drawScatter(); drawDonutChart(); });
}

function updateBandTrigger(wrapOrId, value) {
  const wrap = typeof wrapOrId === "string" ? document.getElementById(wrapOrId) : wrapOrId;
  if (!wrap) return;
  const label = wrap.querySelector(".band-select-label");
  const dot   = wrap.querySelector(".band-trigger-dot");
  if (!value || value === "all") {
    if (label) label.textContent = "All performance bands";
    if (dot) { dot.style.background = "transparent"; dot.style.borderColor = "#94a3b8"; }
  } else {
    if (label) label.textContent = value;
    const color = BAND_COLORS[value] || "#94a3b8";
    if (dot) { dot.style.background = color; dot.style.borderColor = color; }
  }
  wrap.querySelectorAll(".band-select-opt").forEach((opt) => {
    const sel = opt.dataset.value === (value || "all");
    opt.setAttribute("aria-selected", String(sel));
    opt.classList.toggle("is-selected", sel);
  });
}

function updateBandDropdowns(value) {
  ["bandFilter", "kpiBandFilter", "peopleBandFilter"].forEach((id) => updateBandTrigger(id, value));
}

function populateFilterOptions() {
  const bandFilterIds = ["bandFilter", "kpiBandFilter", "peopleBandFilter"];
  const teamFilterIds = ["teamFilter", "kpiTeamFilter", "peopleTeamFilter"];
  const previousBand = state.band;
  const previousTeam = state.team;
  const bands = [...new Set(dataset.employees.map((e) => e.band).filter(Boolean))];
  const teams = [...new Set(dataset.employees.map((e) => mergedTeam(e.team || "Unassigned")))].sort();
  const teamOptionsHtml = `<option value="all">All teams</option>${teams.map((t) => `<option>${t}</option>`).join("")}`;
  state.band = bands.includes(previousBand) ? previousBand : "all";
  state.team = teams.includes(previousTeam) ? previousTeam : "all";
  bandFilterIds.forEach((id) => {
    const wrap = document.getElementById(id);
    if (!wrap) return;
    const panel = wrap.querySelector(".band-select-panel");
    if (!panel) return;
    const allItem = `<li class="band-select-opt${state.band === "all" ? " is-selected" : ""}" data-value="all" role="option" aria-selected="${state.band === "all"}">
      <span class="band-dot" style="background:transparent;border:1.5px solid #94a3b8"></span>
      All performance bands
    </li>`;
    const items = bands.map((b) => {
      const color = BAND_COLORS[b] || "#94a3b8";
      const sel = state.band === b;
      return `<li class="band-select-opt${sel ? " is-selected" : ""}" data-value="${b}" role="option" aria-selected="${sel}">
        <span class="band-dot" style="background:${color}"></span>
        ${b}
      </li>`;
    }).join("");
    panel.innerHTML = allItem + items;
    updateBandTrigger(wrap, state.band);
  });
  teamFilterIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = teamOptionsHtml;
    el.value = state.team;
  });
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
  ["searchInput", "kpiSearchInput", "peopleSearchInput"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.value !== state.search) el.value = state.search;
  });
  updateBandDropdowns(state.band);
  ["teamFilter", "kpiTeamFilter", "peopleTeamFilter"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.value !== state.team) el.value = state.team;
  });
  ["confidenceFilter", "kpiConfidenceFilter", "peopleConfidenceFilter"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && Number(el.value) !== state.confidence) el.value = String(state.confidence);
  });
  renderAll();
  // When a search is active on the overview, show matching employees in the drilldown panel
  // so the user gets visible feedback instead of only aggregate charts updating.
  const overviewActive = document.getElementById("overview")?.classList.contains("active-view");
  const panel = document.getElementById("bandEmployeesPanel");
  if (overviewActive && state.search) {
    renderOverviewMetricEmployees("people", `Search: "${state.search}" — ${filteredEmployees.length} match${filteredEmployees.length === 1 ? "" : "es"}`, { scroll: false });
  } else if (overviewActive && !state.search && panel && !panel.hidden) {
    // If search was cleared and panel was showing search results, close it
    panel.hidden = true;
  }
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
      <div class="alert-dot alert-dot-${level}"></div>
      <div class="alert-info">
        <span class="alert-name">${escapeHtml(e.name)}</span>
        <span class="alert-team">${escapeHtml(mergedTeam(e.team || "Unassigned"))}</span>
      </div>
      <span class="alert-reason">${reason}</span>
      <span class="alert-kpi-badge alert-kpi-${level}">${e.kpi != null ? number.format(e.kpi) : "—"}</span>
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
  renderAttendanceTeamRollup();
  renderAttendanceDetail(document.getElementById("attendanceEmployee").value || dataset.employees[0]?.id);
  renderProjects();
  renderAlerts();
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
    .filter(([, value]) => value != null && Number(value) < 60)
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
  const prodVals = rows.map((e) => e.scoreDrivers?.productivity).filter((v) => v != null);
  const avgProductivity = prodVals.length ? average(prodVals) : 0;
  const taskVals = rows.map((e) => e.scoreDrivers?.taskCompletion).filter((v) => v != null);
  const avgTaskCompletion = taskVals.length ? average(taskVals) : 0;
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
    .sort((a, b) => b.kpi - a.kpi || a.name.localeCompare(b.name))
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
  ["teamFilter", "kpiTeamFilter", "peopleTeamFilter"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = "all";
  });
  applyFilters();
}

async function refreshKpiPerformance() {
  const status = document.getElementById("kpiRefreshStatus");
  if (DEMO_MODE) {
    status.textContent = DEMO_REFRESH_MESSAGE;
    return;
  }
  const monthInput = document.getElementById("globalMonthInput");
  const month = monthInput?.value || new Date().toISOString().slice(0, 7);
  status.textContent = "Refreshing…";
  try {
    const res = await apiFetch("/api/refresh-month", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month }),
    });
    if (!res) return;
    const payload = await res.json().catch(() => ({}));
    if (res.ok && payload.data?.employees?.length) {
      dataset = payload.data;
      applyFilters();
      updateGlobalMonthLabel();
      status.textContent = `KPI data updated ✓ (${payload.period || month})`;
    } else {
      status.textContent = payload.message || "Refresh failed — try again";
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
  const existing = document.getElementById("kpiTeamMembersModal");
  if (existing) existing.remove();

  const sorted = [...employees].sort((a, b) => {
    if (a.kpi == null && b.kpi == null) return a.name.localeCompare(b.name);
    if (a.kpi == null) return 1;
    if (b.kpi == null) return -1;
    return b.kpi - a.kpi;
  });

  const modal = document.createElement("div");
  modal.id = "kpiTeamMembersModal";
  // This overlay is hidden by default in the stylesheet. Dynamic team modals
  // must start open, unlike the attendance modal that is opened separately.
  modal.className = "team-modal-overlay open";
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
  const coverageLabels = {
    worklogix: "Worklogix records", worklogixActivity: "Worklogix activity",
    teams: "Teams activity", greythr: "GreytHR muster", biometrics: "Biometric swipes", github: "GitHub",
  };
  const coverageEntries = Object.entries(dataset.overview?.sourceCoverage || {}).filter(([key]) => key in coverageLabels);
  const bottleneck = coverageEntries.length
    ? coverageEntries.reduce((min, entry) => (entry[1] < min[1] ? entry : min))
    : null;
  const bottleneckPct = bottleneck ? Math.round((bottleneck[1] / (dataset.overview.employees || 1)) * 100) : 0;
  const officeHoursAvg = rows.length ? officeHours / rows.length : 0;
  const metrics = [
    ["Employees", rows.length, "Filtered population", "people", "blue"],
    ["Active", rows.filter((e) => e.active).length, "Currently active", "pulse", "slate"],
    ["Inactive", rows.filter((e) => !e.active).length, "Inactive records", "pause", "slate"],
    ["Avg KPI", scoredRows.length ? number.format(avgKpi) : "—", "75%+ confidence", "trend", "teal"],
    workItems
      ? ["Completed", `${Math.round((completed / workItems) * 100)}%`, `${completed}/${workItems} work items`, "check", "amber"]
      : ["Completed", "No data", bottleneck ? `${coverageLabels[bottleneck[0]]} only ${bottleneckPct}% synced` : "No Worklogix activity synced", "check", "amber"],
    ["Office Hours", number.format(officeHours), `${number.format(officeHoursAvg)} avg per employee`, "clock", "slate"],
    ["Online Now", teamsActive, "Teams presence", "online", "teal"],
    fullConfidence
      ? ["Full Fusion", fullConfidence, "All sources matched", "fusion", "amber"]
      : ["Full Fusion", "Blocked", bottleneck ? `Held back by ${coverageLabels[bottleneck[0]]} (${bottleneckPct}%)` : "No sources fully matched", "fusion", "amber"],
  ];
  document.getElementById("metricGrid").innerHTML = metrics
    .map(([label, value, hint, icon, tone]) => `
      <button type="button" class="metric-card executive-metric tone-${tone}" data-overview-metric="${icon}">
        <div class="metric-card-top">
          <span class="metric-icon metric-icon-${icon}">${metricIcon(icon)}</span>
          <span class="metric-status-dot"></span>
        </div>
        <strong${typeof value === "string" && /[a-zA-Z]{3,}/.test(value) ? ' class="metric-value-text"' : ""}>${value}</strong>
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
          <span class="tl-name">${escapeHtml(e.name)}</span>
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
      <span class="ghost-name">${escapeHtml(e.name)}</span>
      <span class="ghost-meta">${e.worklogix?.workItems || 0} tasks in Worklogix · 0 Teams activity</span>
      <span class="ghost-badge">Ghost</span>
    </div>`).join("");

  document.getElementById("teamsInsightRow").innerHTML = `
    <div class="teams-insight-panel${ghosts.length ? "" : " teams-insight-single"}">
      <div class="ti-section">
        <p class="eyebrow">Teams Activity · Last 30 days</p>
        <h2 class="ti-title">Top 10 Most Active on Teams</h2>
        <div class="tl-list">${ranked.length ? leaderboardRows : '<p class="proj-empty">No Teams activity data yet.</p>'}</div>
      </div>
      ${ghosts.length ? `
      <div class="ti-section">
        <p class="eyebrow">Ghost Workers · Has Worklogix tasks, zero Teams activity</p>
        <h2 class="ti-title">${ghosts.length} Employee${ghosts.length === 1 ? "" : "s"} Off-Grid</h2>
        <div class="tl-list">${ghostRows}</div>
      </div>` : ""}
    </div>`;
}

function renderOverviewMetricEmployees(metric, label, { scroll = true } = {}) {
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
  if (scroll) panel.scrollIntoView({ behavior: "smooth", block: "center" });
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
    .map(([key, value]) => [key, value, Math.round((value / total) * 100)])
    .sort((a, b) => a[2] - b[2])
    .map(([key, value, pct]) => `<div class="coverage-item${pct < 10 ? " coverage-item--gap" : ""}">
        <strong>${labels[key]}${pct < 10 ? '<span class="coverage-gap-flag">Critical gap</span>' : ""}</strong>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <span class="subtle">${value} of ${total} employees matched (${pct}%)</span>
      </div>`)
    .join("");
}

function renderQuadrantSummary() {
  const container = document.getElementById("quadrantGrid");
  if (!container) return;
  const total = filteredEmployees.length || 1;
  const counts = { "High Performer": 0, "Ghost Worker": 0, "Present but Idle": 0, "Disengaged": 0 };
  const scored = filteredEmployees.filter((e) => e.quadrant);
  scored.forEach((e) => {
    if (counts[e.quadrant] !== undefined) counts[e.quadrant]++;
  });
  const banner = document.getElementById("quadrantAlertBanner");
  if (banner) {
    const idle = counts["Present but Idle"];
    const idlePct = scored.length ? Math.round((idle / scored.length) * 100) : 0;
    banner.innerHTML = idle && idlePct >= 50 ? `
      <button type="button" class="overview-alert-banner" id="quadrantAlertCta">
        <span class="overview-alert-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg></span>
        <span class="overview-alert-text">
          <strong>${idlePct}% of scored employees are "Present but Idle"</strong>
          <span>${idle} of ${scored.length} employees with enough tracked signal show high attendance but low work output — the dominant pattern in this view.</span>
        </span>
        <span class="overview-alert-cta">View ${idle} employees →</span>
      </button>` : "";
    const cta = document.getElementById("quadrantAlertCta");
    if (cta) cta.addEventListener("click", () => {
      const employees = filteredEmployees.filter((e) => e.quadrant === "Present but Idle").sort((a, b) => (b.kpi || 0) - (a.kpi || 0));
      openBandDrawer("Present but Idle", employees);
    });
  }
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
  const fw = dataset.meta.kpiFramework;
  const container = document.getElementById("weightBars");
  if (!fw || !container) return;

  const roles = Object.keys(fw).filter(k => k !== "note" && typeof fw[k] === "object");
  const ROLE_LABELS = { technical: "Technical", management: "Management", support: "Support", intern: "Intern", trainee: "Trainee" };
  const WEIGHT_LABELS = {
    productivity: "Productivity", codeContribution: "Code Contribution",
    attendance: "Attendance", punctuality: "Punctuality", collaboration: "Collaboration",
    taskCompletion: "Task Completion", managerRatings: "Manager Ratings",
    teamAverageKpi: "Team Avg KPI", projectDelivery: "Project Delivery",
    taskApprovalSpeed: "Approval Speed", plannerCompletion: "Planner Completion",
    mentorFeedback: "Mentor Feedback",
  };

  let activeRole = roles[0];

  function renderBars(role) {
    return Object.entries(fw[role])
      .sort((a, b) => b[1] - a[1])
      .map(([key, value]) => `<div class="weight-item">
        <strong>${WEIGHT_LABELS[key] || key} ${value}%</strong>
        <div class="bar"><span style="width:${Math.min(value * 2, 100)}%"></span></div>
      </div>`)
      .join("");
  }

  function render() {
    container.innerHTML = `
      <div class="weight-role-tabs">
        ${roles.map(r => `<button type="button" class="weight-role-tab${r === activeRole ? " active" : ""}" data-role="${r}">${ROLE_LABELS[r] || r}</button>`).join("")}
      </div>
      ${renderBars(activeRole)}`;
    container.querySelectorAll(".weight-role-tab").forEach(btn => {
      btn.addEventListener("click", () => { activeRole = btn.dataset.role; render(); });
    });
  }
  render();
}

function lowConfidenceWarning(e) {
  if (e.band === "Insufficient Data") return "";
  if ((e.band === "Critical" || e.band === "Needs Improvement") && (e.sourceConfidence || 0) < 75) {
    return `<span class="low-conf-warn" title="Score based on limited data (${e.sourceConfidence}% confidence) — may not reflect actual performance">⚠ Low data</span>`;
  }
  return "";
}

const LEADERSHIP_AVATAR_COLORS = ["#6366f1", "#0891b2", "#d97706", "#be185d", "#0d9488", "#7c3aed", "#2563eb"];

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
          const reports   = (e.directReports || []).length;
          const status    = e.teams?.presence || "";
          const statusCls = status === "Available" ? "avail" : status === "Away" ? "away" : "offline";
          const kpiBlock  = teamKpi != null
            ? `<div class="lc-kpi">${teamKpi}<span class="lc-kpi-label">Team Avg KPI</span></div>`
            : `<div class="lc-kpi lc-kpi-none">—<span class="lc-kpi-label">No team data yet</span></div>`;
          return `
          <div class="leadership-card" data-exec-index="${i}" style="cursor:pointer" title="Click for details">
            <div class="lc-top">
              <div class="lc-avatar" style="background:${LEADERSHIP_AVATAR_COLORS[i % LEADERSHIP_AVATAR_COLORS.length]}">${e.name.trim().split(" ").map(w => w[0]).slice(0,2).join("")}</div>
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

const BAND_AVATAR_COLORS = {
  "Excellent": "#0f6b3a",
  "Good": "#10b981",
  "Average": "#3b82f6",
  "Needs Improvement": "#f59e0b",
  "Critical": "#e11d48",
  "Executive": "#7c3aed",
};

function avatarInitials(name) {
  return (name || "").trim().split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
}

function avatarColor(e) {
  return BAND_AVATAR_COLORS[e.band] || "#94a3b8";
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
  const scored = sorted.filter((e) => e.kpi != null);
  const awaiting = sorted.filter((e) => e.kpi == null);

  const scoredBadge = document.getElementById("scoredCountBadge");
  if (scoredBadge) scoredBadge.textContent = scored.length;

  const indexMap = new Map(scored.map((e, i) => [e.id, i]));
  const makeEmpRow = (e) => {
    const index = indexMap.get(e.id);
    const kpiCls = e.kpi >= 85 ? "kpi-good" : e.kpi >= 70 ? "kpi-avg" : "kpi-low";
    const kpiBarColor = e.kpi >= 85 ? "#16a34a" : e.kpi >= 70 ? "#d97706" : "#dc2626";
    const bandDisplay = e.band === "Insufficient Data" ? "No Data" : e.band === "Needs Improvement" ? "Needs Improv." : (e.band || "");
    const avatarCls = e.isMtm ? "p-avatar p-avatar-indigo" : "p-avatar p-avatar-teal";
    const mtmBadge = e.isMtm ? '<span class="mtm-row-badge">MTM</span>' : '';
    const teamChipCls = e.isMtm ? "p-team-chip p-team-chip-indigo" : "p-team-chip";
    return `<tr data-index="${index}" class="${e.isMtm ? 'is-mtm-row' : ''}">
          <td><div class="person-row"><div class="${avatarCls}">${avatarInitials(e.name)}</div><div class="person"><strong>${e.name}</strong>${mtmBadge}<small>${e.designation || "Unassigned"}</small><span class="${teamChipCls}">${mergedTeam(e.team || "Unassigned")}</span></div></div></td>
          <td class="numeric-cell"><div class="pt-kpi-cell"><span class="score ${kpiCls}">${e.kpi}</span><span class="pt-kpi-bar"><span class="pt-kpi-fill" style="width:${Math.min(e.kpi, 100)}%;background:${kpiBarColor}"></span></span></div></td>
          <td>${e.band ? `<span class="band ${bandClass(e.band)}">${bandDisplay}</span>` : '<span class="band no-info">Pending Link</span>'} ${lowConfidenceWarning(e)}</td>
          <td class="numeric-cell">${e.worklogix.completed}/${e.worklogix.workItems}</td>
          <td class="numeric-cell">${e.attendance.present}</td>
          <td class="numeric-cell">${e.attendance.leave ?? 0}</td>
          <td class="numeric-cell">${e.attendance.absent}</td>
          <td>${teamsStatusBadge(e.teams)}</td>
        </tr>`;
  };
  const makeDivider = (label, count, cls) =>
    `<tr class="mtm-section-divider"><td colspan="8"><div class="mtm-divider-inner">
      <span class="mtm-divider-label ${cls}">${label}</span>
      <span class="mtm-divider-line"></span>
      <span class="mtm-divider-count">${count}</span>
    </div></td></tr>`;

  const officeScored = scored.filter(e => !e.isMtm);
  const mtmScored   = scored.filter(e =>  e.isMtm);
  const hasBothGroups = officeScored.length > 0 && mtmScored.length > 0;

  document.getElementById("peopleTable").innerHTML = scored.length
    ? [
        ...(hasBothGroups ? [makeDivider("Office", officeScored.length, "divider-office")] : []),
        ...officeScored.map(makeEmpRow),
        ...(mtmScored.length ? [makeDivider("MTM · External", mtmScored.length, "divider-mtm")] : []),
        ...mtmScored.map(makeEmpRow),
      ].join("")
    : `<tr><td colspan="8"><div class="table-empty-state">
        <div class="table-empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="#0F766E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg></div>
        <div class="table-empty-title">No employees found</div>
        <div class="table-empty-sub">Try adjusting your filters or search term</div>
      </div></td></tr>`;

  document.querySelectorAll("#peopleTable tr[data-index]").forEach((row) => {
    row.addEventListener("click", () => showEmployee(scored[Number(row.dataset.index)]));
  });

  renderAwaitingData(awaiting);
  renderPeopleStats();
}

function renderAwaitingData(list) {
  const section = document.getElementById("awaitingDataSection");
  if (!section) return;
  const badge = document.getElementById("awaitingDataBadge");
  const body = document.getElementById("awaitingDataBody");
  if (!list.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  badge.textContent = list.length;
  body.innerHTML = list
    .map((e, index) => `<div class="await-chip" data-await-index="${index}">
      <span class="ca">${avatarInitials(e.name)}</span>
      <span class="cn"><strong>${e.name}</strong><small>${e.designation || "Unassigned"}</small></span>
    </div>`)
    .join("");
  body.querySelectorAll(".await-chip").forEach((chip) => {
    chip.addEventListener("click", () => showEmployee(list[Number(chip.dataset.awaitIndex)]));
  });
}

function renderPeopleStats() {
  const el = document.getElementById("peopleStatStrip");
  if (!el || !dataset) return;
  const nonExec = filteredEmployees.filter((e) => e.band !== "Executive");
  const scoredCount = nonExec.filter((e) => e.kpi != null).length;
  const awaitingCount = nonExec.filter((e) => e.kpi == null).length;
  const execCount = filteredEmployees.filter((e) => e.band === "Executive").length;
  const total = filteredEmployees.length;
  el.innerHTML = `
    <div class="stat-tile is-active">
      <div class="stat-num c-blue">${scoredCount}</div>
      <div class="stat-lbl">Scored &amp; ranked</div>
      <div class="stat-sub">Shown below by default</div>
    </div>
    <div class="stat-tile">
      <div class="stat-num c-amber">${awaitingCount}</div>
      <div class="stat-lbl">Awaiting data</div>
      <div class="stat-sub">No Worklogix/attendance link yet</div>
    </div>
    <div class="stat-tile">
      <div class="stat-num c-violet">${execCount}</div>
      <div class="stat-lbl">Executives</div>
      <div class="stat-sub">Scored by team performance</div>
    </div>
    <div class="stat-tile">
      <div class="stat-num c-ink">${total}</div>
      <div class="stat-lbl">Total headcount</div>
      <div class="stat-sub">Matching current filters</div>
    </div>`;
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

// Backend sometimes stores checkout in 12-hr format (6.0 = 6 PM, not 6 AM)
// Safe to add 12 for any checkout < 12 since nobody leaves before noon
function formatCheckoutHour(h) {
  if (h == null) return "—";
  const adjusted = (h > 0 && h < 12) ? h + 12 : h;
  return formatCheckinHour(adjusted);
}

// Applies a 10-minute grace period to punctuality.
// Count Mon–Fri days from period start up to generatedAt date.
// Used as denominator for employees with no GreytHR calendarDays.
function countWorkingDaysElapsed(dataset) {
  const meta = dataset?.meta || {};
  const periodStr = meta.period || "";
  const generatedAt = meta.generatedAt || "";
  const startMatch = periodStr.match(/(\d{4}-\d{2}-\d{2})/);
  if (!startMatch || !generatedAt) return null;
  const start = new Date(startMatch[1] + "T00:00:00");
  const end = new Date(generatedAt);
  if (isNaN(start) || isNaN(end) || end < start) return null;
  let count = 0;
  const cur = new Date(start);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Backend uses strict 9:00 AM cutoff — arriving at 9:01 AM counts as late.
// We use avgCheckinHour to estimate how many "late" days were actually within grace.
function calcPunctuality(att) {
  const present = Math.max(1, att.present || 1);
  const checkin = att.avgCheckinHour;
  const score = att.punctualityScore;
  const GRACE_MINS = 10;

  if (score == null && checkin == null) return null;

  if (score != null && checkin != null) {
    const strictOnTime = Math.round(score * present / 100);
    const lateDays = present - strictOnTime;
    const avgLateMins = Math.max(0, (checkin - 9.0) * 60);
    // Fraction of late days likely within the grace window (linear 0→1 as avg late → 0 mins)
    const graceFraction = avgLateMins < GRACE_MINS ? (GRACE_MINS - avgLateMins) / GRACE_MINS : 0;
    const additionalOnTime = Math.round(lateDays * graceFraction);
    const graceOnTime = Math.min(present, strictOnTime + additionalOnTime);
    return Math.round((graceOnTime / present) * 100);
  }

  // No backend score — estimate directly from avgCheckinHour with grace applied
  if (checkin != null) {
    const lateMinutes = Math.max(0, (checkin - 9.0) * 60 - GRACE_MINS);
    return Math.max(0, Math.round(100 - lateMinutes));
  }

  return score;
}

function teamsStatusKey(teams) {
  if (!teams.status) return "nodata";
  if (teams.isActive) return "active";
  if (teams.isOutOfOffice) return "ooo";
  if (teams.isAway) return "away";
  return "offline";
}

// "Busy" is a display variant of the "active" bucket — someone in a Teams
// meeting is still online, just shown differently than plain "Available".
function teamsBadgeVariant(teams) {
  if (!teams.status) return "nodata";
  if (teams.status === "Busy") return "busy";
  if (teams.isActive) return "available";
  if (teams.isAway) return "away";
  if (teams.isOutOfOffice) return "ooo";
  return "offline";
}

const TEAMS_BADGE_META = {
  available: { label: "Available",     color: "#22a06b", live: true },
  busy:      { label: "Busy",          color: "#e11d48", live: true },
  away:      { label: "Away",          color: "#e28a0d", live: false },
  ooo:       { label: "Out of Office", color: "#7c3aed", live: false },
  offline:   { label: "Offline",       color: "#64748b", live: false },
  nodata:    { label: "No Data",       color: "#9aa5b1", live: false },
};

function renderTeamsTable() {
  const statusPriority = (e) =>
    e.teams.isActive ? 0 : e.teams.isOutOfOffice ? 1 : e.teams.isAway ? 2 : e.teams.isOffline ? 3 : 4;
  const rows = filteredEmployees
    .slice()
    .sort((a, b) => statusPriority(a) - statusPriority(b) || a.name.localeCompare(b.name));

  // Status summary
  const IN_CALL_STATUSES = new Set(["InACall", "InAConferenceCall", "InAMeeting", "Presenting"]);
  const isInCall = (tm) => IN_CALL_STATUSES.has(tm.status);
  const counts = { active: 0, away: 0, ooo: 0, offline: 0, nodata: 0, incall: 0 };
  rows.forEach(e => {
    counts[teamsStatusKey(e.teams)]++;
    if (isInCall(e.teams)) counts.incall++;
  });

  document.getElementById("presenceSummary").textContent =
    `${counts.active} of ${rows.length} online now`;

  // Proportional composition bar
  document.getElementById("compBar").innerHTML = [
    ["active", "#22a06b"], ["away", "#e28a0d"], ["ooo", "#7c3aed"], ["offline", "#64748b"], ["nodata", "#9aa5b1"],
  ]
    .filter(([key]) => counts[key] > 0)
    .map(([key, color]) => `<div class="seg" style="flex-grow:${counts[key]};background:${color}" title="${key}: ${counts[key]}"></div>`)
    .join("");

  // Legend chips (double as filters)
  const legendBtns = [
    { key: "all",     label: "All",           count: rows.length,    color: "var(--blue)" },
    { key: "active",  label: "Active",        count: counts.active,  color: "#22a06b" },
    { key: "incall",  label: "In Call",       count: counts.incall,  color: "#dc2626" },
    { key: "away",    label: "Away",          count: counts.away,    color: "#e28a0d" },
    { key: "ooo",     label: "Out of Office", count: counts.ooo,     color: "#7c3aed" },
    { key: "offline", label: "Offline",       count: counts.offline, color: "#64748b" },
    { key: "nodata",  label: "No Data",       count: counts.nodata,  color: "#9aa5b1" },
  ];
  document.getElementById("teamsStatusBar").innerHTML = legendBtns
    .map(b => `<button type="button" class="legend-chip${teamsStatusFilter === b.key ? " is-active" : ""}" data-status="${b.key}" style="--c:${b.color}">
      <span class="dot"></span>${b.label} <span class="count">${b.count}</span>
    </button>`)
    .join("");
  document.querySelectorAll("#teamsStatusBar .legend-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      teamsStatusFilter = btn.dataset.status;
      renderTeamsTable();
    });
  });

  const visibleRows = rows
    .filter(e => teamsStatusFilter === "all" || (teamsStatusFilter === "incall" ? isInCall(e.teams) : teamsStatusKey(e.teams) === teamsStatusFilter))
    .filter(e => {
      if (!teamsSearchQuery) return true;
      const haystack = `${e.name} ${e.id} ${mergedTeam(e.team || "")} ${e.designation || ""}`.toLowerCase();
      return haystack.includes(teamsSearchQuery);
    });

  document.getElementById("teamsTable").innerHTML = visibleRows.length
    ? visibleRows.map((e, i) => {
        const variant = teamsBadgeVariant(e.teams);
        const meta = TEAMS_BADGE_META[variant];
        const initials = avatarInitials(e.name);
        return `<tr style="--row-c:${meta.color}">
          <td>
            <div class="who">
              <div class="avatar-wrap">
                <div class="avatar">${initials}</div>
                <div class="presence-dot${meta.live ? " live" : ""}"></div>
              </div>
              <div class="who-text">
                <strong>${e.name}</strong>
                <small>${e.id} | ${mergedTeam(e.team || "Unassigned")}</small>
              </div>
            </div>
          </td>
          <td>${e.designation || "Unassigned"}</td>
          <td><span class="badge clickable-badge" data-emp-index="${i}" style="--c:${meta.color}" title="Click for details"><span class="dot"></span>${meta.label} ›</span></td>
        </tr>`;
      }).join("")
    : `<tr class="empty-row"><td colspan="3">${teamsSearchQuery ? `No employees match "${teamsSearchQuery}"${teamsStatusFilter !== "all" ? " in this status" : ""}.` : "No employees match this status right now."}</td></tr>`;

  document.querySelectorAll(".clickable-badge").forEach(badge => {
    badge.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const emp = visibleRows[Number(badge.dataset.empIndex)];
      if (emp) openTeamsPanel(emp);
    });
  });
}

function openTeamsPanel(e) {
  const att  = e.attendance || {};
  const tm   = e.teams || {};
  const isWFH = !att.officeLocation && !!tm.workLocation && tm.workLocation !== "office";
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
      ${isWFH ? (() => {
        const avgActive = att.avgOfficeHours ?? 0;
        const meetingHrsTotal = cal.meetingHours ?? tm.meetingHours ?? 0;
        const avgMeeting = att.present > 0 ? Math.round((meetingHrsTotal / att.present) * 10) / 10 : 0;
        const avgTotal = Math.round((avgActive + avgMeeting) * 10) / 10;
        return `
        <div class="tsd-wfh-banner">
          <span class="tsd-wfh-dot"></span>Work From Home
        </div>
        <p class="tsd-section-title">Work Presence <small style="opacity:.5">WFH · Teams data</small></p>
        <div class="tsd-grid">
          <div class="tsd-stat">
            <span class="tsd-val tsd-val-total">${avgTotal} hrs</span>
            <span class="tsd-lbl">Avg Hours / Day</span>
            <span class="tsd-lbl-sub">${avgActive} active · ${avgMeeting} in meetings</span>
          </div>
          <div class="tsd-stat"><span class="tsd-val">${att.present} / ${att.present + att.absent + att.leave}</span><span class="tsd-lbl">Present / Working Days</span></div>
        </div>`;
      })() : `
        <p class="tsd-section-title">Office Presence <small style="opacity:.5">${att.officeLocation || tm.workLocation}</small></p>
        <div class="tsd-grid">
          <div class="tsd-stat"><span class="tsd-val">${formatCheckinHour(att.avgCheckinHour)}</span><span class="tsd-lbl">Avg Check-in</span></div>
          <div class="tsd-stat"><span class="tsd-val">${formatCheckoutHour(att.avgCheckoutHour)}</span><span class="tsd-lbl">Avg Check-out</span></div>
          <div class="tsd-stat"><span class="tsd-val">${att.avgOfficeHours != null ? att.avgOfficeHours + " hrs" : "—"}</span><span class="tsd-lbl">Avg Daily Hours</span></div>
          <div class="tsd-stat"><span class="tsd-val">${calcPunctuality(att) != null ? calcPunctuality(att) + "%" : "—"}</span><span class="tsd-lbl">Punctuality</span></div>
          <div class="tsd-stat"><span class="tsd-val">${att.validOfficeDays != null ? att.validOfficeDays + " days" : "—"}</span><span class="tsd-lbl">Days Tracked</span></div>
          <div class="tsd-stat"><span class="tsd-val">${att.present} / ${att.present + att.absent + att.leave}</span><span class="tsd-lbl">Present / Working Days</span></div>
        </div>`}
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
        <div class="tsd-stat"><span class="tsd-val">${calNew.attended != null ? calNew.attended : "—"}</span><span class="tsd-lbl">Invites Accepted</span></div>
        <div class="tsd-stat"><span class="tsd-val">${calNew.attendanceRate != null ? calNew.attendanceRate + "%" : "—"}</span><span class="tsd-lbl">Response Rate</span></div>
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

function renderAttendanceTeamRollup() {
  const container = document.getElementById("attendanceTeamRollup");
  if (!container) return;

  const teamMap = {};
  filteredEmployees.forEach(e => {
    const team = mergedTeam(e.team || "Unassigned");
    if (!teamMap[team]) teamMap[team] = [];
    teamMap[team].push(e);
  });

  function empAttPct(e) {
    const att = e.attendance || {};
    const cal = att.calendarDays || ((att.present ?? 0) + (att.absent ?? 0) + (att.off ?? 0) + (att.leave ?? 0) + (att.holidays ?? 0));
    if (!cal) return null;
    const elapsedSum = (att.present ?? 0) + (att.absent ?? 0) + (att.leave ?? 0) + (att.off ?? 0) + (att.holidays ?? 0);
    const elapsed = att.calendarDays ? Math.min(cal, elapsedSum) : cal;
    const sched = Math.max(1, elapsed - (att.off ?? 0) - (att.holidays ?? 0));
    return Math.min(100, Math.round(((att.present ?? 0) / sched) * 100));
  }

  function avgOf(members, fn) {
    const vals = members.map(fn).filter(v => v != null && isFinite(v));
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }

  function tone(pct) {
    if (pct == null) return "muted";
    return pct >= 80 ? "good" : pct >= 60 ? "warn" : "bad";
  }

  const rows = Object.keys(teamMap).sort().map(team => {
    const members = teamMap[team];
    return {
      team,
      members,
      avgAtt: avgOf(members, empAttPct),
      avgPunct: avgOf(members, e => e.attendance?.punctualityScore),
      avgHrs: members.reduce((s, e) => s + (e.attendance?.officeHours ?? 0), 0) / members.length,
    };
  }).sort((a, b) => (b.avgAtt ?? -1) - (a.avgAtt ?? -1));

  const toneClass = t => t === "good" ? "good" : t === "warn" ? "warn" : t === "bad" ? "bad" : "muted";

  container.innerHTML = `
    <article class="panel" style="margin-bottom:16px;">
      <div class="panel-head">
        <div>
          <p class="eyebrow">Team overview</p>
          <h2>Team Attendance Summary</h2>
        </div>
      </div>
      <div class="att-rollup-wrap">
        <table class="att-rollup-table">
          <thead>
            <tr>
              <th>Team</th>
              <th class="att-num">Avg Attendance</th>
              <th class="att-num">Punctuality</th>
              <th class="att-num">Avg Office Hrs</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(({ team, members, avgAtt, avgPunct, avgHrs }) => {
              const tc = tone(avgAtt);
              return `
              <tr class="att-rollup-row" data-team="${escapeHtml(team)}" role="button" tabindex="0" title="Click to view members">
                <td>
                  <div class="att-rollup-team">${escapeHtml(team)}</div>
                  <div class="att-rollup-size">${members.length} member${members.length === 1 ? "" : "s"}</div>
                </td>
                <td class="att-num">
                  <div class="att-rollup-bar-cell">
                    ${avgAtt != null ? `<span class="att-rollup-pill att-rollup-${tc}">${avgAtt}%</span>` : `<span class="att-rollup-muted">—</span>`}
                    ${avgAtt != null ? `<div class="att-rollup-mini-bar"><div class="att-rollup-mini-fill ${tc === "good" ? "" : tc}" style="width:${avgAtt}%"></div></div>` : ""}
                  </div>
                </td>
                <td class="att-num att-rollup-pct-${tone(avgPunct)}">
                  ${avgPunct != null ? avgPunct + "%" : `<span class="att-rollup-muted">—</span>`}
                </td>
                <td class="att-num">${avgHrs > 0 ? avgHrs.toFixed(1) + " h" : `<span class="att-rollup-muted">—</span>`}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </article>`;

  // Wire up modal
  const overlay = document.getElementById("teamMembersModal");
  const closeBtn = document.getElementById("teamModalClose");

  function openTeamModal(teamName) {
    const members = filteredEmployees.filter(e => mergedTeam(e.team || "Unassigned") === teamName);
    if (!members.length) return;

    const attPcts = members.map(e => empAttPct(e)).filter(v => v != null);
    const punctVals = members.map(e => e.attendance?.punctualityScore).filter(v => v != null && isFinite(v));
    const teamAvgAtt = attPcts.length ? Math.round(attPcts.reduce((a,b)=>a+b,0)/attPcts.length) : null;
    const teamAvgPunct = punctVals.length ? Math.round(punctVals.reduce((a,b)=>a+b,0)/punctVals.length) : null;
    const teamAvgHrs = members.length ? (members.reduce((s,e)=>s+(e.attendance?.officeHours??0),0)/members.length) : 0;
    const atRisk = members.filter(e => { const p = empAttPct(e); return p != null && p < 60; }).length;

    document.getElementById("teamModalName").textContent = teamName;
    document.getElementById("teamModalMeta").textContent = `${members.length} member${members.length===1?"":"s"} · ${state.month || "Current period"}`;

    document.getElementById("teamModalStats").innerHTML = `
      <div class="team-modal-stat"><div class="team-modal-stat-val good">${teamAvgAtt != null ? teamAvgAtt+"%" : "—"}</div><div class="team-modal-stat-lbl">Avg Attendance</div></div>
      <div class="team-modal-stat"><div class="team-modal-stat-val ${teamAvgPunct != null && teamAvgPunct>=80?"good":teamAvgPunct!=null&&teamAvgPunct<60?"bad":""}">${teamAvgPunct != null ? teamAvgPunct+"%" : "—"}</div><div class="team-modal-stat-lbl">Punctuality</div></div>
      <div class="team-modal-stat"><div class="team-modal-stat-val">${teamAvgHrs > 0 ? teamAvgHrs.toFixed(1)+" h" : "—"}</div><div class="team-modal-stat-lbl">Avg Office Hrs</div></div>
      <div class="team-modal-stat"><div class="team-modal-stat-val ${atRisk>0?"bad":""}">${atRisk}</div><div class="team-modal-stat-lbl">At Risk</div></div>`;

    const sorted = [...members].sort((a,b)=>(empAttPct(b)??-1)-(empAttPct(a)??-1));
    document.getElementById("teamModalBody").innerHTML = sorted.map(e => {
      const initials = e.name.split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
      const att = empAttPct(e);
      const tc = tone(att);
      const punct = e.attendance?.punctualityScore;
      const pc = tone(punct);
      const hrs = e.attendance?.officeHours;
      return `
        <div class="team-modal-member">
          <div class="team-modal-member-info">
            <div class="team-modal-avatar">${initials}</div>
            <div>
              <div class="team-modal-member-name">${escapeHtml(e.name)}</div>
              <div class="team-modal-member-role">${escapeHtml(e.designation || e.id)}</div>
            </div>
          </div>
          <div class="team-modal-att">
            <span class="team-modal-pill ${att!=null?toneClass(tc):"muted"}">${att!=null?att+"%":"—"}</span>
            <div class="team-modal-mbar"><div class="team-modal-mbar-fill ${tc==="good"?"":tc}" style="width:${att??0}%"></div></div>
          </div>
          <div class="team-modal-punct ${punct!=null?toneClass(pc):"muted"}">${punct!=null?punct+"%":"—"}</div>
          <div class="team-modal-hrs">${hrs>0?hrs.toFixed(1)+" h":"—"}</div>
        </div>`;
    }).join("");

    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  function closeTeamModal() {
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  }

  closeBtn.onclick = closeTeamModal;
  overlay.addEventListener("click", e => { if (e.target === overlay) closeTeamModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && overlay.classList.contains("open")) closeTeamModal(); });

  container.querySelectorAll(".att-rollup-row").forEach(row => {
    const handler = () => openTeamModal(row.dataset.team);
    row.addEventListener("click", handler);
    row.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handler(); } });
  });
}

function renderAttendanceDetail(employeeId) {
  const employee = dataset.employees.find((item) => item.id === employeeId) || dataset.employees[0];
  if (!employee) return;
  const attendance = employee.attendance;
  const _elapsedSum = (attendance.present ?? 0) + (attendance.absent ?? 0) + (attendance.leave ?? 0) + (attendance.off ?? 0) + (attendance.holidays ?? 0);
  const _effectiveCal = attendance.calendarDays ? Math.min(attendance.calendarDays, _elapsedSum) : _elapsedSum;
  const workingDays = _effectiveCal
    ? _effectiveCal - (attendance.off ?? 0) - (attendance.holidays ?? 0)
    : (attendance.present ?? 0) + (attendance.absent ?? 0) + (attendance.leave ?? 0);
  const trackedDays = workingDays + attendance.off + attendance.holidays;
  const presentRate = workingDays ? Math.min(100, Math.round((attendance.present / workingDays) * 100)) : 0;
  const absentRate = workingDays ? Math.round((attendance.absent / workingDays) * 100) : 0;
  const biometricCoverage = attendance.present
    ? Math.min(100, Math.round((attendance.biometricDays / attendance.present) * 100))
    : 0;
  const avgOfficeHours = Number.isFinite(attendance.avgOfficeHours) ? attendance.avgOfficeHours : 0;
  const monthlyOfficeHours = Number.isFinite(attendance.officeHours) ? attendance.officeHours : 0;
  const health = presentRate >= 90 && absentRate <= 5
    ? { label: "Excellent", tone: "good", color: "#2fb36d", note: "Attendance is consistent for the selected period." }
    : presentRate >= 75
      ? { label: "Stable", tone: "watch", color: "#f3a229", note: "Attendance is acceptable, with a few days to review." }
      : { label: "Needs Review", tone: "risk", color: "#db4d5c", note: "Attendance requires manager attention for the selected period." };
  const biometricStatus = employee.sources.biometrics
    ? `${attendance.biometricDays} biometric days captured`
    : "No biometric match found";
  const initials = employee.name
    .split(" ")
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const hasData = trackedDays > 0;

  const detailEl = document.getElementById("attendanceDetail");

  if (!hasData) {
    detailEl.innerHTML = `
      <section class="attendance-hero attendance-hero-empty">
        <div class="attendance-person">
          <div class="attendance-avatar attendance-avatar-empty">${initials}</div>
          <div>
            <p class="eyebrow">${employee.id} | ${mergedTeam(employee.team || "Unassigned")}</p>
            <h1>${employee.name}</h1>
            <p class="subtle">${employee.designation || "Unassigned"} | No attendance data recorded this period</p>
          </div>
        </div>
        <span class="attendance-empty-tag">No data</span>
      </section>

      <section class="attendance-empty-panel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9.5 15 2 2 3-4"/></svg>
        <h3>No attendance data for ${employee.name} yet</h3>
        <p>Neither GreytHR nor biometric records exist for this employee this period — common for new joiners who haven't been linked yet. This isn't a 0% attendance score, it's an absence of tracking data.</p>
      </section>
    `;
    return;
  }

  const donutKnownSum = attendance.present + attendance.leave + attendance.off + attendance.absent + attendance.holidays;
  const donutCalendarTotal = attendance.calendarDays || donutKnownSum;
  const donutUnaccounted = Math.max(0, donutCalendarTotal - donutKnownSum);
  const donutSegments = [
    ["Present", attendance.present, "#2fb36d"],
    ["Leave/status", attendance.leave, "#f3a229"],
    ["Week off", attendance.off, "#627084"],
    ["Absent", attendance.absent, "#db4d5c"],
    ["Holidays", attendance.holidays, "#7b55d9"],
  ];
  if (donutUnaccounted > 0) donutSegments.push(["No data", donutUnaccounted, "#e2e8f0"]);
  const donutTotal = Math.max(donutCalendarTotal, donutKnownSum) || 1;
  let donutAcc = 0;
  const donutGradient = donutSegments
    .map(([, value, color]) => {
      const start = (donutAcc / donutTotal) * 100;
      donutAcc += value;
      const end = (donutAcc / donutTotal) * 100;
      return `${color} ${start}% ${end}%`;
    })
    .join(", ");

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

  detailEl.innerHTML = `
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
        <div class="emp-kpi-ring" style="--pct:${presentRate}; --c:${health.color}">
          <div class="emp-kpi-ring-inner">
            <div class="emp-kpi-val">${presentRate}%</div>
            <div class="emp-kpi-lbl">Present</div>
          </div>
        </div>
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
        <div class="attendance-donut-wrap">
          <div class="attendance-donut" style="background:conic-gradient(${donutGradient})">
            <div class="attendance-donut-center"><strong>${donutTotal}</strong><span>calendar days</span></div>
          </div>
          <div class="attendance-donut-legend">
            ${donutSegments.map(([label, value, color]) => `
              <div class="adl-row"><span class="adl-dot${label === "No data" ? " adl-dot-empty" : ""}" style="${label === "No data" ? "" : `background:${color}`}"></span>${label} <b>${value}</b></div>
            `).join("")}
          </div>
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

  const completionTierClass = overallPct >= 75 ? "proj-stat-item--good" : overallPct >= 40 ? "proj-stat-item--warn" : "proj-stat-item--bad";
  const statBar = `
    <div class="proj-stat-bar">
      <div class="proj-stat-item">
        <div class="proj-stat-icon" style="--icon-bg:#eff6ff;--icon-fg:#3b82f6"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 7v11a2 2 0 002 2h14a2 2 0 002-2V7M3 7l2-4h14l2 4"/></svg></div>
        <div><span class="proj-stat-val">${all.length}</span><span class="proj-stat-lbl">Projects</span></div>
      </div>
      <div class="proj-stat-item">
        <div class="proj-stat-icon" style="--icon-bg:#f0fdfa;--icon-fg:#00a99d"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4M2 12l3 3L15 5"/></svg></div>
        <div><span class="proj-stat-val">${totalTasks.toLocaleString()}</span><span class="proj-stat-lbl">Total Tasks</span></div>
      </div>
      <div class="proj-stat-item ${completionTierClass}">
        <div class="proj-stat-icon" style="--icon-bg:var(--tier-icon-bg);--icon-fg:var(--tier-icon-fg)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-4"/></svg></div>
        <div><span class="proj-stat-val">${overallPct}%</span><span class="proj-stat-lbl">Completion Rate</span></div>
      </div>
      <div class="proj-stat-item">
        <div class="proj-stat-icon" style="--icon-bg:#f5f3ff;--icon-fg:#7c3aed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg></div>
        <div><span class="proj-stat-val">${totalHours >= 1000 ? (totalHours/1000).toFixed(1)+"K" : Math.round(totalHours)}h</span><span class="proj-stat-lbl">Hours Logged</span></div>
      </div>
      ${atRiskCount ? `
      <div class="proj-stat-item proj-stat-item--risk">
        <div class="proj-stat-icon" style="--icon-bg:#fee2e2;--icon-fg:#dc2626"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg></div>
        <div><span class="proj-stat-val proj-stat-val--risk">${atRiskCount}</span><span class="proj-stat-lbl">At Risk</span></div>
      </div>` : ""}
    </div>`;

  const statusValues = [...new Set(all.map(p => p.status || ""))];
  const hasStatuses = statusValues.some(s => s.length > 0);
  const tabs = hasStatuses ? `
    <div class="proj-filter-tabs">
      ${["all", ...statusValues.filter(Boolean)].map(s =>
        `<button class="proj-filter-tab${_projStatus === s ? " proj-filter-tab--active" : ""}" onclick="_projStatus='${s}';renderProjects()">${s === "all" ? "All" : s}</button>`
      ).join("")}
    </div>` : "";

  const controlsRow = `
    <div class="proj-controls-row">
      <div class="proj-sort-group">
        <span class="proj-sort-label">Sort by</span>
        ${[["completion","Completion %"],["hours","Hours Logged"],["members","Members"],["name","Name"]].map(([val, lbl]) =>
          `<button class="proj-sort-btn${_projSort === val ? " proj-sort-btn--active" : ""}" onclick="_projSort='${val}';renderProjects()">${lbl}</button>`
        ).join("")}
      </div>
      <div class="proj-search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="projectSearch" type="search" placeholder="Search by project or manager..." value="${query}" oninput="renderProjects(this.value)">
      </div>
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
    const dormant = p.tasksTotal === 0;
    const completionColor = dormant ? "" : pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
    const atRisk = p.tasksTotal > 0 && pct < 40 && p.members >= 5;
    const stripeColor = atRisk ? "#e11d48" : dormant ? "#e2e8f0" : completionColor;

    const initialsOf = (n) => n.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
    const memberStats = p.memberStats || [];
    const avatarGradient = dormant ? "linear-gradient(135deg,#cbd5e1,#94a3b8)" : "linear-gradient(135deg,var(--blue),var(--teal))";
    const shown = memberStats.slice(0, 3);
    const overflowCount = p.members - shown.length;
    const avatars = shown.length ? `
      <div class="proj-avatars">
        ${shown.map(m => `<div class="proj-avatar" style="background:${avatarGradient}">${initialsOf(m.name)}</div>`).join("")}
        ${overflowCount > 0 ? `<div class="proj-avatar proj-avatar--more">+${overflowCount}</div>` : ""}
      </div>` : "";

    return `
      <article class="project-card proj-card-v2${atRisk ? " proj-card--risk" : ""}" onclick="showProjDetail('${p.id}')" style="cursor:pointer;--stripe:${stripeColor}">
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

        ${dormant ? `
        <div class="proj-dormant-line"><span class="proj-dormant-dot"></span>No tasks logged this period</div>
        ` : `
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
        </div>` : ""}`}

        <div class="proj-card-footer">
          ${avatars}
          <span class="proj-chip">${p.members} member${p.members !== 1 ? "s" : ""}</span>
          <span class="proj-chip proj-chip--link">View members &rsaquo;</span>
        </div>
      </article>`;
  }).join("");

  document.getElementById("projectGrid").innerHTML =
    statBar + tabs + controlsRow +
    (visible.length
      ? `<div class="project-grid">${cards}</div>`
      : `<p class="proj-empty">No projects match the current filter.</p>`);
}

function showProjDetail(projId) {
  const p = (dataset.projects || []).find(x => x.id === projId);
  if (!p) return;
  const pct = p.tasksTotal ? Math.round(p.tasksCompleted / p.tasksTotal * 100) : 0;
  const approvalPct = p.tasksTotal ? Math.round(p.tasksApproved / p.tasksTotal * 100) : 0;
  const completionColor = pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
  const atRisk = p.tasksTotal > 0 && pct < 40 && p.members >= 5;

  const allMembers = p.memberStats || [];
  const activeMembers = allMembers.filter(m => m.tasksTotal > 0);
  const idleMembers = allMembers.filter(m => m.tasksTotal === 0);
  const initialsOf = (n) => n.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();

  const activeRows = activeMembers.map(m => {
    const mpct = Math.round(m.tasksCompleted / m.tasksTotal * 100);
    const mColor = mpct >= 75 ? "#22c55e" : mpct >= 40 ? "#f59e0b" : "#ef4444";
    const mH = m.hoursWorked || 0;
    return `
      <tr class="projd-member-row">
        <td class="projd-member-name"><div class="projd-who"><div class="projd-avatar">${initialsOf(m.name)}</div>${m.name}</div></td>
        <td class="projd-member-tasks">${m.tasksTotal}</td>
        <td class="projd-member-comp">
          <div class="projd-comp-inner">
            <div class="projd-mini-bar-wrap">
              <div class="projd-mini-bar-fill" style="width:${mpct}%;background:${mColor}"></div>
            </div>
            <span style="color:${mColor};font-weight:600">${mpct}%</span>
          </div>
        </td>
        <td class="projd-member-hours">${(mH >= 1000 ? (mH/1000).toFixed(1)+"K" : mH)}h</td>
      </tr>`;
  }).join("");

  const idleRowsHtml = idleMembers.map(m =>
    `<div class="idle-row"><div class="projd-avatar">${initialsOf(m.name)}</div>${m.name}</div>`
  ).join("");

  document.getElementById("projd-title").textContent = p.name || p.id;
  document.getElementById("projd-meta").innerHTML = `
    ${p.manager ? `<span>PM: <strong>${p.manager}</strong></span>` : ""}
    <span>${p.members} member${p.members !== 1 ? "s" : ""}</span>
    <span style="color:${completionColor};font-weight:600">${pct}% complete</span>
    ${atRisk ? `<span class="proj-badge proj-badge--risk" style="font-size:0.72rem">At Risk</span>` : ""}
  `;

  const ring = document.getElementById("projd-ring");
  ring.style.setProperty("--pct", pct);
  ring.style.setProperty("--c", completionColor);
  document.getElementById("projd-ring-label").textContent = `${pct}%`;

  document.getElementById("projd-stats").innerHTML = `
    <div class="stat"><strong>${p.tasksCompleted} / ${p.tasksTotal}</strong><span>Tasks Done</span></div>
    <div class="stat"><strong>${approvalPct}%</strong><span>Approved</span></div>
    <div class="stat"><strong>${activeMembers.length} of ${allMembers.length || p.members}</strong><span>Active Contributors</span></div>
  `;

  document.getElementById("projd-body").innerHTML = allMembers.length ? `
    ${activeMembers.length ? `
      <p class="group-label">Contributing this period</p>
      <div class="projd-table-wrap">
        <table class="projd-table">
          <colgroup><col style="width:40%"><col style="width:15%"><col style="width:30%"><col style="width:15%"></colgroup>
          <thead><tr><th>Member</th><th>Tasks</th><th>Completion</th><th>Hours</th></tr></thead>
          <tbody>${activeRows}</tbody>
        </table>
      </div>` : ""}
    ${idleMembers.length ? `
      <button class="idle-toggle" id="projdIdleToggle" type="button">
        <span>${idleMembers.length} member${idleMembers.length !== 1 ? "s" : ""} with no tasks logged this period</span>
        <span class="chev">▾</span>
      </button>
      <div class="idle-list" id="projdIdleList">${idleRowsHtml}</div>` : ""}
  ` : `<p class="proj-empty">No individual task data available for this project.</p>`;

  const idleToggle = document.getElementById("projdIdleToggle");
  if (idleToggle) {
    idleToggle.addEventListener("click", () => {
      const open = document.getElementById("projdIdleList").classList.toggle("open");
      idleToggle.classList.toggle("open", open);
    });
  }

  document.querySelectorAll("dialog[open]").forEach(d => d.close());
  document.getElementById("projDetailDialog").showModal();
}

async function renderIntegrations() {
  const sourceFiles = dataset.meta.sourceFiles;
  const STALE_MS = 30 * 60 * 60 * 1000; // 30h grace window past the daily refresh

  let ghLastUpdated = githubData?.lastUpdated || null;
  if (!ghLastUpdated) {
    try {
      const res = await apiFetch("/api/github-data");
      const data = await res.json();
      ghLastUpdated = data?.lastUpdated || null;
    } catch { /* leave null — card shows "Not synced yet" */ }
  }

  const syncStatus = (ts) => {
    if (!ts) return { ok: false, label: "Not synced yet" };
    const age = Date.now() - new Date(ts).getTime();
    return { ok: age < STALE_MS, label: formatRefreshTimestamp(ts, "Synced") };
  };

  const wStatus  = syncStatus(dataset.meta.generatedAt);
  const tStatus  = syncStatus(dataset.meta.teamsRefreshedAt);
  const gStatus  = syncStatus(dataset.meta.graphRefreshedAt);
  const ghStatus = syncStatus(ghLastUpdated);

  const items = [
    ["Worklogix", sourceFiles.worklogix, "Live API data for users, projects, tasks, and work activity.", wStatus],
    ["GreytHR", sourceFiles.greythr, "Live attendance API — present, absent, leave, and week off records.", wStatus],
    ["Biometrics", sourceFiles.biometrics, "Live presence report API — office hours and biometric days per employee.", wStatus],
    ["Teams", sourceFiles.teams, "Live Microsoft Graph API presence data.", tStatus],
    ["GitHub", sourceFiles.github, "Repository contribution data — commits, pull requests, and closed issues per employee.", ghStatus],
    ["Microsoft Planner", "api", "Live Microsoft Graph plans, task assignments, progress, priorities, and due dates.", gStatus],
    ["Microsoft Calendar", "api", "Live employee calendar events and meeting-hour activity for the current month.", gStatus],
    ["Microsoft SharePoint", "api", "Live SharePoint sites, lists, files, and reporting assets.", gStatus],
  ];
  document.getElementById("integrationGrid").innerHTML = items.map(([name, files, detail, status]) => `
    <article class="integration-card">
      <div class="integration-card-top">
        <p class="eyebrow">${files === "api" ? "Live API" : "File Sync"}</p>
        <span class="integration-status${status.ok ? " integration-status--ok" : " integration-status--stale"}">
          <span class="integration-dot${status.ok ? " integration-dot--ok" : " integration-dot--stale"}"></span>${status.ok ? "Active" : "Needs Attention"}
        </span>
      </div>
      <h2>${name}</h2>
      <p class="subtle">${detail}</p>
      <div class="integration-synced">${CLOCK_SVG}${status.label}</div>
    </article>
  `).join("");

  const liveCount = items.filter(([, , , status]) => status.ok).length;
  const roadmapStats = document.getElementById("integrationRoadmapStats");
  if (roadmapStats) {
    roadmapStats.innerHTML = `
      <div class="rm-stat-row">
        <div class="rm-stat">
          <div class="rm-stat-icon rm-stat-icon--green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4M2 12l3 3L15 5"/></svg></div>
          <div><div class="rm-stat-val">${liveCount} / ${items.length}</div><div class="rm-stat-lbl">Connectors Live</div></div>
        </div>
        <div class="rm-stat">
          <div class="rm-stat-icon rm-stat-icon--blue"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.5 9a9 9 0 0114.85-3.36L23 10M1 14l4.65 4.36A9 9 0 0020.5 15"/></svg></div>
          <div><div class="rm-stat-val">Daily</div><div class="rm-stat-lbl">Auto-Refresh Schedule</div></div>
        </div>
        <div class="rm-stat">
          <div class="rm-stat-icon rm-stat-icon--violet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.5.4.8 1 .8 1.6v.7h6.4v-.7c0-.6.3-1.2.8-1.6A7 7 0 0012 2z"/></svg></div>
          <div><div class="rm-stat-val">1</div><div class="rm-stat-lbl">Under Consideration</div></div>
        </div>
      </div>
      <p class="rm-note">All connectors refresh automatically every day, in addition to the manual <b>Refresh now</b> button on each page. Under consideration: Slack integration for real-time presence.</p>
    `;
  }
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
  const isWFH = !att.officeLocation && !!tm.workLocation && tm.workLocation !== "office";
  const cal  = e.graphActivity?.calendar || {};
  const plan = e.graphActivity?.planner  || {};
  const gc   = e.github;

  const bandCls = e.band ? `band ${bandClass(e.band)}` : "band no-info";
  const bandLabel = e.band || "No Data";
  const initials = avatarInitials(e.name);

  const sourceLabels = { worklogix: "Worklogix", greythr: "GreytHR", biometrics: "Biometrics", teams: "Teams", calendar: "Calendar", sharepoint: "SharePoint" };
  const sources = Object.entries(e.sources || {})
    .filter(([name]) => name in sourceLabels)
    .map(([name, ok]) => `<span class="source-chip ${ok ? "ok" : "missing"}">${ok ? "✓" : "✗"} ${sourceLabels[name]}</span>`)
    .join("");

  const quadrantColor = QUADRANT_COLORS[e.quadrant] || "#627084";
  const confPct = e.sourceConfidence ?? 0;
  const confTone = confPct < 50 ? { bg: "#fee2e2", fg: "#991b1b" } : confPct < 75 ? { bg: "#fef3c7", fg: "#92400e" } : { bg: "#f1f5f9", fg: "#64748b" };
  const ringColor = QUADRANT_COLORS[e.band] || "#94a3b8";
  const ringPct = e.roleCategory === "executive" ? (e.scoreDrivers?.teamAvgKpi ?? 0) : (e.kpi ?? 0);

  // Attendance % — cap to elapsed days only (GreytHR returns full-month calendarDays even mid-month)
  const calendarDays = att.calendarDays || ((att.present ?? 0) + (att.absent ?? 0) + (att.off ?? 0) + (att.leave ?? 0) + (att.holidays ?? 0));
  const elapsedCalSum = (att.present ?? 0) + (att.absent ?? 0) + (att.leave ?? 0) + (att.off ?? 0) + (att.holidays ?? 0);
  const effectiveCalDays = att.calendarDays ? Math.min(calendarDays, elapsedCalSum) : calendarDays;
  const rawScheduled = Math.max(1, effectiveCalDays - (att.off ?? 0) - (att.holidays ?? 0));
  // Denominator = working days elapsed from period start to generatedAt, same for everyone.
  // GreytHR per-employee rawScheduled varies (lag, holidays) making the count inconsistent.
  // Use rawScheduled only when elapsed count can't be computed (e.g. missing meta).
  const expectedWD = countWorkingDaysElapsed(dataset);
  const scheduledDays = expectedWD || rawScheduled;
  const presentCapped = Math.min(att.present ?? 0, scheduledDays);
  const attPct = effectiveCalDays ? Math.round((presentCapped / scheduledDays) * 100) : null;

  const hasWorklogixActivity = e.sources?.worklogixActivity === true;

  // Team KPI / attendance comparison — same team, only shown when there's enough of a sample to be meaningful
  const employeeAttPct = (emp) => {
    const a = emp.attendance || {};
    const cd = a.calendarDays || ((a.present ?? 0) + (a.absent ?? 0) + (a.off ?? 0) + (a.leave ?? 0) + (a.holidays ?? 0));
    if (!cd) return null;
    const el = a.calendarDays ? Math.min(cd, (a.present ?? 0) + (a.absent ?? 0) + (a.leave ?? 0) + (a.off ?? 0) + (a.holidays ?? 0)) : cd;
    const sd = Math.max(1, el - (a.off ?? 0) - (a.holidays ?? 0));
    return Math.round((Math.min(a.present ?? 0, sd) / sd) * 100);
  };
  const teamMates = (dataset.employees || []).filter((m) => mergedTeam(m.team || "Unassigned") === mergedTeam(e.team || "Unassigned") && m.kpi != null);
  const teamAvgKpi = teamMates.length >= 2 ? average(teamMates.map((m) => m.kpi)) : null;
  const kpiDelta = teamAvgKpi != null && e.kpi != null ? Math.round((e.kpi - teamAvgKpi) * 10) / 10 : null;
  const teamAttValues = teamMates.map(employeeAttPct).filter((v) => v != null);
  const teamAvgAtt = teamAttValues.length >= 2 ? Math.round(average(teamAttValues)) : null;

  const insightSentence = (() => {
    if (!e.quadrant || e.band === "Insufficient Data") return "";
    const sd = e.scoreDrivers || {};
    const strengths = [];
    if (attPct != null && attPct >= 80) strengths.push(`${attPct}% attendance`);
    if (att.punctualityScore != null && att.punctualityScore >= 80) strengths.push(`${att.punctualityScore}% punctuality`);
    const weaknesses = [];
    if (!hasWorklogixActivity) weaknesses.push("no Worklogix task activity tracked");
    if (sd.collaboration != null && sd.collaboration < 40) weaknesses.push(`low collaboration (${number.format(sd.collaboration)})`);
    if (e.sources?.github === false) weaknesses.push("no GitHub activity");
    const strengthText = strengths.length ? strengths.join(" and ") : null;
    const weaknessText = weaknesses.length ? weaknesses.join(", ") : null;

    if (e.quadrant === "Present but Idle") {
      return strengthText && weaknessText
        ? `Solid ${strengthText} ${strengths.length > 1 ? "aren't" : "isn't"} matched by delivery — ${weaknessText}. That combination is why this profile is flagged "Present but Idle" rather than a stronger band.`
        : `Flagged "Present but Idle" — present and available, but delivery signals are weak this period.`;
    }
    if (e.quadrant === "Ghost Worker") {
      return `Flagged "Ghost Worker" — delivery signals look fine, but physical presence is low. Worth confirming this reflects genuine remote work rather than a tracking gap.`;
    }
    if (e.quadrant === "Disengaged") {
      return `Flagged "Disengaged"${weaknessText ? ` — ${weaknessText}` : ""}. Low signal across the board; this profile likely needs direct follow-up.`;
    }
    if (e.quadrant === "High Performer") {
      return `Flagged "High Performer"${strengthText ? ` — ${strengthText}, backed by consistent delivery` : ""}. One of the stronger profiles on the team this period.`;
    }
    return "";
  })();

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
            ${e.quadrant ? `<span class="quadrant-badge" style="background:color-mix(in srgb, ${quadrantColor} 16%, white);color:${quadrantColor};border-color:color-mix(in srgb, ${quadrantColor} 40%, white)">${e.quadrant}</span>` : ""}
            <span class="conf-badge" style="background:${confTone.bg};color:${confTone.fg}">${e.sourceConfidence}% confidence</span>
          </div>
        </div>
        ${e.band === "Insufficient Data"
          ? `<div class="emp-detail-kpi no-info"><span class="emp-kpi-val" style="font-size:1.1rem">—</span><span class="emp-kpi-lbl">No attendance data</span></div>`
          : `<div>
               <div class="emp-kpi-ring" style="--pct:${Math.min(100, Math.max(0, ringPct))};--c:${ringColor}">
                 <div class="emp-kpi-ring-inner">
                   <span class="emp-kpi-val">${e.roleCategory === "executive" ? (e.scoreDrivers?.teamAvgKpi ?? "—") : (e.kpi ?? "—")}</span>
                   <span class="emp-kpi-lbl">${e.roleCategory === "executive" ? "Team KPI" : "KPI"}</span>
                 </div>
               </div>
               ${kpiDelta != null ? `<div class="emp-kpi-vs ${kpiDelta < 0 ? "down" : kpiDelta > 0 ? "up" : ""}">${kpiDelta > 0 ? "+" : ""}${kpiDelta} vs team avg</div>` : ""}
             </div>`
        }
      </div>

      ${insightSentence ? `<div class="insight-banner">
        <span class="insight-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg></span>
        <div class="insight-text">${escapeHtml(insightSentence)}</div>
      </div>` : ""}

      <p class="detail-period">Period: <strong>${dataset.meta?.period || "—"}</strong> &nbsp;·&nbsp; Teams status is live &nbsp;·&nbsp; Generated: ${dataset.meta?.generatedAt ? new Date(dataset.meta.generatedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}</p>
      <div class="source-chips">${sources}</div>

      <!-- Work Activity -->
      <h3 class="detail-section-title">Work Activity</h3>
      ${hasWorklogixActivity ? `<div class="detail-grid4">
        <div class="dg-stat"><span class="dg-val">${wl.completed}/${wl.workItems}</span><span class="dg-lbl">Tasks Completed</span></div>
        <div class="dg-stat"><span class="dg-val">${wl.approved ?? "—"}</span><span class="dg-lbl">Approved</span></div>
        <div class="dg-stat ${wl.blocked ? "dg-warn" : ""}"><span class="dg-val">${wl.blocked ?? 0}</span><span class="dg-lbl">Blocked</span></div>
        <div class="dg-stat"><span class="dg-val">${wl.inProgress ?? 0}</span><span class="dg-lbl">In Progress</span></div>
      </div>` : `<div class="empty-note">No Worklogix task data synced for this employee this period</div>`}

      <!-- Attendance & Biometrics -->
      <h3 class="detail-section-title">Attendance &amp; Biometrics${teamAvgAtt != null ? `<span class="detail-section-context">Team avg: ${teamAvgAtt}%</span>` : ""}</h3>
      ${(() => {
        const absentWarn = (att.absent ?? 0) > 3 ? "dg-warn" : "";
        // Fall back to meeting hours when office hours are missing
        const _meetingTotal = cal.meetingHours ?? tm.meetingHours ?? 0;
        const _noBiometric = (att.biometricDays === 0) && (att.present > 0);
        const _noPresence = !att.officeHours && _meetingTotal > 0 && (isWFH || _noBiometric);
        const _displayAvgHrs = _noPresence
          ? Math.round((_meetingTotal / Math.max(1, att.present)) * 10) / 10
          : att.avgOfficeHours;
        const _displayTotalHrs = _noPresence ? _meetingTotal : att.officeHours;
        const _hoursLabel = _noPresence ? "Meeting Hrs / Day" : "Avg Daily Hours";
        const _totalLabel = _noPresence ? "Total Meeting Hrs" : "Total Hours";
        const _wfhNote = isWFH
          ? (_noPresence
              ? "Work From Home — Teams presence not captured. Hours shown are from meeting activity."
              : "Work From Home — biometric check-in/out not captured. Hours shown are from GreytHR attendance records.")
          : (_noPresence
              ? "Biometric data not captured for this employee. Hours shown are from meeting activity."
              : "");
        return `
        <div class="att-summary-row">
          <div class="att-summary-main">
            <span class="att-pct ${attPct == null ? "" : attPct >= 90 ? "att-pct--good" : attPct >= 70 ? "att-pct--warn" : "att-pct--bad"}">${attPct != null ? attPct + "%" : "—"}</span>
            <span class="att-pct-lbl">Attendance &nbsp;<small>${presentCapped} of ${scheduledDays} working days</small></span>
          </div>
          <div class="att-chips" id="att-chips-${e.id}">
            <button type="button" class="att-chip att-chip--off att-chip-btn" data-emp="${e.id}" data-bucket="OFF">WO ${att.off ?? 0}d</button>
            <button type="button" class="att-chip att-chip--leave att-chip-btn" data-emp="${e.id}" data-bucket="Leave">Leave ${att.leave ?? 0}d</button>
            <button type="button" class="att-chip ${(att.absent ?? 0) > 0 ? "att-chip--absent" : "att-chip--off"} att-chip-btn" data-emp="${e.id}" data-bucket="A">Absent ${att.absent ?? 0}d</button>
            ${att.holidays ? `<button type="button" class="att-chip att-chip--off att-chip-btn" data-emp="${e.id}" data-bucket="H">Holiday ${att.holidays}d</button>` : ""}
          </div>
          <div class="att-dates-popup" id="att-dates-${e.id}" hidden></div>
        </div>
        ${isWFH ? `<div class="dg-wfh-note">${_wfhNote}</div>` : ""}
        <div class="detail-grid4">
          <div class="dg-stat"><span class="dg-val ${isWFH ? "dg-na" : ""}">${!isWFH ? formatCheckinHour(att.avgCheckinHour) : "WFH"}</span><span class="dg-lbl">Avg Check-in</span></div>
          <div class="dg-stat"><span class="dg-val ${isWFH ? "dg-na" : ""}">${!isWFH ? formatCheckoutHour(att.avgCheckoutHour) : "WFH"}</span><span class="dg-lbl">Avg Check-out</span></div>
          <div class="dg-stat"><span class="dg-val">${_displayAvgHrs ?? "—"} hrs</span><span class="dg-lbl">${_hoursLabel}</span></div>
          <div class="dg-stat"><span class="dg-val">${_displayTotalHrs ?? "—"} hrs</span><span class="dg-lbl">${_totalLabel}</span></div>
          <div class="dg-stat ${!isWFH && calcPunctuality(att) < 50 ? "dg-warn" : !isWFH && calcPunctuality(att) >= 80 ? "dg-good" : ""}"><span class="dg-val ${isWFH ? "dg-na" : ""}">${!isWFH ? (calcPunctuality(att) != null ? calcPunctuality(att) + "%" : "—") : "WFH"}</span><span class="dg-lbl">Punctuality</span></div>
          <div class="dg-stat"><span class="dg-val">${att.officeLocation || (isWFH ? "Work From Home" : tm.workLocation)}</span><span class="dg-lbl">Work Location</span></div>
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
        <div class="dg-stat ${gc.commits > 0 ? "dg-good" : ""}"><span class="dg-val">${gc.commits}</span><span class="dg-lbl">Commits</span></div>
        <div class="dg-stat ${gc.prs > 0 ? "dg-good" : ""}"><span class="dg-val">${gc.prs}</span><span class="dg-lbl">Pull Requests</span></div>
        <div class="dg-stat"><span class="dg-val">${gc.done}</span><span class="dg-lbl">Issues Closed</span></div>
        <div class="dg-stat"><span class="dg-val">${gc.contributionScore}</span><span class="dg-lbl">Contribution Score</span></div>
      </div>` : ""}

      ${e.calendar ? (() => {
        const rate = e.calendar.attendanceRate ?? 0;
        const notAccepted = e.calendar.invited > 0 ? (e.calendar.invited - e.calendar.attended) : 0;
        return `
      <!-- Calendar -->
      <h3 class="detail-section-title">Calendar Activity <small style="font-weight:400;font-size:0.75rem;color:var(--muted)">(invite responses, not physical attendance)</small></h3>
      <div class="detail-grid4">
        <div class="dg-stat"><span class="dg-val">${e.calendar.invited}</span><span class="dg-lbl">Meetings Invited</span></div>
        <div class="dg-stat"><span class="dg-val">${e.calendar.attended}</span><span class="dg-lbl">Invites Accepted</span></div>
        <div class="dg-stat"><span class="dg-val">${rate}%</span><span class="dg-lbl">Response Rate</span></div>
        <div class="dg-stat"><span class="dg-val">${notAccepted}</span><span class="dg-lbl">Not Responded</span></div>
      </div>`;
      })() : ""}

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
              const drBandLabel = !r.band || r.band === "Insufficient Data" ? "No Data" : r.band === "Needs Improvement" ? "Needs Improv." : r.band;
              return `<tr class="dr-row">
                <td class="dr-name">${r.name}</td>
                <td class="dr-role">${r.designation || "—"}</td>
                <td class="dr-kpi">${r.kpi != null ? r.kpi : "—"}</td>
                <td><span class="${bc}">${drBandLabel}</span></td>
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
      ${(() => {
        const roleDrivers = {
          technical: ["productivity","delivery","efficiency","attendance","taskCompletion","punctuality","collaboration","codeContribution","github"],
          management: ["projectDelivery","attendance","collaboration","taskApprovalSpeed","taskReviewEffectiveness","teamAvgKpi","plannerCompletion"],
          executive:  ["teamAvgKpi","attendance","collaboration","pmProjectScore"],
          support:    ["attendance","punctuality","collaboration","taskCompletion","managerRatings"],
          intern:     ["attendance","punctuality","collaboration","mentorFeedback","taskCompletion"],
          trainee:    ["taskCompletion","attendance","punctuality","collaboration","mentorFeedback"],
        };
        const allowed = roleDrivers[e.roleCategory] || roleDrivers.technical;
        const drivers = allowed.filter(k => e.scoreDrivers[k] != null).map(k => [title(k), e.scoreDrivers[k]]);
        if (!drivers.length) return `<div class="empty-note">No score-driver data available for this employee.</div>`;
        const tierColor = (v) => v < 20 ? "#dc2626" : v < 60 ? "#d97706" : "#16a34a";
        return `
        <div class="driver-bar-chart">
          <div class="driver-bar-chart-grid"><span>100</span><span>75</span><span>50</span><span>25</span><span>0</span></div>
          <div class="driver-bar-cols">
            ${drivers.map(([label, value]) => `
              <div class="driver-bar-col">
                <span class="driver-bar-value" style="color:${tierColor(value)}">${number.format(value)}</span>
                <div class="driver-bar-track"><div class="driver-bar-fill" style="height:${Math.max(2, Math.min(value, 100))}%;background:${tierColor(value)}"></div></div>
                <span class="driver-bar-label">${label}</span>
              </div>`).join("")}
          </div>
        </div>
        <div class="bar-chart-legend">
          <span><i style="background:#dc2626"></i>Weak (&lt;20)</span>
          <span><i style="background:#d97706"></i>Low (20&ndash;59)</span>
          <span><i style="background:#16a34a"></i>Strong (60+)</span>
        </div>`;
      })()}

      ${(() => {
        if (!e.gapReason) return "";
        const cleaned = e.gapReason.replace(/worklogixActivity/gi, "Worklogix activity").replace(/\bgithub\b/gi, "GitHub");
        const [headline, ...rest] = cleaned.split(";").map(s => s.trim());
        const detail = rest.join("; ");
        return `<div class="gap-reason-note">
          <span class="gap-reason-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg></span>
          <div class="gap-reason-text">
            <strong>${escapeHtml(headline)}</strong>
            ${detail ? `<span>${escapeHtml(detail)}</span>` : ""}
          </div>
        </div>`;
      })()}

    </section>
  `;
  document.querySelectorAll("dialog[open]").forEach(d => d.close());
  document.getElementById("employeeDialog").showModal();

  // Attendance chip buttons → show dates for that status
  document.querySelectorAll(".att-chip-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const empId  = btn.dataset.emp;
      const bucket = btn.dataset.bucket;
      const popup  = document.getElementById(`att-dates-${empId}`);
      if (!popup) return;
      if (!popup.hidden && popup.dataset.activeBucket === bucket) {
        popup.hidden = true;
        return;
      }
      const emp = dataset.employees.find(x => x.id === empId);
      const days = emp?.attendanceDays || {};
      const bucketLabel = { A: "Absent", Leave: "Leave", OFF: "Week Off", H: "Holiday" };
      const matched = Object.entries(days)
        .filter(([, b]) => b === bucket)
        .map(([d]) => d)
        .sort();
      popup.dataset.activeBucket = bucket;
      popup.hidden = false;
      if (!matched.length) {
        popup.innerHTML = `<span class="att-dates-empty">No specific dates recorded for ${bucketLabel[bucket] || bucket}.</span>`;
        return;
      }
      popup.innerHTML = `
        <span class="att-dates-label">${bucketLabel[bucket] || bucket} dates</span>
        <div class="att-dates-list">
          ${matched.map(d => {
            const dt = new Date(d + "T00:00:00");
            const fmt = dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", weekday: "short" });
            return `<span class="att-date-pill">${fmt}</span>`;
          }).join("")}
        </div>`;
    });
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
  link.download = `peopleops-kpi-${dataset.meta?.period?.replace(/\s/g, "-") || "export"}.csv`;
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
let _ghSort = "attention";
let _ghContribSort = "attention";

const STATUS_COLOR = {
  "done":            "#22c55e",
  "completed":       "#22c55e",
  "completed in qa": "#22c55e",
  "in progress":     "#3b82f6",
  "dev":             "#3b82f6",
  "qa":              "#3b82f6",
  "review in qa":    "#3b82f6",
  "todo":            "#f59e0b",
  "backlog":         "#94a3b8",
  "production":      "#dc2626",
};

function ghStatusColor(s) {
  return STATUS_COLOR[(s || "").toLowerCase()] || "#94a3b8";
}

const GH_STATUS_DISPLAY = {
  "dev": "In Development",
  "qa": "In QA",
  "review in qa": "In QA Review",
  "todo": "To Do",
};

function ghDisplayStatus(s) {
  return GH_STATUS_DISPLAY[(s || "").toLowerCase()] || s;
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

const GH_DONE_STATUSES = new Set(["done", "completed", "completed in qa"]);

function showGhContributor(login) {
  const c = (githubData?.contributors || []).find(x => x.login === login);
  if (!c) return;
  const realName    = ghLoginToName(c.login);
  const displayName = realName || c.login;
  const color       = ghAvatarColor(c.login);
  const initials    = displayName.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const mergeRate   = c.prs > 0 ? Math.round((c.prsMerged || 0) / c.prs * 100) : null;
  const locTotal    = (c.additions || 0) + (c.deletions || 0);
  const taskPct     = c.total > 0 ? Math.round((c.done || 0) / c.total * 100) : 0;
  const ringColor   = taskPct >= 75 ? "#22c55e" : taskPct >= 40 ? "#f59e0b" : "#ef4444";

  // Group tasks by project, open (not done) tasks first within each group
  const byProject = {};
  for (const t of (c.tasks || [])) {
    if (!byProject[t.project]) byProject[t.project] = [];
    byProject[t.project].push(t);
  }
  const taskSection = Object.entries(byProject).map(([proj, tasks]) => {
    const sorted = [...tasks].sort((a, b) => {
      const aDone = GH_DONE_STATUSES.has((a.status || "").toLowerCase());
      const bDone = GH_DONE_STATUSES.has((b.status || "").toLowerCase());
      return aDone === bDone ? 0 : aDone ? 1 : -1;
    });
    return `
    <div class="ghcd-project-group">
      <div class="ghcd-project-name">${proj}</div>
      ${sorted.map(t => {
        const isUrgent = (t.status || "").toLowerCase() === "production";
        return `
        <div class="ghcd-task-row${isUrgent ? " ghcd-task-row--urgent" : ""}">
          <span class="gh-task-dot" style="background:${ghStatusColor(t.status)}"></span>
          <span class="ghcd-task-title">${t.title}</span>
          <span class="ghcd-task-status" style="color:${ghStatusColor(t.status)}">${isUrgent ? "Live in Production" : ghDisplayStatus(t.status)}</span>
        </div>
      `;
      }).join("")}
    </div>
  `;
  }).join("");

  const codeStats = `
    ${c.commits > 0 ? `<div class="ghcd-code-stat"><strong>${c.commits}</strong><span>Code Saves</span></div>` : ""}
    ${c.prs > 0     ? `<div class="ghcd-code-stat"><strong>${c.prs}</strong><span>Reviews</span></div>` : ""}
    ${mergeRate !== null ? `<div class="ghcd-code-stat"><strong class="ghcd-merged">${mergeRate}%</strong><span>Merge Rate</span></div>` : ""}
    ${locTotal > 0  ? `<div class="ghcd-code-stat"><strong>${fmtLoc(locTotal)}</strong><span>Lines Changed</span></div>` : ""}
  `;

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

    ${c.total > 0 ? `
    <div class="ghcd-stat-strip">
      <div class="ghcd-ring" style="--pct:${taskPct};--c:${ringColor}"><div class="ghcd-ring-inner" style="color:${ringColor}">${taskPct}%</div></div>
      <div class="ghcd-stat-strip-text"><strong>${c.done} / ${c.total}</strong><span>Board tasks done this period</span></div>
    </div>` : ""}
    ${codeStats.trim() ? `<div class="ghcd-code-stats">${codeStats}</div>` : ""}

    ${taskSection ? `
      <h3 class="ghcd-section-title">Tasks${c.total > 0 ? " — open first" : ""}</h3>
      ${taskSection}
    ` : `<p style="color:var(--muted);margin-top:16px">No tasks assigned in this period.</p>`}
    </div>
  `;
  document.querySelectorAll("dialog[open]").forEach(d => d.close());
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
    document.getElementById("ghRefreshLabel").innerHTML =
      CLOCK_SVG + formatRefreshTimestamp(lastUpdated, "Updated");
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
  const warnSvg  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>`;
  const folderSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>`;

  document.getElementById("ghSummaryCards").innerHTML = `
    <div class="gh-stat-item">
      <div class="gh-stat-icon" style="--icon-bg:#eff6ff;--icon-fg:#3b82f6"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18M3 7v11a2 2 0 002 2h14a2 2 0 002-2V7M3 7l2-4h14l2 4"/></svg></div>
      <div><span class="gh-stat-val">${projects.length}</span><span class="gh-stat-lbl">Active Projects</span></div>
    </div>
    <div class="gh-stat-item">
      <div class="gh-stat-icon" style="--icon-bg:#f0fdf4;--icon-fg:#16a34a"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4M2 12l3 3L15 5"/></svg></div>
      <div><span class="gh-stat-val">${doneTasks}<span class="gh-stat-sub"> / ${totalTasks}</span></span><span class="gh-stat-lbl">Tasks Done &nbsp;<span style="color:#16a34a;font-weight:600">${donePct}%</span></span></div>
    </div>
    <div class="gh-stat-item">
      <div class="gh-stat-icon" style="--icon-bg:#eff6ff;--icon-fg:#3b82f6"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8"/></svg></div>
      <div><span class="gh-stat-val">${inProg}</span><span class="gh-stat-lbl">In Progress</span></div>
    </div>
    <div class="gh-stat-item${inProd ? " gh-stat-item--urgent" : ""}">
      <div class="gh-stat-icon" style="--icon-bg:${inProd ? "#fee2e2" : "#f1f5f9"};--icon-fg:${inProd ? "#dc2626" : "#64748b"}">${warnSvg}</div>
      <div><span class="gh-stat-val">${inProd}</span><span class="gh-stat-lbl">Live Production Issues</span></div>
    </div>
    <div class="gh-stat-item">
      <div class="gh-stat-icon" style="--icon-bg:#f5f3ff;--icon-fg:#7c3aed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M2 21v-1a5 5 0 015-5h1M14 21v-1a5 5 0 015-5h-1"/></svg></div>
      <div><span class="gh-stat-val">${totalContrib}</span><span class="gh-stat-lbl">Contributors</span></div>
    </div>
    <div class="gh-stat-item">
      <div class="gh-stat-icon" style="--icon-bg:#f0fdfa;--icon-fg:#00a99d"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M2 12h20"/></svg></div>
      <div><span class="gh-stat-val">${totalCommits}</span><span class="gh-stat-lbl">Total Code Saves</span></div>
    </div>
    ${totalLoc ? `
    <div class="gh-stat-item">
      <div class="gh-stat-icon" style="--icon-bg:#f5f3ff;--icon-fg:#7c3aed"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 18l6-6-6-6M8 6l-6 6 6 6"/></svg></div>
      <div><span class="gh-stat-val">${fmtLoc(totalLoc)}</span><span class="gh-stat-lbl">Lines Changed</span></div>
    </div>` : ""}
  `;

  // ── Attention banner ────────────────────────────────────────────────────
  const prodProjects = projects.filter(p => (p.stats?.production || 0) > 0);
  document.getElementById("ghAttentionBanner").innerHTML = prodProjects.length ? `
    <div class="gh-attn-banner">
      <div class="gh-attn-icon">${warnSvg}</div>
      <div class="gh-attn-text"><b>${prodProjects.length} project${prodProjects.length !== 1 ? "s" : ""} have live bugs reported in production</b> — <span class="gh-attn-links">${prodProjects.map(p => p.title).join(", ")}</span>. Sorted to the top below.</div>
    </div>` : "";

  // ── Controls row (sort + search) ────────────────────────────────────────
  const ghQuery = (document.getElementById("ghProjectSearch")?.value || "").toLowerCase().trim();
  document.getElementById("ghControlsRow").innerHTML = `
    <div class="gh-controls-row">
      <div class="gh-sort-group">
        <span class="gh-sort-label">Sort by</span>
        ${[["attention","Needs Attention"],["completion","Completion %"],["tasks","Most Tasks"],["name","Name"]].map(([val, lbl]) =>
          `<button class="gh-sort-btn${_ghSort === val ? " gh-sort-btn--active" : ""}" onclick="_ghSort='${val}';renderGitHub(false)">${lbl}</button>`
        ).join("")}
      </div>
      <div class="gh-search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="ghProjectSearch" type="search" placeholder="Search projects..." value="${ghQuery}" oninput="renderGitHub(false)">
      </div>
    </div>`;

  // ── Projects list ──────────────────────────────────────────────────────
  const searched = ghQuery ? projects.filter(p => (p.title || "").toLowerCase().includes(ghQuery)) : projects;
  const activeProjects  = searched.filter(p => (p.stats?.total || 0) > 0);
  const dormantProjects = searched.filter(p => (p.stats?.total || 0) === 0);

  activeProjects.sort((a, b) => {
    const sa = a.stats || {}, sb = b.stats || {};
    if (_ghSort === "attention") {
      if ((sb.production || 0) !== (sa.production || 0)) return (sb.production || 0) - (sa.production || 0);
      return (sb.inProgress || 0) - (sa.inProgress || 0);
    }
    if (_ghSort === "completion") {
      const pa = sa.total ? sa.done / sa.total : 0;
      const pb = sb.total ? sb.done / sb.total : 0;
      return pb - pa;
    }
    if (_ghSort === "tasks") return (sb.total || 0) - (sa.total || 0);
    return (a.title || "").localeCompare(b.title || "");
  });

  const cardsHtml = activeProjects.map(proj => {
    const s = proj.stats || {};
    const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
    const hasProd = (s.production || 0) > 0;
    const stripeColor = hasProd ? "#e11d48" : pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : (s.inProgress || 0) > 0 ? "#3b82f6" : "#ef4444";
    const taskCount = (proj.items || []).length;
    const startOpen = taskCount <= 5;
    const listId = `gh-tasks-${proj.number}`;
    const items = (proj.items || []).map(item => {
      const isUrgent = (item.status || "").toLowerCase() === "production";
      return `
        <div class="gh-task-row${isUrgent ? " gh-task-row--urgent" : ""}">
          <span class="gh-task-dot" style="background:${ghStatusColor(item.status)}"></span>
          <span class="gh-task-title">${item.title}</span>
          <span class="gh-task-badges">
            ${item.priority ? `<span class="gh-badge gh-badge--pri">${item.priority}</span>` : ""}
            ${item.size     ? `<span class="gh-badge">${item.size}</span>` : ""}
            ${(item.assignees || []).map(a => `<span class="gh-badge gh-badge--user">${a}</span>`).join("")}
          </span>
          <span class="gh-task-status${isUrgent ? " gh-task-status--urgent" : ""}" style="color:${ghStatusColor(item.status)}">${isUrgent ? warnSvg + " Live in Production" : ghDisplayStatus(item.status)}</span>
        </div>
      `;
    }).join("");

    return `
      <article class="panel gh-project-card${hasProd ? " gh-project-card--urgent" : ""}" style="--stripe:${stripeColor}">
        <div class="gh-project-head gh-project-toggle" onclick="toggleGhProject('${listId}', this)" style="cursor:pointer">
          <div>
            <h3 class="gh-project-name">${proj.title} ${hasProd ? `<span class="gh-pill gh-pill--urgent">${warnSvg} ${s.production} live issue${s.production !== 1 ? "s" : ""}</span>` : ""}</h3>
            <span class="gh-project-meta">${s.total} tasks · ${pct}% done</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <div class="gh-status-pills">
              ${s.done       ? `<span class="gh-pill" style="background:#dcfce7;color:#15803d">✓ ${s.done} Done</span>` : ""}
              ${s.inProgress ? `<span class="gh-pill" style="background:#dbeafe;color:#1d4ed8">⟳ ${s.inProgress} In Progress</span>` : ""}
              ${s.todo       ? `<span class="gh-pill" style="background:#fef9c3;color:#a16207">○ ${s.todo} Todo</span>` : ""}
              ${s.backlog    ? `<span class="gh-pill" style="background:#f1f5f9;color:#475569">· ${s.backlog} Backlog</span>` : ""}
            </div>
            <span class="gh-chevron ${startOpen ? "open" : ""}">&#8964;</span>
          </div>
        </div>
        <div class="gh-progress-bar-wrap">
          <div class="gh-progress-bar" style="width:${pct}%;background:${pct >= 75 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444"}"></div>
        </div>
        <div class="gh-task-list" id="${listId}" ${startOpen ? "" : 'style="display:none"'}>${items}</div>
      </article>
    `;
  }).join("");

  const dormantHtml = dormantProjects.length ? `
    <div class="gh-dormant-group">
      <div class="gh-dormant-group-label">${folderSvg}${dormantProjects.length} project${dormantProjects.length !== 1 ? "s" : ""} with no tasks logged</div>
      <div class="gh-dormant-chips">
        ${dormantProjects.map(p => `<span class="gh-dormant-chip">${folderSvg}${p.title}</span>`).join("")}
      </div>
    </div>` : "";

  document.getElementById("ghProjectsList").innerHTML = projects.length
    ? (cardsHtml + dormantHtml || `<p style="color:var(--muted)">No projects match the current search.</p>`)
    : `<p style="color:var(--muted)">No project data yet. Click "Refresh now".</p>`;

  // ── Contributors grid ──────────────────────────────────────────────────
  const contribQuery = (document.getElementById("ghContribSearch")?.value || "").toLowerCase().trim();
  document.getElementById("ghContribControlsRow").innerHTML = `
    <div class="gh-controls-row">
      <div class="gh-sort-group">
        <span class="gh-sort-label">Sort by</span>
        ${[["attention","Needs Attention"],["active","Most Active"],["tasks","Most Tasks"],["name","Name"]].map(([val, lbl]) =>
          `<button class="gh-sort-btn${_ghContribSort === val ? " gh-sort-btn--active" : ""}" onclick="_ghContribSort='${val}';renderGitHub(false)">${lbl}</button>`
        ).join("")}
      </div>
      <div class="gh-search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input id="ghContribSearch" type="search" placeholder="Search contributors..." value="${contribQuery}" oninput="renderGitHub(false)">
      </div>
    </div>`;

  const searchedContribs = contribQuery
    ? contributors.filter(c => {
        const realName = ghLoginToName(c.login);
        return (realName || "").toLowerCase().includes(contribQuery) || (c.login || "").toLowerCase().includes(contribQuery);
      })
    : contributors;

  const sortedContribs = [...searchedContribs].sort((a, b) => {
    const aStalled = (a.total || 0) >= 10 && (a.done || 0) === 0;
    const bStalled = (b.total || 0) >= 10 && (b.done || 0) === 0;
    if (_ghContribSort === "attention") {
      if (aStalled !== bStalled) return aStalled ? -1 : 1;
      return (b.commits + b.total) - (a.commits + a.total);
    }
    if (_ghContribSort === "active") return (b.commits || 0) - (a.commits || 0);
    if (_ghContribSort === "tasks") return (b.total || 0) - (a.total || 0);
    return (ghLoginToName(a.login) || a.login || "").localeCompare(ghLoginToName(b.login) || b.login || "");
  });

  document.getElementById("ghContributors").innerHTML = sortedContribs.length ? `
    <div class="gh-contrib-grid">
      ${sortedContribs.map(c => {
        const realName  = ghLoginToName(c.login);
        const displayName = realName || c.login;
        const mergeRate = c.prs > 0 ? Math.round((c.prsMerged || 0) / c.prs * 100) : null;
        const initials  = displayName.split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
        const color     = ghAvatarColor(c.login);
        const locTotal  = (c.additions || 0) + (c.deletions || 0);
        const taskPct   = c.total > 0 ? Math.round((c.done || 0) / c.total * 100) : 0;
        const stalled   = (c.total || 0) >= 10 && (c.done || 0) === 0;
        const barColor  = taskPct >= 75 ? "#22c55e" : taskPct >= 40 ? "#f59e0b" : "#ef4444";
        const stripe    = stalled ? "#f59e0b" : c.total > 0 ? barColor : "#e2e8f0";
        return `
        <div class="gh-contrib-card${stalled ? " gh-contrib-card--warn" : ""}" onclick="showGhContributor('${c.login}')" style="cursor:pointer;--stripe:${stripe}">
          <div class="gh-contrib-card-header">
            <div class="gh-contrib-avatar2" style="background:${color}">${initials}</div>
            <div class="gh-contrib-card-identity">
              <div class="gh-contrib-card-name">${displayName}</div>
              ${realName ? `<div class="gh-contrib-card-login">${c.login}</div>` : ""}
              ${stalled ? `<span class="gh-warn-pill"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L2.5 17.1a1.5 1.5 0 001.3 2.25h16.4a1.5 1.5 0 001.3-2.25L13.7 3.9a1.5 1.5 0 00-2.6 0z"/></svg>${c.total} tasks, 0 done</span>` : ""}
            </div>
          </div>
          <div class="gh-contrib-chips">${(c.projects || []).length ? c.projects.map(p => `<span class="gh-contrib-chip">${p}</span>`).join("") : `<span class="gh-contrib-chip" style="opacity:.6">No board tasks</span>`}</div>
          ${c.total > 0 ? `
          <div class="gh-contrib-task-block">
            <div class="gh-contrib-task-label"><span>Task completion</span><strong style="color:${barColor}">${taskPct}%</strong></div>
            <div class="gh-contrib-bar-wrap"><div class="gh-contrib-bar-fill" style="width:${taskPct}%;background:${barColor}"></div></div>
          </div>` : ""}
          <div class="gh-contrib-card-stats">
            ${c.commits > 0 ? `<span class="gh-cs"><b>${c.commits}</b> code saves</span>` : ""}
            ${c.total  > 0 ? `<span class="gh-cs"><b>${c.done}/${c.total}</b> tasks</span>` : ""}
            ${c.prs    > 0 ? `<span class="gh-cs"><b>${c.prs}</b> review${c.prs!==1?"s":""}${mergeRate!==null?` <span class="gh-merged">${mergeRate}% merged</span>`:"" }</span>` : ""}
            ${locTotal > 0 ? `<span class="gh-cs"><b>${fmtLoc(locTotal)}</b> lines changed</span>` : ""}
          </div>
        </div>`;
      }).join("")}
    </div>
  ` : `<p style="color:var(--muted);padding:24px">No contributors match the current search.</p>`;
}

// ======= TARA MARKDOWN RENDERER =======
function taraMarkdown(raw) {
  const q = (taraLastQuestion || "").replace(/'/g, "\\'");

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\.\.\.and (\d+) more\./gi, (_, n) => {
      if (parseInt(n, 10) === 0) return "";
      return `<button class="tara-show-more-btn" onclick="askTara('show all ${q}')">▼ Show ${n} more</button>`;
    });
    s = s.replace(/\b(Issue|Action|Team|Band|KPI|Tasks|Absent|Status|Priority):/g, "<strong>$1:</strong>");
    return s;
  }

  const lines = raw.split("\n");
  const parts = [];
  let inList = false;
  let listItems = [];
  let currentItem = null;

  function flushList() {
    if (!listItems.length) return;
    let html = '<ol class="tara-md-ol">';
    for (const item of listItems) {
      html += `<li><span class="tara-md-li-main">${item.main}</span>`;
      if (item.details.length) {
        html += `<div class="tara-md-li-details">${item.details.map(d => `<div>${d}</div>`).join("")}</div>`;
      }
      html += "</li>";
    }
    html += "</ol>";
    parts.push(html);
    listItems = [];
    currentItem = null;
    inList = false;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^[━─]{3,}/.test(trimmed)) {
      flushList();
      parts.push('<hr class="tara-md-hr">');
      continue;
    }

    const olMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (olMatch) {
      inList = true;
      currentItem = { main: inline(olMatch[2]), details: [] };
      listItems.push(currentItem);
      continue;
    }

    if (inList && currentItem && /^\s{2,}/.test(line) && trimmed) {
      currentItem.details.push(inline(trimmed));
      continue;
    }

    if (inList) flushList();

    if (!trimmed) {
      parts.push('<div class="tara-md-spacer"></div>');
      continue;
    }

    if (trimmed.startsWith("→")) {
      parts.push(`<div class="tara-md-insight">${inline(trimmed)}</div>`);
      continue;
    }

    if (/^[✓⚠—]/.test(trimmed)) {
      const cls = trimmed.startsWith("✓") ? "ok" : trimmed.startsWith("⚠") ? "warn" : "neutral";
      parts.push(`<div class="tara-md-verdict tara-md-verdict--${cls}">${inline(trimmed)}</div>`);
      continue;
    }

    parts.push(`<div class="tara-md-line">${inline(line)}</div>`);
  }

  flushList();
  return parts.join("");
}

// ======= TARA CHATBOT =======
let taraHistory = [];
let taraInitialized = false;
let taraLastQuestion = "";

const TARA_FOLLOWUPS = {
  performance:   ["Who is in Critical band?", "Show their attendance", "Which team leads in KPI?"],
  attendance:    ["Who was absent most?", "Show their KPI score", "Which team attends best?"],
  availability:  ["Who is online right now?", "Show their task progress", "Who is away on Teams?"],
  task:          ["Who has pending tasks?", "Show their KPI score", "Who completed most tasks?"],
  efficiency:    ["Who has lowest efficiency?", "Show top performers", "Compare with attendance"],
  github:        ["Who has the most commits?", "Which project has the most pending tasks?", "Show all contributors"],
  planner:       ["Show overdue Planner tasks", "Which Planner plan has the most tasks?", "Show completed Planner tasks"],
  calendar:      ["Show today's meetings", "Which employee has the most calendar events?", "Show cancelled events"],
  sharepoint:    ["Show all SharePoint sites", "Which sites have document libraries?", "Show recently active sites"],
  employee360:   ["Show their Planner tasks", "Show their calendar events", "Show their attendance"],
  risk_insight:  ["Show their KPI score", "Show their attendance", "Which team has the most at-risk employees?"],
  team_summary:  ["Which team has the highest KPI?", "Show attendance by team", "Which team has the most pending tasks?"],
  general:       ["Show top 3 performers", "Who needs attention?", "Who was absent this month?"],
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
    `<div class="tara-msg-row">
       <div class="tara-msg-row-avatar">✦</div>
       <div class="tara-msg tara-msg--bot">
         <p style="white-space:pre-wrap;margin:0">Hi! I'm Tara, your PeopleOps assistant. Ask me anything about your team's performance, attendance, or productivity.</p>
       </div>
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
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 35000);
    const res = await apiFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        history: taraHistory,
        activeMonth: dataset?.meta?.period?.match(/(\d{4}-\d{2})/)?.[1] || null,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
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
      bubble.innerHTML = `<div class="tara-md">${taraMarkdown(text)}</div>
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
