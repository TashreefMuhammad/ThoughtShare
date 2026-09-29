/* ThoughtShare — board + submission logic
 * Plain JavaScript, no build step. All message text is inserted with
 * textContent (never innerHTML), so a note can never run code.
 */
(function () {
  "use strict";

  // ---------- Config ----------
  var DEFAULTS = {
    siteTitle: "ThoughtShare",
    tagline: "",
    ownerName: "",
    ownerUrl: "",
    submitEndpoint: "",
    dataUrl: "data/messages.json",
    minLength: 5,
    maxLength: 600,
    cooldownSeconds: 60,
    pageSize: 24,
    categories: [],
    defaultCategory: "random"
  };
  var cfg = Object.assign({}, DEFAULTS, window.THOUGHTSHARE_CONFIG || {});
  var CATS = {};
  cfg.categories.forEach(function (c) { CATS[c.id] = c; });
  if (!CATS[cfg.defaultCategory]) {
    CATS[cfg.defaultCategory] = { id: cfg.defaultCategory, label: cap(cfg.defaultCategory), color: "#F1ECE4", ink: "#5E5248" };
    cfg.categories.push(CATS[cfg.defaultCategory]);
  }

  var params = new URLSearchParams(location.search);
  var DEMO = params.has("demo");
  var CLAMP_AT = 320;
  var COOLDOWN_KEY = "thoughtshare:lastSubmit";

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var el = {
    title: $("site-title"), tagline: $("site-tagline"), footerOwner: $("footer-owner"),
    chips: $("chips"), search: $("search"), sort: $("sort"), meta: $("board-meta"),
    board: $("board"), pinned: $("pinned"), pinnedNotes: $("pinned-notes"), notes: $("notes"),
    empty: $("empty"), emptyTitle: $("empty-title"), emptyText: $("empty-text"), more: $("show-more"),
    compose: $("compose"), form: $("compose-form"), message: $("message"), counter: $("counter"),
    catPicker: $("cat-picker"), website: $("website"), submit: $("submit"), status: $("status"),
    closedNote: $("closed-note"), openCompose: $("open-compose"),
    reader: $("reader"), readerBody: $("reader-body"), readerText: $("reader-text"),
    readerTag: $("reader-tag"), readerDate: $("reader-date")
  };

  // ---------- State ----------
  var state = {
    all: [],
    updated: null,
    filter: "all",
    query: "",
    sort: "newest",
    shown: cfg.pageSize,
    shuffleKey: {},
    openedAt: Date.now()
  };

  // ---------- Utilities ----------
  function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function hash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function parseDate(v) {
    if (!v) return null;
    var d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + "T12:00:00") : new Date(v);
    return isNaN(d) ? null : d;
  }
  var dateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
  function fmtDate(d) { return d ? dateFmt.format(d) : ""; }
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function catOf(id) { return CATS[id] || CATS[cfg.defaultCategory]; }
  function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ---------- Branding ----------
  document.title = cfg.siteTitle;
  el.title.textContent = cfg.siteTitle;
  el.tagline.textContent = cfg.tagline;
  if (cfg.ownerName) {
    el.footerOwner.textContent = "A board kept by ";
    var a = node(cfg.ownerUrl ? "a" : "span", null, cfg.ownerName);
    if (cfg.ownerUrl) { a.href = cfg.ownerUrl; a.rel = "noopener"; }
    el.footerOwner.appendChild(a);
    el.footerOwner.appendChild(document.createTextNode(" · Built with ThoughtShare"));
  } else {
    el.footerOwner.textContent = "Built with ThoughtShare";
  }

  // ---------- Loading ----------
  function showSkeletons() {
    el.notes.textContent = "";
    [150, 220, 130, 190, 170, 240, 140, 200].forEach(function (h) {
      var s = node("div", "skeleton");
      s.style.setProperty("--h", h + "px");
      el.notes.appendChild(s);
    });
  }

  function normalize(raw) {
    var list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.messages) ? raw.messages : []);
    var seen = {};
    return list.map(function (m, i) {
      if (!m || typeof m.text !== "string") return null;
      var text = m.text.trim();
      if (!text) return null;
      var id = String(m.id || ("n-" + i));
      if (seen[id]) id = id + "-" + i;
      seen[id] = true;
      var cat = typeof m.category === "string" ? m.category.toLowerCase().trim() : "";
      return {
        id: id,
        text: text,
        category: CATS[cat] ? cat : cfg.defaultCategory,
        date: parseDate(m.date),
        featured: m.featured === true || m.featured === "true",
        order: i
      };
    }).filter(Boolean);
  }

  function load() {
    showSkeletons();
    var url = DEMO ? "data/messages.example.json" : cfg.dataUrl;
    fetch(url, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (json) {
        state.all = normalize(json);
        state.updated = parseDate(json && json.updated);
        buildChips();
        readHash();
        render();
      })
      .catch(function (err) {
        console.error("ThoughtShare: could not load messages", err);
        el.notes.textContent = "";
        el.chips.textContent = "";
        showEmpty("The board couldn't be loaded", "Please refresh in a moment. If you run this board, check that " + url + " is valid JSON.");
        el.meta.textContent = "";
      });
  }

  // ---------- Filters ----------
  function counts() {
    var c = { all: state.all.length };
    state.all.forEach(function (m) { c[m.category] = (c[m.category] || 0) + 1; });
    return c;
  }

  function buildChips() {
    var c = counts();
    el.chips.textContent = "";
    el.chips.appendChild(makeChip("all", "All", c.all, null));
    cfg.categories.forEach(function (cat) {
      if (!c[cat.id]) return; // hide empty categories on the board
      el.chips.appendChild(makeChip(cat.id, cat.label, c[cat.id], cat));
    });
    syncChips();
  }

  function makeChip(id, label, count, cat) {
    var b = node("button", "chip" + (id === "all" ? " chip--all" : ""));
    b.type = "button";
    b.dataset.cat = id;
    if (cat) {
      b.style.setProperty("--chip-bg", cat.color);
      b.style.setProperty("--chip-ink", cat.ink);
      b.appendChild(node("span", "chip__dot"));
    }
    b.appendChild(node("span", null, label));
    b.appendChild(node("span", "chip__count", String(count)));
    b.addEventListener("click", function () { setFilter(id); });
    return b;
  }

  function syncChips() {
    Array.prototype.forEach.call(el.chips.children, function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.cat === state.filter));
    });
  }

  function setFilter(id, fromHash) {
    state.filter = id === "all" || CATS[id] ? id : "all";
    state.shown = cfg.pageSize;
    syncChips();
    if (!fromHash) {
      var h = state.filter === "all" ? "" : "#cat=" + state.filter;
      history.replaceState(null, "", location.pathname + location.search + h);
    }
    render();
  }

  function readHash() {
    var m = /cat=([a-z0-9_-]+)/i.exec(location.hash);
    state.filter = m && CATS[m[1].toLowerCase()] ? m[1].toLowerCase() : "all";
    syncChips();
  }

  function reshuffle() {
    state.shuffleKey = {};
    state.all.forEach(function (m) { state.shuffleKey[m.id] = Math.random(); });
  }

  function visible() {
    var q = state.query.toLowerCase();
    var list = state.all.filter(function (m) {
      if (state.filter !== "all" && m.category !== state.filter) return false;
      if (q && m.text.toLowerCase().indexOf(q) === -1 && catOf(m.category).label.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    var time = function (m) { return m.date ? m.date.getTime() : 0; };
    if (state.sort === "shuffle") {
      list.sort(function (a, b) { return state.shuffleKey[a.id] - state.shuffleKey[b.id]; });
    } else {
      var dir = state.sort === "oldest" ? 1 : -1;
      // Newest first by date; ties broken by position in the JSON (later = newer)
      list.sort(function (a, b) { return dir * ((time(a) - time(b)) || (a.order - b.order)); });
    }
    return list;
  }

  // ---------- Rendering ----------
  var PIN_COLORS = ["red", "red", "blue", "green"]; // gold is reserved for featured notes

  function noteEl(m, index) {
    var cat = catOf(m.category);
    var h = hash(m.id);
    var art = node("article", "note" + (m.featured ? " note--featured" : ""));
    art.tabIndex = 0;
    art.setAttribute("role", "button");
    art.setAttribute("aria-label", cat.label + " thought: " + m.text.slice(0, 80) + (m.text.length > 80 ? "…" : ""));
    art.style.setProperty("--note-bg", cat.color);
    art.style.setProperty("--note-ink", cat.ink);
    art.style.setProperty("--tilt", (((h % 45) / 10) - 2.2).toFixed(1) + "deg");
    art.style.setProperty("--delay", Math.min(index, 12) * 40 + "ms");
    if (h % 5 === 0) art.classList.add("note--tape");
    art.dataset.pin = m.featured ? "gold" : PIN_COLORS[(h >>> 3) % PIN_COLORS.length];

    art.appendChild(node("span", "note__pin"));
    var long = m.text.length > CLAMP_AT;
    art.appendChild(node("p", "note__text" + (long ? " note__text--clamp" : ""), m.text));
    if (long) art.appendChild(node("p", "note__more", "Read the whole note →"));

    var foot = node("footer", "note__foot");
    foot.appendChild(node("span", "tag", cat.label));
    if (m.date) {
      var t = node("time", null, fmtDate(m.date));
      t.dateTime = m.date.toISOString().slice(0, 10);
      foot.appendChild(t);
    }
    art.appendChild(foot);

    var open = function () { openReader(m); };
    art.addEventListener("click", open);
    art.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    return art;
  }

  function showEmpty(title, text) {
    el.emptyTitle.textContent = title;
    el.emptyText.textContent = text;
    el.empty.hidden = false;
  }

  function render() {
    var list = visible();
    var featured = list.filter(function (m) { return m.featured; });
    var rest = list.filter(function (m) { return !m.featured; });

    el.pinnedNotes.textContent = "";
    el.pinned.hidden = featured.length === 0;
    featured.forEach(function (m, i) { el.pinnedNotes.appendChild(noteEl(m, i)); });

    el.notes.textContent = "";
    var page = rest.slice(0, state.shown);
    var frag = document.createDocumentFragment();
    page.forEach(function (m, i) { frag.appendChild(noteEl(m, i)); });
    el.notes.appendChild(frag);

    el.more.hidden = rest.length <= state.shown;
    if (!el.more.hidden) el.more.textContent = "Show more (" + (rest.length - state.shown) + " left)";

    el.empty.hidden = true;
    if (state.all.length === 0) {
      showEmpty("The board is empty", "No thoughts have been pinned yet. Yours could be the first.");
    } else if (list.length === 0) {
      showEmpty("Nothing matches", state.query ? "No notes contain “" + state.query + "”." : "No notes in this category yet.");
    }

    var total = state.all.length;
    var parts = [];
    if (total) {
      var showing = featured.length + page.length;
      parts.push(list.length === total && showing === total
        ? total + (total === 1 ? " thought pinned" : " thoughts pinned")
        : "Showing " + showing + " of " + list.length + (list.length === total ? "" : " matching") + " · " + total + " in total");
    }
    if (state.updated) parts.push("Updated " + fmtDate(state.updated));
    if (DEMO) parts.push("Demo data");
    el.meta.textContent = parts.join(" · ");
  }

  el.more.addEventListener("click", function () {
    state.shown += cfg.pageSize;
    render();
  });

  var searchTimer;
  el.search.addEventListener("input", function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = el.search.value.trim();
      state.shown = cfg.pageSize;
      render();
    }, 150);
  });

  el.sort.addEventListener("change", function () {
    state.sort = el.sort.value;
    if (state.sort === "shuffle") reshuffle();
    render();
  });

  window.addEventListener("hashchange", function () { readHash(); state.shown = cfg.pageSize; render(); });

  // ---------- Dialog helpers ----------
  function openDialog(d) {
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }
  function closeDialog(d) {
    if (typeof d.close === "function") d.close();
    else d.removeAttribute("open");
  }
  [el.compose, el.reader].forEach(function (d) {
    d.addEventListener("click", function (e) {
      if (e.target === d) closeDialog(d); // backdrop click
      if (e.target.closest("[data-close]")) closeDialog(d);
    });
  });

  function openReader(m) {
    var cat = catOf(m.category);
    el.readerBody.style.setProperty("--note-bg", cat.color);
    el.readerBody.style.setProperty("--note-ink", cat.ink);
    el.readerText.textContent = m.text;
    el.readerTag.textContent = cat.label;
    el.readerDate.textContent = fmtDate(m.date);
    if (m.date) el.readerDate.dateTime = m.date.toISOString().slice(0, 10);
    openDialog(el.reader);
  }

  // ---------- Compose ----------
  // https only (plus http://localhost for local testing)
  var endpointOk = /^(https:\/\/\S+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*)$/.test(String(cfg.submitEndpoint || "").trim());

  function buildPicker() {
    el.catPicker.textContent = "";
    var options = [{ id: "", label: "Let the moderator decide" }].concat(cfg.categories);
    options.forEach(function (c, i) {
      var input = node("input");
      input.type = "radio";
      input.name = "category";
      input.value = c.id;
      input.id = "cat-" + (c.id || "none");
      if (i === 0) input.checked = true;
      var label = node("label");
      label.htmlFor = input.id;
      if (c.color) {
        label.style.setProperty("--chip-bg", c.color);
        label.style.setProperty("--chip-ink", c.ink);
        label.appendChild(node("span", "chip__dot"));
      }
      label.appendChild(document.createTextNode(c.label));
      el.catPicker.appendChild(input);
      el.catPicker.appendChild(label);
    });
  }

  function updateCounter() {
    var n = el.message.value.length;
    el.counter.textContent = n + " / " + cfg.maxLength;
    el.counter.classList.toggle("counter--warn", n > cfg.maxLength * 0.9 && n <= cfg.maxLength);
    el.counter.classList.toggle("counter--over", n > cfg.maxLength);
  }

  function setStatus(msg, kind) {
    el.status.textContent = msg;
    el.status.className = "status" + (kind ? " status--" + kind : "");
  }

  function cooldownLeft() {
    var last = parseInt(storageGet(COOLDOWN_KEY) || "0", 10);
    var left = Math.ceil((last + cfg.cooldownSeconds * 1000 - Date.now()) / 1000);
    return left > 0 ? left : 0;
  }

  function openCompose() {
    setStatus("");
    el.closedNote.hidden = endpointOk;
    el.submit.disabled = !endpointOk;
    openDialog(el.compose);
    if (endpointOk) setTimeout(function () { el.message.focus(); }, 50);
  }

  el.openCompose.addEventListener("click", openCompose);
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-open-compose]")) openCompose();
  });
  el.message.addEventListener("input", function () {
    updateCounter();
    if (el.status.classList.contains("status--err")) setStatus("");
  });

  el.form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (!endpointOk) return;

    var text = el.message.value.trim();
    var picked = el.form.querySelector('input[name="category"]:checked');
    var category = picked ? picked.value : "";

    if (text.length < cfg.minLength) { setStatus("Write a little more — at least " + cfg.minLength + " characters.", "err"); el.message.focus(); return; }
    if (text.length > cfg.maxLength) { setStatus("That's " + (text.length - cfg.maxLength) + " characters over the limit.", "err"); el.message.focus(); return; }
    var wait = cooldownLeft();
    if (wait) { setStatus("Thanks for sharing! You can send another in " + wait + "s.", "err"); return; }

    // Bots fill the honeypot or submit instantly. Pretend success, send nothing.
    if (el.website.value || Date.now() - state.openedAt < 2500) {
      done();
      return;
    }

    el.submit.disabled = true;
    el.submit.textContent = "Sending…";
    setStatus("");

    var body = new URLSearchParams();
    body.set("message", text);
    body.set("category", category);
    body.set("website", el.website.value);

    // A form-encoded POST is a "simple" CORS request: no preflight, works with Apps Script.
    fetch(cfg.submitEndpoint.trim(), { method: "POST", body: body, redirect: "follow" })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (res) {
        if (res && res.ok) done();
        else fail(res && res.error ? res.error : "The board didn't accept that. Please try again.");
      })
      .catch(function () { fail("Couldn't reach the board. Check your connection and try again."); })
      .finally(function () {
        el.submit.disabled = false;
        el.submit.textContent = "Send for review";
      });
  });

  function done() {
    storageSet(COOLDOWN_KEY, String(Date.now()));
    el.form.reset();
    buildPicker();
    updateCounter();
    setStatus("Sent. Thank you. If it's approved, it'll be pinned here soon.", "ok");
  }
  function fail(msg) { setStatus(msg, "err"); }

  // ---------- Start ----------
  el.message.maxLength = cfg.maxLength + 200; // soft cap; counter shows the real limit
  buildPicker();
  updateCounter();
  load();
})();
