/* ThoughtShare — board, threads and submission logic
 * Plain JavaScript, no build step. All message text is inserted with
 * textContent (never innerHTML), so a note or reply can never run code.
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
    allowReplies: true,
    replyMaxLength: 400,
    moderatorLabel: "Moderator",
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
  var NOTE_COOLDOWN_KEY = "thoughtshare:lastSubmit";
  var REPLY_COOLDOWN_KEY = "thoughtshare:lastReply";

  // https only (plus http://localhost for local testing)
  var endpointOk = /^(https:\/\/\S+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\S*)$/.test(String(cfg.submitEndpoint || "").trim());

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
    readerTag: $("reader-tag"), readerDate: $("reader-date"),
    thread: $("thread"), threadTitle: $("thread-title"), threadList: $("thread-list"), threadEmpty: $("thread-empty"),
    replyForm: $("reply-form"), replyMessage: $("reply-message"), replyCounter: $("reply-counter"),
    replyWebsite: $("reply-website"), replySubmit: $("reply-submit"), replyStatus: $("reply-status")
  };

  // ---------- State ----------
  var state = {
    all: [],
    byId: {},
    updated: null,
    filter: "all",
    query: "",
    sort: "newest",
    shown: cfg.pageSize,
    shuffleKey: {},
    current: null,          // note open in the thread view
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
  function isoDay(d) { return d ? d.toISOString().slice(0, 10) : ""; }
  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(pathD, size) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size || 14);
    svg.setAttribute("height", size || 14);
    svg.setAttribute("aria-hidden", "true");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", pathD);
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "2");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    svg.appendChild(p);
    return svg;
  }
  var ICON_BUBBLE = "M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z";
  var ICON_CHECK = "M5 12.5l4.5 4.5L19 7.5";
  function catOf(id) { return CATS[id] || CATS[cfg.defaultCategory]; }
  function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

  // Hash holds shareable state: #cat=hope&t=t-260929-0ad8b
  function readHashParams() { return new URLSearchParams(location.hash.replace(/^#/, "")); }
  function writeHashParams(p) {
    var s = p.toString();
    history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : ""));
  }
  function setHashKey(key, value) {
    var p = readHashParams();
    if (value) p.set(key, value); else p.delete(key);
    writeHashParams(p);
  }

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

  function normalizeReplies(list, parentId) {
    if (!Array.isArray(list)) return [];
    return list.map(function (r, i) {
      if (!r || typeof r.text !== "string" || !r.text.trim()) return null;
      return {
        id: String(r.id || (parentId + "-r" + i)),
        text: r.text.trim(),
        date: parseDate(r.date),
        fromOwner: r.fromOwner === true || r.fromOwner === "true",
        order: i
      };
    }).filter(Boolean).sort(function (a, b) {
      var ta = a.date ? a.date.getTime() : 0, tb = b.date ? b.date.getTime() : 0;
      return (ta - tb) || (a.order - b.order);
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
      var reply = typeof m.reply === "string" ? m.reply.trim() : "";
      var replies = normalizeReplies(m.replies, id);
      return {
        id: id,
        text: text,
        category: CATS[cat] ? cat : cfg.defaultCategory,
        date: parseDate(m.date),
        featured: m.featured === true || m.featured === "true",
        reply: reply,
        replies: replies,
        talk: (reply ? 1 : 0) + replies.length,
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
        state.byId = {};
        state.all.forEach(function (m) { state.byId[m.id] = m; });
        state.updated = parseDate(json && json.updated);
        buildChips();
        applyHash();
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

  function setFilter(id) {
    state.filter = id === "all" || CATS[id] ? id : "all";
    state.shown = cfg.pageSize;
    syncChips();
    setHashKey("cat", state.filter === "all" ? "" : state.filter);
    render();
  }

  function applyHash() {
    var p = readHashParams();
    // Old links used "#cat=x" only — URLSearchParams reads those too.
    var cat = (p.get("cat") || "").toLowerCase();
    state.filter = CATS[cat] ? cat : "all";
    syncChips();
    var t = p.get("t");
    if (t && state.byId[t]) {
      if (!state.current || state.current.id !== t) openReader(state.byId[t]);
    } else if (!t && el.reader.open) {
      closeDialog(el.reader);
    }
  }

  function reshuffle() {
    state.shuffleKey = {};
    state.all.forEach(function (m) { state.shuffleKey[m.id] = Math.random(); });
  }

  function matches(m, q) {
    if (!q) return true;
    if (m.text.toLowerCase().indexOf(q) !== -1) return true;
    if (catOf(m.category).label.toLowerCase().indexOf(q) !== -1) return true;
    if (m.reply && m.reply.toLowerCase().indexOf(q) !== -1) return true;
    return m.replies.some(function (r) { return r.text.toLowerCase().indexOf(q) !== -1; });
  }

  function visible() {
    var q = state.query.toLowerCase();
    var list = state.all.filter(function (m) {
      if (state.filter !== "all" && m.category !== state.filter) return false;
      return matches(m, q);
    });
    var time = function (m) { return m.date ? m.date.getTime() : 0; };
    if (state.sort === "shuffle") {
      list.sort(function (a, b) { return state.shuffleKey[a.id] - state.shuffleKey[b.id]; });
    } else if (state.sort === "active") {
      list.sort(function (a, b) { return (b.talk - a.talk) || ((time(b) - time(a)) || (b.order - a.order)); });
    } else {
      var dir = state.sort === "oldest" ? 1 : -1;
      // Newest first by date; ties broken by position in the JSON
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
    var label = cat.label + " thought: " + m.text.slice(0, 80) + (m.text.length > 80 ? "…" : "");
    if (m.talk) label += ". " + plural(m.talk, "reply", "replies");
    art.setAttribute("aria-label", label);
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

    if (m.reply) {
      var ans = node("div", "note__answer");
      var who = node("span", "note__answer-who");
      who.appendChild(icon(ICON_CHECK, 12));
      who.appendChild(document.createTextNode(cfg.moderatorLabel));
      ans.appendChild(who);
      ans.appendChild(node("p", "note__answer-text", m.reply));
      art.appendChild(ans);
    }

    var foot = node("footer", "note__foot");
    foot.appendChild(node("span", "tag", cat.label));
    var right = node("span", "note__meta");
    if (m.replies.length) {
      var talk = node("span", "note__talk");
      talk.appendChild(icon(ICON_BUBBLE, 13));
      talk.appendChild(document.createTextNode(String(m.replies.length)));
      talk.title = plural(m.replies.length, "reply", "replies");
      right.appendChild(talk);
    }
    if (m.date) {
      var t = node("time", null, fmtDate(m.date));
      t.dateTime = isoDay(m.date);
      right.appendChild(t);
    }
    foot.appendChild(right);
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

  window.addEventListener("hashchange", function () {
    if (!state.all.length) return;
    applyHash();
    state.shown = cfg.pageSize;
    render();
  });

  // ---------- Dialog helpers ----------
  function openDialog(d) {
    if (d.open) return;
    if (typeof d.showModal === "function") d.showModal();
    else d.setAttribute("open", "");
  }
  function closeDialog(d) {
    if (typeof d.close === "function") d.close();
    else { d.removeAttribute("open"); d.dispatchEvent(new Event("close")); }
  }
  [el.compose, el.reader].forEach(function (d) {
    d.addEventListener("click", function (e) {
      if (e.target === d) closeDialog(d); // backdrop click
      if (e.target.closest("[data-close]")) closeDialog(d);
    });
  });
  el.reader.addEventListener("close", function () {
    state.current = null;
    setHashKey("t", "");
  });

  // ---------- Thread view ----------
  function entryEl(text, date, fromOwner) {
    var li = node("li", "entry" + (fromOwner ? " entry--owner" : ""));
    var head = node("div", "entry__head");
    var who = node("span", "entry__who");
    if (fromOwner) who.appendChild(icon(ICON_CHECK, 12));
    who.appendChild(document.createTextNode(fromOwner ? cfg.moderatorLabel : "Anonymous"));
    head.appendChild(who);
    if (date) {
      var t = node("time", null, fmtDate(date));
      t.dateTime = isoDay(date);
      head.appendChild(t);
    }
    li.appendChild(head);
    li.appendChild(node("p", "entry__text", text));
    return li;
  }

  function renderThread(m) {
    el.threadList.textContent = "";
    if (m.reply) el.threadList.appendChild(entryEl(m.reply, null, true));
    m.replies.forEach(function (r) { el.threadList.appendChild(entryEl(r.text, r.date, r.fromOwner)); });
    el.threadTitle.textContent = m.talk ? plural(m.talk, "reply", "replies") : "Replies";
    el.threadEmpty.hidden = m.talk > 0;
    el.threadEmpty.textContent = cfg.allowReplies ? "No replies yet. Start the conversation." : "No replies yet.";

    var canReply = cfg.allowReplies && endpointOk;
    el.replyForm.hidden = !canReply;
    el.thread.hidden = !cfg.allowReplies && !m.talk;
  }

  function openReader(m) {
    state.current = m;
    var cat = catOf(m.category);
    el.readerBody.style.setProperty("--note-bg", cat.color);
    el.readerBody.style.setProperty("--note-ink", cat.ink);
    el.readerText.textContent = m.text;
    el.readerTag.textContent = cat.label;
    el.readerDate.textContent = fmtDate(m.date);
    el.readerDate.dateTime = isoDay(m.date);
    renderThread(m);
    el.replyForm.reset();
    setReplyStatus("");
    updateReplyCounter();
    setHashKey("t", m.id);
    openDialog(el.reader);
    el.reader.scrollTop = 0;
  }

  // ---------- Shared submission ----------
  function cooldownLeft(key) {
    var last = parseInt(storageGet(key) || "0", 10);
    var left = Math.ceil((last + cfg.cooldownSeconds * 1000 - Date.now()) / 1000);
    return left > 0 ? left : 0;
  }

  // A form-encoded POST is a "simple" CORS request: no preflight, works with Apps Script.
  function send(fields) {
    var body = new URLSearchParams();
    Object.keys(fields).forEach(function (k) { body.set(k, fields[k]); });
    return fetch(cfg.submitEndpoint.trim(), { method: "POST", body: body, redirect: "follow" })
      .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
      .then(function (res) {
        if (res && res.ok) return res;
        throw new Error(res && res.error ? res.error : "The board didn't accept that. Please try again.");
      }, function () {
        throw new Error("Couldn't reach the board. Check your connection and try again.");
      });
  }

  function looksLikeBot(honeypot) {
    return !!honeypot.value || Date.now() - state.openedAt < 2500;
  }

  function counter(input, out, limit) {
    var n = input.value.length;
    out.textContent = n + " / " + limit;
    out.classList.toggle("counter--warn", n > limit * 0.9 && n <= limit);
    out.classList.toggle("counter--over", n > limit);
  }

  // ---------- Compose a note ----------
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

  function updateCounter() { counter(el.message, el.counter, cfg.maxLength); }
  function setStatus(msg, kind) {
    el.status.textContent = msg;
    el.status.className = "status" + (kind ? " status--" + kind : "");
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
    var wait = cooldownLeft(NOTE_COOLDOWN_KEY);
    if (wait) { setStatus("Thanks for sharing! You can send another in " + wait + "s.", "err"); return; }

    // Bots fill the honeypot or submit instantly. Pretend success, send nothing.
    if (looksLikeBot(el.website)) { noteDone(); return; }

    el.submit.disabled = true;
    el.submit.textContent = "Sending…";
    setStatus("");

    send({ message: text, category: category, website: el.website.value })
      .then(noteDone, function (err) { setStatus(err.message, "err"); })
      .finally(function () {
        el.submit.disabled = false;
        el.submit.textContent = "Send for review";
      });
  });

  function noteDone() {
    storageSet(NOTE_COOLDOWN_KEY, String(Date.now()));
    el.form.reset();
    buildPicker();
    updateCounter();
    setStatus("Sent. Thank you. If it's approved, it'll be pinned here soon.", "ok");
  }

  // ---------- Reply to a thread ----------
  function updateReplyCounter() { counter(el.replyMessage, el.replyCounter, cfg.replyMaxLength); }
  function setReplyStatus(msg, kind) {
    el.replyStatus.textContent = msg;
    el.replyStatus.className = "status" + (kind ? " status--" + kind : "");
  }

  el.replyMessage.addEventListener("input", function () {
    updateReplyCounter();
    if (el.replyStatus.classList.contains("status--err")) setReplyStatus("");
  });

  el.replyForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var m = state.current;
    if (!m || !endpointOk || !cfg.allowReplies) return;

    var text = el.replyMessage.value.trim();
    if (text.length < cfg.minLength) { setReplyStatus("Write a little more — at least " + cfg.minLength + " characters.", "err"); el.replyMessage.focus(); return; }
    if (text.length > cfg.replyMaxLength) { setReplyStatus("That's " + (text.length - cfg.replyMaxLength) + " characters over the limit.", "err"); el.replyMessage.focus(); return; }
    var wait = cooldownLeft(REPLY_COOLDOWN_KEY);
    if (wait) { setReplyStatus("Thanks! You can reply again in " + wait + "s.", "err"); return; }

    if (looksLikeBot(el.replyWebsite)) { replyDone(); return; }

    el.replySubmit.disabled = true;
    el.replySubmit.textContent = "Sending…";
    setReplyStatus("");

    send({ message: text, parentId: m.id, website: el.replyWebsite.value })
      .then(replyDone, function (err) { setReplyStatus(err.message, "err"); })
      .finally(function () {
        el.replySubmit.disabled = false;
        el.replySubmit.textContent = "Send reply for review";
      });
  });

  function replyDone() {
    storageSet(REPLY_COOLDOWN_KEY, String(Date.now()));
    el.replyForm.reset();
    updateReplyCounter();
    setReplyStatus("Sent for review. If it's approved, it'll appear in this thread.", "ok");
  }

  // ---------- Start ----------
  el.message.maxLength = cfg.maxLength + 200;          // soft cap; counter shows the real limit
  el.replyMessage.maxLength = cfg.replyMaxLength + 200;
  if (!cfg.allowReplies) {
    var opt = el.sort.querySelector('option[value="active"]');
    if (opt) opt.remove();
  }
  buildPicker();
  updateCounter();
  load();
})();
