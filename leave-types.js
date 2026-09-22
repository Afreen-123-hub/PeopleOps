// "Type of leaves taken" card on the Attendance page.
//
// Self-contained: it loads its own per-month leave data from /api/leave-types (GreytHR leave codes per
// day) and never touches the dashboard's main dataset. It only reads two things from app.js:
// filteredEmployees (who to include) and apiFetch (authenticated requests).
(function () {
  "use strict";

  // Full names are the usual meaning of each GreytHR code; unknown codes still work, they just get a neutral colour.
  var ABSENT_CODE = "__ABSENT__"; // matches the reserved marker services/greythr_api_client.py uses for plain Absent
  var KNOWN = [
    { code: "CL",     name: "Casual Leave",       color: "#0f9d8f", fg: "#fff" },
    { code: "SL",     name: "Sick Leave",         color: "#e0745c", fg: "#fff" },
    { code: "WFH",    name: "Work From Home",     color: "#f0a72d", fg: "#3d2a00" },
    { code: "Prob-L", name: "Probation Leave",    color: "#6b7fd7", fg: "#fff" },
    { code: "LOP",    name: "Loss of Pay",        color: "#d9485f", fg: "#fff" },
    { code: "COF",    name: "Comp Off",           color: "#4aa3df", fg: "#062b44" },
    { code: "RH",     name: "Restricted Holiday", color: "#c98bb9", fg: "#fff" },
    { code: "ML",     name: "Maternity Leave",    color: "#9a6fd8", fg: "#fff" },
    { code: "BL",     name: "Bereavement Leave",  color: "#8b95a5", fg: "#fff" },
    { code: "PTL",    name: "Paternity Leave",    color: "#7fb069", fg: "#10300a" },
    // Not a GreytHR leave code — plain "Absent" with no leave ever filed. Kept last and visually
    // distinct so it reads as "no leave on record", not as another kind of approved leave.
    { code: ABSENT_CODE, short: "ABS", name: "Absent (no leave filed)", color: "#55606e", fg: "#fff" }
  ];
  var FALLBACK_COLORS = ["#94a3b8", "#b08968", "#5aa9a2", "#a78bfa", "#d4a373"];
  var KNOWN_BY = {};
  KNOWN.forEach(function (t) { t.short = t.short || t.code; KNOWN_BY[t.code.toUpperCase()] = t; });

  function hexRgb(hex) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n = parseInt(h, 16);
    return ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255);
  }

  function typeMeta(code) {
    var k = KNOWN_BY[String(code).toUpperCase()];
    if (k) return k;
    var h = 0;
    for (var i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0;
    return { code: code, short: code, name: code, color: FALLBACK_COLORS[h % FALLBACK_COLORS.length], fg: "#fff" };
  }

  // ---------- dates (ISO strings, UTC arithmetic so timezones never shift a day) ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function localToday() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function D(s) { return new Date(s + "T00:00:00Z"); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function add(s, n) { var d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function dow(s) { return D(s).getUTCDay(); }
  function isWeekend(s) { var w = dow(s); return w === 0 || w === 6; }
  function fmt(s, o) { return D(s).toLocaleDateString("en-GB", Object.assign({ timeZone: "UTC" }, o)); }
  function monthStart(s) { return s.slice(0, 7) + "-01"; }
  function monthEnd(s) { var d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); }
  function addMonths(s, n) { var d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); }
  function shiftMonth(s, n) { // same day of the month, clamped to the target month's length
    var d = D(s), day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    d.setUTCDate(Math.min(day, D(monthEnd(iso(d))).getUTCDate()));
    return iso(d);
  }
  function weekStart(s) { var w = dow(s); return add(s, w === 0 ? -6 : 1 - w); }
  function num(n) { return Number.isInteger(n) ? String(n) : n.toFixed(1); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function normKey(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }

  var TODAY = localToday();
  var MIN = addMonths(monthStart(TODAY), -12);

  var state = { mode: "month", anchor: TODAY, filter: null, includeOthers: false, showAll: false, person: null, personFilter: null };
  var months = {};   // "YYYY-MM" -> { status: "loading" | "ready" | "error", days, stale }
  var bound = false;

  function root() { return document.getElementById("leaveTypesCard"); }
  function isVisible() { var v = document.getElementById("attendance"); return !!(v && v.classList.contains("active-view")); }

  // ---------- data ----------
  function range() {
    var a = state.anchor;
    if (state.mode === "day") return [a, a];
    if (state.mode === "week") { var w = weekStart(a); return [w, add(w, 6)]; }
    return [monthStart(a), monthEnd(a)];
  }
  function monthsIn(r) {
    var out = [], m = monthStart(r[0]);
    while (m <= r[1]) { out.push(m.slice(0, 7)); m = addMonths(m, 1); }
    return out;
  }

  function loadMonth(m, force) {
    var cur = months[m];
    if (cur && !force) return; // loading, ready or failed: only an explicit Retry fetches again
    months[m] = { status: "loading" };
    apiFetch("/api/leave-types?month=" + encodeURIComponent(m))
      .then(function (res) {
        if (!res) return null; // apiFetch already redirected to login
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (!r) return;
        months[m] = r.ok && r.body && r.body.days
          ? { status: "ready", days: r.body.days, people: r.body.people || [], stale: !!r.body.stale }
          : { status: "error", message: (r.body && r.body.error) || "Leave data could not be loaded." };
      })
      .catch(function () { months[m] = { status: "error", message: "Could not reach the server. Check your connection and retry." }; })
      .then(safeRender);
  }

  function employees() {
    return (typeof filteredEmployees !== "undefined" && filteredEmployees) ? filteredEmployees : [];
  }

  // GreytHR people with leave who have no matching dashboard employee (not in Worklogix, etc).
  function dashboardKeys() {
    var set = {};
    ((typeof dataset !== "undefined" && dataset && dataset.employees) || employees()).forEach(function (e) {
      var sk = e.sourceKeys || {};
      [String(e.id || ""), String(sk.greythr || ""), String(sk.biometric || ""), "name:" + normKey(e.name)].forEach(function (k) { if (k && k !== "name:") set[k] = 1; });
    });
    return set;
  }
  function extraPeople(monthKeys) {
    var known = dashboardKeys(), seen = {}, out = [];
    monthKeys.forEach(function (m) {
      var p = months[m];
      if (!p || p.status !== "ready" || !p.people) return;
      p.people.forEach(function (x) {
        if (x.keys.some(function (k) { return known[k]; })) return;
        var id = x.no || x.name;
        if (seen[id]) return;
        seen[id] = 1;
        out.push({ id: "gh:" + id, name: x.name, team: "Not in dashboard", sourceKeys: { greythr: x.keys[0] } });
      });
    });
    return out;
  }
  function rosterFor(monthKeys) {
    var base = employees();
    return state.includeOthers ? base.concat(extraPeople(monthKeys)) : base;
  }

  // Same lookup order the attendance refresh uses to match a GreytHR person to a dashboard employee.
  function daysFor(e, monthKeys) {
    var keys = [String(e.id || ""), String((e.sourceKeys && e.sourceKeys.greythr) || ""), String((e.sourceKeys && e.sourceKeys.biometric) || ""), "name:" + normKey(e.name)];
    var merged = {};
    monthKeys.forEach(function (m) {
      var payload = months[m];
      if (!payload || payload.status !== "ready") return;
      for (var i = 0; i < keys.length; i++) {
        var hit = keys[i] && payload.days[keys[i]];
        if (hit) { Object.keys(hit).forEach(function (d) { merged[d] = hit[d]; }); break; }
      }
    });
    return merged;
  }

  function aggregate(r) {
    var totals = {}, perDay = {}, perEmp = [], seen = [];
    var mk = monthsIn(r);
    rosterFor(mk).forEach(function (e) {
      var all = daysFor(e, mk), mine = {}, sum = 0, inRange = {};
      Object.keys(all).forEach(function (d) {
        if (d < r[0] || d > r[1]) return;
        inRange[d] = all[d];
        Object.keys(all[d]).forEach(function (c) {
          var n = all[d][c];
          totals[c] = (totals[c] || 0) + n; mine[c] = (mine[c] || 0) + n; sum += n;
          perDay[d] = perDay[d] || {}; perDay[d][c] = (perDay[d][c] || 0) + n;
          if (seen.indexOf(c) < 0) seen.push(c);
        });
      });
      if (sum > 0) perEmp.push({ e: e, days: inRange, mine: mine, sum: sum });
    });
    perEmp.sort(function (a, b) { return b.sum - a.sum || String(a.e.name).localeCompare(String(b.e.name)); });
    // Known types first (in GreytHR's order), then any code we haven't seen before.
    var codes = KNOWN.map(function (t) { return t.code; });
    seen.forEach(function (c) { if (!KNOWN_BY[c.toUpperCase()] && codes.indexOf(c) < 0) codes.push(c); });
    return { totals: totals, perDay: perDay, perEmp: perEmp, codes: codes };
  }

  // ---------- drawing ----------
  function periodLabel(r) {
    if (state.mode === "day") return fmt(r[0], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    if (state.mode === "week") return fmt(r[0], { day: "numeric", month: "short" }) + " – " + fmt(r[1], { day: "numeric", month: "short", year: "numeric" });
    return fmt(r[0], { month: "long", year: "numeric" });
  }

  function ringSvg(agg, sum) {
    var R = 78, C = 2 * Math.PI * R, off = 0;
    var h = '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="#e9eef5" stroke-width="26"/>';
    if (sum > 0) {
      agg.codes.forEach(function (c) {
        var v = agg.totals[c]; if (!v) return;
        if (state.filter && state.filter !== c) return;
        var len = v / sum * C, t = typeMeta(c), dash = Math.max(0, len - 1.5);
        h += '<circle cx="100" cy="100" r="' + R + '" fill="none" stroke="' + t.color + '" stroke-width="26" stroke-dasharray="' + dash + " " + (C - dash) +
             '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 100 100)"><title>' + esc(t.name) + ": " + num(v) + "</title></circle>";
        off += len;
      });
    }
    return '<svg viewBox="0 0 200 200" role="img" aria-label="Leave types breakdown">' + h + "</svg>";
  }

  function legendHtml(agg) {
    return agg.codes.map(function (c) {
      var v = agg.totals[c] || 0, t = typeMeta(c), rgb = hexRgb(t.color);
      var tint = v ? ' style="--lt-bg:rgba(' + rgb + ',.10);--lt-bg-hover:rgba(' + rgb + ',.18);--lt-accent:' + t.color + ';--lt-edge:rgba(' + rgb + ',.35)"' : "";
      return '<button type="button" class="lt-lg' + (v ? "" : " lt-zero") + '"' + tint + ' data-code="' + esc(c) + '" aria-pressed="' + (state.filter === c) + '" title="' + esc(t.name) + '">' +
        '<span class="lt-dot" style="background:' + t.color + '"></span><span class="lt-code">' + esc(t.short) + '</span><span class="lt-n">' + (v ? num(v) : "0") + "</span></button>";
    }).join("");
  }

  function trendHtml(r, agg) {
    var days = [], s = r[0];
    while (s <= r[1]) { days.push(s); s = add(s, 1); }
    var max = 1;
    days.forEach(function (d) {
      var t = 0;
      Object.keys(agg.perDay[d] || {}).forEach(function (c) { if (!state.filter || state.filter === c) t += agg.perDay[d][c]; });
      if (t > max) max = t;
    });
    return days.map(function (d) {
      var segs = "", tot = 0, tip = fmt(d, { weekday: "short", day: "numeric", month: "short" });
      agg.codes.forEach(function (c) {
        var v = (agg.perDay[d] || {})[c]; if (!v || (state.filter && state.filter !== c)) return;
        tot += v; tip += " · " + typeMeta(c).short + " " + num(v);
        segs += '<div class="lt-seg-b" style="height:' + (v / max * 100) + "%;background:" + typeMeta(c).color + '"></div>';
      });
      var dn = D(d).getUTCDate();
      var lab = state.mode === "week" ? fmt(d, { weekday: "narrow" }) + " " + dn : (dn === 1 || dn % 5 === 0 ? String(dn) : "");
      return '<div class="lt-col' + (tot ? "" : " lt-empty") + (isWeekend(d) ? " lt-weekend" : "") + (d === TODAY ? " lt-active" : "") + '" title="' + esc(tip + (tot ? "" : " · none")) + '">' +
        '<div class="lt-stack">' + segs + '</div><div class="lt-lbl">' + lab + "</div></div>";
    }).join("");
  }

  // Consecutive calendar days with the same leave type and length become one bar.
  function runsForDays(dayMap, filterCode) {
    var out = [], cur = null;
    Object.keys(dayMap).sort().forEach(function (d) {
      Object.keys(dayMap[d]).forEach(function (code) {
        if (filterCode && filterCode !== code) return;
        var v = dayMap[d][code];
        if (cur && cur.code === code && cur.v === v && add(cur.end, 1) === d) { cur.end = d; cur.len++; }
        else { cur = { code: code, v: v, start: d, end: d, len: 1 }; out.push(cur); }
      });
    });
    return out;
  }
  function runsFor(p) { return runsForDays(p.days, state.filter); }
  function spanText(a, b) {
    if (a === b) return fmt(a, { day: "numeric", month: "short" });
    if (a.slice(0, 7) === b.slice(0, 7)) return D(a).getUTCDate() + "–" + fmt(b, { day: "numeric", month: "short" });
    return fmt(a, { day: "numeric", month: "short" }) + " – " + fmt(b, { day: "numeric", month: "short" });
  }
  function teamOf(e) {
    var t = e.team || "Unassigned";
    return typeof mergedTeam === "function" ? mergedTeam(t) : t;
  }

  function timelineHtml(r, list) {
    var days = [], s = r[0];
    while (s <= r[1]) { days.push(s); s = add(s, 1); }
    var n = days.length, week = state.mode === "week", cell = 100 / n;
    function pct(i) { return (i * cell).toFixed(3) + "%"; }

    var axis = days.map(function (d, i) {
      var dn = D(d).getUTCDate();
      if (!week && !(dn === 1 || dn % 7 === 1)) return "";
      return '<span class="' + (d === TODAY ? "lt-tdy" : "") + '" style="left:' + pct(i) + ";width:" + cell.toFixed(3) + '%">' + (week ? fmt(d, { weekday: "short" }) : "") + "<b>" + dn + "</b></span>";
    }).join("");
    var head = '<div class="lt-tl-row lt-tl-head"><div></div><div class="lt-axis">' + axis + '</div><div class="lt-tl-lbl">Dates</div></div>';

    var shade = days.map(function (d, i) {
      return isWeekend(d) ? '<i class="lt-we" style="left:' + pct(i) + ";width:" + cell.toFixed(3) + '%"></i>' : "";
    }).join("");
    var ti = days.indexOf(TODAY);
    var todayMark = ti >= 0 ? '<i class="lt-td" style="left:calc(' + pct(ti) + " + " + (cell / 2).toFixed(3) + '% - 1px)"></i>' : "";

    var rows = list.map(function (p) {
      var sum = state.filter ? p.mine[state.filter] : p.sum;
      var runs = runsFor(p);
      var bars = runs.map(function (u) {
        var t = typeMeta(u.code), half = u.v < 1;
        var label = week ? t.short + (half ? " ½" : "") : (u.len >= 2 && t.short.length <= 3 ? t.short : "");
        var st = "left:" + pct(days.indexOf(u.start)) + ";width:calc(" + (u.len * cell).toFixed(3) + "% - 2px);margin-left:1px;";
        st += half ? "background:linear-gradient(90deg," + t.color + " 50%,transparent 50%);box-shadow:inset 0 0 0 1.5px " + t.color + ";color:var(--ink,#0f1c2e);"
                   : "background:" + t.color + ";color:" + t.fg + ";";
        var total = u.len * u.v;
        var tip = p.e.name + " · " + t.name + " · " + spanText(u.start, u.end) + " (" + num(total) + (total === 1 ? " day" : " days") + ")";
        return '<div class="lt-bar" style="' + st + '" title="' + esc(tip) + '">' + esc(label) + "</div>";
      }).join("");
      var dates = runs.map(function (u) {
        return '<span class="lt-chip"><i style="background:' + typeMeta(u.code).color + '"></i>' + esc(typeMeta(u.code).short) + " · " + spanText(u.start, u.end) + (u.v < 1 ? " ½" : "") + "</span>";
      }).join("");
      return '<div class="lt-tl-row"><div class="lt-name"><div class="lt-who">' + esc(p.e.name) + '</div><div class="lt-team">' + esc(teamOf(p.e)) + " · " +
        num(sum) + (sum === 1 ? " day" : " days") + '</div></div><div class="lt-track">' + shade + todayMark + bars + '</div><div class="lt-dates">' + dates + "</div></div>";
    }).join("");
    return head + rows;
  }

  function listHtml(list) {
    return list.map(function (p) {
      var ini = String(p.e.name || "?").split(" ").map(function (w) { return w[0]; }).slice(0, 2).join("");
      var sum = state.filter ? p.mine[state.filter] : p.sum;
      var chips = Object.keys(p.mine).filter(function (c) { return !state.filter || state.filter === c; }).map(function (c) {
        return '<span class="lt-chip"><i style="background:' + typeMeta(c).color + '"></i>' + esc(typeMeta(c).short) + " " + num(p.mine[c]) + "</span>";
      }).join("");
      return '<div class="lt-list-row"><div class="lt-av">' + esc(ini) + '</div><div><div class="lt-who">' + esc(p.e.name) + '</div><div class="lt-team">' + esc(teamOf(p.e)) +
        '</div></div><div class="lt-chips">' + chips + '</div><div class="lt-tot">' + num(sum) + " <small>" + (sum === 1 ? "day" : "days") + "</small></div></div>";
    }).join("");
  }

  // ---------- person search (someone's whole leave history, independent of the Day/Week/Month view) ----------
  function personMonths() {
    var out = [], m = monthStart(TODAY);
    for (var i = 0; i < 6; i++) { out.unshift(m.slice(0, 7)); m = addMonths(m, -1); }
    return out; // 6 months ending at the current month, oldest first
  }
  function personTotals(dayMap) {
    var totals = {}, codes = [];
    Object.keys(dayMap).forEach(function (d) {
      Object.keys(dayMap[d]).forEach(function (c) {
        totals[c] = (totals[c] || 0) + dayMap[d][c];
        if (codes.indexOf(c) < 0) codes.push(c);
      });
    });
    var ordered = KNOWN.map(function (t) { return t.code; }).filter(function (c) { return codes.indexOf(c) >= 0; });
    codes.forEach(function (c) { if (ordered.indexOf(c) < 0) ordered.push(c); });
    return { totals: totals, codes: ordered };
  }
  function personChipsHtml(pt) {
    return pt.codes.map(function (c) {
      var v = pt.totals[c] || 0, t = typeMeta(c), rgb = hexRgb(t.color);
      var tint = ' style="--lt-bg:rgba(' + rgb + ',.10);--lt-bg-hover:rgba(' + rgb + ',.18);--lt-accent:' + t.color + ';--lt-edge:rgba(' + rgb + ',.35)"';
      return '<button type="button" class="lt-lg" data-pfilter="' + esc(c) + '" aria-pressed="' + (state.personFilter === c) + '"' + tint + '>' +
        '<span class="lt-dot" style="background:' + t.color + '"></span><span class="lt-code">' + esc(t.short) + '</span><span class="lt-n">' + num(v) + "</span></button>";
    }).join("");
  }
  function personTimelineHtml(dayMap, monthsList) {
    var start = monthsList[0] + "-01", end = monthEnd(monthsList[monthsList.length - 1] + "-01");
    var span = [], s = start;
    while (s <= end) { span.push(s); s = add(s, 1); }
    var n = span.length, cell = 100 / n;
    function pct(i) { return (i * cell).toFixed(3) + "%"; }
    var ticks = monthsList.map(function (m) {
      var idx = span.indexOf(m + "-01");
      return '<span style="left:' + pct(idx) + '">' + fmt(m + "-01", { month: "short" }) + "</span>";
    }).join("");
    var runs = runsForDays(dayMap, state.personFilter);
    var bars = runs.map(function (u) {
      var t = typeMeta(u.code), half = u.v < 1, a = span.indexOf(u.start);
      var st = "left:" + pct(a) + ";width:calc(" + (u.len * cell).toFixed(3) + "% - 1px);";
      st += half ? "background:linear-gradient(90deg," + t.color + " 50%,transparent 50%);box-shadow:inset 0 0 0 1.5px " + t.color + ";"
                 : "background:" + t.color + ";";
      var total = u.len * u.v;
      var tip = t.name + " · " + spanText(u.start, u.end) + " (" + num(total) + (total === 1 ? " day" : " days") + ")";
      return '<div class="lt-pbar" style="' + st + '" title="' + esc(tip) + '"></div>';
    }).join("");
    var ti = span.indexOf(TODAY);
    var todayMark = ti >= 0 ? '<i class="lt-ptoday" style="left:' + pct(ti) + '"></i>' : "";
    return '<div class="lt-pticks">' + ticks + '</div><div class="lt-ptrack">' + bars + todayMark + "</div>";
  }
  function personEntriesHtml(dayMap) {
    var runs = runsForDays(dayMap, state.personFilter).slice().reverse(); // most recent first
    if (!runs.length) return '<div class="lt-empty-msg">No leave or absence recorded in this range.</div>';
    return runs.map(function (u) {
      var t = typeMeta(u.code), total = u.len * u.v;
      return '<div class="lt-pentry"><span class="lt-dot" style="background:' + t.color + '"></span>' +
        '<span class="lt-pentry-name">' + esc(t.name) + '</span>' +
        '<span class="lt-pentry-when">' + esc(spanText(u.start, u.end)) + (u.v < 1 ? " · half day" : "") + '</span>' +
        '<span class="lt-pentry-days">' + num(total) + (total === 1 ? " day" : " days") + "</span></div>";
    }).join("");
  }
  function personBodyHtml(emp) {
    var monthsList = personMonths();
    monthsList.forEach(function (m) { loadMonth(m, false); });
    var loading = monthsList.some(function (m) { return !months[m] || months[m].status === "loading"; });
    if (loading) return '<div class="lt-status">Loading ' + esc(emp.name) + "’s leave history…</div>";
    var dayMap = daysFor(emp, monthsList);
    if (state.personFilter && personTotals(dayMap).codes.indexOf(state.personFilter) < 0) state.personFilter = null;
    var pt = personTotals(dayMap);
    var total = pt.codes.reduce(function (a, c) { return a + (pt.totals[c] || 0); }, 0);
    var rangeLabel = fmt(monthsList[0] + "-01", { month: "short", year: "numeric" }) + " – " + fmt(monthsList[monthsList.length - 1] + "-01", { month: "short", year: "numeric" });
    return (
      '<div class="lt-pheader"><div><div class="lt-who" style="font-size:1.05rem">' + esc(emp.name) + '</div><div class="lt-team">' + esc(teamOf(emp)) + " · " + rangeLabel + "</div></div>" +
      '<div class="lt-ptotal">' + num(total) + " <small>" + (total === 1 ? "day" : "days") + " total</small></div></div>" +
      (total === 0
        ? '<div class="lt-empty-msg">No leave or absence recorded for ' + esc(emp.name) + " in this range.</div>"
        : '<div class="lt-legend">' + personChipsHtml(pt) + "</div>" +
          '<div class="lt-ptrack-wrap">' + personTimelineHtml(dayMap, monthsList) + "</div>" +
          '<div class="lt-section-title"><h3>Leave history</h3><span>' + rangeLabel + "</span></div>" +
          '<div class="lt-pentries">' + personEntriesHtml(dayMap) + "</div>")
    );
  }

  function render() {
    var el = root();
    if (!el || !isVisible()) return;
    if (typeof apiFetch !== "function") return;

    var r = range(), mk = monthsIn(r);
    mk.forEach(function (m) { loadMonth(m, false); });
    var loading = mk.some(function (m) { return months[m].status === "loading"; });
    var failed = mk.map(function (m) { return months[m]; }).filter(function (m) { return m.status === "error"; })[0];

    var agg = aggregate(r);
    if (state.filter && agg.codes.indexOf(state.filter) < 0) state.filter = null;
    var sum = agg.codes.reduce(function (a, c) { return a + (agg.totals[c] || 0); }, 0);
    var list = agg.perEmp.filter(function (p) { return !state.filter || p.mine[state.filter]; });
    var inView = employees().length;
    var outsiders = 0, outsiderDays = 0;
    extraPeople(mk).forEach(function (x) {
      var all = daysFor(x, mk), sum2 = 0;
      Object.keys(all).forEach(function (d) { if (d >= r[0] && d <= r[1]) Object.keys(all[d]).forEach(function (c) { sum2 += all[d][c]; }); });
      if (sum2 > 0) { outsiders++; outsiderDays += sum2; }
    });
    var note = outsiders
      ? '<div class="lt-note"><span>' + (state.includeOthers ? "Including " : "") + outsiders + (outsiders === 1 ? " person" : " people") +
        (state.includeOthers ? " who " + (outsiders === 1 ? "isn't" : "aren't") + " in the PeopleOps dashboard" : " with leave in GreytHR " + (outsiders === 1 ? "isn't" : "aren't") + " in the PeopleOps dashboard") +
        " (" + num(outsiderDays) + (outsiderDays === 1 ? " day" : " days") + ").</span><button type=\"button\" data-others=\"1\">" + (state.includeOthers ? "Hide them" : "Include them") + "</button></div>"
      : "";
    var total = (typeof dataset !== "undefined" && dataset && dataset.employees) ? dataset.employees.length : inView;

    var searchRow = state.person
      ? '<div class="lt-search-row"><button type="button" class="lt-searchclear" data-clear-person="1">&#8592; Back to everyone</button></div>'
      : '<div class="lt-search-row"><div class="lt-search-wrap"><input type="text" id="ltSearch" class="lt-search-input" placeholder="Search a person…" autocomplete="off" value="' + esc(state.query || "") + '">' +
        '<div class="lt-search-drop" id="ltSearchDrop" hidden></div></div></div>';

    var head =
      '<div class="lt-head"><div><p class="eyebrow">Attendance intelligence</p><h2>Type of leaves taken</h2>' +
      '<p class="lt-sub">' + inView + " employees" + (inView < total ? " in view (filters applied)" : "") + " · from GreytHR" +
      (mk.some(function (m) { return months[m].stale; }) ? " · showing saved data, GreytHR could not be reached" : "") + "</p></div>" +
      '<div class="lt-controls"><div class="lt-seg" role="group" aria-label="Period">' +
      ["day", "week", "month"].map(function (m) { return '<button type="button" data-mode="' + m + '" aria-pressed="' + (state.mode === m) + '">' + m[0].toUpperCase() + m.slice(1) + "</button>"; }).join("") +
      '</div><div class="lt-nav"><button type="button" data-nav="-1" aria-label="Previous period"' + (r[0] <= MIN ? " disabled" : "") + '>&#8249;</button>' +
      '<div class="lt-period" aria-live="polite">' + esc(periodLabel(r)) + '</div>' +
      '<button type="button" data-nav="1" aria-label="Next period"' + (r[1] >= TODAY ? " disabled" : "") + '>&#8250;</button>' +
      '<button type="button" class="lt-today" data-nav="today"' + (r[0] <= TODAY && TODAY <= r[1] ? " disabled" : "") + ">Today</button></div></div></div>";

    var body;
    if (failed && !loading) {
      body = '<div class="lt-status lt-err">' + esc(failed.message) + ' <button type="button" data-retry="1">Retry</button></div>';
    } else if (loading) {
      body = '<div class="lt-status">Loading leave data from GreytHR…</div>';
    } else {
      var timeline;
      var TODAY_IN = r[0] <= TODAY && TODAY <= r[1];
      if (!list.length) timeline = '<div class="lt-empty-msg">No leaves recorded in this period.' + (TODAY_IN ? " GreytHR finalises today's records overnight, so today can look empty." : "") + "</div>";
      else {
        var collapse = list.length > 15 && !state.showAll;
        var shown = collapse ? list.slice(0, 12) : list;
        timeline = (state.mode === "day" ? listHtml(shown) : timelineHtml(r, shown)) +
          (list.length > 15 ? '<button type="button" class="lt-more" data-showall="1">' + (collapse ? "Show all " + list.length + " people" : "Show fewer") + "</button>" : "");
      }
      body = note +
        '<div class="lt-body"><div class="lt-donut">' + ringSvg(agg, sum) + '<div class="lt-mid"><div class="lt-big">' + num(sum) + '</div><div class="lt-mid-sub">Leave &amp; absence days</div></div></div>' +
        '<div class="lt-legend">' + legendHtml(agg) + "</div></div>" +
        (state.mode === "day" ? "" : '<div><div class="lt-section-title"><h3>Day by day</h3><span>Weekends are dimmed</span></div><div class="lt-trend">' + trendHtml(r, agg) + "</div></div>") +
        '<div><div class="lt-section-title"><h3>' + (state.filter ? (state.filter === ABSENT_CODE ? "Who was marked Absent, no leave filed" : "Who took " + esc(typeMeta(state.filter).name)) : "Who was away") + (state.mode === "day" ? "" : ", and when") + "</h3><span>" +
        list.length + (list.length === 1 ? " person" : " people") + (state.mode === "day" ? " · click a type to filter" : " · hover a bar for details") + "</span></div>" + timeline + "</div>";
    }
    if (state.person) {
      var found = employees().concat(extraPeople(mk)).filter(function (e) { return e.id === state.person; })[0];
      body = found ? personBodyHtml(found) : '<div class="lt-empty-msg">That person is no longer in view.</div>';
    }
    el.innerHTML = '<article class="panel lt-card">' + head + searchRow + body + "</article>";
    bind(el);
    // Typing shouldn't be interrupted by the innerHTML replace above — restore focus/caret after a search selection re-render.
    var input = el.querySelector("#ltSearch");
    if (input && document.activeElement !== input && state.refocusSearch) {
      input.focus(); input.setSelectionRange(input.value.length, input.value.length); state.refocusSearch = false;
    }
  }

  function shift(dir) {
    var a = state.anchor;
    if (state.mode === "day") { do { a = add(a, dir); } while (isWeekend(a)); }
    else if (state.mode === "week") a = add(a, 7 * dir);
    else a = shiftMonth(a, dir);
    if (a > TODAY) a = TODAY;
    if (a < MIN) return;
    state.anchor = a;
  }

  function searchMatches(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    return employees().filter(function (e) { return (e.name || "").toLowerCase().indexOf(q) >= 0; }).slice(0, 8);
  }
  function renderSearchDrop(el) {
    var box = el.querySelector("#ltSearchDrop"), input = el.querySelector("#ltSearch");
    if (!box || !input) return;
    var matches = searchMatches(input.value);
    if (!input.value.trim()) { box.hidden = true; box.innerHTML = ""; return; }
    box.innerHTML = matches.length
      ? matches.map(function (e) { return '<button type="button" class="lt-sres" data-person="' + esc(e.id) + '">' + esc(e.name) + '<small>' + esc(teamOf(e)) + "</small></button>"; }).join("")
      : '<div class="lt-sres-empty">No one matches “' + esc(input.value.trim()) + '”</div>';
    box.hidden = false;
  }

  function bind(el) {
    if (bound) return;
    bound = true; // el's children are replaced on every render, so delegate from the stable container
    el.addEventListener("click", function (ev) {
      var t = ev.target.closest("button");
      if (!t || t.disabled) return;
      if (t.dataset.mode) {
        state.mode = t.dataset.mode;
        if (state.mode === "day") while (isWeekend(state.anchor)) state.anchor = add(state.anchor, -1); // weekends have no working-day view
      } else if (t.dataset.nav === "today") state.anchor = TODAY;
      else if (t.dataset.nav) shift(Number(t.dataset.nav));
      else if (t.dataset.code) state.filter = state.filter === t.dataset.code ? null : t.dataset.code;
      else if (t.dataset.pfilter) state.personFilter = state.personFilter === t.dataset.pfilter ? null : t.dataset.pfilter;
      else if (t.dataset.others) state.includeOthers = !state.includeOthers;
      else if (t.dataset.showall) state.showAll = !state.showAll;
      else if (t.dataset.retry) monthsIn(range()).forEach(function (m) { if (months[m] && months[m].status === "error") loadMonth(m, true); });
      else if (t.dataset.person) { state.person = t.dataset.person; state.personFilter = null; state.query = ""; }
      else if (t.dataset.clearPerson) { state.person = null; state.refocusSearch = true; }
      else return;
      safeRender();
    });
    // Typing updates only the small dropdown — never a full safeRender(), so the input never loses focus or caret position mid-word.
    el.addEventListener("input", function (ev) {
      if (ev.target.id !== "ltSearch") return;
      state.query = ev.target.value;
      renderSearchDrop(el);
    });
    el.addEventListener("keydown", function (ev) {
      if (ev.target.id !== "ltSearch" || ev.key !== "Enter") return;
      var first = searchMatches(ev.target.value)[0];
      if (first) { state.person = first.id; state.personFilter = null; state.query = ""; safeRender(); }
    });
    document.addEventListener("click", function (ev) {
      if (!ev.target.closest(".lt-search-wrap")) { var box = el.querySelector("#ltSearchDrop"); if (box) box.hidden = true; }
    });
  }

  function start() {
    var view = document.getElementById("attendance");
    if (!view || !root()) return;
    // Render whenever the Attendance page becomes the active one, however it was opened.
    new MutationObserver(function () { if (isVisible()) safeRender(); }).observe(view, { attributes: true, attributeFilter: ["class"] });
    safeRender();
  }

  // The card must never be able to break the rest of the dashboard, so errors stay in here.
  function safeRender() { try { render(); } catch (err) { if (window.console) console.warn("Leave types card:", err); } }
  window.renderLeaveTypesCard = safeRender;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
