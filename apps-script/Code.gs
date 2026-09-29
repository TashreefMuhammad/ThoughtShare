/**
 * ThoughtShare — Google Apps Script backend
 * =========================================
 * Paste this whole file into Extensions → Apps Script of a Google Sheet
 * (the sheet becomes your private inbox + moderation dashboard).
 *
 * What it does
 *   • doPost  – receives anonymous thoughts from the website and appends them
 *               to the "Submissions" tab. Nothing about the sender is stored.
 *   • doGet   – returns ONLY approved thoughts as JSON, and only when called
 *               with your secret sync key (used by the optional GitHub Action).
 *   • Menu    – "ThoughtShare" menu in the sheet: set up, export approved JSON,
 *               manage the sync key.
 *
 * Deploy: Deploy → New deployment → Web app
 *         Execute as: Me   |   Who has access: Anyone
 * Full walkthrough: see README.md in the repository.
 */

// ---------------------------------------------------------------------------
// Settings — keep CATEGORIES in sync with config.js on the website
// ---------------------------------------------------------------------------
var CATEGORIES = ['gratitude', 'confession', 'advice', 'rant', 'hope', 'random'];
var DEFAULT_CATEGORY = 'random';
var SHEET_NAME = 'Submissions';
var MIN_LENGTH = 5;
var MAX_LENGTH = 600;              // should match maxLength in config.js
var MAX_PER_10_MIN = 40;           // whole-board flood limit (no per-person data is kept)
var DUPLICATE_WINDOW_HOURS = 6;    // identical text is ignored inside this window
var INCLUDE_DATES = true;          // put the day a note was received into the public JSON

// Column layout (1-based). Don't reorder after you start collecting.
var COL = { ID: 1, RECEIVED: 2, MESSAGE: 3, SUGGESTED: 4, CATEGORY: 5, APPROVED: 6, FEATURED: 7, NOTES: 8 };
var HEADERS = ['ID', 'Received', 'Message', 'Suggested category', 'Category (final)', 'Approved', 'Featured', 'Private notes'];

// ---------------------------------------------------------------------------
// Web endpoints
// ---------------------------------------------------------------------------
function doPost(e) {
  try {
    var p = (e && e.parameter) || {};

    // Honeypot: real visitors never fill this field. Say "ok" so bots learn nothing.
    if (p.website) return json_({ ok: true });

    var text = clean_(p.message);
    if (text.length < MIN_LENGTH) return json_({ ok: false, error: 'Please write at least ' + MIN_LENGTH + ' characters.' });
    if (text.length > MAX_LENGTH) return json_({ ok: false, error: 'Please keep it under ' + MAX_LENGTH + ' characters.' });

    var suggested = String(p.category || '').toLowerCase().trim();
    if (CATEGORIES.indexOf(suggested) === -1) suggested = '';

    var cache = CacheService.getScriptCache();

    // Board-wide flood control (10-minute buckets)
    var bucket = 'rate:' + Math.floor(Date.now() / 600000);
    var count = parseInt(cache.get(bucket) || '0', 10);
    if (count >= MAX_PER_10_MIN) {
      return json_({ ok: false, error: 'The board is getting a lot of notes right now. Please try again in a few minutes.' });
    }

    // Duplicate suppression (same text, recently)
    var digest = 'dup:' + sha_(text.toLowerCase().replace(/\s+/g, ' '));
    if (cache.get(digest)) return json_({ ok: true });

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return json_({ ok: false, error: 'Busy — please try again.' });
    try {
      var sheet = sheet_();
      // Not appendRow(): the pre-filled checkboxes count as "content", so appendRow
      // would write below the last checkbox row (row 1001+). Use the first row with no ID instead.
      var row = nextRow_(sheet);
      sheet.getRange(row, 1, 1, HEADERS.length).setValues([[
        newId_(),
        new Date(),
        safeCell_(text),
        suggested,
        '',          // Category (final) — you fill this while reviewing
        false,       // Approved
        false,       // Featured
        ''
      ]]);
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
  return json_({ ok: true, service: 'ThoughtShare', accepting: true });
}

// ---------------------------------------------------------------------------
// Sheet menu
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

function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    var first = ss.getSheets()[0];
    // Reuse a blank first tab, otherwise add a new one
    sheet = (first.getLastRow() === 0) ? first.setName(SHEET_NAME) : ss.insertSheet(SHEET_NAME);
  }

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#2B2420').setFontColor('#FFFFFF');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(COL.ID, 130);
  sheet.setColumnWidth(COL.RECEIVED, 150);
  sheet.setColumnWidth(COL.MESSAGE, 460);
  sheet.setColumnWidth(COL.SUGGESTED, 140);
  sheet.setColumnWidth(COL.CATEGORY, 140);
  sheet.setColumnWidth(COL.APPROVED, 90);
  sheet.setColumnWidth(COL.FEATURED, 90);
  sheet.setColumnWidth(COL.NOTES, 220);

  formatRows_(sheet);

  if (!PropertiesService.getScriptProperties().getProperty('SYNC_KEY')) rotateSyncKey_(true);

  SpreadsheetApp.getUi().alert('ThoughtShare is set up.\n\nNext: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone), then paste the /exec URL into config.js.');
}

function showExport() {
  var data = buildExport_();
  var t = HtmlService.createTemplate(EXPORT_HTML_);
  t.json = JSON.stringify(data, null, 2);
  t.count = data.messages.length;
  SpreadsheetApp.getUi().showModalDialog(t.evaluate().setWidth(720).setHeight(560), 'Approved thoughts → data/messages.json');
}

function showSyncKey() {
  var key = PropertiesService.getScriptProperties().getProperty('SYNC_KEY') || rotateSyncKey_(true);
  SpreadsheetApp.getUi().alert(
    'Sync key (keep it secret):\n\n' + key +
    '\n\nAdd it to your GitHub repo as the secret THOUGHTSHARE_EXPORT_KEY. ' +
    'Anyone with this key and your web-app URL can read APPROVED thoughts only — never pending ones.'
  );
}

function rotateSyncKey() {
  var key = rotateSyncKey_(false);
  SpreadsheetApp.getUi().alert('New sync key:\n\n' + key + '\n\nUpdate THOUGHTSHARE_EXPORT_KEY in your GitHub repo secrets. The old key no longer works.');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function buildExport_() {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  var tz = Session.getScriptTimeZone();
  var messages = [];
  if (last >= 2) {
    var rows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
    rows.forEach(function (r) {
      if (r[COL.APPROVED - 1] !== true) return;
      var text = String(r[COL.MESSAGE - 1] || '').trim();
      if (!text) return;
      var cat = String(r[COL.CATEGORY - 1] || r[COL.SUGGESTED - 1] || DEFAULT_CATEGORY).toLowerCase();
      if (CATEGORIES.indexOf(cat) === -1) cat = DEFAULT_CATEGORY;
      var item = { id: String(r[COL.ID - 1] || ''), text: text, category: cat };
      var received = r[COL.RECEIVED - 1];
      if (INCLUDE_DATES && received instanceof Date) item.date = Utilities.formatDate(received, tz, 'yyyy-MM-dd');
      item.featured = r[COL.FEATURED - 1] === true;
      item._sort = received instanceof Date ? received.getTime() : 0;
      messages.push(item);
    });
  }
  messages.sort(function (a, b) { return b._sort - a._sort; });
  messages.forEach(function (m) { delete m._sort; });
  return { updated: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'), messages: messages };
}

// Checkboxes, dropdown, wrapping and colours for every data row in the sheet
function formatRows_(sheet) {
  var rows = sheet.getMaxRows() - 1;
  if (rows < 1) return;
  sheet.getRange(2, COL.MESSAGE, rows, 1).setWrap(true).setVerticalAlignment('top');
  sheet.getRange(2, COL.RECEIVED, rows, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(2, COL.APPROVED, rows, 2).insertCheckboxes();
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

// First row (from 2) whose ID cell is empty. Grows the sheet when it's full.
function nextRow_(sheet) {
  var max = sheet.getMaxRows();
  if (max >= 2) {
    var ids = sheet.getRange(2, COL.ID, max - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i][0] === '' || ids[i][0] === null) return i + 2;
    }
  }
  sheet.insertRowsAfter(max, 500);
  formatRows_(sheet);
  return max + 1;
}

function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('Run ThoughtShare → Set up / repair sheet first.');
    ss = SpreadsheetApp.openById(id);
  }
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + SHEET_NAME + '" tab. Run ThoughtShare → Set up / repair sheet.');
  return sheet;
}

function clean_(v) {
  return String(v || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '') // control + bidi tricks
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Stop text like "=IMPORTDATA(...)" from becoming a live formula in your sheet
function safeCell_(text) {
  return /^[=+\-@\t]/.test(text) ? "'" + text : text;
}

function newId_() {
  var d = Utilities.formatDate(new Date(), 'UTC', 'yyMMdd');
  return 't-' + d + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 5);
}

function sha_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s)).slice(0, 22);
}

function rotateSyncKey_(quiet) {
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
  '<p><b><?= count ?></b> approved thought(s). Replace the contents of <code>data/messages.json</code> with this, then commit and push.</p>',
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