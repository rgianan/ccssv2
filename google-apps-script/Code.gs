/**
 * Code.gs — CHED-OSDS Client Satisfaction Measurement backend.
 *
 * Deploy: Web app → Execute as "Me", Who has access "Anyone".
 * The Vercel function at /api/gas-proxy is the only intended caller; every
 * request must carry the shared proxy token issued by setupCsmSecurity().
 *
 * Companion files: Certificate.gs (Certificate of Appearance) and
 * Report.gs (CSM Summary Report workbook).
 */

var SHEET_RESPONSES = 'Responses';
var SHEET_SERVICES = 'Services';
var SHEET_SERVICE_STATS = 'ServiceStats';
var SHEET_SETTINGS = 'Settings';
var SHEET_REPORTS = 'Reports';
var SHEET_USERS = 'Users';
var SHEET_WHITELIST = 'Whitelist';
var SHEET_AUDIT = 'Audit';

var SQD_KEYS = ['sqd0','sqd1','sqd2','sqd3','sqd4','sqd5','sqd6','sqd7','sqd8'];
var CC_KEYS = ['cc1','cc2','cc3'];

/**
 * What each Citizen's Charter question may hold. These must stay in step with
 * CC_QUESTIONS in src/lib/csm.js and CC_LABELS_ in Report.gs: the report gives
 * every question a column per numbered choice plus one for N/A, so a value
 * accepted here but absent there is stored, dropped from the table, and still
 * counted in the Total — leaving a row that does not add up.
 *
 * CC2 therefore stops accepting '5' and CC3 stops accepting '4' and '5'; in
 * the circular those positions are N/A, which is listed separately.
 */
var CC_OPTIONS_ = {
  cc1: ['1','2','3','4'],
  cc2: ['1','2','3','4'],
  cc3: ['1','2','3']
};

/**
 * CC1's fourth choice: the client has never encountered a Citizen's Charter.
 *
 * Must equal CC_UNAWARE_VALUE in src/lib/csm.js. The two live in different
 * runtimes and cannot share a definition, and a divergence does not fail
 * loudly — the browser would hide CC2 and CC3 for one option while the server
 * still demanded answers for it, leaving the client staring at "Please answer
 * all Citizen's Charter questions" with no such questions on screen. If you
 * reorder CC1's options, change both.
 */
var CC_UNAWARE_VALUE_ = '4';

var SQD_OPTIONS_ = ['1','2','3','4','5','N/A'];
/** Where a fee is charged every client pays one, so there is no N/A to give. */
var SQD_RATED_OPTIONS_ = ['1','2','3','4','5'];
var PUBLIC_CACHE_SECONDS = 900;

// --------------------------------- Entry -------------------------------------

function doGet() {
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:Arial,sans-serif;background:#f5f8fc;color:#16223c;display:grid;place-items:center;min-height:90vh;margin:0}' +
    '.card{text-align:center;background:#fff;border:1px solid #dae2ec;border-radius:18px;padding:32px;max-width:480px}img{width:220px;max-width:80%}p{color:#66748a}</style>' +
    '<div class="card"><img src="https://ik.imagekit.io/k2qmtccm6/CHED_Logo_New.png" alt="CHED">' +
    '<h1>CSM Portal API</h1><p>This service is online. Use the deployed portal to access the application.</p></div>'
  ).setTitle('CHED-OSDS CSM API')
   .setFaviconUrl('https://ik.imagekit.io/k2qmtccm6/CHED-cropped-logo100x100.png');
}

function doPost(e) {
  var body = null, action = '', auditActor = null, requestContext = {};
  try {
    var raw = (e && e.postData && e.postData.contents) || '{}';
    if (raw.length > 6000000) throw new Error('Request payload is too large.');
    body = JSON.parse(raw);
    assertSubmitSharedToken_(body.proxyToken);
    delete body.proxyToken;
    rememberPortalBaseUrl_(body.portalBaseUrl);
    delete body.portalBaseUrl;
    requestContext = body.requestContext || {};
    delete body.requestContext;
    action = safeTrim_(body.action);
    // Only audited actions need an actor. Resolving one validates the session,
    // so doing it for every read validated each admin request twice.
    auditActor = isAuditedAction_(action) ? auditActorForRequest_(action, body) : null;

    var data;
    if (action === 'getPortalConfig') data = getPortalConfig();
    else if (action === 'submitResponse') data = submitResponse(body.payload || {});
    else if (action === 'verifyCertificate') data = verifyCertificate(body.code);
    else if (action === 'adminLogin') data = adminLogin(body.email, body.password, requestContext);
    else if (action === 'adminLogout') data = adminLogout(body.adminToken);
    else if (action === 'adminValidateSession') data = adminValidateSession(body.adminToken);
    else if (action === 'adminGetOverview') data = adminGetOverview(body.period || {}, body.adminToken);
    else if (action === 'adminGetResponses') data = adminGetResponses(body.filters || {}, body.adminToken);
    else if (action === 'adminGetCoaRequests') data = adminGetCoaRequests(body.filters || {}, body.adminToken);
    else if (action === 'adminSaveCoaDetails') data = adminSaveCoaDetails(body.payload || {}, body.adminToken);
    else if (action === 'adminGenerateCoa') data = adminGenerateCoa(body.responseId, body.issueKey, body.adminToken, body.expectedStatus);
    else if (action === 'adminGetServices') data = adminGetServices(body.adminToken);
    else if (action === 'adminSaveService') data = adminSaveService(body.payload || {}, body.adminToken);
    else if (action === 'adminGetServiceStats') data = adminGetServiceStats(body.period || {}, body.adminToken);
    else if (action === 'adminSaveServiceStats') data = adminSaveServiceStats(body.period || {}, body.rows || [], body.adminToken);
    else if (action === 'adminGenerateReport') data = adminGenerateReport(body.period || {}, body.adminToken);
    else if (action === 'adminGetReports') data = adminGetReports(body.adminToken);
    else if (action === 'adminGetSettings') data = adminGetSettings(body.adminToken);
    else if (action === 'adminSaveSettings') data = adminSaveSettings(body.settings || {}, body.adminToken);
    else if (action === 'adminUploadCoaTemplate') data = adminUploadCoaTemplate(body.payload || {}, body.adminToken);
    else if (action === 'adminUploadSignature') data = adminUploadSignature(body.payload || {}, body.adminToken);
    else if (action === 'adminGetUsers') data = adminGetUsers(body.adminToken);
    else if (action === 'adminSaveUser') data = adminSaveUser(body.payload || {}, body.adminToken);
    else if (action === 'adminGetAuditLog') data = adminGetAuditLog(body.filters || {}, body.adminToken);
    else throw new Error('Unknown action: ' + action);

    if (isAuditedAction_(action)) {
      try {
        appendAuditForRequest_(action, body, true, '', auditActorForResult_(action, data, auditActor), requestContext);
      } catch (auditError) {
        console.error('Audit write failed: ' + String(auditError && auditError.message || auditError));
      }
    }
    return jsonResponse_({ ok: true, data: data });
  } catch (error) {
    try {
      if (body && isAuditedAction_(action))
        appendAuditForRequest_(action, body, false, error && error.message ? error.message : String(error), auditActor, requestContext);
    } catch (_) {}
    return jsonResponse_({ ok: false, error: error && error.message ? error.message : String(error) });
  }
}

function jsonResponse_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------- Utilities -----------------------------------

function safeTrim_(v) { return String(v == null ? '' : v).trim(); }
/** Leading =, +, -, or @ makes Sheets treat stored text as a formula. */
function safeSheetValue_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? ("'" + v) : v; }
function escapeHtml_(v) { return safeTrim_(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
/** Asked once per execution: every call is a round trip out of the script. */
var SCRIPT_TIME_ZONE_ = null;
function timezone_() {
  return SCRIPT_TIME_ZONE_ || (SCRIPT_TIME_ZONE_ = Session.getScriptTimeZone() || 'Asia/Manila');
}

function getHeaderMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return {};
  var map = {};
  sheet.getRange(1, 1, 1, lastCol).getValues()[0].forEach(function (header, index) {
    var key = String(header || '').trim().toLowerCase();
    if (key) map[key] = index;
  });
  return map;
}

function idxOf_(headerMap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var key = String(candidates[i]).toLowerCase();
    if (key in headerMap) return headerMap[key];
  }
  return -1;
}

var MONTH_NAMES_ = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value);
}

/**
 * yyyy-MM-dd or "MMMM d, yyyy", from the Date's own calendar fields.
 *
 * Utilities.formatDate is a round trip out of the script, and the response
 * reads call it for up to three dates in every row — thousands of calls on a
 * sheet of any size, and the bulk of what made the dashboard's tables slow.
 * The runtime's local zone is the script's zone (parseDate_ and inPeriod_
 * already rely on that), so the fields give the same answer for free.
 */
function localDateText_(date, kind) {
  var year = String(date.getFullYear()), month = date.getMonth(), day = date.getDate();
  while (year.length < 4) year = '0' + year;
  return kind === 'long'
    ? MONTH_NAMES_[month] + ' ' + day + ', ' + year
    : year + '-' + (month < 9 ? '0' : '') + (month + 1) + '-' + (day < 10 ? '0' : '') + day;
}

/**
 * Whether localDateText_ agrees with Utilities.formatDate here, checked once
 * per execution against instants either side of a day boundary. Relying on it
 * blind would shift every date if the two zones ever differed; where they do,
 * the formatters below fall back to Utilities and cost what they used to.
 */
var LOCAL_DATES_AGREE_ = null;
function localDatesAgree_() {
  if (LOCAL_DATES_AGREE_ === null) {
    try {
      var zone = timezone_();
      LOCAL_DATES_AGREE_ = [new Date(), new Date(Date.UTC(2026, 2, 31, 16, 30)),
        new Date(Date.UTC(2026, 11, 31, 15, 59)), new Date(Date.UTC(2027, 6, 4, 3, 0))]
        .every(function (date) {
          return Utilities.formatDate(date, zone, 'yyyy-MM-dd|MMMM d, yyyy') ===
            localDateText_(date, 'iso') + '|' + localDateText_(date, 'long');
        });
    } catch (_) {
      LOCAL_DATES_AGREE_ = false;
    }
    if (!LOCAL_DATES_AGREE_)
      console.warn('Local date fields disagree with Utilities.formatDate; using the slower path.');
  }
  return LOCAL_DATES_AGREE_;
}

function fmtDate_(value) {
  if (isDate_(value))
    return localDatesAgree_() ? localDateText_(value, 'iso') : Utilities.formatDate(value, timezone_(), 'yyyy-MM-dd');
  return safeTrim_(value);
}

/** Accepts a Date, a yyyy-MM-dd string, or a locale string; returns a Date or null. */
function parseDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) return value;
  var text = safeTrim_(value);
  if (!text) return null;
  var iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  var parsed = new Date(text);
  return isNaN(parsed) ? null : parsed;
}

function longDate_(value) {
  var date = parseDate_(value);
  if (!date) return safeTrim_(value);
  return localDatesAgree_() ? localDateText_(date, 'long') : Utilities.formatDate(date, timezone_(), 'MMMM d, yyyy');
}

function ordinal_(day) {
  if (day % 100 >= 11 && day % 100 <= 13) return day + 'th';
  return day + (['th','st','nd','rd'][day % 10] || 'th');
}

function randomSecret_() {
  return Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'');
}
function sha256Base64_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value||''), Utilities.Charset.UTF_8)).replace(/=+$/,'');
}
/**
 * HMAC-SHA256, base64url without padding. Computed in-script where it agrees
 * with Utilities: the audit log verifies one of these per entry on every
 * read, so a log of a few thousand rows was a few thousand calls out of the
 * script each time the Audit tab opened.
 */
function hmac256Base64_(value, secret) {
  value = String(value || ''); secret = String(secret || '');
  if (fastHmacAgrees_()) {
    try { return fastHmacText_(value, secret); } catch (_) {}
  }
  return utilitiesHmacText_(value, secret);
}

function utilitiesHmacText_(value, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8)).replace(/=+$/,'');
}

function fastHmacText_(value, secret) {
  return String.fromCharCode.apply(null,
    base64WebSafeAscii_(hmacSha256Bytes_(utf8Bytes_(value), utf8Bytes_(secret)))).replace(/=+$/, '');
}

/** Checked once per execution, with a key longer than the block size. */
var FAST_HMAC_AGREES_ = null;
function fastHmacAgrees_() {
  if (FAST_HMAC_AGREES_ === null) {
    try {
      var message = 'audit|ü|' + new Array(40).join('row'), key = 'kéy-' + new Array(30).join('secret');
      FAST_HMAC_AGREES_ = fastHmacText_(message, key) === utilitiesHmacText_(message, key) &&
        fastHmacText_('x', 'short') === utilitiesHmacText_('x', 'short');
    } catch (_) {
      FAST_HMAC_AGREES_ = false;
    }
    if (!FAST_HMAC_AGREES_)
      console.warn('In-script HMAC disagrees with Utilities; using the slower path.');
  }
  return FAST_HMAC_AGREES_;
}
function constantTimeEquals_(a, b) {
  a = String(a || ''); b = String(b || '');
  var diff = a.length ^ b.length, len = Math.max(a.length, b.length);
  for (var i = 0; i < len; i++)
    diff |= (a.charCodeAt(i % Math.max(1, a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1, b.length)) || 0);
  return diff === 0;
}

function assertSubmitSharedToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('SUBMIT_SHARED_TOKEN_HASH');
  if (!expected) throw new Error('Backend security is not configured. Run setupCsmSecurity().');
  if (!token || !constantTimeEquals_(sha256Base64_(String(token)), expected))
    throw new Error('Forbidden: invalid submit token.');
}

/**
 * Fed only by PORTAL_BASE_URL as configured in Vercel. The proxy used to fall
 * back to the request's Host header, which made this a persistent store for
 * an attacker-supplied domain; it now sends nothing when the variable is
 * unset, so an absent value leaves the stored one untouched.
 */
function rememberPortalBaseUrl_(url) {
  url = safeTrim_(url).replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(url)) return;
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PORTAL_BASE_URL') !== url) props.setProperty('PORTAL_BASE_URL', url);
}

function portalBaseUrl_() {
  return safeTrim_(PropertiesService.getScriptProperties().getProperty('PORTAL_BASE_URL')).replace(/\/$/, '');
}

function invalidatePublicCache_() {
  CacheService.getScriptCache().removeAll(['PUBLIC_CSM_CONFIG']);
}

// ------------------------------- Result cache ---------------------------------

/**
 * The Overview and Certificates tabs each read and parse the whole Responses
 * sheet, which grows by a row with every submission. Their answers are small
 * and change only when the data behind them does, so they are kept in the
 * script cache under a version that every write to that data replaces. A
 * write makes the next read recompute; no answer is served that predates a
 * write this code made.
 *
 * Edits made by hand in the spreadsheet are not writes this code sees. The
 * change trigger setupCsmSheets installs replaces the version for those too,
 * and the cache lifetime bounds how stale an answer can get without it.
 */
var RESULT_CACHE_SECONDS_ = 600;
var RESULT_VERSION_PROPERTY_ = 'RESULT_CACHE_VERSION';
/** Characters per cache entry: under the 100 KB value cap even at 3 bytes each. */
var RESULT_CACHE_CHUNK_ = 30000;
var RESULT_CACHE_MAX_CHUNKS_ = 60;

function newResultVersion_() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function resultCacheVersion_() {
  var props = PropertiesService.getScriptProperties();
  var version = props.getProperty(RESULT_VERSION_PROPERTY_);
  if (!version) {
    version = newResultVersion_();
    props.setProperty(RESULT_VERSION_PROPERTY_, version);
  }
  return version;
}

/** Call after — never before — changing data a cached result is built from. */
function invalidateResultCache_() {
  try {
    PropertiesService.getScriptProperties().setProperty(RESULT_VERSION_PROPERTY_, newResultVersion_());
  } catch (error) {
    console.error('Result cache version not replaced: ' + String(error && error.message || error));
  }
}

/**
 * compute(), served from the cache when it can be. The version is read before
 * the data: a write landing between the two then files its result under a
 * version already retired, rather than filing pre-write data under the new one.
 */
function cachedResult_(name, part, fresh, compute) {
  var key = 'RESULT_' + resultCacheVersion_() + '_' + name + '_' + part;
  if (!fresh) {
    var hit = cacheGetJson_(key);
    if (hit !== null) return hit;
  }
  var value = compute();
  cachePutJson_(key, value, RESULT_CACHE_SECONDS_);
  return value;
}

/** A value split across entries: the head holds the count, #0… the text. */
function cacheGetJson_(key) {
  try {
    var cache = CacheService.getScriptCache(), count = Number(cache.get(key));
    if (!(count >= 1 && count <= RESULT_CACHE_MAX_CHUNKS_)) return null;
    var keys = [];
    for (var i = 0; i < count; i++) keys.push(key + '#' + i);
    var parts = cache.getAll(keys), text = '';
    for (var j = 0; j < keys.length; j++) {
      // Any part evicted on its own makes the whole value a miss.
      if (typeof parts[keys[j]] !== 'string') return null;
      text += parts[keys[j]];
    }
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function cachePutJson_(key, value, seconds) {
  try {
    var text = JSON.stringify(value), count = Math.max(1, Math.ceil(text.length / RESULT_CACHE_CHUNK_));
    if (count > RESULT_CACHE_MAX_CHUNKS_) return;          // too large to be worth holding
    var entries = {};
    for (var i = 0; i < count; i++)
      entries[key + '#' + i] = text.slice(i * RESULT_CACHE_CHUNK_, (i + 1) * RESULT_CACHE_CHUNK_);
    entries[key] = String(count);
    CacheService.getScriptCache().putAll(entries, seconds);
  } catch (error) {
    // Caching is an optimisation; the answer already computed still goes out.
    console.warn('Result not cached: ' + String(error && error.message || error).slice(0, 120));
  }
}

/**
 * Installed by setupCsmSheets as an on-change trigger. A hand edit anywhere in
 * the spreadsheet retires cached results and the public programme list;
 * changes made by this script do not fire it.
 */
function onSpreadsheetChange() {
  invalidateResultCache_();
  try { invalidatePublicCache_(); } catch (_) {}
}

/** Idempotent, like ensureDailyTrigger_. */
function ensureChangeTrigger_(handlerName) {
  var exists = ScriptApp.getProjectTriggers().some(function (trigger) {
    return trigger.getHandlerFunction() === handlerName;
  });
  if (exists) return false;
  ScriptApp.newTrigger(handlerName).forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet()).onChange().create();
  return true;
}

/**
 * Publishes a file to anyone holding its link. Returns whether that worked.
 *
 * A refusal is not reported to the administrator. It is a standing Workspace
 * policy, not an event: it will fail identically on every certificate, nobody
 * issuing one can change it, and the client is unaffected because the PDF
 * travels as an attachment. Saying so on every issue only buries the part that
 * matters — that the certificate went out — in a sentence that reads like a
 * fault. The reason still goes to the execution log for anyone diagnosing it.
 */
function shareFileByLink_(file) {
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return true;
  } catch (error) {
    console.info('Link sharing refused by Workspace policy: ' +
      String(error && error.message || error).slice(0, 160));
    return false;
  }
}

/** Portal administrators, for granting access to files that hold client data. */
function activeAdminEmails_() {
  var sh = ensureWhitelistSheet_();
  if (sh.getLastRow() < 2) return [];
  var hdr = getHeaderMap_(sh);
  var cEmail = idxOf_(hdr, ['email','e-mail']), cActive = idxOf_(hdr, ['active','enabled']);
  if (cEmail < 0) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .filter(function (row) {
      return safeTrim_(row[cEmail]) &&
        (cActive < 0 || String(row[cActive]).toLowerCase() !== 'false');
    })
    .map(function (row) { return safeTrim_(row[cEmail]).toLowerCase(); });
}

/** Creates the folder on first use and remembers its id in Settings. */
function getOrCreateFolder_(settingKey, folderName) {
  var settings = readSettings_(), existing = safeTrim_(settings[settingKey]);
  if (existing) {
    try {
      var folder = DriveApp.getFolderById(existing);
      folder.getName();
      return folder;
    } catch (_) {}
  }
  var created = DriveApp.createFolder(folderName);
  writeSettings_({ [settingKey]: created.getId() });
  return created;
}

// ------------------------------ Sheet setup ----------------------------------

function setupColumn_(header, aliases) {
  return { header: header, aliases: [header].concat(aliases || []) };
}

/** Idempotent: re-running setup does not stack duplicate triggers. */
function ensureDailyTrigger_(handlerName, atHour) {
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === handlerName;
  });
  if (existing.length) return false;
  ScriptApp.newTrigger(handlerName).timeBased().everyDays(1).atHour(atHour || 3).create();
  return true;
}

function formatHeaderRow_(sh) {
  sh.setFrozenRows(1);
  if (sh.getLastColumn() > 0)
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#0032a0').setFontColor('#ffffff');
}

/**
 * Sheets already checked in this execution. readSettings_ alone runs several
 * times in one request, and each pass re-read the header row to learn nothing
 * new — columns are only ever added, never removed, while a request runs.
 */
var ENSURED_SHEETS_ = {};

function ensureSetupSheet_(ss, sheetName, columns) {
  if (ENSURED_SHEETS_[sheetName])
    return { sheet: ENSURED_SHEETS_[sheetName], created: false, headersAdded: [] };
  var sh = ss.getSheetByName(sheetName), created = false, added = [];
  if (!sh) { sh = ss.insertSheet(sheetName); created = true; }
  var hdr = getHeaderMap_(sh);
  columns.forEach(function (column) {
    if (idxOf_(hdr, column.aliases) < 0) {
      var nextColumn = sh.getLastColumn() + 1;
      sh.getRange(1, nextColumn).setValue(column.header);
      hdr[String(column.header).toLowerCase()] = nextColumn - 1;
      added.push(column.header);
    }
  });
  // Formatting is a write, and this runs on nearly every request — a client's
  // submission, every settings read, every audit entry. Restyling a header
  // that has not changed cost a slow write each time, so it now happens only
  // when this call changed the header. setupCsmSheets restyles all of them.
  if (created || added.length) formatHeaderRow_(sh);
  ENSURED_SHEETS_[sheetName] = sh;
  return { sheet: sh, created: created, headersAdded: added };
}

function responseColumns_() {
  var columns = [
    setupColumn_('Timestamp', ['submitted at']),
    setupColumn_('ResponseID', ['response id','reference']),
    setupColumn_('SubmissionID', ['submission id']),
    setupColumn_('TransactionDate', ['transaction date','date']),
    setupColumn_('Month'), setupColumn_('Year'),
    setupColumn_('ClientType', ['client type']),
    setupColumn_('Sex'), setupColumn_('Age'),
    setupColumn_('Region'), setupColumn_('RegionCode', ['region code']),
    setupColumn_('ServiceID', ['service id']),
    setupColumn_('ServiceCode', ['service code']),
    setupColumn_('ServiceName', ['service name']),
    setupColumn_('OtherService', ['other service'])
  ];
  CC_KEYS.forEach(function (key) { columns.push(setupColumn_(key.toUpperCase())); });
  SQD_KEYS.forEach(function (key) { columns.push(setupColumn_(key.toUpperCase())); });
  return columns.concat([
    setupColumn_('Suggestions', ['comments','comments/suggestions']),
    setupColumn_('Email', ['e-mail']),
    setupColumn_('Language'),
    setupColumn_('COARequested', ['coa requested']),
    setupColumn_('COATitle', ['coa title']),
    setupColumn_('COAName', ['coa name']),
    setupColumn_('COAAgency', ['coa agency']),
    setupColumn_('COAPurpose', ['coa purpose']),
    setupColumn_('COADateFrom', ['coa date from']),
    setupColumn_('COADateTo', ['coa date to']),
    setupColumn_('COAStatus', ['coa status']),
    setupColumn_('COALink', ['coa link']),
    setupColumn_('COAIssuedAt', ['coa issued at']),
    setupColumn_('COAIssueKey', ['coa issue key']),
    setupColumn_('COAIssuedDetails', ['coa issued details']),
    setupColumn_('VerificationCode', ['verification code']),
    setupColumn_('VerificationURL', ['verification url'])
  ]);
}

/**
 * Adds any response column this version needs and the sheet lacks, for the
 * admin paths that write one. setupCsmSheets does the same, but nothing
 * reminds anyone to re-run it, and writeResponseCells_ skips a missing column
 * without a word — which for the issued-details snapshot would silently put
 * verification back to reading the editable fields.
 */
function ensureResponseColumns_() {
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_RESPONSES, responseColumns_()).sheet;
}

/**
 * Creates the spreadsheet schema. Safe to run again: existing rows and
 * recognized columns are preserved and only missing columns are appended.
 */
function setupCsmSheets() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Sheet setup is already running. Please try again.');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), props = PropertiesService.getScriptProperties();
    if (!props.getProperty('AUDIT_HASH_SECRET')) props.setProperty('AUDIT_HASH_SECRET', randomSecret_());

    var responses = ensureSetupSheet_(ss, SHEET_RESPONSES, responseColumns_());
    var services = ensureSetupSheet_(ss, SHEET_SERVICES, [
      setupColumn_('service_id'), setupColumn_('code'), setupColumn_('name_en'), setupColumn_('name_tl'),
      setupColumn_('category'), setupColumn_('active'), setupColumn_('has_fees'), setupColumn_('sort_order'),
      setupColumn_('created_at'), setupColumn_('updated_at')
    ]);
    var stats = ensureSetupSheet_(ss, SHEET_SERVICE_STATS, [
      setupColumn_('period_key'), setupColumn_('service_id'), setupColumn_('clients'),
      setupColumn_('transactions'), setupColumn_('remarks'), setupColumn_('updated_at')
    ]);
    var settings = ensureSetupSheet_(ss, SHEET_SETTINGS, [setupColumn_('key'), setupColumn_('value')]);
    var reports = ensureSetupSheet_(ss, SHEET_REPORTS, [
      setupColumn_('report_id'), setupColumn_('name'), setupColumn_('period_key'), setupColumn_('period_label'),
      setupColumn_('file_id'), setupColumn_('url'), setupColumn_('created_at'), setupColumn_('created_by')
    ]);
    var whitelist = ensureSetupSheet_(ss, SHEET_WHITELIST, [
      setupColumn_('user_id'), setupColumn_('name'), setupColumn_('role'), setupColumn_('email', ['e-mail']),
      setupColumn_('active', ['enabled']), setupColumn_('created_at'), setupColumn_('updated_at')
    ]);
    var users = ensureSetupSheet_(ss, SHEET_USERS, [
      setupColumn_('Email'), setupColumn_('PasswordHash', ['password hash']), setupColumn_('Salt'),
      setupColumn_('Name', ['display name']), setupColumn_('Role'), setupColumn_('Active'), setupColumn_('CreatedAt', ['created at'])
    ]);
    var audit = ensureSetupSheet_(ss, SHEET_AUDIT, [
      setupColumn_('timestamp'), setupColumn_('audit_id'), setupColumn_('actor_email'), setupColumn_('actor_role'),
      setupColumn_('action'), setupColumn_('target_type'), setupColumn_('target_id'), setupColumn_('outcome'),
      setupColumn_('details'), setupColumn_('request_id'), setupColumn_('previous_hash'), setupColumn_('entry_hash')
    ]);
    audit.sheet.getRange('A:A').setNumberFormat('@');

    var programsRestored = seedServices_(services.sheet);
    seedSettings_();
    // Setting up the sheets is the important part; a trigger that cannot be
    // installed is worth reporting, not worth failing the whole setup over.
    var triggerStatus;
    try {
      triggerStatus = ensureDailyTrigger_('pruneAdminSessions', 3) ? 'installed' : 'already present';
    } catch (triggerError) {
      triggerStatus = 'could not be installed (' +
        String(triggerError && triggerError.message || triggerError).slice(0, 120) +
        ') — add a daily trigger for pruneAdminSessions by hand.';
    }
    var changeTriggerStatus;
    try {
      changeTriggerStatus = ensureChangeTrigger_('onSpreadsheetChange') ? 'installed' : 'already present';
    } catch (triggerError) {
      changeTriggerStatus = 'could not be installed (' +
        String(triggerError && triggerError.message || triggerError).slice(0, 120) +
        ') — hand edits to the sheet will show on the dashboard within ' + (RESULT_CACHE_SECONDS_ / 60) + ' minutes.';
    }
    // The schema may have changed under cached results.
    invalidateResultCache_();

    // Running setup is the moment to put every header right, including ones
    // someone restyled by hand; ensureSetupSheet_ no longer does it per call.
    [responses, services, stats, settings, reports, whitelist, users, audit].forEach(function (result) {
      formatHeaderRow_(result.sheet);
    });

    return {
      status: 'OK',
      spreadsheetUrl: ss.getUrl(),
      sessionPruneTrigger: triggerStatus,
      resultCacheTrigger: changeTriggerStatus,
      programsRestored: programsRestored.length ? programsRestored : 'none missing',
      sheets: [responses, services, stats, settings, reports, whitelist, users, audit].map(function (result) {
        return { name: result.sheet.getName(), created: result.created, headersAdded: result.headersAdded };
      }),
      nextStep: 'Run setupCsmSecurity(), copy its submit token into Vercel as SUBMIT_SHARED_TOKEN, then edit and run seedUsers().'
    };
  } finally { lock.releaseLock(); }
}

var DEFAULT_SERVICES_ = [
  { code: 'CEM/CED', name_en: 'Application for Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)', name_tl: 'Aplikasyon para sa Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)', category: 'main', has_fees: true },
  { code: 'SIAP 1', name_en: 'Application for Student Internship Program (SIAP) Phase 1', name_tl: 'Aplikasyon para sa Student Internship Program (SIAP) Phase 1', category: 'main' },
  { code: 'SIAP 2', name_en: 'Application for Student Internship Program (SIAP) Phase 2', name_tl: 'Aplikasyon para sa Student Internship Program (SIAP) Phase 2', category: 'main' },
  { code: 'BI INDORSEMENT', name_en: 'Request for Endorsement for Conversion/Extension of Visa of Foreign Students to the Bureau of Immigration', name_tl: 'Kahilingan para sa Endorsement para sa Conversion/Extension ng Visa ng mga Dayuhang Estudyante sa Bureau of Immigration', category: 'main' },
  { code: 'OTHER', name_en: 'Other Services', name_tl: 'Iba pang Serbisyo', category: 'other' }
];

/**
 * Adds any default program the sheet is missing, matched by code.
 *
 * This used to return early if the sheet had a single row, so a Services tab
 * that ended up partially populated stayed that way however often setup was
 * re-run — and since the landing page and the survey list exactly what this
 * sheet holds, the missing programs simply never appeared. Rows that already
 * exist are left alone, including ones renamed or deactivated on purpose.
 */
function seedServices_(sheet) {
  var hdr = getHeaderMap_(sheet), now = new Date(), existing = {};
  var codeCol = idxOf_(hdr, ['code']);
  if (sheet.getLastRow() >= 2 && codeCol >= 0)
    sheet.getRange(2, codeCol + 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach(function (row) {
        var code = safeTrim_(row[0]).toUpperCase();
        if (code) existing[code] = true;
      });

  var added = [];
  DEFAULT_SERVICES_.forEach(function (service, index) {
    if (existing[service.code.toUpperCase()]) return;
    var row = new Array(sheet.getLastColumn()).fill('');
    row[hdr['service_id']] = 'S-' + Utilities.getUuid().replace(/-/g,'').slice(0, 8).toUpperCase();
    row[hdr['code']] = safeSheetValue_(service.code);
    row[hdr['name_en']] = safeSheetValue_(service.name_en);
    row[hdr['name_tl']] = safeSheetValue_(service.name_tl);
    row[hdr['category']] = service.category;
    row[hdr['active']] = true;
    row[hdr['has_fees']] = service.has_fees === true;
    row[hdr['sort_order']] = (index + 1) * 10;
    row[hdr['created_at']] = now;
    row[hdr['updated_at']] = now;
    sheet.appendRow(row);
    added.push(service.code);
  });

  backfillServiceFees_(sheet);
  // The public list is cached for 15 minutes; without this the restored
  // programs would not show up on the portal until it expired.
  if (added.length) invalidatePublicCache_();
  return added;
}

function seedSettings_() {
  var existing = readSettings_(), defaults = {
    office_name: 'Office of Student Development and Services (OSDS)',
    coa_signatory: '', coa_designation: '',
    report_prepared_by: '', report_prepared_title: '',
    report_reviewed_by: '', report_reviewed_title: '',
    report_approved_by: '', report_approved_title: ''
  }, missing = {};
  Object.keys(defaults).forEach(function (key) { if (!(key in existing)) missing[key] = defaults[key]; });
  if (Object.keys(missing).length) writeSettings_(missing);
}

/**
 * Run once and copy the returned submitSharedToken into Vercel as
 * SUBMIT_SHARED_TOKEN. Apps Script keeps only its SHA-256 hash. Running it
 * again rotates both secrets and signs out every administrator.
 */
function setupCsmSecurity() {
  var sharedToken = randomSecret_(), sessionSecret = randomSecret_();
  var properties = PropertiesService.getScriptProperties(), existing = properties.getProperties();
  Object.keys(existing).forEach(function (key) {
    if (key.indexOf('ADMIN_SESSION_') === 0) properties.deleteProperty(key);
  });
  properties.setProperties({
    SUBMIT_SHARED_TOKEN_HASH: sha256Base64_(sharedToken),
    SESSION_HASH_SECRET: sessionSecret,
    AUDIT_HASH_SECRET: existing.AUDIT_HASH_SECRET || randomSecret_(),
    SECURITY_SECRETS_UPDATED_AT: new Date().toISOString()
  }, false);
  return {
    status: 'OK',
    submitSharedToken: sharedToken,
    vercelVariable: 'SUBMIT_SHARED_TOKEN',
    warning: 'Copy this token to Vercel now. Apps Script does not store it in plain text. Existing admin sessions were invalidated.'
  };
}

/** Apps Script does not display return values, so mirror the token to the log. */
function logSubmitSharedToken() {
  Logger.log(JSON.stringify(setupCsmSecurity(), null, 2));
}

// ------------------------------- Data reset -----------------------------------

/**
 * The sheets a reset empties, and the ones it must not touch.
 *
 * Everything here is collected data. Services, Settings, Users and Whitelist
 * are configuration — the office spends real effort on the program list, the
 * signatory block and the accounts, and none of it is what "start clean" means.
 * Naming both sets explicitly is deliberate: a reset written as "every sheet
 * except these" quietly starts clearing anything added later.
 */
var RESET_DATA_SHEETS_ = [SHEET_RESPONSES, SHEET_SERVICE_STATS, SHEET_REPORTS, SHEET_AUDIT];
var RESET_KEEPS_ = [SHEET_SERVICES, SHEET_SETTINGS, SHEET_USERS, SHEET_WHITELIST];

/**
 * What a reset would remove, without removing it.
 *
 * Run this first. It is the same walk resetCsmData() makes, so the counts it
 * reports are the rows that would actually go.
 */
function previewCsmDataReset() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), counts = {}, total = 0;
  RESET_DATA_SHEETS_.forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    var rows = sheet && sheet.getLastRow() > 1 ? sheet.getLastRow() - 1 : 0;
    counts[name] = sheet ? rows : 'sheet not created yet';
    if (sheet) total += rows;
  });
  var result = {
    wouldDelete: counts,
    totalRows: total,
    wouldKeep: RESET_KEEPS_,
    note: 'Nothing has been changed. To go ahead, edit resetCsmData() as its comment describes and run it.'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Empties the collected data so the portal can be handed over clean.
 *
 * Run once from the Apps Script editor, after setupCsmSheets(), when the trial
 * responses gathered while testing should not be part of the first real
 * quarter. It is deliberately not reachable through doPost: no administrator
 * signed in through the portal can trigger it, whatever their role.
 *
 * To run it, replace CHANGE_THIS_TO_CONFIRM below with the word RESET and run
 * the function. It refuses otherwise — the same guard seedUsers() uses, and for
 * the same reason: an editor-run function is one misclick away from the Run
 * button, and this one cannot be undone from here.
 *
 * Certificates and report workbooks already in Drive are left alone. They are
 * outside this spreadsheet, a reset should not reach across into a Drive it was
 * not asked about, and the trial ones are easy to find and bin by hand.
 */
function resetCsmData() {
  var confirmation = 'CHANGE_THIS_TO_CONFIRM';
  return resetCsmData_(confirmation);
}

function resetCsmData_(confirmation) {
  if (safeTrim_(confirmation).toUpperCase() !== 'RESET')
    throw new Error('Edit resetCsmData() and replace CHANGE_THIS_TO_CONFIRM with RESET before running it.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000))
    throw new Error('Another operation is running. Wait for it to finish, then run this again.');
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet(), cleared = {}, total = 0;
    RESET_DATA_SHEETS_.forEach(function (name) {
      var sheet = ss.getSheetByName(name);
      if (!sheet) { cleared[name] = 'not created yet'; return; }
      var rows = sheet.getLastRow() - 1;
      // deleteRows, not clearContent: cleared cells still count towards
      // getLastRow, so every later append would land below a block of blanks
      // and every full-sheet read would page through them.
      if (rows > 0) sheet.deleteRows(2, rows);
      cleared[name] = rows > 0 ? rows : 0;
      total += Math.max(0, rows);
    });

    // The audit log is a hash chain whose head lives in script properties, and
    // adminGetAuditLog compares the two. Emptying the sheet and leaving the
    // head behind reports a broken chain on a portal that has done nothing yet.
    // The dropped-entry counters are part of that same report.
    var props = PropertiesService.getScriptProperties();
    ['AUDIT_HEAD_HASH', 'AUDIT_DROPPED_COUNT', 'AUDIT_DROPPED_LAST'].forEach(function (key) {
      props.deleteProperty(key);
    });

    // The programme list is unchanged, but the public copy of it is cached and
    // a reset is exactly when someone is watching the portal for a change.
    invalidatePublicCache_();
    invalidateResultCache_();

    // One entry, written after the clear, so the log opens with the reset that
    // emptied it rather than with an unexplained gap.
    //
    // The email is resolved separately and defensively. Session.getEffectiveUser
    // needs an OAuth scope this project does not request, and asking for it
    // would force everyone to re-authorise the deployment for a single
    // editor-run function. Nested inside the audit call, that lookup threw and
    // took the whole entry with it — the reset emptied the log and then failed
    // to say so, which is the one outcome this entry exists to prevent. Losing
    // the name is a footnote; losing the record is the bug.
    var actorEmail = '';
    try {
      actorEmail = safeTrim_(Session.getEffectiveUser().getEmail()).toLowerCase();
    } catch (_) {
      // Left blank. Apps Script logs the executing account against the run.
    }
    try {
      appendAuditForRequest_('csmDataReset', {}, true, '',
        { email: actorEmail, role: 'script' }, {});
    } catch (auditError) {
      console.error('Reset recorded no audit entry: ' + String(auditError && auditError.message || auditError));
    }

    var result = {
      status: 'OK',
      deletedRows: cleared,
      totalRows: total,
      kept: RESET_KEEPS_,
      nextStep: 'Confirm the Programs list and the Settings signatory block are still as you want them, then submit one test response and delete its row.'
    };
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// -------------------------------- Settings -----------------------------------

function ensureSettingsSheet_() {
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_SETTINGS,
    [setupColumn_('key'), setupColumn_('value')]).sheet;
}

function readSettings_() {
  var sh = ensureSettingsSheet_(), out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (row) {
    var key = safeTrim_(row[0]);
    if (key) out[key] = safeTrim_(row[1]);
  });
  return out;
}

function writeSettings_(values) {
  var sh = ensureSettingsSheet_(), lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Settings are busy. Please try again.');
  try {
    var rows = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
    var index = {};
    rows.forEach(function (row, i) { var key = safeTrim_(row[0]); if (key) index[key] = i + 2; });
    Object.keys(values).forEach(function (key) {
      var value = safeSheetValue_(safeTrim_(values[key]));
      if (index[key]) sh.getRange(index[key], 2).setValue(value);
      else { sh.appendRow([key, value]); index[key] = sh.getLastRow(); }
    });
  } finally { lock.releaseLock(); }
  invalidatePublicCache_();
  return readSettings_();
}

// -------------------------------- Services -----------------------------------

/**
 * Fills in the fees flag for any program still missing one, using the defaults
 * that ship with the portal.
 *
 * A blank cell and a deliberate "no" are the same value once read, so the gap
 * between adding the column and filling it was dangerous: readServices_ maps
 * blank to false, the Programs form shows the box unticked, and the first save
 * writes that guess back as a decision — which then looks like an answer worth
 * preserving and leaves the real default stranded. Filling the column the
 * moment it appears means that gap never exists. Blank cells only.
 */
function backfillServiceFees_(sheet) {
  // Whichever request first touches the Services sheet runs this, and that is
  // as likely to be a client pressing Submit as an administrator opening the
  // Programs page. So it must be cheap — one read and one write rather than a
  // write per row — and it must never be able to fail the request that
  // happened to trigger it. A failure here leaves the cells blank, and the
  // next call simply tries again.
  try {
    var hdr = getHeaderMap_(sheet);
    var feeCol = idxOf_(hdr, ['has_fees']), codeCol = idxOf_(hdr, ['code']);
    if (feeCol < 0 || codeCol < 0 || sheet.getLastRow() < 2) return 0;

    var charges = {};
    DEFAULT_SERVICES_.forEach(function (service) {
      if (service.has_fees) charges[service.code.toUpperCase()] = true;
    });

    var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
    var column = [], filled = 0;
    rows.forEach(function (row) {
      if (safeTrim_(row[feeCol]) !== '') {          // already answered
        column.push([row[feeCol]]);
        return;
      }
      column.push([charges[safeTrim_(row[codeCol]).toUpperCase()] === true]);
      filled++;
    });
    if (!filled) return 0;

    sheet.getRange(2, feeCol + 1, column.length, 1).setValues(column);
    invalidatePublicCache_();
    // The overview reads every answer through this flag.
    invalidateResultCache_();
    return filled;
  } catch (error) {
    console.error('has_fees backfill skipped: ' + String(error && error.message || error));
    return 0;
  }
}

function ensureServicesSheet_() {
  var setup = ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_SERVICES, [
    setupColumn_('service_id'), setupColumn_('code'), setupColumn_('name_en'), setupColumn_('name_tl'),
    setupColumn_('category'), setupColumn_('active'), setupColumn_('has_fees'), setupColumn_('sort_order'),
    setupColumn_('created_at'), setupColumn_('updated_at')
  ]);
  // Whichever request first brings the column into being also populates it, so
  // no caller ever sees the column blank — not even the one that created it.
  if (setup.headersAdded.indexOf('has_fees') >= 0) backfillServiceFees_(setup.sheet);
  return setup.sheet;
}

function readServices_() {
  var sh = ensureServicesSheet_();
  if (sh.getLastRow() < 2) return [];
  var hdr = getHeaderMap_(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .map(function (row, index) {
      return {
        rowIndex: index + 2,
        service_id: safeTrim_(row[hdr['service_id']]),
        code: safeTrim_(row[hdr['code']]),
        name_en: safeTrim_(row[hdr['name_en']]),
        name_tl: safeTrim_(row[hdr['name_tl']]),
        category: safeTrim_(row[hdr['category']]).toLowerCase() || 'main',
        active: String(row[hdr['active']]).toLowerCase() !== 'false',
        // Opt-in, so a service only asks about fees when someone says it charges them.
        has_fees: String(row[hdr['has_fees']]).toLowerCase() === 'true',
        sort_order: Number(row[hdr['sort_order']]) || 0
      };
    })
    .filter(function (service) { return service.service_id && service.code; })
    .sort(function (a, b) { return a.sort_order - b.sort_order; });
}

function adminGetServices(adminToken) {
  requireAdmin_(adminToken);
  return readServices_();
}

function adminSaveService(payload, adminToken) {
  requireAdmin_(adminToken);
  var code = safeTrim_(payload.code).toUpperCase(),
      nameEn = safeTrim_(payload.name_en),
      nameTl = safeTrim_(payload.name_tl),
      category = safeTrim_(payload.category).toLowerCase() === 'other' ? 'other' : 'main',
      active = payload.active !== false && String(payload.active).toLowerCase() !== 'false',
      serviceId = safeTrim_(payload.service_id);
  if (!code || code.length > 24) throw new Error('A short program code of 1-24 characters is required.');
  if (!nameEn) throw new Error('The English program name is required.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Program management is busy. Please try again.');
  try {
    var sh = ensureServicesSheet_(), hdr = getHeaderMap_(sh), existing = readServices_();
    var clash = existing.filter(function (service) {
      return service.code === code && service.service_id !== serviceId;
    });
    if (clash.length) throw new Error('Another program already uses the code ' + code + '.');

    var current = existing.filter(function (service) { return service.service_id === serviceId; })[0];
    var rowIndex = current ? current.rowIndex : sh.getLastRow() + 1;
    var values = current
      ? sh.getRange(rowIndex, 1, 1, sh.getLastColumn()).getValues()[0]
      : new Array(sh.getLastColumn()).fill('');
    if (!serviceId) serviceId = 'S-' + Utilities.getUuid().replace(/-/g,'').slice(0, 8).toUpperCase();

    var sortOrder = payload.sort_order === '' || payload.sort_order == null
      ? (current ? current.sort_order : (existing.length + 1) * 10)
      : Number(payload.sort_order) || 0;

    // An update that does not mention the flag leaves it as it was, the way
    // sort_order above already behaves. Reading a missing field as false would
    // let a partial payload — an admin page still running the previous bundle,
    // say — quietly stop a fee-charging program from asking about fees, with
    // nothing on screen to show it happened.
    var hasFees = 'has_fees' in payload
      ? (payload.has_fees === true || String(payload.has_fees).toLowerCase() === 'true')
      : (current ? current.has_fees === true : false);

    values[hdr['service_id']] = serviceId;
    values[hdr['code']] = safeSheetValue_(code);
    values[hdr['name_en']] = safeSheetValue_(nameEn);
    values[hdr['name_tl']] = safeSheetValue_(nameTl);
    values[hdr['category']] = category;
    values[hdr['active']] = active;
    values[hdr['has_fees']] = hasFees;
    values[hdr['sort_order']] = sortOrder;
    if (!current) values[hdr['created_at']] = new Date();
    values[hdr['updated_at']] = new Date();
    sh.getRange(rowIndex, 1, 1, values.length).setValues([values]);
  } finally { lock.releaseLock(); }
  invalidatePublicCache_();
  // The overview reads every answer through the fees flag set here.
  invalidateResultCache_();
  return { status: 'OK', service_id: serviceId, code: code };
}

// ------------------------------ Public config ---------------------------------

function getPortalConfig() {
  var cache = CacheService.getScriptCache(), hit = cache.get('PUBLIC_CSM_CONFIG');
  if (hit) return JSON.parse(hit);
  var settings = readSettings_();
  var config = {
    officeName: settings.office_name || 'Office of Student Development and Services (OSDS)',
    services: readServices_()
      .filter(function (service) { return service.active; })
      .map(function (service) {
        return {
          service_id: service.service_id, code: service.code,
          name_en: service.name_en, name_tl: service.name_tl,
          category: service.category, active: true, has_fees: service.has_fees
        };
      })
  };
  var json = JSON.stringify(config);
  if (json.length < 90000) { try { cache.put('PUBLIC_CSM_CONFIG', json, PUBLIC_CACHE_SECONDS); } catch (_) {} }
  return config;
}

// ------------------------------- Submission -----------------------------------

/**
 * Region name -> report code. The official names the form now offers are
 * listed first; the portal's earlier, shorter labels are kept below them so
 * responses recorded before the rename still resolve to the same code and the
 * report's region columns stay continuous across the change.
 */
var REGION_CODES_ = {
  'national capital region': 'NCR',
  '01 - ilocos region': 'I',
  '02 - cagayan valley': 'II',
  '03 - central luzon': 'III',
  '04 - calabarzon': 'IV-A',
  '05 - bicol region': 'V',
  '06 - western visayas': 'VI',
  '07 - central visayas': 'VII',
  '08 - eastern visayas': 'VIII',
  '09 - zamboanga peninsula': 'IX',
  '10 - northern mindanao': 'X',
  '11 - davao region': 'XI',
  '12 - soccsksargen': 'XII',
  'caraga': 'CARAGA',
  'cordillera administrative region': 'CAR',
  'bangsamoro autonomous region in muslim mindanao': 'BARMM',
  'mimaropa': 'IV-B',
  'negros island region': 'NIR',

  // Retired labels, still present in older rows.
  'region ncr': 'NCR', 'region 1': 'I', 'region 2': 'II', 'region 3': 'III', 'region 4': 'IV-A',
  'region 5': 'V', 'region 6': 'VI', 'region 7': 'VII', 'region 8': 'VIII', 'region 9': 'IX',
  'region 10': 'X', 'region 11': 'XI', 'region 12': 'XII', 'region car': 'CAR',
  'region caraga': 'CARAGA', 'region mimaropa': 'IV-B', 'barmm': 'BARMM', 'nir': 'NIR'
};

function regionCode_(region) { return REGION_CODES_[safeTrim_(region).toLowerCase()] || 'N/A'; }

function makeVerificationCode_() {
  return 'OSDS-' + Utilities.getUuid().replace(/-/g,'').slice(0, 20).toUpperCase();
}

/**
 * The browser retries a submission whose response never arrived, and a slow
 * write here looks exactly like a failed one. Each form carries an id that
 * survives those retries, so the second arrival is answered with the first
 * reference instead of appending another row and inflating the CSM counts.
 *
 * Scans newest first: a duplicate is always recent. Returns null when the
 * SubmissionID column is absent, which keeps this safe on a sheet created
 * before the column existed.
 */
function findSubmissionById_(sheet, headerMap, submissionId) {
  var col = idxOf_(headerMap, ['submissionid','submission id']);
  if (col < 0 || !submissionId || sheet.getLastRow() < 2) return null;
  var values = sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (safeTrim_(values[i][0]) !== submissionId) continue;
    var row = sheet.getRange(i + 2, 1, 1, sheet.getLastColumn()).getValues()[0];
    var refCol = idxOf_(headerMap, ['responseid','response id','reference']);
    var coaCol = idxOf_(headerMap, ['coarequested','coa requested']);
    return {
      referenceId: refCol >= 0 ? safeTrim_(row[refCol]) : '',
      coaRequested: coaCol >= 0 && safeTrim_(row[coaCol]).toUpperCase() === 'YES'
    };
  }
  return null;
}

function submitResponse(formData) {
  formData = formData || {};
  // Bots fill every field they find; a real client never sees this one.
  if (safeTrim_(formData.website)) return { status: 'OK', referenceId: '', coaRequested: false };

  var email = safeTrim_(formData.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
    return { status: 'BAD_REQUEST', message: 'A valid email address is required.' };

  var clientType = safeTrim_(formData.clientType);
  if (['Citizen','Business','Government'].indexOf(clientType) < 0)
    return { status: 'BAD_REQUEST', message: 'Please select a valid client type.' };

  var transactionDate = parseDate_(formData.transactionDate);
  if (!transactionDate) return { status: 'BAD_REQUEST', message: 'A valid transaction date is required.' };
  // A day the office has not reached yet, or a mistyped year, files the
  // response under a quarter it does not belong to — and nothing in the report
  // would show it had been misfiled.
  var transactionDay = fmtDate_(transactionDate);
  if (transactionDay > fmtDate_(new Date()))
    return { status: 'BAD_REQUEST', message: 'The transaction date cannot be in the future.' };
  if (transactionDay < '2000-01-01')
    return { status: 'BAD_REQUEST', message: 'Please check the year of the transaction date.' };

  // Checked against the official list rather than merely for being non-empty.
  // The report counts by region code and regionCode_ maps anything unrecognised
  // to N/A, so a value from outside the list was stored and then dropped out of
  // the region table with nothing in the workbook to show a respondent had gone
  // missing. This is also what bounds the field: only a listed name gets in, so
  // it needs no separate length cap.
  var region = safeTrim_(formData.region);
  if (!region) return { status: 'BAD_REQUEST', message: 'Region of residence is required.' };
  if (regionCode_(region) === 'N/A')
    return { status: 'BAD_REQUEST', message: 'Please choose your region of residence from the list.' };

  var service = readServices_().filter(function (entry) {
    return entry.service_id === safeTrim_(formData.serviceId) && entry.active;
  })[0];
  // Also the answer when a programme is withdrawn while a client has the form
  // open. The code lets the browser refresh its list — its copy still offers
  // the programme, so a plain message had the client pick it and be refused
  // again on every Submit.
  if (!service)
    return {
      status: 'BAD_REQUEST',
      code: 'SERVICE_UNAVAILABLE',
      message: 'The service you chose is no longer offered. Please choose again from the list.'
    };

  // Checked against the choices the form offers, for the reason region and
  // the Charter answers are: the report has a column for MALE, FEMALE and N/A
  // (blank), and any other value was stored, counted in the Total and in no
  // column — leaving a row that does not add up.
  var sex = safeTrim_(formData.sex).toUpperCase();
  if (sex && sex !== 'MALE' && sex !== 'FEMALE')
    return { status: 'BAD_REQUEST', message: 'Please choose a valid option for sex.' };

  var otherService = safeTrim_(formData.otherService).slice(0, 200);
  if (service.category === 'other' && !otherService)
    return { status: 'BAD_REQUEST', message: 'Please specify the service you availed.' };

  var age = safeTrim_(formData.age);
  if (age && (!/^\d{1,3}$/.test(age) || Number(age) < 1 || Number(age) > 120))
    return { status: 'BAD_REQUEST', message: 'Age must be between 1 and 120.' };

  // CC2 and CC3 ask about a Charter the client has seen, so a client who says
  // they have never encountered one is not asked them and is recorded as N/A.
  // Decided here rather than taken on trust from the browser: the form can be
  // bypassed, and a rating of a document the respondent never saw is noise in
  // the filed table.
  var ccAnswers = {};
  CC_KEYS.forEach(function (key) { ccAnswers[key] = safeTrim_(formData[key]); });
  var unawareOfCharter = ccAnswers.cc1 === CC_UNAWARE_VALUE_;
  if (unawareOfCharter) { ccAnswers.cc2 = 'N/A'; ccAnswers.cc3 = 'N/A'; }

  // Each question is checked against the choices it actually offers, so a
  // value the report has no column for cannot be stored.
  for (var c = 0; c < CC_KEYS.length; c++) {
    var ccKey = CC_KEYS[c];
    var ccAllowed = unawareOfCharter && ccKey !== 'cc1' ? ['N/A'] : CC_OPTIONS_[ccKey];
    if (ccAllowed.indexOf(ccAnswers[ccKey]) < 0)
      return { status: 'BAD_REQUEST', message: 'Please answer all Citizen’s Charter questions.' };
  }

  // SQD5 asks about fees, so it is only put to clients of a service that
  // charges them. Everyone else is recorded as N/A, decided here rather than
  // taken on trust from the browser — the form can be bypassed, and a rating
  // for a fee nobody paid would quietly distort the filed average.
  var sqdAnswers = {};
  SQD_KEYS.forEach(function (key) { sqdAnswers[key] = safeTrim_(formData[key]); });
  if (!service.has_fees) sqdAnswers.sqd5 = 'N/A';

  for (var s = 0; s < SQD_KEYS.length; s++) {
    var sqdKey = SQD_KEYS[s];
    // Every client of a fee-charging service pays, so N/A is not an answer
    // there — accepting one would drop the response out of the Costs average
    // without anything to show it had been dropped.
    var allowed = sqdKey === 'sqd5' && service.has_fees
      ? SQD_RATED_OPTIONS_
      : SQD_OPTIONS_;
    if (allowed.indexOf(sqdAnswers[sqdKey]) < 0) {
      // A form rendered before this service was marked as charging a fee has
      // no control to satisfy this, so the client cannot act on a plain error
      // message. The code lets the browser refresh its copy of the service
      // list and put the question in front of them instead.
      if (sqdKey === 'sqd5' && service.has_fees)
        return {
          status: 'BAD_REQUEST',
          code: 'SQD5_REQUIRED',
          message: 'Please rate the fees you paid for this transaction.'
        };
      return {
        status: 'BAD_REQUEST',
        message: 'Please answer all Service Quality Dimension questions.'
      };
    }
  }

  var wantsCoa = safeTrim_(formData.wantsCoa).toLowerCase() === 'yes';
  var coaName = safeTrim_(formData.coaName).slice(0, 160);
  var coaAgency = safeTrim_(formData.coaAgency).slice(0, 200);
  var coaPurpose = safeTrim_(formData.coaPurpose).slice(0, 300);
  var coaFrom = parseDate_(formData.coaDateFrom);
  var coaTo = parseDate_(formData.coaDateTo);
  if (wantsCoa && (!coaName || !coaAgency || !coaPurpose || !coaFrom))
    return { status: 'BAD_REQUEST', message: 'Complete the Certificate of Appearance details.' };
  // adminSaveCoaDetails refuses this; the submission let it in, and the
  // certificate would then print "from August 9 to August 8".
  if (wantsCoa && coaTo && coaTo < coaFrom)
    return { status: 'BAD_REQUEST', message: 'The end date of your appearance cannot be earlier than its start.' };

  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
    if (!sh) throw new Error("Sheet 'Responses' not found. Run setupCsmSheets().");
    var hdr = getHeaderMap_(sh), lastCol = sh.getLastColumn(), row = new Array(lastCol).fill('');

    var submissionId = safeTrim_(formData.submissionId).slice(0, 64);
    var alreadyStored = findSubmissionById_(sh, hdr, submissionId);
    if (alreadyStored)
      return {
        status: 'OK',
        referenceId: alreadyStored.referenceId,
        coaRequested: alreadyStored.coaRequested,
        duplicate: true
      };

    var referenceId = 'CSM-' + Utilities.getUuid().replace(/-/g,'').slice(0, 10).toUpperCase();

    function put(names, value) {
      var col = idxOf_(hdr, names);
      if (col >= 0) row[col] = safeSheetValue_(value);
    }
    put(['timestamp'], new Date());
    put(['responseid'], referenceId);
    put(['submissionid'], submissionId);
    put(['transactiondate'], Utilities.formatDate(transactionDate, timezone_(), 'yyyy-MM-dd'));
    put(['month'], Utilities.formatDate(transactionDate, timezone_(), 'MMMM').toUpperCase());
    put(['year'], transactionDate.getFullYear());
    put(['clienttype'], clientType.toUpperCase());
    put(['sex'], sex);
    put(['age'], age || 'N/A');
    put(['region'], region);
    put(['regioncode'], regionCode_(region));
    put(['serviceid'], service.service_id);
    put(['servicecode'], service.code);
    put(['servicename'], service.name_en);
    put(['otherservice'], otherService);
    CC_KEYS.forEach(function (key) { put([key], ccAnswers[key]); });
    SQD_KEYS.forEach(function (key) { put([key], sqdAnswers[key]); });
    put(['suggestions'], safeTrim_(formData.suggestions).slice(0, 1500));
    put(['email'], email);
    // The only two the form has. Stored as sent, this was an unbounded field
    // any caller could fill with whatever it liked.
    put(['language'], safeTrim_(formData.language) === 'tl' ? 'tl' : 'en');
    put(['coarequested'], wantsCoa ? 'YES' : 'NO');
    put(['coatitle'], wantsCoa ? safeTrim_(formData.coaTitle).slice(0, 12) : '');
    put(['coaname'], wantsCoa ? coaName : '');
    put(['coaagency'], wantsCoa ? coaAgency : '');
    put(['coapurpose'], wantsCoa ? coaPurpose : '');
    put(['coadatefrom'], wantsCoa ? Utilities.formatDate(coaFrom, timezone_(), 'yyyy-MM-dd') : '');
    put(['coadateto'], wantsCoa && coaTo ? Utilities.formatDate(coaTo, timezone_(), 'yyyy-MM-dd') : '');
    put(['coastatus'], wantsCoa ? 'REQUESTED' : 'NONE');
    put(['verificationcode'], wantsCoa ? makeVerificationCode_() : '');

    sh.getRange(sh.getLastRow() + 1, 1, 1, lastCol).setValues([row]);
    invalidateResultCache_();
    return { status: 'OK', referenceId: referenceId, coaRequested: wantsCoa };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ------------------------------ Response reads ---------------------------------

/**
 * Record field -> the header names that may hold it, matching the aliases
 * declared in responseColumns_ so a sheet that predates a rename still reads.
 */
var RESPONSE_FIELDS_ = {
  referenceId: ['responseid','response id','reference'],
  timestamp: ['timestamp','submitted at'],
  transactionDate: ['transactiondate','transaction date','date'],
  month: ['month'],
  year: ['year'],
  clientType: ['clienttype','client type'],
  sex: ['sex'],
  age: ['age'],
  region: ['region'],
  regionCode: ['regioncode','region code'],
  serviceId: ['serviceid','service id'],
  serviceCode: ['servicecode','service code'],
  serviceName: ['servicename','service name'],
  otherService: ['otherservice','other service'],
  suggestions: ['suggestions','comments','comments/suggestions'],
  email: ['email','e-mail'],
  coaRequested: ['coarequested','coa requested'],
  coaTitle: ['coatitle','coa title'],
  coaName: ['coaname','coa name'],
  coaAgency: ['coaagency','coa agency'],
  coaPurpose: ['coapurpose','coa purpose'],
  coaDateFrom: ['coadatefrom','coa date from'],
  coaDateTo: ['coadateto','coa date to'],
  coaStatus: ['coastatus','coa status'],
  coaLink: ['coalink','coa link'],
  coaIssuedAt: ['coaissuedat','coa issued at'],
  coaIssueKey: ['coaissuekey','coa issue key'],
  coaIssuedDetails: ['coaissueddetails','coa issued details'],
  verificationCode: ['verificationcode','verification code'],
  verificationUrl: ['verificationurl','verification url']
};

/**
 * Resolves every column once per read. The row loop used to look each field up
 * by name again for every row — some forty header searches per row, each
 * lowercasing strings — which is what made a few thousand responses expensive
 * to page through rather than the single getValues call.
 */
function responseFieldColumns_(headerMap) {
  var columns = {};
  Object.keys(RESPONSE_FIELDS_).forEach(function (field) {
    columns[field] = idxOf_(headerMap, RESPONSE_FIELDS_[field]);
  });
  CC_KEYS.concat(SQD_KEYS).forEach(function (key) {
    columns[key] = idxOf_(headerMap, [key]);
  });
  return columns;
}

function cellText_(value, columnIndex) {
  return columnIndex >= 0 ? safeTrim_(value[columnIndex]) : '';
}

function buildResponseRecord_(value, col, rowIndex) {
  var record = {
    rowIndex: rowIndex,
    referenceId: cellText_(value, col.referenceId),
    timestamp: col.timestamp >= 0 ? value[col.timestamp] : '',
    transactionDate: col.transactionDate >= 0 ? fmtDate_(value[col.transactionDate]) : '',
    month: cellText_(value, col.month).toUpperCase(),
    year: col.year >= 0 ? Number(value[col.year]) || 0 : 0,
    clientType: cellText_(value, col.clientType).toUpperCase(),
    sex: cellText_(value, col.sex).toUpperCase(),
    age: cellText_(value, col.age),
    region: cellText_(value, col.region),
    regionCode: cellText_(value, col.regionCode) || 'N/A',
    serviceId: cellText_(value, col.serviceId),
    serviceCode: cellText_(value, col.serviceCode),
    serviceName: cellText_(value, col.serviceName),
    otherService: cellText_(value, col.otherService),
    suggestions: cellText_(value, col.suggestions),
    email: cellText_(value, col.email),
    coaRequested: cellText_(value, col.coaRequested).toUpperCase() === 'YES',
    coaTitle: cellText_(value, col.coaTitle),
    coaName: cellText_(value, col.coaName),
    coaAgency: cellText_(value, col.coaAgency),
    coaPurpose: cellText_(value, col.coaPurpose),
    coaDateFrom: col.coaDateFrom >= 0 ? fmtDate_(value[col.coaDateFrom]) : '',
    coaDateTo: col.coaDateTo >= 0 ? fmtDate_(value[col.coaDateTo]) : '',
    coaStatus: cellText_(value, col.coaStatus).toUpperCase() || 'NONE',
    coaLink: cellText_(value, col.coaLink),
    coaIssuedAt: cellText_(value, col.coaIssuedAt),
    coaIssueKey: cellText_(value, col.coaIssueKey),
    coaIssuedDetails: cellText_(value, col.coaIssuedDetails),
    verificationCode: cellText_(value, col.verificationCode),
    verificationUrl: cellText_(value, col.verificationUrl)
  };
  var answerKeys = CC_KEYS.concat(SQD_KEYS);
  for (var i = 0; i < answerKeys.length; i++)
    record[answerKeys[i]] = cellText_(value, col[answerKeys[i]]);
  record.overall = meanOf_(SQD_KEYS.map(function (key) { return record[key]; }));
  return record;
}

function readResponses_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
  if (!sh || sh.getLastRow() < 2) return { rows: [], sheet: sh, header: sh ? getHeaderMap_(sh) : {} };
  var hdr = getHeaderMap_(sh), col = responseFieldColumns_(hdr);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var rows = [];
  for (var i = 0; i < values.length; i++) {
    // Skip blank rows before building anything for them.
    if (!cellText_(values[i], col.referenceId)) continue;
    rows.push(buildResponseRecord_(values[i], col, i + 2));
  }
  return { rows: rows, sheet: sh, header: hdr };
}

/**
 * Finds one response by an exact match in a single column: reads that column
 * alone, then only the row that matched. readResponses_ parses every column of
 * every row, which is the wrong shape for a point lookup — and one of these
 * lookups sits behind the public, unauthenticated verification endpoint.
 */
function findResponseByColumn_(sheet, col, columnIndex, wanted) {
  wanted = safeTrim_(wanted).toUpperCase();
  if (columnIndex < 0 || !wanted || sheet.getLastRow() < 2) return null;
  var values = sheet.getRange(2, columnIndex + 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (safeTrim_(values[i][0]).toUpperCase() !== wanted) continue;
    var rowIndex = i + 2;
    return buildResponseRecord_(
      sheet.getRange(rowIndex, 1, 1, sheet.getLastColumn()).getValues()[0], col, rowIndex);
  }
  return null;
}

/** N/A and blanks are excluded from every CSM average, per the ARTA guidance. */
function numericScores_(values) {
  return values.map(function (value) { return Number(value); })
    .filter(function (score) { return score >= 1 && score <= 5; });
}
function meanOf_(values) {
  var scores = numericScores_(values);
  return scores.length ? scores.reduce(function (a, b) { return a + b; }, 0) / scores.length : 0;
}
function medianOf_(values) {
  var scores = numericScores_(values).sort(function (a, b) { return a - b; });
  if (!scores.length) return 0;
  var middle = Math.floor(scores.length / 2);
  return scores.length % 2 ? scores[middle] : (scores[middle - 1] + scores[middle]) / 2;
}
function round2_(value) { return Math.round((Number(value) || 0) * 100) / 100; }

/**
 * The one definition of an overall score: the mean of every valid SQD answer
 * across `records`, respondent-weighted, N/A excluded.
 *
 * The dashboard and the CSM Summary Report both call this. They used to
 * compute it two different ways — the dashboard over all answers, the report
 * as an unweighted average of per-service averages — so a program with two
 * respondents swung the filed figure as hard as one with two hundred, and the
 * two screens disagreed about the same quarter.
 */
function overallScore_(records) {
  var values = [];
  records.forEach(function (record) {
    SQD_KEYS.forEach(function (key) { values.push(record[key]); });
  });
  return round2_(meanOf_(values));
}

// ------------------------------ Period helpers ---------------------------------

var QUARTER_MONTHS_ = { '1': [0,1,2], '2': [3,4,5], '3': [6,7,8], '4': [9,10,11] };

function normalizePeriod_(period) {
  period = period || {};
  var year = Number(period.year) || new Date().getFullYear();
  var type = safeTrim_(period.type).toLowerCase() === 'year' ? 'year' : 'quarter';
  var quarter = String(period.quarter || '1');
  if (!QUARTER_MONTHS_[quarter]) quarter = '1';
  return {
    type: type, year: year, quarter: quarter,
    key: type === 'year' ? year + '-FY' : year + '-Q' + quarter,
    label: type === 'year' ? 'CY ' + year : ['','1st','2nd','3rd','4th'][Number(quarter)] + ' Quarter ' + year,
    shortLabel: type === 'year' ? 'CY ' + year : 'Q' + quarter + ' ' + year
  };
}

function inPeriod_(record, period) {
  if (record.year !== period.year) return false;
  if (period.type === 'year') return true;
  var date = parseDate_(record.transactionDate);
  if (!date) return false;
  return QUARTER_MONTHS_[period.quarter].indexOf(date.getMonth()) >= 0;
}

// -------------------------------- Analytics ------------------------------------

var AGE_BRACKETS_ = [
  { label: '16 & Below (Child)', min: 0, max: 16 },
  { label: '17-30 (Young Adult)', min: 17, max: 30 },
  { label: '31-45 (Middle-aged Adult)', min: 31, max: 45 },
  { label: 'Above 45 (Old-aged adult)', min: 46, max: 200 }
];

function ageBracketOf_(age) {
  var value = Number(age);
  if (!value || isNaN(value)) return 'N/A';
  for (var i = 0; i < AGE_BRACKETS_.length; i++)
    if (value >= AGE_BRACKETS_[i].min && value <= AGE_BRACKETS_[i].max) return AGE_BRACKETS_[i].label;
  return 'N/A';
}

function tally_(map, key) {
  key = key || 'N/A';
  map[key] = (map[key] || 0) + 1;
  return map;
}

function adminGetOverview(periodInput, adminToken) {
  requireAdmin_(adminToken);
  var period = normalizePeriod_(periodInput);
  return cachedResult_('OVERVIEW', period.key, periodInput && periodInput.fresh === true, function () {
    return computeOverview_(period);
  });
}

function computeOverview_(period) {
  var allRecords = readResponses_().rows;
  // Read through the same answer policy the CSM Summary Report applies (see
  // applyAnswerPolicy_ in Report.gs). Without it, responses collected before
  // the fees flag or the Charter rule existed kept their old SQD5 and CC2/CC3
  // answers here while the report treated them as N/A — so the dashboard and
  // the filed workbook gave two different scores for the same quarter.
  var records = applyAnswerPolicy_(
    allRecords.filter(function (record) { return inPeriod_(record, period); }),
    readServices_()
  );

  var sqd = {}, cc = {}, clientTypes = {}, sexes = {}, ageBrackets = {}, byService = {};
  SQD_KEYS.forEach(function (key) {
    sqd[key] = { mean: round2_(meanOf_(records.map(function (r) { return r[key]; }))) };
  });
  CC_KEYS.forEach(function (key) {
    cc[key] = {};
    records.forEach(function (record) { tally_(cc[key], record[key] || 'N/A'); });
  });
  records.forEach(function (record) {
    tally_(clientTypes, record.clientType);
    tally_(sexes, record.sex);
    tally_(ageBrackets, ageBracketOf_(record.age));
    var bucket = byService[record.serviceCode] || (byService[record.serviceCode] = {
      code: record.serviceCode, name: record.serviceName, records: []
    });
    bucket.records.push(record);
  });

  var aware = records.filter(function (record) {
    return ['1','2','3'].indexOf(record.cc1) >= 0;
  }).length;
  var coaIssued = records.filter(function (record) { return record.coaRequested && record.coaStatus === 'ISSUED'; }).length;
  var coaFailed = records.filter(function (record) { return record.coaRequested && record.coaStatus.indexOf('ERROR') === 0; }).length;
  // Pending certificates are a work queue, not a period statistic: an admin
  // needs to see everything still awaiting release regardless of the filter.
  var coaPending = allRecords.filter(function (record) {
    // PROCESSING too: an issuance cut off mid-run is still unreleased work.
    return record.coaRequested && (record.coaStatus === 'REQUESTED' || record.coaStatus === 'PROCESSING');
  }).length;

  return {
    period: period,
    totalResponses: records.length,
    overall: overallScore_(records),
    ccAwareness: records.length ? Math.round((aware / records.length) * 1000) / 10 : 0,
    sqd: sqd, cc: cc,
    clientTypes: clientTypes, sexes: sexes, ageBrackets: ageBrackets,
    services: Object.keys(byService).map(function (code) {
      var bucket = byService[code];
      return {
        code: code, name: bucket.name,
        respondents: bucket.records.length,
        overall: overallScore_(bucket.records)
      };
    }).sort(function (a, b) { return b.respondents - a.respondents; }),
    coa: { issued: coaIssued, pending: coaPending, failed: coaFailed }
  };
}

/**
 * Filters and pages over the whole sheet rather than handing the browser the
 * newest 500 rows to sift locally. That older shape quietly capped what an
 * administrator could see or search — the screen said "All responses" while
 * anything past the cap was simply absent — which is the wrong failure for the
 * record a compliance report is drawn from.
 *
 * Returns a page plus the true match count, so the UI can say what it is
 * showing and what it is not.
 */
function adminGetResponses(filters, adminToken) {
  requireAdmin_(adminToken);
  filters = filters || {};
  var query = safeTrim_(filters.query).toLowerCase();
  var serviceCode = safeTrim_(filters.serviceCode).toUpperCase();
  var coaStatus = safeTrim_(filters.coaStatus).toUpperCase();
  var period = filters.period && safeTrim_(filters.period.year)
    ? normalizePeriod_(filters.period) : null;
  var limit = Math.min(500, Math.max(25, Number(filters.limit) || 100));
  var offset = Math.max(0, Number(filters.offset) || 0);

  // Unfiltered paging is the common case, and it does not need the whole
  // sheet: the rows wanted are a window at the end of it. Reading just that
  // window keeps opening the Responses tab cheap however far the sheet grows.
  if (!query && !serviceCode && !coaStatus && !period) {
    var page = readResponseWindow_(offset, limit);
    return { rows: page.rows.map(publicResponse_), total: page.total, offset: offset, limit: limit };
  }

  var matched = readResponses_().rows.filter(function (record) {
    if (period && !inPeriod_(record, period)) return false;
    if (serviceCode && record.serviceCode.toUpperCase() !== serviceCode) return false;
    if (coaStatus && (record.coaStatus || 'NONE').toUpperCase() !== coaStatus) return false;
    if (!query) return true;
    return [record.referenceId, record.email, record.serviceName, record.otherService,
      record.region, record.clientType, record.suggestions]
      .join(' ').toLowerCase().indexOf(query) >= 0;
  });

  // Newest first, then page.
  return {
    rows: matched.reverse().slice(offset, offset + limit).map(publicResponse_),
    total: matched.length,
    offset: offset,
    limit: limit
  };
}

/** The response shape the admin table consumes. */
function publicResponse_(record) {
  var out = {
    referenceId: record.referenceId, transactionDate: record.transactionDate,
    clientType: record.clientType, sex: record.sex, age: record.age,
    region: record.region, serviceCode: record.serviceCode, serviceName: record.serviceName,
    otherService: record.otherService, email: record.email, suggestions: record.suggestions,
    overall: round2_(record.overall), coaStatus: record.coaStatus
  };
  CC_KEYS.concat(SQD_KEYS).forEach(function (key) { out[key] = record[key]; });
  return out;
}

/**
 * Reads one page from the end of the sheet, newest first, without parsing the
 * rows before it. `total` is taken from the sheet's own row count rather than
 * from a parse, so it stays exact without the cost.
 */
function readResponseWindow_(offset, limit) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
  if (!sh || sh.getLastRow() < 2) return { rows: [], total: 0 };
  var hdr = getHeaderMap_(sh), col = responseFieldColumns_(hdr);
  if (col.referenceId < 0) return { rows: [], total: 0 };

  // The reference column alone says which rows are real and how many there
  // are — an exact count, at a fraction of the cost of parsing every column.
  // Reading the sheet's row count instead would include any blank row.
  var refs = sh.getRange(2, col.referenceId + 1, sh.getLastRow() - 1, 1).getValues();
  var rowNumbers = [];
  for (var i = 0; i < refs.length; i++)
    if (safeTrim_(refs[i][0])) rowNumbers.push(i + 2);
  rowNumbers.reverse();                                   // newest first

  var total = rowNumbers.length;
  var wanted = rowNumbers.slice(offset, offset + limit);
  if (!wanted.length) return { rows: [], total: total };

  // One block read covers the page; only those rows are built into records.
  var top = Math.min.apply(null, wanted), bottom = Math.max.apply(null, wanted);
  var block = sh.getRange(top, 1, bottom - top + 1, sh.getLastColumn()).getValues();
  return {
    rows: wanted.map(function (rowNumber) {
      return buildResponseRecord_(block[rowNumber - top], col, rowNumber);
    }),
    total: total
  };
}

// --------------------------- Service statistics --------------------------------

function ensureServiceStatsSheet_() {
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_SERVICE_STATS, [
    setupColumn_('period_key'), setupColumn_('service_id'), setupColumn_('clients'),
    setupColumn_('transactions'), setupColumn_('remarks'), setupColumn_('updated_at')
  ]).sheet;
}

function readServiceStats_(periodKey) {
  var sh = ensureServiceStatsSheet_();
  if (sh.getLastRow() < 2) return {};
  var hdr = getHeaderMap_(sh), out = {};
  sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (row, index) {
    if (safeTrim_(row[hdr['period_key']]) !== periodKey) return;
    out[safeTrim_(row[hdr['service_id']])] = {
      rowIndex: index + 2,
      clients: safeTrim_(row[hdr['clients']]),
      transactions: safeTrim_(row[hdr['transactions']]),
      remarks: safeTrim_(row[hdr['remarks']])
    };
  });
  return out;
}

function adminGetServiceStats(periodInput, adminToken) {
  requireAdmin_(adminToken);
  var period = normalizePeriod_(periodInput);
  var stats = readServiceStats_(period.key);
  var records = readResponses_().rows.filter(function (record) { return inPeriod_(record, period); });
  return readServices_().map(function (service) {
    var stat = stats[service.service_id] || {};
    return {
      service_id: service.service_id, code: service.code, name_en: service.name_en,
      category: service.category,
      respondents: records.filter(function (record) { return record.serviceId === service.service_id; }).length,
      clients: stat.clients || '',
      transactions: stat.transactions || '',
      remarks: stat.remarks || ''
    };
  });
}

function adminSaveServiceStats(periodInput, rows, adminToken) {
  requireAdmin_(adminToken);
  var period = normalizePeriod_(periodInput);
  if (!Array.isArray(rows)) throw new Error('Invalid statistics payload.');
  // Counts of people and transactions: whole numbers, or blank for "not
  // entered". Anything else was stored as text and reached the report as NaN
  // or a negative total. Checked for every row before any is written, so a
  // bad figure cannot leave the period half saved.
  rows.forEach(function (entry) {
    ['clients', 'transactions'].forEach(function (key) {
      var value = safeTrim_(entry && entry[key]);
      if (value && !/^\d{1,9}$/.test(value))
        throw new Error('Client and transaction counts must be whole numbers of zero or more (' +
          safeTrim_(entry.code || entry.service_id) + ': "' + value.slice(0, 20) + '").');
    });
  });
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('Report statistics are busy. Please try again.');
  try {
    var sh = ensureServiceStatsSheet_(), hdr = getHeaderMap_(sh), existing = readServiceStats_(period.key);
    rows.forEach(function (entry) {
      var serviceId = safeTrim_(entry.service_id);
      if (!serviceId) return;
      var current = existing[serviceId];
      var rowIndex = current ? current.rowIndex : sh.getLastRow() + 1;
      var values = new Array(sh.getLastColumn()).fill('');
      values[hdr['period_key']] = period.key;
      values[hdr['service_id']] = serviceId;
      values[hdr['clients']] = safeTrim_(entry.clients);
      values[hdr['transactions']] = safeTrim_(entry.transactions);
      values[hdr['remarks']] = safeSheetValue_(safeTrim_(entry.remarks).slice(0, 300));
      values[hdr['updated_at']] = new Date();
      sh.getRange(rowIndex, 1, 1, values.length).setValues([values]);
      if (!current) existing[serviceId] = { rowIndex: rowIndex };
    });
  } finally { lock.releaseLock(); }
  return { status: 'OK', period: period.key };
}

// -------------------------- Admin credentials & sessions ------------------------

function seedUsers() {
  // Edit these values before running this function once from the Apps Script editor.
  var users = [
    { email: 'host@example.com', password: 'CHANGE_THIS_PASSWORD', name: 'Portal Host', role: 'superadmin' }
  ];
  if (users.some(function (user) { return user.password === 'CHANGE_THIS_PASSWORD'; }))
    throw new Error('Edit seedUsers() and replace CHANGE_THIS_PASSWORD before running it.');
  return users.map(function (user) { return seedUser(user.email, user.password, user.name, user.role); });
}

function seedUser(email, password, displayName, role, active) {
  email = safeTrim_(email).toLowerCase();
  password = String(password || '');
  displayName = safeTrim_(displayName);
  role = safeTrim_(role || 'admin').toLowerCase();
  active = active !== false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid user email is required.');
  if (password.length < 12) throw new Error('Admin passwords must contain at least 12 characters.');

  var setup = ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_USERS, [
    setupColumn_('Email'), setupColumn_('PasswordHash', ['password hash']), setupColumn_('Salt'),
    setupColumn_('Name', ['display name']), setupColumn_('Role'), setupColumn_('Active'), setupColumn_('CreatedAt', ['created at'])
  ]);
  var sh = setup.sheet, hdr = getHeaderMap_(sh), row = findRowByEmail_(sh, email);
  var salt = Utilities.getUuid() + Utilities.getUuid(), hash = hashAdminPassword_(password, salt);
  var lastCol = sh.getLastColumn();
  var values = row ? sh.getRange(row, 1, 1, lastCol).getValues()[0] : new Array(lastCol).fill('');
  function put(names, value) { var col = idxOf_(hdr, names); if (col >= 0) values[col] = safeSheetValue_(value); }
  put(['email'], email); put(['passwordhash','password hash'], hash); put(['salt'], salt);
  put(['name','display name'], displayName || email); put(['role'], role); put(['active'], active);
  if (!row) put(['createdat','created at'], new Date());
  if (row) sh.getRange(row, 1, 1, lastCol).setValues([values]); else sh.appendRow(values);
  // Sessions validated earlier in this execution were checked against the old
  // hash; nothing later in it may reuse that answer.
  ADMIN_SESSION_MEMO_ = {};
  upsertWhitelistUser_({ name: displayName || email, role: role, email: email, active: active });
  return { email: email, name: displayName || email, role: role };
}

function findRowByEmail_(sheet, email) {
  if (sheet.getLastRow() < 2) return 0;
  var hdr = getHeaderMap_(sheet), col = idxOf_(hdr, ['email','e-mail']);
  if (col < 0) return 0;
  var values = sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < values.length; i++)
    if (safeTrim_(values[i][0]).toLowerCase() === email) return i + 2;
  return 0;
}

function ensureWhitelistSheet_() {
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_WHITELIST, [
    setupColumn_('user_id'), setupColumn_('name'), setupColumn_('role'), setupColumn_('email', ['e-mail']),
    setupColumn_('active', ['enabled']), setupColumn_('created_at'), setupColumn_('updated_at')
  ]).sheet;
}

function upsertWhitelistUser_(user) {
  var sh = ensureWhitelistSheet_(), hdr = getHeaderMap_(sh), row = findRowByEmail_(sh, user.email), now = new Date();
  var existing = row ? sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0] : [];
  var createdCol = idxOf_(hdr, ['created_at']);
  var values = {
    user_id: user.user_id || (row ? safeTrim_(existing[idxOf_(hdr, ['user_id'])]) : '') || ('U-' + Utilities.getUuid().replace(/-/g,'').slice(0, 8)),
    name: user.name, role: user.role, email: user.email, active: user.active,
    created_at: (row && createdCol >= 0 && existing[createdCol]) || now,
    updated_at: now
  };
  if (!row) row = Math.max(2, sh.getLastRow() + 1);
  Object.keys(values).forEach(function (key) {
    sh.getRange(row, hdr[key] + 1).setValue(safeSheetValue_(values[key]));
  });
  return values;
}

function syncCredentialMetadata_(user) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  var row = sh ? findRowByEmail_(sh, user.email) : 0;
  if (!sh || !row) throw new Error('A password is required when creating a new user.');
  var hdr = getHeaderMap_(sh), updates = { name: user.name, role: user.role, active: user.active };
  Object.keys(updates).forEach(function (key) {
    var col = idxOf_(hdr, [key]);
    if (col >= 0) sh.getRange(row, col + 1).setValue(safeSheetValue_(updates[key]));
  });
}

function adminGetUsers(adminToken) {
  requireSuperadmin_(adminToken);
  var sh = ensureWhitelistSheet_();
  if (sh.getLastRow() < 2) return [];
  var hdr = getHeaderMap_(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .filter(function (row) { return safeTrim_(row[idxOf_(hdr, ['email'])]); })
    .map(function (row) {
      return {
        user_id: safeTrim_(row[idxOf_(hdr, ['user_id'])]),
        name: safeTrim_(row[idxOf_(hdr, ['name'])]),
        role: safeTrim_(row[idxOf_(hdr, ['role'])]),
        email: safeTrim_(row[idxOf_(hdr, ['email'])]),
        active: String(row[idxOf_(hdr, ['active'])]).toLowerCase() !== 'false',
        created_at: fmtDate_(row[idxOf_(hdr, ['created_at'])]),
        updated_at: fmtDate_(row[idxOf_(hdr, ['updated_at'])])
      };
    });
}

function adminSaveUser(payload, adminToken) {
  var session = requireSuperadmin_(adminToken);
  var email = safeTrim_(payload.email).toLowerCase(), name = safeTrim_(payload.name);
  var role = safeTrim_(payload.role).toLowerCase();
  var active = payload.active !== false && String(payload.active).toLowerCase() !== 'false';
  var password = String(payload.password || '');
  if (!name) throw new Error('Name is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email is required.');
  if (['admin','superadmin'].indexOf(role) < 0) throw new Error('Role must be admin or superadmin.');
  if (session.email === email && (role !== 'superadmin' || !active))
    throw new Error('You cannot demote or deactivate your own superadmin account.');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('User management is busy. Please try again.');
  try {
    var existing = findRowByEmail_(ensureWhitelistSheet_(), email);
    if (!existing && password.length < 12) throw new Error('New users require a password of at least 12 characters.');
    if (password && password.length < 12) throw new Error('Passwords must contain at least 12 characters.');
    if (password) {
      seedUser(email, password, name, role, active);
      // The new hash ends every session opened with the old one (see
      // getAdminSession_). A superadmin changing their own password keeps the
      // tab they did it from, rather than being thrown out mid-save.
      if (session.email === email) restampAdminSession_(adminToken);
    }
    else syncCredentialMetadata_({ email: email, name: name, role: role, active: active });
    return upsertWhitelistUser_({ user_id: safeTrim_(payload.user_id), name: name, role: role, email: email, active: active });
  } finally { lock.releaseLock(); }
}

/** Hashed in place of a real salt when the email matches no account. */
var UNKNOWN_ACCOUNT_SALT_ = 'no-such-account';

/**
 * Sign-in attempts are counted twice: per account and device (the email plus
 * the client IP the proxy reports), which is the limit a guesser runs into;
 * and per account alone, set higher, which caps guessing spread across many
 * addresses. The single per-account limit of five this replaces let anyone who
 * knew an administrator's email keep them locked out by failing five times a
 * quarter-hour — the throttle had become the attack.
 */
var LOGIN_DEVICE_LIMIT_ = 5, LOGIN_ACCOUNT_LIMIT_ = 30, LOGIN_WINDOW_SECONDS_ = 900;

function adminLogin(email, password, requestContext) {
  email = safeTrim_(email).toLowerCase();
  password = String(password || '');
  var cache = CacheService.getScriptCache();
  var clientIp = safeTrim_((requestContext || {}).clientIp).slice(0, 64);
  var deviceKey = adminLoginThrottleKey_(email + '|' + clientIp), accountKey = adminLoginThrottleKey_(email);
  var deviceAttempts = Number(cache.get(deviceKey) || 0), accountAttempts = Number(cache.get(accountKey) || 0);
  if (deviceAttempts >= LOGIN_DEVICE_LIMIT_ || accountAttempts >= LOGIN_ACCOUNT_LIMIT_)
    throw new Error('Too many sign-in attempts. Try again in 15 minutes.');
  cache.put(deviceKey, String(deviceAttempts + 1), LOGIN_WINDOW_SECONDS_);
  cache.put(accountKey, String(accountAttempts + 1), LOGIN_WINDOW_SECONDS_);

  var users = readSmallSheet_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS));
  var hdr = users.header, rows = users.rows;
  var cEmail = idxOf_(hdr, ['email']), cHash = idxOf_(hdr, ['passwordhash','password hash']),
      cSalt = idxOf_(hdr, ['salt']), cName = idxOf_(hdr, ['name','display name']),
      cRole = idxOf_(hdr, ['role']), cActive = idxOf_(hdr, ['active']);
  var match = null;
  for (var i = 0; i < rows.length; i++)
    if (safeTrim_(rows[i][cEmail]).toLowerCase() === email) { match = rows[i]; break; }
  // Hashed whether or not the account exists. The rounds are the costliest
  // step of a sign-in, and skipping them for an unknown email made "no such
  // account" answer measurably sooner than "wrong password" — enough to test a
  // list of addresses for which ones are administrators. Disabled accounts pay
  // the same cost for the same reason.
  var hash = hashAdminPassword_(password, match ? match[cSalt] : UNKNOWN_ACCOUNT_SALT_);
  if (!match || String(match[cActive]).toLowerCase() === 'false' ||
      !constantTimeEquals_(hash, safeTrim_(match[cHash])))
    throw new Error('Invalid email or password.');
  cache.remove(deviceKey);
  cache.remove(accountKey);

  // Logins are rare, so this is the natural place to drain a few dead sessions.
  try { pruneAdminSessions_(25); } catch (_) {}

  var token = Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'');
  var session = {
    email: email, name: safeTrim_(match[cName]) || email,
    role: safeTrim_(match[cRole]) || 'admin', expiresAt: Date.now() + 21600000,
    credentialStamp: credentialStamp_(match[cHash])
  };
  var key = adminSessionKey_(token), json = JSON.stringify(session);
  CacheService.getScriptCache().put(key, json, 21600);
  var props = PropertiesService.getScriptProperties();
  try {
    props.setProperty(key, json);
  } catch (quotaError) {
    // Already full: sweep hard rather than refuse the sign-in.
    pruneAdminSessions_(5000);
    props.setProperty(key, json);
  }
  return { token: token, user: { email: session.email, name: session.name, role: session.role }, expiresAt: session.expiresAt };
}

function adminValidateSession(token) {
  var session = getAdminSession_(token);
  if (!session) throw new Error('Your admin session has expired.');
  return { user: { email: session.email, name: session.name, role: session.role }, expiresAt: session.expiresAt };
}

function adminLogout(token) {
  ADMIN_SESSION_MEMO_[safeTrim_(token)] = null;
  var key = adminSessionKey_(token);
  CacheService.getScriptCache().remove(key);
  PropertiesService.getScriptProperties().deleteProperty(key);
  return true;
}

/**
 * One validation per token per execution. An audited action resolves its
 * actor and then authorises, and each pass was a cache read, four reads of
 * the Users sheet and a cache write — twice over, for the same answer.
 */
var ADMIN_SESSION_MEMO_ = {};

function getAdminSession_(token) {
  token = safeTrim_(token);
  if (!token) return null;
  if (Object.prototype.hasOwnProperty.call(ADMIN_SESSION_MEMO_, token)) return ADMIN_SESSION_MEMO_[token];
  return (ADMIN_SESSION_MEMO_[token] = loadAdminSession_(token));
}

function loadAdminSession_(token) {
  var key = adminSessionKey_(token), cache = CacheService.getScriptCache();
  var cached = cache.get(key);
  var json = cached || PropertiesService.getScriptProperties().getProperty(key);
  if (!json) return null;
  try {
    var storedJson = json, session = JSON.parse(json);
    if (!session.expiresAt || session.expiresAt < Date.now()) { adminLogout(token); return null; }
    var current = getCredentialUser_(session.email);
    if (!current || !current.active) { adminLogout(token); return null; }
    // A session belongs to the password it was opened with. Changing that
    // password used to leave every existing session running for up to six
    // hours — including one held by whoever the reset was meant to shut out.
    // Checked here rather than by sweeping sessions at the change, so a reset
    // run from the editor through seedUsers() counts too, and a request already
    // in flight cannot put a revoked session back into the cache.
    if (!session.credentialStamp ||
        !constantTimeEquals_(session.credentialStamp, current.credentialStamp)) {
      adminLogout(token);
      return null;
    }
    session.name = current.name;
    session.role = current.role;
    json = JSON.stringify(session);
    // A hit that has not changed is already cached for the rest of its life —
    // the login put it with the full six hours — so only a miss or a change
    // needs writing back. Re-putting it was a cache write on every request.
    if (!cached || json !== storedJson)
      cache.put(key, json, Math.min(21600, Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))));
    if (json !== storedJson) PropertiesService.getScriptProperties().setProperty(key, json);
    return session;
  } catch (_) { return null; }
}

function getCredentialUser_(email) {
  email = safeTrim_(email).toLowerCase();
  var users = readSmallSheet_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS));
  var hdr = users.header, cEmail = idxOf_(hdr, ['email','e-mail']), values = null;
  for (var i = 0; cEmail >= 0 && i < users.rows.length; i++)
    if (safeTrim_(users.rows[i][cEmail]).toLowerCase() === email) { values = users.rows[i]; break; }
  if (!values) return null;
  var cName = idxOf_(hdr, ['name','display name']), cRole = idxOf_(hdr, ['role']), cActive = idxOf_(hdr, ['active']);
  var cHash = idxOf_(hdr, ['passwordhash','password hash']);
  return {
    email: email,
    name: cName >= 0 ? safeTrim_(values[cName]) || email : email,
    role: cRole >= 0 ? safeTrim_(values[cRole]).toLowerCase() || 'admin' : 'admin',
    active: cActive < 0 || String(values[cActive]).toLowerCase() !== 'false',
    credentialStamp: cHash >= 0 ? credentialStamp_(values[cHash]) : ''
  };
}

/**
 * Identifies which password a session was opened with, without carrying the
 * hash itself into the session store. seedUser salts afresh on every change,
 * so even setting the same password again produces a new stamp.
 */
function credentialStamp_(passwordHash) {
  var hash = safeTrim_(passwordHash);
  return hash ? sha256Base64_('session-credential|' + hash).slice(0, 22) : '';
}

/** Moves the caller's own session onto their new password. */
function restampAdminSession_(token) {
  var key = adminSessionKey_(token), props = PropertiesService.getScriptProperties();
  var json = props.getProperty(key);
  if (!json) return;
  var session = JSON.parse(json), current = getCredentialUser_(session.email);
  if (!current) return;
  session.credentialStamp = current.credentialStamp;
  json = JSON.stringify(session);
  props.setProperty(key, json);
  CacheService.getScriptCache().put(key, json,
    Math.min(21600, Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))));
}

function requireAdmin_(adminToken) {
  var session = getAdminSession_(adminToken);
  if (!session) throw new Error('Forbidden: administrator authorization required.');
  return session;
}

function requireSuperadmin_(adminToken) {
  var session = requireAdmin_(adminToken);
  if (safeTrim_(session.role).toLowerCase() !== 'superadmin')
    throw new Error('Forbidden: superadmin access required.');
  return session;
}

var SESSION_PROPERTY_PREFIX_ = 'ADMIN_SESSION_';

function adminSessionKey_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('SESSION_HASH_SECRET');
  if (!secret) throw new Error('Session security is not configured. Run setupCsmSecurity().');
  return SESSION_PROPERTY_PREFIX_ + hmac256Base64_(String(token || ''), secret);
}

/**
 * Sessions are kept in Script Properties because CacheService may evict an
 * entry before the six hours are up. Nothing removed them, though: an expired
 * session is only cleared when its own token is presented again, so an
 * administrator who closes the browser leaves a property behind for good.
 *
 * Script Properties is capped at 500KB in total, and setProperty throws once
 * that is reached — which would take out adminLogin itself and lock every
 * administrator out of the module permanently. Drained a little on each login
 * and in bulk by a daily trigger.
 */
function pruneAdminSessions_(budget) {
  var props = PropertiesService.getScriptProperties();
  var stored, removed = 0, now = Date.now();
  try { stored = props.getProperties(); } catch (_) { return 0; }
  var keys = Object.keys(stored);
  for (var i = 0; i < keys.length && removed < (budget || 25); i++) {
    if (keys[i].indexOf(SESSION_PROPERTY_PREFIX_) !== 0) continue;
    var expiresAt = 0;
    // An entry that will not parse can never authenticate anyone; drop it too.
    try { expiresAt = Number(JSON.parse(stored[keys[i]]).expiresAt) || 0; } catch (_) {}
    if (expiresAt > now) continue;
    try { props.deleteProperty(keys[i]); removed++; } catch (_) {}
  }
  return removed;
}

/** Installed as a daily trigger by setupCsmSheets(); safe to run by hand. */
function pruneAdminSessions() {
  return { status: 'OK', removed: pruneAdminSessions_(5000) };
}

function adminLoginThrottleKey_(email) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email || 'unknown'), Utilities.Charset.UTF_8);
  return 'LOGIN_ATTEMPTS_' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'').slice(0, 32);
}

/**
 * A sheet small enough to read whole — Users, a handful of rows — in one call
 * rather than the four it takes to locate a row first and then read it.
 */
function readSmallSheet_(sh) {
  var data = sh ? sh.getDataRange().getValues() : [], header = {};
  (data[0] || []).forEach(function (cell, index) {
    var key = String(cell || '').trim().toLowerCase();
    if (key) header[key] = index;
  });
  return { header: header, rows: data.slice(1) };
}

var ADMIN_HASH_ROUNDS_ = 12000;

/**
 * Iterated SHA-256; Apps Script has no native PBKDF2 or bcrypt. Each round is
 * base64url(SHA-256(UTF-8(previous))), starting from "salt|password".
 *
 * The rounds used to go through Utilities: two calls out of the script per
 * round, twenty-four thousand per sign-in, and it was that traffic — not the
 * hashing — that made signing in take seconds. The same rounds now run in the
 * script itself and produce the same string, so every stored hash still
 * verifies and the work factor is unchanged. Where the fast path cannot be
 * shown to agree with Utilities, or cannot encode the input, the original
 * runs instead: slower, never wrong.
 */
function hashAdminPassword_(password, salt) {
  var seed = String(salt || '') + '|' + String(password || '');
  if (fastHashAgrees_()) {
    try { return fastHashRounds_(seed, ADMIN_HASH_ROUNDS_); } catch (_) {}
  }
  return utilitiesHashRounds_(seed, ADMIN_HASH_ROUNDS_);
}

function utilitiesHashRounds_(value, rounds) {
  for (var i = 0; i < rounds; i++)
    value = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
  return value;
}

function fastHashRounds_(value, rounds) {
  var bytes = utf8Bytes_(value);
  for (var i = 0; i < rounds; i++) bytes = base64WebSafeAscii_(sha256Bytes_(bytes));
  return String.fromCharCode.apply(null, bytes);
}

/** Checked once per execution, on a non-ASCII sample, over a few rounds. */
var FAST_HASH_AGREES_ = null;
function fastHashAgrees_() {
  if (FAST_HASH_AGREES_ === null) {
    try {
      var sample = 'sält-ü|pässwörd-✓';
      FAST_HASH_AGREES_ = fastHashRounds_(sample, 3) === utilitiesHashRounds_(sample, 3);
    } catch (_) {
      FAST_HASH_AGREES_ = false;
    }
    if (!FAST_HASH_AGREES_)
      console.warn('In-script SHA-256 disagrees with Utilities; hashing passwords the slower way.');
  }
  return FAST_HASH_AGREES_;
}

/** Throws URIError on a lone surrogate, which sends the caller to Utilities. */
function utf8Bytes_(text) {
  var binary = unescape(encodeURIComponent(text)), bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

var BASE64_WEBSAFE_CODES_ = (function () {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var codes = new Uint8Array(64);
  for (var i = 0; i < 64; i++) codes[i] = alphabet.charCodeAt(i);
  return codes;
})();

/** base64url with '=' padding, as ASCII codes — the text the next round hashes. */
function base64WebSafeAscii_(bytes) {
  var codes = BASE64_WEBSAFE_CODES_, n = bytes.length, out = new Uint8Array(Math.ceil(n / 3) * 4);
  var o = 0, i = 0, v;
  for (; i + 2 < n; i += 3) {
    v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = codes[(v >> 18) & 63]; out[o++] = codes[(v >> 12) & 63];
    out[o++] = codes[(v >> 6) & 63]; out[o++] = codes[v & 63];
  }
  if (n - i === 1) {
    v = bytes[i] << 16;
    out[o++] = codes[(v >> 18) & 63]; out[o++] = codes[(v >> 12) & 63]; out[o++] = 61; out[o++] = 61;
  } else if (n - i === 2) {
    v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out[o++] = codes[(v >> 18) & 63]; out[o++] = codes[(v >> 12) & 63];
    out[o++] = codes[(v >> 6) & 63]; out[o++] = 61;
  }
  return out;
}

var SHA256_K_ = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

/** RFC 2104 HMAC over sha256Bytes_; both arguments are byte arrays. */
function hmacSha256Bytes_(messageBytes, keyBytes) {
  if (keyBytes.length > 64) keyBytes = sha256Bytes_(keyBytes);
  var inner = new Uint8Array(64 + messageBytes.length), outer = new Uint8Array(96);
  for (var i = 0; i < 64; i++) {
    var k = i < keyBytes.length ? keyBytes[i] : 0;
    inner[i] = k ^ 0x36;
    outer[i] = k ^ 0x5c;
  }
  inner.set(messageBytes, 64);
  outer.set(sha256Bytes_(inner), 64);
  return sha256Bytes_(outer);
}

/** FIPS 180-4 SHA-256 over a byte array; returns the 32-byte digest. */
function sha256Bytes_(bytes) {
  var length = bytes.length, blocks = ((length + 8) >> 6) + 1, end = blocks * 64;
  var msg = new Uint8Array(end);
  msg.set(bytes);
  msg[length] = 0x80;
  var bitsHigh = Math.floor(length / 0x20000000), bitsLow = (length << 3) >>> 0;
  msg[end - 8] = bitsHigh >>> 24; msg[end - 7] = bitsHigh >>> 16; msg[end - 6] = bitsHigh >>> 8; msg[end - 5] = bitsHigh;
  msg[end - 4] = bitsLow >>> 24; msg[end - 3] = bitsLow >>> 16; msg[end - 2] = bitsLow >>> 8; msg[end - 1] = bitsLow;

  var K = SHA256_K_, w = new Int32Array(64);
  var h0 = 0x6a09e667, h1 = 0xbb67ae85 | 0, h2 = 0x3c6ef372, h3 = 0xa54ff53a | 0,
      h4 = 0x510e527f, h5 = 0x9b05688c | 0, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (var offset = 0; offset < end; offset += 64) {
    var t, x, y;
    for (t = 0; t < 16; t++) {
      var p = offset + t * 4;
      w[t] = (msg[p] << 24) | (msg[p + 1] << 16) | (msg[p + 2] << 8) | msg[p + 3];
    }
    for (t = 16; t < 64; t++) {
      x = w[t - 15]; y = w[t - 2];
      w[t] = (w[t - 16] +
        (((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)) +
        w[t - 7] +
        (((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10))) | 0;
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (t = 0; t < 64; t++) {
      var t1 = (h + (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) +
        ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      var t2 = ((((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) +
        ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  var digest = new Uint8Array(32), words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (var i = 0; i < 8; i++) {
    digest[i * 4] = words[i] >>> 24; digest[i * 4 + 1] = words[i] >>> 16;
    digest[i * 4 + 2] = words[i] >>> 8; digest[i * 4 + 3] = words[i];
  }
  return digest;
}

function adminGetSettings(adminToken) {
  requireAdmin_(adminToken);
  return readSettings_();
}

/**
 * These decide whose name and signature appear on an issued certificate, and
 * which template it is built from. Changing them is effectively signing on
 * someone else's behalf, so they are held to superadmin rather than to any
 * administrator who can reach the Settings page.
 */
var SIGNING_SETTINGS_ = [
  'coa_signatory', 'coa_designation',
  'coa_template_id', 'coa_template_name',
  'coa_signature_id', 'coa_signature_name'
];

function adminSaveSettings(settings, adminToken) {
  var session = requireAdmin_(adminToken);
  var allowed = [
    'office_name',
    'report_prepared_by','report_prepared_title','report_reviewed_by','report_reviewed_title',
    'report_approved_by','report_approved_title'
  ].concat(SIGNING_SETTINGS_);

  var isSuperadmin = safeTrim_(session.role).toLowerCase() === 'superadmin';
  var updates = {}, current = null;
  allowed.forEach(function (key) {
    if (!(key in settings)) return;
    var value = safeTrim_(settings[key]).slice(0, 300);
    if (!isSuperadmin && SIGNING_SETTINGS_.indexOf(key) >= 0) {
      // Read once, not once per signing key.
      if (current === null) current = readSettings_();
      // Silently dropping it would look like a save that worked.
      if (value !== safeTrim_(current[key]))
        throw new Error('Only a superadmin can change the certificate signatory, designation, template or e-signature.');
      return;
    }
    updates[key] = value;
  });
  return writeSettings_(updates);
}

// --------------------------- Tamper-evident audit log ---------------------------

var AUDITED_ACTIONS_ = {
  adminLogin: 'LOGIN', adminLogout: 'LOGOUT', adminSaveService: 'SERVICE_SAVE',
  adminSaveSettings: 'SETTINGS_SAVE', adminGenerateCoa: 'COA_GENERATE',
  adminSaveCoaDetails: 'COA_UPDATE', adminGenerateReport: 'REPORT_GENERATE',
  adminSaveServiceStats: 'SERVICE_STATS_SAVE', adminSaveUser: 'USER_SAVE',
  adminUploadCoaTemplate: 'TEMPLATE_UPLOAD', adminUploadSignature: 'SIGNATURE_UPLOAD',
  // Not reachable through doPost — resetCsmData() records itself under this
  // label so the emptied log opens with an explanation of why it is empty.
  csmDataReset: 'DATA_RESET'
};

function isAuditedAction_(action) { return Object.prototype.hasOwnProperty.call(AUDITED_ACTIONS_, action); }

function auditActorForRequest_(action, body) {
  if (action === 'adminLogin') return { email: safeTrim_(body.email).toLowerCase(), role: '' };
  var session = getAdminSession_(body.adminToken);
  return session ? { email: session.email, role: session.role } : { email: '', role: '' };
}

function auditActorForResult_(action, data, fallback) {
  if (action === 'adminLogin' && data && data.user)
    return { email: safeTrim_(data.user.email).toLowerCase(), role: safeTrim_(data.user.role).toLowerCase() };
  return fallback || { email: '', role: '' };
}

function auditTargetForRequest_(action, body) {
  var payload = body.payload || {};
  if (action === 'adminLogin' || action === 'adminLogout')
    return { type: 'session', id: safeTrim_(body.email || (auditActorForRequest_(action, body) || {}).email) };
  if (action === 'adminSaveService')
    return { type: 'service', id: safeTrim_(payload.service_id || payload.code), details: { code: safeTrim_(payload.code), category: safeTrim_(payload.category) } };
  if (action === 'adminSaveSettings')
    return { type: 'settings', id: 'Settings', details: { keys: Object.keys(body.settings || {}).join(',').slice(0, 200) } };
  if (action === 'adminGenerateCoa' || action === 'adminSaveCoaDetails')
    return { type: 'certificate', id: safeTrim_(body.responseId || payload.referenceId) };
  if (action === 'adminGenerateReport')
    return { type: 'report', id: normalizePeriod_(body.period).key };
  if (action === 'adminSaveServiceStats')
    return { type: 'report_stats', id: normalizePeriod_(body.period).key, details: { rows: (body.rows || []).length } };
  if (action === 'adminSaveUser')
    return { type: 'user', id: safeTrim_(payload.user_id || payload.email).toLowerCase(), details: { role: safeTrim_(payload.role).toLowerCase(), active: payload.active !== false } };
  if (action === 'adminUploadCoaTemplate' || action === 'adminUploadSignature')
    return { type: 'file', id: safeTrim_(payload.filename).slice(0, 180) };
  return { type: 'system', id: '' };
}

function ensureAuditSheet_() {
  var setup = ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_AUDIT, [
    setupColumn_('timestamp'), setupColumn_('audit_id'), setupColumn_('actor_email'), setupColumn_('actor_role'),
    setupColumn_('action'), setupColumn_('target_type'), setupColumn_('target_id'), setupColumn_('outcome'),
    setupColumn_('details'), setupColumn_('request_id'), setupColumn_('previous_hash'), setupColumn_('entry_hash')
  ]);
  // The timestamp is hashed as written. Left to parse as a date, Sheets can
  // display it back in another shape and every entry then fails the chain
  // check. setupCsmSheets sets this; a sheet first created here needs it too.
  if (setup.created) setup.sheet.getRange('A:A').setNumberFormat('@');
  return setup.sheet;
}

/** The spreadsheet's zone: the one Sheets used when it read text as a date. */
function spreadsheetTimeZone_() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || timezone_();
  } catch (_) {
    return timezone_();
  }
}

/**
 * An audit cell as the text that was hashed. Every field is written as text;
 * a Date here is a timestamp Sheets parsed on the way in, and formatting it
 * back in the spreadsheet's zone with the pattern it was written in recovers
 * the original string exactly, seconds included.
 */
function auditCellText_(value, zone) {
  if (isDate_(value)) return Utilities.formatDate(value, zone, 'yyyy-MM-dd HH:mm:ss');
  return safeTrim_(value);
}

function auditCanonical_(entry) {
  return [entry.timestamp, entry.audit_id, entry.actor_email, entry.actor_role, entry.action,
    entry.target_type, entry.target_id, entry.outcome, entry.details, entry.request_id, entry.previous_hash]
    .map(safeTrim_).join('|');
}

/**
 * A log documented as tamper-evident must never lose an entry quietly. When
 * the append cannot happen the count is recorded and reported alongside the
 * chain check, so a gap is visible instead of invisible.
 */
function recordAuditDrop_(action, reason) {
  try {
    var props = PropertiesService.getScriptProperties();
    props.setProperty('AUDIT_DROPPED_COUNT',
      String((Number(props.getProperty('AUDIT_DROPPED_COUNT')) || 0) + 1));
    props.setProperty('AUDIT_DROPPED_LAST', Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd HH:mm:ss') +
      ' ' + safeTrim_(action) + ' (' + safeTrim_(reason) + ')');
  } catch (_) {}
  console.error('Audit write skipped for ' + action + ': ' + reason);
}

function appendAuditForRequest_(action, body, success, errorMessage, actor, requestContext) {
  var secret = PropertiesService.getScriptProperties().getProperty('AUDIT_HASH_SECRET');
  if (!secret) return;
  // The document lock, not the script lock: appending one row is short, while
  // the script lock also carries certificate issuance and report building.
  // Waiting on those for 5s and then returning meant every privileged action
  // taken during a 60s report build went unrecorded, with the chain still
  // validating over what did get written.
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(20000)) {
    recordAuditDrop_(action, 'could not acquire the audit lock');
    return;
  }
  try {
    var sh = ensureAuditSheet_(), hdr = getHeaderMap_(sh), target = auditTargetForRequest_(action, body);
    var lastRow = sh.getLastRow(), cHash = idxOf_(hdr, ['entry_hash']);
    var previous = lastRow >= 2 && cHash >= 0 ? safeTrim_(sh.getRange(lastRow, cHash + 1).getValue()) : '';
    var entry = {
      timestamp: Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd HH:mm:ss'),
      audit_id: 'AUD-' + Utilities.getUuid().replace(/-/g,'').slice(0, 16).toUpperCase(),
      // Bounded because the sign-in form puts whatever was typed as the email
      // into both of these, before anyone is authenticated. A value past the
      // 50,000-character cell limit could not be written, so a single request
      // left the log permanently flagged as having lost an entry.
      actor_email: safeTrim_((actor || {}).email).toLowerCase().slice(0, 254),
      actor_role: safeTrim_((actor || {}).role).toLowerCase(),
      action: AUDITED_ACTIONS_[action] || safeTrim_(action).toUpperCase(),
      target_type: target.type, target_id: safeTrim_(target.id).slice(0, 254),
      outcome: success ? 'SUCCESS' : 'FAILURE',
      details: JSON.stringify(success ? (target.details || {}) : { error: safeTrim_(errorMessage).slice(0, 300) }),
      request_id: safeTrim_((requestContext || {}).requestId).slice(0, 100),
      previous_hash: previous
    };
    entry.entry_hash = hmac256Base64_(auditCanonical_(entry), secret);
    var row = new Array(sh.getLastColumn()).fill('');
    Object.keys(entry).forEach(function (key) { if (key in hdr) row[hdr[key]] = safeSheetValue_(entry[key]); });
    // The timestamp cell is made plain text before the row goes in. appendRow
    // let Sheets read "2026-09-12 14:03:07" as a date, and a date is displayed
    // in the sheet's own date format rather than as the string that was
    // hashed — so an entry nobody had touched failed the chain check. The
    // column-wide format setupCsmSheets applies reaches only the rows that
    // existed then, and only a sheet laid out with the timestamp in column A.
    var targetRow = lastRow + 1;
    if (targetRow > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 100);
    var cTime = idxOf_(hdr, ['timestamp']);
    if (cTime >= 0) sh.getRange(targetRow, cTime + 1).setNumberFormat('@');
    sh.getRange(targetRow, 1, 1, row.length).setValues([row]);
    PropertiesService.getScriptProperties().setProperty('AUDIT_HEAD_HASH', entry.entry_hash);
  } catch (writeError) {
    recordAuditDrop_(action, String(writeError && writeError.message || writeError).slice(0, 120));
    throw writeError;
  } finally { lock.releaseLock(); }
}

function adminGetAuditLog(filters, adminToken) {
  requireSuperadmin_(adminToken);
  filters = filters || {};
  var sh = ensureAuditSheet_();
  var props = PropertiesService.getScriptProperties();
  var expectedHead = props.getProperty('AUDIT_HEAD_HASH') || '';
  // An entry that could not be written is as much a gap as one that was
  // deleted, so it is reported next to the chain result rather than buried.
  var dropped = Number(props.getProperty('AUDIT_DROPPED_COUNT')) || 0;
  var droppedLast = safeTrim_(props.getProperty('AUDIT_DROPPED_LAST'));
  if (sh.getLastRow() < 2)
    return {
      entries: [], total: 0,
      integrity: { valid: !expectedHead && !dropped, checkedRows: 0, dropped: dropped, droppedLast: droppedLast }
    };
  var hdr = getHeaderMap_(sh);
  // Raw values, not display values. A cell Sheets turned into a date or a
  // number is displayed in whatever format the sheet applies to it, which is
  // not the text that was hashed; the raw value can be put back into exactly
  // that text. This is what let an intact log report a broken chain.
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var zone = spreadsheetTimeZone_();
  var secret = props.getProperty('AUDIT_HASH_SECRET') || '';
  var broken = null, previousShown = null, entries = [];
  rows.forEach(function (row, index) {
    // Wholly blank rows are skipped rather than checked as empty entries.
    // That hides nothing: an entry cleared by hand still breaks the link of
    // the entry after it, or the head check if it was the last.
    if (row.every(function (value) { return safeTrim_(value) === ''; })) return;
    function cell(name) { return name in hdr ? auditCellText_(row[hdr[name]], zone) : ''; }
    entries.push({
      sheetRow: index + 2,
      timestamp: cell('timestamp'), audit_id: cell('audit_id'), actor_email: cell('actor_email'),
      actor_role: cell('actor_role'), action: cell('action'), target_type: cell('target_type'),
      target_id: cell('target_id'), outcome: cell('outcome'), details: cell('details'),
      request_id: cell('request_id'), previous_hash: cell('previous_hash'), entry_hash: cell('entry_hash')
    });
  });
  // The first break is reported by row and kind, so "the chain does not
  // match" can be traced to the row that caused it.
  entries.forEach(function (entry) {
    if (!broken) {
      if (!secret)
        broken = { reason: 'secret', row: entry.sheetRow, auditId: entry.audit_id };
      else if (!constantTimeEquals_(hmac256Base64_(auditCanonical_(entry), secret), entry.entry_hash))
        broken = { reason: 'contents', row: entry.sheetRow, auditId: entry.audit_id };
      else if (previousShown !== null && entry.previous_hash !== previousShown)
        broken = { reason: 'link', row: entry.sheetRow, auditId: entry.audit_id };
    }
    previousShown = entry.entry_hash;
  });
  if (!broken && expectedHead && previousShown !== expectedHead)
    broken = { reason: 'head', row: null, auditId: '' };
  var integrity = !broken;

  var action = safeTrim_(filters.action).toUpperCase(), outcome = safeTrim_(filters.outcome).toUpperCase();
  var query = safeTrim_(filters.query).toLowerCase();
  var filtered = entries.filter(function (entry) {
    return (!action || entry.action === action) && (!outcome || entry.outcome === outcome) &&
      (!query || [entry.actor_email, entry.target_id, entry.action, entry.details, entry.request_id].join(' ').toLowerCase().indexOf(query) >= 0);
  });
  var limit = Math.min(500, Math.max(25, Number(filters.limit) || 200));
  return {
    entries: filtered.slice(-limit).reverse().map(function (entry) {
      delete entry.previous_hash; delete entry.entry_hash; delete entry.sheetRow;
      try { entry.details = JSON.parse(entry.details || '{}'); } catch (_) { entry.details = {}; }
      return entry;
    }),
    integrity: {
      valid: integrity && !dropped,
      broken: broken,
      checkedRows: entries.length,
      dropped: dropped,
      droppedLast: droppedLast
    },
    total: filtered.length
  };
}
