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
  var POLL_MS = 15000;

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
  function people(n) { return n + (n === 1 ? " person" : " people"); }
  function normKey(v) { return String(v == null ? "" : v).trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }

  var TODAY = localToday();
  var MIN = add(TODAY, -366);

  var state = { day: TODAY, filter: null, query: "", showAll: false };
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
    months[m] = { status: "loading", payload: cur && cur.payload };
    apiFetch("/api/work-location?month=" + encodeURIComponent(m))
      .then(function (res) {
        if (!res) return null; // apiFetch already redirected to login
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      })
      .then(function (r) {
        if (!r) return;
        var b = r.body || {};
        if (r.ok && b.days) months[m] = { status: "ready", payload: b };
        else if (r.ok && b.building) months[m] = { status: "building", message: b.error };
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
    return '<span class="wl-dim">No swipe' + (rec.s ? " · GreytHR: " + esc(rec.s) : "") + "</span>";
  }

  function timeCell(r, which) {
    var rec = r.rec, office = r.cat === "office";
    if (r.cat !== "office" && r.cat !== "wfh") return '<span class="wl-dim">—</span>';
    var t = office ? (which === "in" ? rec.bi : rec.bo) : (which === "in" ? rec.wi : rec.wo);
    var note = office ? "Biometric" + (rec.door ? " · " + esc(rec.door) : "") : (rec.mob ? "Mobile sign-in" : "Web sign-in");
    if (!t) {
      return state.day === TODAY
        ? '<div class="wl-io"><b class="wl-dim">Not yet</b><small>still ' + (office ? "in office" : "signed in") + "</small></div>"
        : '<div class="wl-io"><b class="wl-dim">—</b><small>no check-out recorded</small></div>';
    }
    return '<div class="wl-io"><b>' + esc(t) + "</b><small>" + note + "</small></div>";
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
    if (!cur || (cur.status === "loading" && !cur.payload)) return statusHtml("Loading work location…");
    if (cur.status === "building") return statusHtml("Fetching swipes from GreytHR for this month. This takes a minute or two the first time; the card updates by itself.");
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

    var tiles = '<div class="wl-tiles">' + CATS.map(function (c) {
      return '<button type="button" class="wl-tile wl-' + c.key + '" data-wl-cat="' + c.key + '" aria-pressed="' + (state.filter === c.key) + '">' +
        "<strong>" + n[c.key] + "</strong><span>" + label(c) + "</span><small>" + Math.round(n[c.key] / total * 100) + "% of " + counted.length + "</small></button>";
    }).join("") + "</div>";
    var bar = '<div class="wl-bar" aria-hidden="true">' + CATS.map(function (c) {
      return n[c.key] ? '<i class="wl-' + c.key + '" style="width:' + (n[c.key] / total * 100) + '%"></i>' : "";
    }).join("") + "</div>";

    var notes = '<div class="wl-note"><span aria-hidden="true">ⓘ</span><span><b>WFH approval is not shown.</b> GreytHR\'s API does not say whether a web sign-in was approved or is pending.' +
      (offCount ? " " + people(offCount) + " on a holiday or weekly off " + (offCount === 1 ? "is" : "are") + " not counted." : "") +
      (payload.refreshing ? " Updating from GreytHR…" : "") +
      ((payload.missing || []).length ? " Swipes could not be loaded for " + people(payload.missing.length) + "." : "") +
      "</span></div>";

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
      "<th>Employee</th><th>Team</th><th>How they signed in</th><th>Check-in</th><th>Check-out</th><th>Work location</th>" +
      "</tr></thead><tbody>" + visible.map(function (r) {
        return "<tr>" +
          '<td class="wl-nm"><b>' + esc(r.name) + "</b><small>" + esc(r.no) + "</small></td>" +
          "<td>" + (r.team ? esc(r.team) : '<span class="wl-dim">—</span>') + "</td>" +
          "<td>" + howCell(r) + "</td>" +
          "<td>" + timeCell(r, "in") + "</td>" +
          "<td>" + timeCell(r, "out") + "</td>" +
          '<td><span class="wl-chip wl-' + r.cat + '">' + label(CAT_BY[r.cat]) + "</span></td></tr>";
      }).join("") + "</tbody></table></div>" +
      (shown.length ? "" : '<p class="wl-status">No one in this group on this day.</p>') +
      (shown.length > visible.length ? '<button type="button" class="wl-more" data-wl-more="1">Show all ' + shown.length + "</button>" : "");

    return tiles + bar + notes +
      '<div class="wl-tools"><h3>' + esc(title) + "</h3>" +
      '<input class="wl-search" id="wlSearch" type="search" placeholder="Search employee or team…" aria-label="Search employee or team" value="' + esc(state.query) + '"></div>' +
      '<div id="wlList">' + table + "</div>";
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
