/**
 * ThoughtShare — Google Apps Script backend
 * =========================================
 * Paste this whole file into Extensions → Apps Script of a Google Sheet
 * (the sheet becomes your private inbox + moderation dashboard).
 *
 * What it does
 *   • doPost  – receives anonymous notes and anonymous replies from the website.
 *               Notes go to the "Submissions" tab, replies to the "Replies" tab.
 *               Nothing about the sender is stored.
 *   • doGet   – returns ONLY approved content as JSON, and only when called
 *               with your secret sync key (used by the optional GitHub Action).
 *   • Menu    – "ThoughtShare" menu in the sheet: set up, export approved JSON,
 *               manage the sync key.
 *
 * Deploy: Deploy → New deployment → Web app
 *         Execute as: Me   |   Who has access: Anyone
 * After changing this file: Deploy → Manage deployments → ✏️ → Version: New version.
 * Full walkthrough: see README.md in the repository.
 */

// ---------------------------------------------------------------------------
// Settings — keep CATEGORIES in sync with config.js on the website
// ---------------------------------------------------------------------------
var CATEGORIES = ['gratitude', 'confession', 'advice', 'rant', 'hope', 'random'];
var DEFAULT_CATEGORY = 'random';
var SHEET_NAME = 'Submissions';
var REPLIES_SHEET = 'Replies';
var MIN_LENGTH = 5;
var MAX_LENGTH = 600;              // should match maxLength in config.js
var ALLOW_REPLIES = true;          // should match allowReplies in config.js
var REPLY_MAX_LENGTH = 400;        // should match replyMaxLength in config.js
var MAX_PER_10_MIN = 40;           // whole-board flood limit, notes + replies (no per-person data is kept)
var DUPLICATE_WINDOW_HOURS = 6;    // identical text is ignored inside this window
var INCLUDE_DATES = true;          // put the day a note/reply was received into the public JSON

// Submissions tab (1-based). Only ever ADD columns at the end — existing sheets keep working.
var COL = { ID: 1, RECEIVED: 2, MESSAGE: 3, SUGGESTED: 4, CATEGORY: 5, APPROVED: 6, FEATURED: 7, NOTES: 8, REPLY: 9 };
var HEADERS = ['ID', 'Received', 'Message', 'Suggested category', 'Category (final)', 'Approved', 'Featured', 'Private notes', 'My reply'];

// Replies tab (1-based). Column H shows the note being replied to (formula, read-only).
var RCOL = { ID: 1, RECEIVED: 2, THREAD: 3, MESSAGE: 4, FROM_ME: 5, APPROVED: 6, NOTES: 7, CONTEXT: 8 };
var R_HEADERS = ['ID', 'Received', 'Thread ID', 'Message', 'From me', 'Approved', 'Private notes'];

// ---------------------------------------------------------------------------
// Web endpoints
// ---------------------------------------------------------------------------
function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // Honeypot: real visitors never fill this field. Say "ok" so bots learn nothing.
    if (p.website) return json_({ ok: true });

    var parentId = String(p.parentId || '').trim();
    var isReply = parentId !== '';
    if (isReply && !ALLOW_REPLIES) return json_({ ok: false, error: 'Replies are turned off on this board.' });

    var limit = isReply ? REPLY_MAX_LENGTH : MAX_LENGTH;
    var text = clean_(p.message);
    if (text.length < MIN_LENGTH) return json_({ ok: false, error: 'Please write at least ' + MIN_LENGTH + ' characters.' });
    if (text.length > limit) return json_({ ok: false, error: 'Please keep it under ' + limit + ' characters.' });

    var cache = CacheService.getScriptCache();

    // Board-wide flood control (10-minute buckets)
    var bucket = 'rate:' + Math.floor(Date.now() / 600000);
    var count = parseInt(cache.get(bucket) || '0', 10);
    if (count >= MAX_PER_10_MIN) {
      return json_({ ok: false, error: 'The board is getting a lot of notes right now. Please try again in a few minutes.' });
    }

    // Duplicate suppression (same text in the same place, recently)
    var digest = 'dup:' + sha_(parentId + '|' + text.toLowerCase().replace(/\s+/g, ' '));
    if (cache.get(digest)) return json_({ ok: true });

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return json_({ ok: false, error: 'Busy — please try again.' });
    try {
      if (isReply) {
        // Only approved notes can be replied to — hidden or made-up IDs are refused.
        if (!approvedIds_()[parentId]) {
          return json_({ ok: false, error: "This thread isn't open for replies." });
        }
        var rs = repliesSheet_();
        var rrow = nextRow_(rs, RCOL.ID, RCOL.MESSAGE, formatReplyRows_);
        rs.getRange(rrow, 1, 1, R_HEADERS.length).setValues([[
          newId_('r'),
          new Date(),
          parentId,
          safeCell_(text),
          false,       // From me
          false,       // Approved
          ''
        ]]);
      } else {
        var suggested = String(p.category || '').toLowerCase().trim();
        if (CATEGORIES.indexOf(suggested) === -1) suggested = '';
        var sheet = sheet_();
        // Not appendRow(): pre-formatted rows count as "content" and appendRow would
        // write below all of them. Use the first row with no ID and no message instead.
        var row = nextRow_(sheet, COL.ID, COL.MESSAGE, formatRows_);
        sheet.getRange(row, 1, 1, HEADERS.length).setValues([[
          newId_('t'),
          new Date(),
          safeCell_(text),
          suggested,
          '',          // Category (final) — you fill this while reviewing
          false,       // Approved
          false,       // Featured
          '',          // Private notes
          ''           // My reply
        ]]);
      }
    } finally {
      lock.releaseLock();
    }

    cache.put(bucket, String(count + 1), 660);
    cache.put(digest, '1', DUPLICATE_WINDOW_HOURS * 3600);
    return json_({ ok: true });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'Something went wrong on the board. Please try again later.' });
  }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'export') {
    var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY');
    if (!key || p.key !== key) return json_({ ok: false, error: 'Not allowed.' });
    return json_(buildExport_());
  }
  // Public status check — reveals nothing about submissions.
  return json_({ ok: true, service: 'ThoughtShare', accepting: true, replies: ALLOW_REPLIES });
}

// ---------------------------------------------------------------------------
// Sheet menu + helpers for you
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('ThoughtShare')
    .addItem('Set up / repair sheet', 'setupSheet')
    .addSeparator()
    .addItem('Export approved as JSON', 'showExport')
    .addSeparator()
    .addItem('Show sync key (for GitHub Action)', 'showSyncKey')
    .addItem('Create a new sync key', 'rotateSyncKey')
    .addToUi();
}

// When YOU type a message into the Replies tab, fill in its ID and time automatically.
function onEdit(e) {
  try {
    var range = e && e.range;
    if (!range) return;
    var sh = range.getSheet();
    if (sh.getName() !== REPLIES_SHEET || range.getRow() < 2) return;
    var first = range.getRow(), rows = range.getNumRows();
    for (var r = first; r < first + rows; r++) {
      var vals = sh.getRange(r, 1, 1, R_HEADERS.length).getValues()[0];
      var hasText = String(vals[RCOL.MESSAGE - 1] || '').trim() !== '';
      if (hasText && !vals[RCOL.ID - 1]) sh.getRange(r, RCOL.ID).setValue(newId_('r'));
      if (hasText && !(vals[RCOL.RECEIVED - 1] instanceof Date)) sh.getRange(r, RCOL.RECEIVED).setValue(new Date());
    }
  } catch (err) {
    console.error(err);
  }
}

// Safe to run any time: it never deletes or changes your rows, ticks or replies.
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    var first = ss.getSheets()[0];
    // Reuse a blank first tab, otherwise add a new one
    sheet = (first.getLastRow() === 0) ? first.setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getMaxColumns() < HEADERS.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEADERS.length - sheet.getMaxColumns());

  styleHeader_(sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]));
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(COL.ID, 130);
  sheet.setColumnWidth(COL.RECEIVED, 150);
  sheet.setColumnWidth(COL.MESSAGE, 460);
  sheet.setColumnWidth(COL.SUGGESTED, 140);
  sheet.setColumnWidth(COL.CATEGORY, 140);
  sheet.setColumnWidth(COL.APPROVED, 90);
  sheet.setColumnWidth(COL.FEATURED, 90);
  sheet.setColumnWidth(COL.NOTES, 200);
  sheet.setColumnWidth(COL.REPLY, 360);
  formatRows_(sheet);

  setupReplies_(ss);

  if (!PropertiesService.getScriptProperties().getProperty('SYNC_KEY')) rotateSyncKey_();

  SpreadsheetApp.getUi().alert(
    'ThoughtShare is set up.\n\n' +
    '• Submissions: tick Approved to publish a note. Type in "My reply" to answer it.\n' +
    '• Replies: tick Approved to publish a visitor reply. To add your own message to a thread, ' +
    'type the Thread ID and Message in a new row and tick "From me".\n\n' +
    'If you changed Code.gs: Deploy → Manage deployments → Edit → Version: New version → Deploy.'
  );
}

function setupReplies_(ss) {
  var rs = ss.getSheetByName(REPLIES_SHEET) || ss.insertSheet(REPLIES_SHEET);
  if (rs.getMaxColumns() < RCOL.CONTEXT) rs.insertColumnsAfter(rs.getMaxColumns(), RCOL.CONTEXT - rs.getMaxColumns());
  rs.getRange(1, 1, 1, R_HEADERS.length).setValues([R_HEADERS]);
  // Read-only helper column: shows the note each reply belongs to
  rs.getRange(1, RCOL.CONTEXT).setFormula(
    '={"Replying to";ARRAYFORMULA(IF(C2:C="","",IFERROR(VLOOKUP(C2:C,' + SHEET_NAME + '!A:C,3,FALSE),"(no such note)")))}'
  );
  styleHeader_(rs.getRange(1, 1, 1, RCOL.CONTEXT));
  rs.setFrozenRows(1);
  rs.setColumnWidth(RCOL.ID, 130);
  rs.setColumnWidth(RCOL.RECEIVED, 150);
  rs.setColumnWidth(RCOL.THREAD, 140);
  rs.setColumnWidth(RCOL.MESSAGE, 400);
  rs.setColumnWidth(RCOL.FROM_ME, 80);
  rs.setColumnWidth(RCOL.APPROVED, 90);
  rs.setColumnWidth(RCOL.NOTES, 180);
  rs.setColumnWidth(RCOL.CONTEXT, 320);
  formatReplyRows_(rs);
}

function showExport() {
  var data = buildExport_();
  var replies = 0, answered = 0;
  data.messages.forEach(function (m) { replies += (m.replies || []).length; if (m.reply) answered++; });
  var t = HtmlService.createTemplate(EXPORT_HTML_);
  t.json = JSON.stringify(data, null, 2);
  t.summary = data.messages.length + ' approved note(s), ' + answered + ' with your reply, ' + replies + ' thread repl' + (replies === 1 ? 'y' : 'ies') + '.';
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(720).setHeight(560), 'Approved content → data/messages.json');
}

function showSyncKey() {
  var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY') || rotateSyncKey_();
  SpreadsheetApp.getUi().alert(
    'Sync key (keep it secret):\n\n' + key +
    '\n\nAdd it to your GitHub repo as the secret THOUGHTSHARE_EXPORT_KEY. ' +
    'Anyone with this key and your web-app URL can read APPROVED content only — never pending notes or replies.'
  );
}

function rotateSyncKey() {
  var key = rotateSyncKey_();
  SpreadsheetApp.getUi().alert('New sync key:\n\n' + key + '\n\nUpdate THOUGHTSHARE_EXPORT_KEY in your GitHub repo secrets. The old key no longer works.');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function buildExport_() {
  var sheet = sheet_();
  var tz = Session.getScriptTimeZone();
  var day = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var messages = [], byId = {};

  var last = sheet.getLastRow();
  if (last >= 2) {
    var width = Math.min(HEADERS.length, sheet.getMaxColumns());
    sheet.getRange(2, 1, last - 1, width).getValues().forEach(function (r) {
      if (r[COL.APPROVED - 1] !== true) return;
      var text = String(r[COL.MESSAGE - 1] || '').trim();
      if (!text) return;
      var cat = String(r[COL.CATEGORY - 1] || r[COL.SUGGESTED - 1] || DEFAULT_CATEGORY).toLowerCase();
      if (CATEGORIES.indexOf(cat) === -1) cat = DEFAULT_CATEGORY;
      var id = String(r[COL.ID - 1] || '').trim();
      if (!id) return;
      var item = { id: id, text: text, category: cat };
      var received = r[COL.RECEIVED - 1];
      if (INCLUDE_DATES && received instanceof Date) item.date = day(received);
      item.featured = r[COL.FEATURED - 1] === true;
      var reply = String(r[COL.REPLY - 1] || '').trim();
      if (reply) item.reply = reply;
      item._sort = received instanceof Date ? received.getTime() : 0;
      item._replies = [];
      messages.push(item);
      byId[id] = item;
    });
  }

  var rs = spreadsheet_().getSheetByName(REPLIES_SHEET);
  if (rs && rs.getLastRow() >= 2) {
    rs.getRange(2, 1, rs.getLastRow() - 1, R_HEADERS.length).getValues().forEach(function (r, i) {
      var parent = byId[String(r[RCOL.THREAD - 1] || '').trim()];
      var text = String(r[RCOL.MESSAGE - 1] || '').trim();
      var fromMe = r[RCOL.FROM_ME - 1] === true;
      if (!parent || !text) return;
      if (r[RCOL.APPROVED - 1] !== true && !fromMe) return; // your own messages don't need approving
      var received = r[RCOL.RECEIVED - 1];
      var rep = { id: String(r[RCOL.ID - 1] || ('r-row' + (i + 2))), text: text };
      if (INCLUDE_DATES && received instanceof Date) rep.date = day(received);
      rep.fromOwner = fromMe;
      rep._sort = received instanceof Date ? received.getTime() : 0;
      rep._row = i;
      parent._replies.push(rep);
    });
  }

  messages.sort(function (a, b) { return b._sort - a._sort; });
  messages.forEach(function (m) {
    if (m._replies.length) {
      m._replies.sort(function (a, b) { return (a._sort - b._sort) || (a._row - b._row); });
      m.replies = m._replies.map(function (r) { delete r._sort; delete r._row; return r; });
    }
    delete m._sort; delete m._replies;
  });
  return { updated: day(new Date()), messages: messages };
}

// IDs of approved notes, for validating replies
function approvedIds_() {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  var ok = {};
  if (last < 2) return ok;
  sheet.getRange(2, 1, last - 1, COL.APPROVED).getValues().forEach(function (r) {
    if (r[COL.APPROVED - 1] === true && r[COL.ID - 1]) ok[String(r[COL.ID - 1]).trim()] = true;
  });
  return ok;
}

function styleHeader_(range) {
  range.setFontWeight('bold').setBackground('#2B2420').setFontColor('#FFFFFF');
}

// Checkbox validation only — unlike insertCheckboxes(), this never resets existing ticks.
function checkboxes_(range) {
  range.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
}

// Submissions: checkboxes, dropdown, wrapping and colours for every data row
function formatRows_(sheet) {
  var rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  sheet.getRange(2, COL.MESSAGE, rows, 1).setWrap(true).setVerticalAlignment('top');
  sheet.getRange(2, COL.REPLY, rows, 1).setWrap(true).setVerticalAlignment('top');
  sheet.getRange(2, COL.RECEIVED, rows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  checkboxes_(sheet.getRange(2, COL.APPROVED, rows, 2));
  sheet.getRange(2, COL.CATEGORY, rows, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(CATEGORIES, true).setAllowInvalid(false).build()
  );
  // Approved rows turn green, featured rows gold
  var body = sheet.getRange(2, 1, rows, HEADERS.length);
  sheet.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$G2=TRUE').setBackground('#FFF1C2').setRanges([body]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$F2=TRUE').setBackground('#DDF3E8').setRanges([body]).build()
  ]);
}

// Replies: same idea
function formatReplyRows_(rs) {
  var rows = rs.getMaxRows() - 1;
  if (rows < 1) return;
  rs.getRange(2, RCOL.MESSAGE, rows, 1).setWrap(true).setVerticalAlignment('top');
  rs.getRange(2, RCOL.CONTEXT, rows, 1).setWrap(true).setVerticalAlignment('top').setFontColor('#6B5E55');
  rs.getRange(2, RCOL.RECEIVED, rows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  checkboxes_(rs.getRange(2, RCOL.FROM_ME, rows, 2));
  var body = rs.getRange(2, 1, rows, R_HEADERS.length);
  rs.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$E2=TRUE').setBackground('#FDE3DC').setRanges([body]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$F2=TRUE').setBackground('#DDF3E8').setRanges([body]).build()
  ]);
}

// First row (from 2) with no ID and no message. Grows the sheet when it's full.
function nextRow_(sheet, idCol, msgCol, formatter) {
  var max = sheet.getMaxRows();
  if (max >= 2) {
    var ids = sheet.getRange(2, idCol, max - 1, 1).getValues();
    var msgs = sheet.getRange(2, msgCol, max - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === '' && String(msgs[i][0]).trim() === '') return i + 2;
    }
  }
  sheet.insertRowsAfter(max, 500);
  formatter(sheet);
  return max + 1;
}

function spreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('Run ThoughtShare → Set up / repair sheet first.');
    ss = SpreadsheetApp.openById(id);
  }
  return ss;
}

function sheet_() {
  var sheet = spreadsheet_().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + SHEET_NAME + '" tab. Run ThoughtShare → Set up / repair sheet.');
  return sheet;
}

function repliesSheet_() {
  var rs = spreadsheet_().getSheetByName(REPLIES_SHEET);
  if (!rs) throw new Error('Missing "' + REPLIES_SHEET + '" tab. Run ThoughtShare → Set up / repair sheet.');
  return rs;
}

function clean_(v) {
  return String(v || '')
    .replace(/\r\n?/g, '\n')
    // control characters and invisible direction-override tricks
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Stop text like "=IMPORTDATA(...)" from becoming a live formula in your sheet
function safeCell_(text) {
  return /^[=+\-@\t]/.test(text) ? "'" + text : text;
}

function newId_(prefix) {
  var d = Utilities.formatDate(new Date(), 'UTC', 'yyMMdd');
  return (prefix || 't') + '-' + d + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 5);
}

function sha_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)).slice(0, 22);
}

function rotateSyncKey_() {
  var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  PropertiesService.getScriptProperties().setProperty('SYNC_KEY', key);
  return key;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

var EXPORT_HTML_ = [
  '<!doctype html><html><head><base target="_top"><style>',
  'body{font-family:Inter,Arial,sans-serif;margin:0;padding:14px;color:#2B2420}',
  'p{margin:0 0 10px;font-size:13px;color:#6B5E55}',
  'textarea{width:100%;height:400px;box-sizing:border-box;font:12px/1.45 Menlo,Consolas,monospace;border:1px solid #ddd;border-radius:8px;padding:10px}',
  '.row{display:flex;gap:8px;margin-top:10px;align-items:center}',
  'button{border:0;border-radius:999px;padding:9px 16px;font-weight:600;cursor:pointer;background:#C8412F;color:#fff}',
  'button.alt{background:#EFE7DC;color:#2B2420}#s{font-size:13px;color:#1D6B52}',
  '</style></head><body>',
  '<p><b><?= summary ?></b> Replace the contents of <code>data/messages.json</code> with this, then commit and push.</p>',
  '<textarea id="t" readonly><?= json ?></textarea>',
  '<div class="row"><button id="c">Copy</button><button class="alt" id="d">Download file</button><span id="s"></span></div>',
  '<script>',
  'var t=document.getElementById("t"),s=document.getElementById("s");',
  'document.getElementById("c").onclick=function(){t.select();var ok=false;try{ok=document.execCommand("copy")}catch(e){}',
  's.textContent=ok?"Copied.":"Press Ctrl/Cmd + C to copy the selected text.";};',
  'document.getElementById("d").onclick=function(){try{var b=new Blob([t.value],{type:"application/json"});',
  'var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="messages.json";document.body.appendChild(a);a.click();',
  's.textContent="If nothing downloaded, use Copy instead.";}catch(e){s.textContent="Download blocked — use Copy instead.";}};',
  '</script></body></html>'
].join('\n');
