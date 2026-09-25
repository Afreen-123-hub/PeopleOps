// "Work location" card on the Attendance page.
//
// Self-contained: it loads its own per-month data from /api/work-location (GreytHR swipes + day status)
// and never touches the dashboard's main dataset. It only reads two things from app.js:
// dataset (to show each person's team) and apiFetch (authenticated requests).
//
// Rules, per working day:
//   biometric swipe at an office door (with or without a sign-in) -> Work from office
//   web or mobile sign-in, no biometric swipe                      -> Work from home
//   no swipe, GreytHR shows a leave code (CL, SL, ...)             -> On leave
//   no swipe otherwise                                             -> Absent
// People on a holiday or weekly off that day are left out of the counts.
//
// Times: check-in is the first swipe. Today, the latest swipe is shown as "Last swipe · still in office",
// because a mid-day swipe is usually a break; on past days it is the check-out, with hours worked.
// Clicking a row opens "How it works" for that person: every swipe of the day on a timeline.
(function () {
  "use strict";

  var CATS = [
    { key: "office", label: "Work from office" },
    { key: "wfh",    label: "Work from home" },
    { key: "absent", label: "Absent", todayLabel: "Not signed in yet" },
    { key: "leave",  label: "On leave" }
  ];
  var CAT_BY = {};
  CATS.forEach(function (c) { CAT_BY[c.key] = c; });
  var NON_LEAVE = { P: 1, A: 1, H: 1, OFF: 1, WFH: 1 };
  var PAGE = 25;
  var POLL_MS = 8000;

  var ICON = {
    bio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M7 11h10"/></svg>',
    web: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
    mob: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>'
  };

  // ---------- dates (ISO strings, UTC arithmetic so timezones never shift a day) ----------
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function localToday() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function D(s) { return new Date(s + "T00:00:00Z"); }
  function iso(d) { return d.toISOString().slice(0, 10); }
  function add(s, n) { var d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
  function isWeekend(s) { var w = D(s).getUTCDay(); return w === 0 || w === 6; }
  function fmt(s) { return D(s).toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function toMin(t) { var p = String(t).split(":"); return (+p[0]) * 60 + (+p[1]); }
  function hm(m) { return pad(Math.floor(m / 60)) + ":" + pad(m % 60); }
  function dur(m) { return Math.floor(m / 60) + "h " + pad(m % 60) + "m"; }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function people(n) { return n + (n === 1 ? " person" : " people"); }
  function normKey(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }

  var TODAY = localToday();
  var MIN = add(TODAY, -366);

  var state = { day: TODAY, filter: null, query: "", showAll: false, person: null };
  var months = {};   // "YYYY-MM" -> { status: "loading" | "ready" | "building" | "error", payload, message }
  var pollTimer = null;
  var bound = false;

  function root() { return document.getElementById("workLocationCard"); }
  function isVisible() { var v = document.getElementById("attendance"); return !!(v && v.classList.contains("active-view")); }

  // ---------- data ----------
  function loadMonth(m, force) {
    var cur = months[m];
    if (cur && cur.status === "loading") return;
    if (cur && !force) return; // only polling or an explicit Retry fetches again
    months[m] = { status: "loading", payload: cur && cur.payload, prev: cur && cur.status === "building" ? cur : null };
    apiFetch("/api/work-location?month=" + encodeURIComponent(m))
      .then(function (res) {
        if (!res) return null; // apiFetch already redirected to login
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (!r) return;
        var b = r.body || {};
        if (r.ok && b.days) months[m] = { status: "ready", payload: b };
        else if (r.ok && b.building && b.error) {
          // The last background fetch failed. It is retried on every poll, but say so instead of waiting silently.
          console.warn("Work location: GreytHR fetch failed:", b.error);
          months[m] = { status: "error", message: "Could not fetch swipes from GreytHR. Check the GreytHR settings on the server, then retry." };
        }
        else if (r.ok && b.building) months[m] = { status: "building", done: b.done || 0, total: b.total || 0 };
        else months[m] = { status: "error", message: b.error || "Work location data could not be loaded." };
      })
      .catch(function () { months[m] = { status: "error", message: "Could not reach the server. Check your connection and retry." }; })
      .then(function () { schedulePoll(m); safeRender(); });
  }

  // While the server is still fetching from GreytHR, check back every few seconds.
  function schedulePoll(m) {
    var cur = months[m];
    var waiting = cur && (cur.status === "building" || (cur.status === "ready" && cur.payload.refreshing));
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (!waiting) return;
    pollTimer = setTimeout(function () {
      pollTimer = null;
      if (isVisible() && state.day.slice(0, 7) === m) loadMonth(m, true);
    }, POLL_MS);
  }

  // Team names come from the dashboard's own employee list, matched by GreytHR id, employee number or name.
  var teamIndex = null, teamIndexFor = null;
  function teamOf(p) {
    var list = (typeof dataset !== "undefined" && dataset && dataset.employees) || [];
    if (teamIndexFor !== list) {
      teamIndexFor = list;
      teamIndex = {};
      list.forEach(function (e) {
        var sk = e.sourceKeys || {};
        [String(e.id || ""), String(sk.greythr || ""), String(sk.biometric || ""), "name:" + normKey(e.name)].forEach(function (k) {
          if (k && k !== "name:" && e.team && !teamIndex[k]) teamIndex[k] = e.team;
        });
      });
    }
    return teamIndex[p.no] || teamIndex[p.id] || teamIndex["name:" + normKey(p.name)] || "";
  }

  function classify(rec) {
    if (rec.bi) return "office";
    if (rec.wi) return "wfh";
    var parts = String(rec.s || "").split("/").filter(Boolean);
    if (parts.some(function (p) { return !NON_LEAVE[p.toUpperCase()]; })) return "leave";
    if (parts.indexOf("WFH") >= 0) return "wfh";
    if (parts.length && parts.every(function (p) { return p === "H" || p === "OFF"; })) return "off";
    return "absent";
  }

  function rowsFor(payload, day) {
    var recs = (payload.days && payload.days[day]) || {};
    return (payload.people || []).map(function (p) {
      var rec = recs[p.id] || {};
      return { id: p.id, no: p.no, name: p.name, team: teamOf(p), rec: rec, cat: classify(rec) };
    });
  }

  // ---------- cells ----------
  function howCell(r) {
    var rec = r.rec, parts = [];
    if (rec.bi) parts.push('<span class="wl-src">' + ICON.bio + "Biometric</span>");
    if (rec.wi) parts.push('<span class="wl-src">' + (rec.mob ? ICON.mob + "Mobile sign-in" : ICON.web + "Web sign-in") + "</span>");
    if (parts.length) return parts.join(" + ");
    var showStatus = rec.s && !(state.day === TODAY && r.cat === "absent");
    return '<span class="wl-dim">No swipe' + (showStatus ? " · GreytHR: " + esc(rec.s) : "") + "</span>";
  }

  function inCell(r) {
    var rec = r.rec;
    if (r.cat === "office") return '<div class="wl-io"><b>' + esc(rec.bi) + "</b><small>Biometric" + (rec.door ? " · " + esc(rec.door) : "") + "</small></div>";
    if (r.cat === "wfh" && rec.wi) return '<div class="wl-io"><b>' + esc(rec.wi) + "</b><small>" + (rec.mob ? "Mobile" : "Web") + " sign-in</small></div>";
    return '<span class="wl-dim">—</span>';
  }

  // Today the latest swipe is not a check-out yet; on past days it is, and hours are added.
  function outCell(r) {
    var rec = r.rec, today = state.day === TODAY;
    if (r.cat === "office") {
      if (!rec.bo) return today
        ? '<div class="wl-io"><b class="wl-dim">No swipe yet</b><small>since check-in</small></div>'
        : '<div class="wl-io"><b class="wl-dim">—</b><small>No check-out recorded</small></div>';
      if (today) return '<div class="wl-io"><b>' + esc(rec.bo) + '</b><small><span class="wl-live">Last swipe · still in office</span></small></div>';
      return '<div class="wl-io"><b>' + esc(rec.bo) + '<span class="wl-hrs">' + dur(toMin(rec.bo) - toMin(rec.bi)) + "</span></b>" +
        "<small>Check-out · Biometric" + (rec.door ? " · " + esc(rec.door) : "") + "</small></div>";
    }
    if (r.cat === "wfh" && rec.wi) {
      if (!rec.wo) return today
        ? '<div class="wl-io"><b class="wl-dim">Not yet</b><small><span class="wl-live">still signed in</span></small></div>'
        : '<div class="wl-io"><b class="wl-dim">—</b><small>No sign-out recorded</small></div>';
      return '<div class="wl-io"><b>' + esc(rec.wo) + (today ? "" : '<span class="wl-hrs">' + dur(toMin(rec.wo) - toMin(rec.wi)) + "</span>") +
        "</b><small>Signed out · " + (rec.mob ? "Mobile" : "Web") + " sign-in</small></div>";
    }
    return '<span class="wl-dim">—</span>';
  }

  // ---------- how it works ----------
  // Every swipe of the day, as minutes since midnight. Older cached data only has first/last.
  function swipesOf(r) {
    var rec = r.rec;
    if (r.cat === "office") return (rec.bs || [rec.bi, rec.bo].filter(Boolean)).map(function (t) { return { t: toMin(t) }; });
    if (r.cat === "wfh" && rec.wi) {
      var rs = rec.rs || [rec.wi + "i"].concat(rec.wo ? [rec.wo + "o"] : []);
      return rs.map(function (x) { return { t: toMin(x.slice(0, 5)), out: x.slice(5) === "o" }; });
    }
    return [];
  }

  function timelineSvg(r, s, today) {
    var office = r.cat === "office", col = office ? "#0d9488" : "#1d4ed8";
    var first = s[0].t, last = s[s.length - 1].t, now = nowMin();
    var hasOut = !office && s.some(function (q) { return q.out; });
    var running = today && (office || !hasOut) && now > last;
    var endT = running ? now : last;
    var start = Math.min(8 * 60, Math.floor(first / 60) * 60), stop = Math.max(20 * 60, Math.ceil(endT / 60) * 60);
    var W = 1040, H = 120, L = 20, R = 20, y0 = 62;
    var x = function (t) { return L + (t - start) / (stop - start) * (W - L - R); };
    var svg = '<svg class="wl-tl" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Swipes for ' + esc(r.name) + '">' +
      '<defs><pattern id="wlHatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="3" height="6" fill="' + col + '" opacity=".35"/></pattern></defs>';
    for (var h = start; h <= stop; h += 120) {
      svg += '<line class="wl-tl-grid" x1="' + x(h) + '" x2="' + x(h) + '" y1="30" y2="' + (y0 + 18) + '"/>' +
        '<text class="wl-tl-axis" x="' + x(h) + '" y="' + (H - 8) + '" text-anchor="middle">' + hm(h) + "</text>";
    }
    svg += '<rect x="' + x(first) + '" y="' + (y0 - 7) + '" width="' + Math.max(2, x(endT) - x(first)) + '" height="14" rx="4" fill="' + col + '" opacity=".18"/>';
    if (running) {
      svg += '<rect x="' + x(last) + '" y="' + (y0 - 7) + '" width="' + Math.max(0, x(now) - x(last)) + '" height="14" fill="url(#wlHatch)"/>' +
        '<line x1="' + x(now) + '" x2="' + x(now) + '" y1="24" y2="' + (y0 + 18) + '" stroke="#0f1c2e" stroke-width="1.5" stroke-dasharray="3 3"/>' +
        '<text x="' + (x(now) + 6) + '" y="30" font-size="11" font-weight="700" fill="#0f1c2e">now ' + hm(now) + "</text>";
    }
    s.forEach(function (q, i) {
      var edge = i === 0 || i === s.length - 1;
      var role = i === 0 ? (office ? "Check-in" : "Signed in")
        : office ? (i === s.length - 1 ? (today ? "Last swipe" : "Check-out") : "Swipe in between")
        : (q.out ? "Signed out" : "Signed in");
      svg += '<circle cx="' + x(q.t) + '" cy="' + y0 + '" r="' + (edge ? 7 : 5) + '" fill="' + (edge ? col : "#fff") + '" stroke="' + col + '" stroke-width="2.5">' +
        "<title>" + role + " · " + hm(q.t) + "</title></circle>";
      if (edge) svg += '<text x="' + x(q.t) + '" y="' + (y0 - 16) + '" font-size="11.5" font-weight="700" text-anchor="middle" fill="#0f1c2e">' + hm(q.t) + "</text>";
    });
    return { svg: svg + "</svg>", running: running, hasOut: hasOut, now: now };
  }

  function howHtml(rows, label) {
    var list = rows.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var r = null;
    list.forEach(function (x) { if (x.id === state.person) r = x; });
    if (!r) { // start on someone whose day shows the rules best: office, with a break swipe
      list.forEach(function (x) { if (!r && x.cat === "office" && swipesOf(x).length >= 3) r = x; });
      if (!r) list.forEach(function (x) { if (!r && x.cat === "office") r = x; });
      if (!r) r = list[0];
    }
    if (!r) return "";
    var today = state.day === TODAY, dayText = fmt(state.day);
    var pick = '<label class="wl-who">Person <select id="wlWho">' + list.map(function (x) {
      return '<option value="' + esc(x.id) + '"' + (x.id === r.id ? " selected" : "") + ">" + esc(x.name) + "</option>";
    }).join("") + "</select></label>";

    var body, s = swipesOf(r);
    if (!s.length) {
      var why = r.cat === "leave" ? "GreytHR shows <b>" + esc(r.rec.s) + "</b> (leave) for " + esc(dayText) + ", so " + esc(r.name) + " is counted as <b>On leave</b>."
        : today ? esc(r.name) + " hasn’t swiped or signed in yet today, so they show as <b>Not signed in yet</b>. They move to a tile as soon as they swipe."
        : "No biometric swipe and no sign-in on " + esc(dayText) + ", and no leave in GreytHR, so " + esc(r.name) + " is counted as <b>Absent</b>.";
      body = '<p class="wl-nodata">' + why + "</p>";
    } else {
      var office = r.cat === "office", tl = timelineSvg(r, s, today);
      var first = s[0].t, last = s[s.length - 1].t;
      var between = office ? Math.max(0, s.length - 2) : 0;
      var lastLabel = office ? (today ? "Last swipe (so far)" : "Check-out") : "Sign-out";
      var lastVal = office ? (s.length > 1 ? hm(last) : "—") : (r.rec.wo || (today ? "Not yet" : "—"));
      var lastNote = office
        ? (s.length === 1 ? (today ? "Only one swipe so far." : "Only one swipe, so no check-out was recorded.")
          : (today ? "The day isn’t over, so this is not a check-out." : "The last swipe of the day."))
        : (r.rec.wo ? "They signed out in GreytHR." : (today ? "Still signed in." : "No sign-out was recorded."));
      var endForHours = office ? last : (r.rec.wo ? toMin(r.rec.wo) : null);
      var hours = tl.running ? dur(tl.now - first) + " so far" : (endForHours != null && endForHours > first ? dur(endForHours - first) : "—");
      var steps = [
        ["Swipes found", String(s.length), office
          ? "Biometric swipes" + (r.rec.door ? " at " + esc(r.rec.door) : "") + (between ? ", " + between + " in between (breaks or moving between doors)" : "") + "."
          : (r.rec.mob ? "Mobile" : "Web") + " sign-in" + (tl.hasOut ? " and sign-out" : "") + ". No biometric swipe, so: work from home."],
        [office ? "Check-in" : "Signed in", hm(first), "The first swipe of the day."],
        [lastLabel, lastVal, lastNote],
        ["Hours", hours, tl.running ? "Counted up to now while the day is running." : (office ? "Last swipe minus first swipe." : "Sign-out minus sign-in.")]
      ];
      body = '<div class="wl-tl-wrap">' + tl.svg + "</div>" +
        '<div class="wl-steps">' + steps.map(function (st) {
          return '<div class="wl-step"><h4>' + st[0] + "</h4><b>" + st[1] + "</b><p>" + st[2] + "</p></div>";
        }).join("") + "</div>";
    }

    return '<section class="wl-how" id="wlHow" aria-label="How it works">' +
      '<div class="wl-how-top"><div><p class="eyebrow">How it works</p><h3>' + esc(r.name) + " · " + esc(dayText) +
      ' <span class="wl-chip wl-' + r.cat + '">' + label(CAT_BY[r.cat]) + "</span></h3></div>" + pick + "</div>" +
      body +
      '<div class="wl-rules"><div><h4>Which tile a person lands in</h4><ul>' +
        "<li><b>Biometric swipe</b> at an office door → Work from office</li>" +
        "<li><b>Web or mobile sign-in</b>, no biometric → Work from home</li>" +
        "<li><b>Leave code</b> in GreytHR (CL, SL…) → On leave</li>" +
        "<li><b>Nothing</b> → Absent, or <b>Not signed in yet</b> while today is running</li></ul></div>" +
      "<div><h4>How the times are read</h4><ul>" +
        "<li><b>Check-in</b> is the first swipe of the day</li>" +
        "<li><b>Today</b>, the last swipe so far shows as “still in office”, because a mid-day swipe is usually a break</li>" +
        "<li><b>Past days</b>, the last swipe is the check-out, plus hours worked</li>" +
        "<li><b>One swipe only</b> on a past day → “No check-out recorded”</li></ul></div></div>" +
      "</section>";
  }

  // ---------- render ----------
  function headHtml() {
    var yday = add(TODAY, -1);
    return '<div class="wl-head"><div>' +
        '<p class="eyebrow">Attendance intelligence</p>' +
        "<h2>Work location</h2>" +
        '<p class="wl-sub">From GreytHR swipes. A biometric swipe at an office door means work from office. A web or mobile sign-in with no biometric swipe means work from home.</p>' +
      "</div>" +
      '<div class="wl-days">' +
        '<div class="wl-seg" role="group" aria-label="Quick day">' +
          '<button type="button" data-wl-day="' + TODAY + '" aria-pressed="' + (state.day === TODAY) + '">Today</button>' +
          '<button type="button" data-wl-day="' + yday + '" aria-pressed="' + (state.day === yday) + '">Yesterday</button>' +
        "</div>" +
        '<div class="wl-nav">' +
          '<button type="button" data-wl-step="-1" aria-label="Previous day"' + (state.day <= MIN ? " disabled" : "") + ">‹</button>" +
          '<span class="wl-period">' + esc(fmt(state.day)) + "</span>" +
          '<button type="button" data-wl-step="1" aria-label="Next day"' + (state.day >= TODAY ? " disabled" : "") + ">›</button>" +
        "</div>" +
        '<input class="wl-date" id="wlPick" type="date" aria-label="Pick a date" min="' + MIN + '" max="' + TODAY + '" value="' + state.day + '">' +
      "</div></div>";
  }

  function statusHtml(text, retry) {
    return '<p class="wl-status">' + esc(text) + (retry ? ' <button type="button" data-wl-retry="1">Retry</button>' : "") + "</p>";
  }

  function bodyHtml() {
    if (isWeekend(state.day)) return statusHtml(fmt(state.day) + " is a weekend. Pick a working day.");
    var m = state.day.slice(0, 7), cur = months[m];
    if (cur && cur.status === "loading" && cur.prev) cur = cur.prev; // keep showing progress while re-checking
    if (!cur || (cur.status === "loading" && !cur.payload)) return statusHtml("Loading work location…");
    if (cur.status === "building") {
      var progress = cur.total ? " Fetched " + cur.done + " of " + cur.total + " employees." : "";
      return statusHtml("Fetching swipes from GreytHR for this month. GreytHR is slow, so this takes about a minute the first time; the card updates by itself." + progress);
    }
    if (cur.status === "error") return statusHtml(cur.message, true);

    var payload = cur.payload;
    var rows = rowsFor(payload, state.day);
    var counted = rows.filter(function (r) { return r.cat !== "off"; });
    var offCount = rows.length - counted.length;
    var hasAny = counted.some(function (r) { return r.cat === "office" || r.cat === "wfh" || r.rec.s; });
    if (!hasAny) {
      return statusHtml(state.day === TODAY
        ? "No one has swiped or signed in yet today."
        : "GreytHR has no attendance for " + fmt(state.day) + ". It may be a holiday.");
    }

    var isToday = state.day === TODAY;
    var n = {};
    CATS.forEach(function (c) { n[c.key] = counted.filter(function (r) { return r.cat === c.key; }).length; });
    var total = counted.length || 1;
    var label = function (c) { return isToday && c.todayLabel ? c.todayLabel : c.label; };
    var asOf = "";
    if (isToday && payload.fetchedAt) {
      var f = new Date(payload.fetchedAt);
      if (!isNaN(f)) asOf = " · as of " + pad(f.getHours()) + ":" + pad(f.getMinutes());
    }

    var tiles = '<div class="wl-tiles">' + CATS.map(function (c) {
      return '<button type="button" class="wl-tile wl-' + c.key + '" data-wl-cat="' + c.key + '" aria-pressed="' + (state.filter === c.key) + '">' +
        "<strong>" + n[c.key] + "</strong><span>" + label(c) + "</span><small>" + Math.round(n[c.key] / total * 100) + "% of " + counted.length + (c.key !== "leave" ? asOf : "") + "</small></button>";
    }).join("") + "</div>";
    var bar = '<div class="wl-bar" aria-hidden="true">' + CATS.map(function (c) {
      return n[c.key] ? '<i class="wl-' + c.key + '" style="width:' + (n[c.key] / total * 100) + '%"></i>' : "";
    }).join("") + "</div>";

    var noteText = [
      offCount ? people(offCount) + " on a holiday or weekly off " + (offCount === 1 ? "is" : "are") + " not counted." : "",
      payload.refreshing ? "Updating from GreytHR…" : "",
      (payload.missing || []).length ? "Swipes could not be loaded for " + people(payload.missing.length) + "." : ""
    ].filter(Boolean).join(" ");
    var notes = noteText ? '<div class="wl-note"><span aria-hidden="true">ⓘ</span><span>' + noteText + "</span></div>" : "";

    var q = normKey(state.query);
    var shown = counted.filter(function (r) {
      return (!state.filter || r.cat === state.filter) &&
        (!q || normKey(r.name).indexOf(q) >= 0 || normKey(r.no).indexOf(q) >= 0 || normKey(r.team).indexOf(q) >= 0);
    });
    var order = { office: 0, wfh: 1, absent: 2, leave: 3 };
    shown.sort(function (a, b) { return order[a.cat] - order[b.cat] || a.name.localeCompare(b.name); });
    var visible = state.showAll ? shown : shown.slice(0, PAGE);

    var title = (state.filter ? label(CAT_BY[state.filter]) : "Everyone") + " · " + shown.length;
    var table = '<div class="wl-scroll"><table class="wl-table"><thead><tr>' +
      "<th>Employee</th><th>Team</th><th>How they signed in</th><th>Check-in</th><th>" + (isToday ? "Last swipe" : "Check-out") + "</th><th>Work location</th>" +
      "</tr></thead><tbody>" + visible.map(function (r) {
        return '<tr data-wl-person="' + esc(r.id) + '" class="wl-row' + (r.id === state.person ? " wl-sel" : "") + '">' +
          '<td class="wl-nm"><b>' + esc(r.name) + "</b><small>" + esc(r.no) + "</small></td>" +
          "<td>" + (r.team ? esc(r.team) : '<span class="wl-dim">—</span>') + "</td>" +
          "<td>" + howCell(r) + "</td>" +
          "<td>" + inCell(r) + "</td>" +
          "<td>" + outCell(r) + "</td>" +
          '<td><span class="wl-chip wl-' + r.cat + '">' + label(CAT_BY[r.cat]) + "</span></td></tr>";
      }).join("") + "</tbody></table></div>" +
      (shown.length ? "" : '<p class="wl-status">No one in this group on this day.</p>') +
      (shown.length > visible.length ? '<button type="button" class="wl-more" data-wl-more="1">Show all ' + shown.length + "</button>" : "");

    return tiles + bar + notes +
      '<div class="wl-tools"><h3>' + esc(title) + "</h3>" +
      '<input class="wl-search" id="wlSearch" type="search" placeholder="Search employee or team…" aria-label="Search employee or team" value="' + esc(state.query) + '"></div>' +
      '<div id="wlList">' + table + "</div>" +
      '<p class="wl-hint">Click a row to see how that person’s times were worked out.</p>' +
      howHtml(counted, label);
  }

  function render() {
    var el = root();
    if (!el || !isVisible()) return;
    if (!isWeekend(state.day)) loadMonth(state.day.slice(0, 7), false);
    var search = el.querySelector("#wlSearch");
    var hadFocus = search && document.activeElement === search;
    el.className = "panel wl-card";
    el.innerHTML = headHtml() + bodyHtml();
    bind(el);
    if (hadFocus) { var s = el.querySelector("#wlSearch"); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  }

  function goTo(day) {
    if (!day || day > TODAY || day < MIN) return;
    state.day = day; state.showAll = false;
    safeRender();
  }

  function bind(el) {
    if (bound) return;
    bound = true; // el's children are replaced on every render, so delegate from the stable container
    el.addEventListener("click", function (ev) {
      var row = ev.target.closest("tr[data-wl-person]");
      if (row && el.contains(row)) {
        state.person = row.dataset.wlPerson;
        safeRender();
        var how = root() && root().querySelector("#wlHow");
        if (how && how.scrollIntoView) how.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      var t = ev.target.closest("button");
      if (!t || !el.contains(t)) return;
      if (t.dataset.wlDay) goTo(t.dataset.wlDay);
      else if (t.dataset.wlStep) goTo(add(state.day, +t.dataset.wlStep));
      else if (t.dataset.wlCat) { state.filter = state.filter === t.dataset.wlCat ? null : t.dataset.wlCat; state.showAll = false; safeRender(); }
      else if (t.dataset.wlMore) { state.showAll = true; safeRender(); }
      else if (t.dataset.wlRetry) { loadMonth(state.day.slice(0, 7), true); safeRender(); }
    });
    el.addEventListener("input", function (ev) {
      if (ev.target.id !== "wlSearch") return;
      state.query = ev.target.value; state.showAll = false;
      safeRender();
    });
    el.addEventListener("change", function (ev) {
      if (ev.target.id === "wlPick" && ev.target.value) goTo(ev.target.value);
      else if (ev.target.id === "wlWho") { state.person = ev.target.value; safeRender(); }
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
  function safeRender() { try { render(); } catch (err) { if (window.console) console.warn("Work location card:", err); } }
  window.renderWorkLocationCard = safeRender;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
