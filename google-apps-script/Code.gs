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
var PUBLIC_CACHE_SECONDS = 900;

// --------------------------------- Entry -------------------------------------

function doGet() {
  return HtmlService.createHtmlOutput(
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>body{font-family:Arial,sans-serif;background:#f5f7f2;color:#18322d;display:grid;place-items:center;min-height:90vh;margin:0}' +
    '.card{text-align:center;background:#fff;border:1px solid #dfe7e1;border-radius:18px;padding:32px;max-width:480px}img{width:220px;max-width:80%}p{color:#6d7f79}</style>' +
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
    auditActor = auditActorForRequest_(action, body);

    var data;
    if (action === 'getPortalConfig') data = getPortalConfig();
    else if (action === 'submitResponse') data = submitResponse(body.payload || {});
    else if (action === 'verifyCertificate') data = verifyCertificate(body.code);
    else if (action === 'adminLogin') data = adminLogin(body.email, body.password);
    else if (action === 'adminLogout') data = adminLogout(body.adminToken);
    else if (action === 'adminValidateSession') data = adminValidateSession(body.adminToken);
    else if (action === 'adminGetOverview') data = adminGetOverview(body.period || {}, body.adminToken);
    else if (action === 'adminGetResponses') data = adminGetResponses(body.filters || {}, body.adminToken);
    else if (action === 'adminGetCoaRequests') data = adminGetCoaRequests(body.filters || {}, body.adminToken);
    else if (action === 'adminSaveCoaDetails') data = adminSaveCoaDetails(body.payload || {}, body.adminToken);
    else if (action === 'adminGenerateCoa') data = adminGenerateCoa(body.responseId, body.adminToken);
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
function timezone_() { return Session.getScriptTimeZone() || 'Asia/Manila'; }

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

function fmtDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value))
    return Utilities.formatDate(value, timezone_(), 'yyyy-MM-dd');
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
  return date ? Utilities.formatDate(date, timezone_(), 'MMMM d, yyyy') : safeTrim_(value);
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
function hmac256Base64_(value, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(String(value||''), String(secret||''), Utilities.Charset.UTF_8)).replace(/=+$/,'');
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

function ensureSetupSheet_(ss, sheetName, columns) {
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
  sh.setFrozenRows(1);
  if (sh.getLastColumn() > 0)
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold').setBackground('#0b4b3c').setFontColor('#ffffff');
  return { sheet: sh, created: created, headersAdded: added };
}

function responseColumns_() {
  var columns = [
    setupColumn_('Timestamp', ['submitted at']),
    setupColumn_('ResponseID', ['response id','reference']),
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
    setupColumn_('VerificationCode', ['verification code']),
    setupColumn_('VerificationURL', ['verification url'])
  ]);
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
      setupColumn_('category'), setupColumn_('active'), setupColumn_('sort_order'),
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

    seedServices_(services.sheet);
    seedSettings_();

    return {
      status: 'OK',
      spreadsheetUrl: ss.getUrl(),
      sheets: [responses, services, stats, settings, reports, whitelist, users, audit].map(function (result) {
        return { name: result.sheet.getName(), created: result.created, headersAdded: result.headersAdded };
      }),
      nextStep: 'Run setupCsmSecurity(), copy its submit token into Vercel as SUBMIT_SHARED_TOKEN, then edit and run seedUsers().'
    };
  } finally { lock.releaseLock(); }
}

var DEFAULT_SERVICES_ = [
  { code: 'CEM/CED', name_en: 'Application for Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)', name_tl: 'Aplikasyon para sa Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)', category: 'main' },
  { code: 'SIAP 1', name_en: 'Application for Student Internship Program (SIAP) Phase 1', name_tl: 'Aplikasyon para sa Student Internship Program (SIAP) Phase 1', category: 'main' },
  { code: 'SIAP 2', name_en: 'Application for Student Internship Program (SIAP) Phase 2', name_tl: 'Aplikasyon para sa Student Internship Program (SIAP) Phase 2', category: 'main' },
  { code: 'BI INDORSEMENT', name_en: 'Request for Endorsement for Conversion/Extension of Visa of Foreign Students to the Bureau of Immigration', name_tl: 'Kahilingan para sa Endorsement para sa Conversion/Extension ng Visa ng mga Dayuhang Estudyante sa Bureau of Immigration', category: 'main' },
  { code: 'OTHER', name_en: 'Other Services', name_tl: 'Iba pang Serbisyo', category: 'other' }
];

function seedServices_(sheet) {
  if (sheet.getLastRow() >= 2) return;
  var hdr = getHeaderMap_(sheet), now = new Date();
  DEFAULT_SERVICES_.forEach(function (service, index) {
    var row = new Array(sheet.getLastColumn()).fill('');
    row[hdr['service_id']] = 'S-' + Utilities.getUuid().replace(/-/g,'').slice(0, 8).toUpperCase();
    row[hdr['code']] = service.code;
    row[hdr['name_en']] = service.name_en;
    row[hdr['name_tl']] = service.name_tl;
    row[hdr['category']] = service.category;
    row[hdr['active']] = true;
    row[hdr['sort_order']] = (index + 1) * 10;
    row[hdr['created_at']] = now;
    row[hdr['updated_at']] = now;
    sheet.appendRow(row);
  });
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

function ensureServicesSheet_() {
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_SERVICES, [
    setupColumn_('service_id'), setupColumn_('code'), setupColumn_('name_en'), setupColumn_('name_tl'),
    setupColumn_('category'), setupColumn_('active'), setupColumn_('sort_order'),
    setupColumn_('created_at'), setupColumn_('updated_at')
  ]).sheet;
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

    values[hdr['service_id']] = serviceId;
    values[hdr['code']] = safeSheetValue_(code);
    values[hdr['name_en']] = safeSheetValue_(nameEn);
    values[hdr['name_tl']] = safeSheetValue_(nameTl);
    values[hdr['category']] = category;
    values[hdr['active']] = active;
    values[hdr['sort_order']] = sortOrder;
    if (!current) values[hdr['created_at']] = new Date();
    values[hdr['updated_at']] = new Date();
    sh.getRange(rowIndex, 1, 1, values.length).setValues([values]);
  } finally { lock.releaseLock(); }
  invalidatePublicCache_();
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
          category: service.category, active: true
        };
      })
  };
  var json = JSON.stringify(config);
  if (json.length < 90000) { try { cache.put('PUBLIC_CSM_CONFIG', json, PUBLIC_CACHE_SECONDS); } catch (_) {} }
  return config;
}

// ------------------------------- Submission -----------------------------------

var REGION_CODES_ = {
  'region ncr': 'NCR', 'region 1': 'I', 'region 2': 'II', 'region 3': 'III', 'region 4': 'IV-A',
  'region 5': 'V', 'region 6': 'VI', 'region 7': 'VII', 'region 8': 'VIII', 'region 9': 'IX',
  'region 10': 'X', 'region 11': 'XI', 'region 12': 'XII', 'region car': 'CAR',
  'region caraga': 'CARAGA', 'region mimaropa': 'IV-B', 'barmm': 'BARMM', 'nir': 'NIR'
};

function regionCode_(region) { return REGION_CODES_[safeTrim_(region).toLowerCase()] || 'N/A'; }

function makeVerificationCode_() {
  return 'OSDS-' + Utilities.getUuid().replace(/-/g,'').slice(0, 20).toUpperCase();
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

  var region = safeTrim_(formData.region);
  if (!region) return { status: 'BAD_REQUEST', message: 'Region of residence is required.' };

  var service = readServices_().filter(function (entry) {
    return entry.service_id === safeTrim_(formData.serviceId) && entry.active;
  })[0];
  if (!service) return { status: 'BAD_REQUEST', message: 'Please select the service you availed.' };

  var otherService = safeTrim_(formData.otherService).slice(0, 200);
  if (service.category === 'other' && !otherService)
    return { status: 'BAD_REQUEST', message: 'Please specify the service you availed.' };

  var age = safeTrim_(formData.age);
  if (age && (!/^\d{1,3}$/.test(age) || Number(age) < 1 || Number(age) > 120))
    return { status: 'BAD_REQUEST', message: 'Age must be between 1 and 120.' };

  for (var c = 0; c < CC_KEYS.length; c++)
    if (['1','2','3','4','5','N/A'].indexOf(safeTrim_(formData[CC_KEYS[c]])) < 0)
      return { status: 'BAD_REQUEST', message: 'Please answer all Citizen’s Charter questions.' };
  for (var s = 0; s < SQD_KEYS.length; s++)
    if (['1','2','3','4','5','N/A'].indexOf(safeTrim_(formData[SQD_KEYS[s]])) < 0)
      return { status: 'BAD_REQUEST', message: 'Please answer all Service Quality Dimension questions.' };

  var wantsCoa = safeTrim_(formData.wantsCoa).toLowerCase() === 'yes';
  var coaName = safeTrim_(formData.coaName).slice(0, 160);
  var coaAgency = safeTrim_(formData.coaAgency).slice(0, 200);
  var coaPurpose = safeTrim_(formData.coaPurpose).slice(0, 300);
  var coaFrom = parseDate_(formData.coaDateFrom);
  var coaTo = parseDate_(formData.coaDateTo);
  if (wantsCoa && (!coaName || !coaAgency || !coaPurpose || !coaFrom))
    return { status: 'BAD_REQUEST', message: 'Complete the Certificate of Appearance details.' };

  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
    if (!sh) throw new Error("Sheet 'Responses' not found. Run setupCsmSheets().");
    var hdr = getHeaderMap_(sh), lastCol = sh.getLastColumn(), row = new Array(lastCol).fill('');
    var referenceId = 'CSM-' + Utilities.getUuid().replace(/-/g,'').slice(0, 10).toUpperCase();

    function put(names, value) {
      var col = idxOf_(hdr, names);
      if (col >= 0) row[col] = safeSheetValue_(value);
    }
    put(['timestamp'], new Date());
    put(['responseid'], referenceId);
    put(['transactiondate'], Utilities.formatDate(transactionDate, timezone_(), 'yyyy-MM-dd'));
    put(['month'], Utilities.formatDate(transactionDate, timezone_(), 'MMMM').toUpperCase());
    put(['year'], transactionDate.getFullYear());
    put(['clienttype'], clientType.toUpperCase());
    put(['sex'], safeTrim_(formData.sex).toUpperCase());
    put(['age'], age || 'N/A');
    put(['region'], region);
    put(['regioncode'], regionCode_(region));
    put(['serviceid'], service.service_id);
    put(['servicecode'], service.code);
    put(['servicename'], service.name_en);
    put(['otherservice'], otherService);
    CC_KEYS.forEach(function (key) { put([key], safeTrim_(formData[key])); });
    SQD_KEYS.forEach(function (key) { put([key], safeTrim_(formData[key])); });
    put(['suggestions'], safeTrim_(formData.suggestions).slice(0, 1500));
    put(['email'], email);
    put(['language'], safeTrim_(formData.language) || 'en');
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
    return { status: 'OK', referenceId: referenceId, coaRequested: wantsCoa };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ------------------------------ Response reads ---------------------------------

function readResponses_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
  if (!sh || sh.getLastRow() < 2) return { rows: [], sheet: sh, header: sh ? getHeaderMap_(sh) : {} };
  var hdr = getHeaderMap_(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var rows = values.map(function (value, index) {
    function cell(name) {
      var col = idxOf_(hdr, [name]);
      return col >= 0 ? value[col] : '';
    }
    var record = {
      rowIndex: index + 2,
      referenceId: safeTrim_(cell('responseid')),
      timestamp: cell('timestamp'),
      transactionDate: fmtDate_(cell('transactiondate')),
      month: safeTrim_(cell('month')).toUpperCase(),
      year: Number(cell('year')) || 0,
      clientType: safeTrim_(cell('clienttype')).toUpperCase(),
      sex: safeTrim_(cell('sex')).toUpperCase(),
      age: safeTrim_(cell('age')),
      region: safeTrim_(cell('region')),
      regionCode: safeTrim_(cell('regioncode')) || 'N/A',
      serviceId: safeTrim_(cell('serviceid')),
      serviceCode: safeTrim_(cell('servicecode')),
      serviceName: safeTrim_(cell('servicename')),
      otherService: safeTrim_(cell('otherservice')),
      suggestions: safeTrim_(cell('suggestions')),
      email: safeTrim_(cell('email')),
      coaRequested: safeTrim_(cell('coarequested')).toUpperCase() === 'YES',
      coaTitle: safeTrim_(cell('coatitle')),
      coaName: safeTrim_(cell('coaname')),
      coaAgency: safeTrim_(cell('coaagency')),
      coaPurpose: safeTrim_(cell('coapurpose')),
      coaDateFrom: fmtDate_(cell('coadatefrom')),
      coaDateTo: fmtDate_(cell('coadateto')),
      coaStatus: safeTrim_(cell('coastatus')).toUpperCase() || 'NONE',
      coaLink: safeTrim_(cell('coalink')),
      coaIssuedAt: safeTrim_(cell('coaissuedat')),
      verificationCode: safeTrim_(cell('verificationcode')),
      verificationUrl: safeTrim_(cell('verificationurl'))
    };
    CC_KEYS.concat(SQD_KEYS).forEach(function (key) { record[key] = safeTrim_(cell(key)); });
    record.overall = meanOf_(SQD_KEYS.map(function (key) { return record[key]; }));
    return record;
  }).filter(function (record) { return record.referenceId; });
  return { rows: rows, sheet: sh, header: hdr };
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
  var allRecords = readResponses_().rows;
  var records = allRecords.filter(function (record) { return inPeriod_(record, period); });

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
      code: record.serviceCode, name: record.serviceName, respondents: 0, scores: []
    });
    bucket.respondents++;
    SQD_KEYS.forEach(function (key) { bucket.scores.push(record[key]); });
  });

  var aware = records.filter(function (record) {
    return ['1','2','3'].indexOf(record.cc1) >= 0;
  }).length;
  var coaIssued = records.filter(function (record) { return record.coaRequested && record.coaStatus === 'ISSUED'; }).length;
  var coaFailed = records.filter(function (record) { return record.coaRequested && record.coaStatus.indexOf('ERROR') === 0; }).length;
  // Pending certificates are a work queue, not a period statistic: an admin
  // needs to see everything still awaiting release regardless of the filter.
  var coaPending = allRecords.filter(function (record) {
    return record.coaRequested && record.coaStatus === 'REQUESTED';
  }).length;

  return {
    period: period,
    totalResponses: records.length,
    overall: round2_(meanOf_([].concat.apply([], records.map(function (record) {
      return SQD_KEYS.map(function (key) { return record[key]; });
    })))),
    ccAwareness: records.length ? Math.round((aware / records.length) * 1000) / 10 : 0,
    sqd: sqd, cc: cc,
    clientTypes: clientTypes, sexes: sexes, ageBrackets: ageBrackets,
    services: Object.keys(byService).map(function (code) {
      var bucket = byService[code];
      return { code: code, name: bucket.name, respondents: bucket.respondents, overall: round2_(meanOf_(bucket.scores)) };
    }).sort(function (a, b) { return b.respondents - a.respondents; }),
    coa: { issued: coaIssued, pending: coaPending, failed: coaFailed }
  };
}

function adminGetResponses(filters, adminToken) {
  requireAdmin_(adminToken);
  var limit = Math.min(2000, Math.max(25, Number(filters.limit) || 500));
  var rows = readResponses_().rows;
  return rows.slice(-limit).reverse().map(function (record) {
    var out = {
      referenceId: record.referenceId, transactionDate: record.transactionDate,
      clientType: record.clientType, sex: record.sex, age: record.age,
      region: record.region, serviceCode: record.serviceCode, serviceName: record.serviceName,
      otherService: record.otherService, email: record.email, suggestions: record.suggestions,
      overall: round2_(record.overall), coaStatus: record.coaStatus
    };
    CC_KEYS.concat(SQD_KEYS).forEach(function (key) { out[key] = record[key]; });
    return out;
  });
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
    if (password) seedUser(email, password, name, role, active);
    else syncCredentialMetadata_({ email: email, name: name, role: role, active: active });
    return upsertWhitelistUser_({ user_id: safeTrim_(payload.user_id), name: name, role: role, email: email, active: active });
  } finally { lock.releaseLock(); }
}

function adminLogin(email, password) {
  email = safeTrim_(email).toLowerCase();
  password = String(password || '');
  var throttleKey = adminLoginThrottleKey_(email), cache = CacheService.getScriptCache();
  var attempts = Number(cache.get(throttleKey) || 0);
  if (attempts >= 5) throw new Error('Too many sign-in attempts. Try again in 15 minutes.');
  cache.put(throttleKey, String(attempts + 1), 900);

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  if (!sh || sh.getLastRow() < 2) throw new Error('Invalid email or password.');
  var hdr = getHeaderMap_(sh), rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var cEmail = idxOf_(hdr, ['email']), cHash = idxOf_(hdr, ['passwordhash','password hash']),
      cSalt = idxOf_(hdr, ['salt']), cName = idxOf_(hdr, ['name','display name']),
      cRole = idxOf_(hdr, ['role']), cActive = idxOf_(hdr, ['active']);
  var match = null;
  for (var i = 0; i < rows.length; i++)
    if (safeTrim_(rows[i][cEmail]).toLowerCase() === email) { match = rows[i]; break; }
  if (!match || String(match[cActive]).toLowerCase() === 'false' ||
      !constantTimeEquals_(hashAdminPassword_(password, match[cSalt]), safeTrim_(match[cHash])))
    throw new Error('Invalid email or password.');
  cache.remove(throttleKey);

  var token = Utilities.getUuid().replace(/-/g,'') + Utilities.getUuid().replace(/-/g,'');
  var session = {
    email: email, name: safeTrim_(match[cName]) || email,
    role: safeTrim_(match[cRole]) || 'admin', expiresAt: Date.now() + 21600000
  };
  var key = adminSessionKey_(token), json = JSON.stringify(session);
  CacheService.getScriptCache().put(key, json, 21600);
  PropertiesService.getScriptProperties().setProperty(key, json);
  return { token: token, user: { email: session.email, name: session.name, role: session.role }, expiresAt: session.expiresAt };
}

function adminValidateSession(token) {
  var session = getAdminSession_(token);
  if (!session) throw new Error('Your admin session has expired.');
  return { user: { email: session.email, name: session.name, role: session.role }, expiresAt: session.expiresAt };
}

function adminLogout(token) {
  var key = adminSessionKey_(token);
  CacheService.getScriptCache().remove(key);
  PropertiesService.getScriptProperties().deleteProperty(key);
  return true;
}

function getAdminSession_(token) {
  token = safeTrim_(token);
  if (!token) return null;
  var key = adminSessionKey_(token), cache = CacheService.getScriptCache();
  var json = cache.get(key) || PropertiesService.getScriptProperties().getProperty(key);
  if (!json) return null;
  try {
    var storedJson = json, session = JSON.parse(json);
    if (!session.expiresAt || session.expiresAt < Date.now()) { adminLogout(token); return null; }
    var current = getCredentialUser_(session.email);
    if (!current || !current.active) { adminLogout(token); return null; }
    session.name = current.name;
    session.role = current.role;
    json = JSON.stringify(session);
    cache.put(key, json, Math.min(21600, Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))));
    if (json !== storedJson) PropertiesService.getScriptProperties().setProperty(key, json);
    return session;
  } catch (_) { return null; }
}

function getCredentialUser_(email) {
  email = safeTrim_(email).toLowerCase();
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_USERS);
  if (!sh || sh.getLastRow() < 2) return null;
  var hdr = getHeaderMap_(sh), row = findRowByEmail_(sh, email);
  if (!row) return null;
  var values = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  var cName = idxOf_(hdr, ['name','display name']), cRole = idxOf_(hdr, ['role']), cActive = idxOf_(hdr, ['active']);
  return {
    email: email,
    name: cName >= 0 ? safeTrim_(values[cName]) || email : email,
    role: cRole >= 0 ? safeTrim_(values[cRole]).toLowerCase() || 'admin' : 'admin',
    active: cActive < 0 || String(values[cActive]).toLowerCase() !== 'false'
  };
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

function adminSessionKey_(token) {
  var secret = PropertiesService.getScriptProperties().getProperty('SESSION_HASH_SECRET');
  if (!secret) throw new Error('Session security is not configured. Run setupCsmSecurity().');
  return 'ADMIN_SESSION_' + hmac256Base64_(String(token || ''), secret);
}

function adminLoginThrottleKey_(email) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(email || 'unknown'), Utilities.Charset.UTF_8);
  return 'LOGIN_ATTEMPTS_' + Utilities.base64EncodeWebSafe(digest).replace(/=+$/,'').slice(0, 32);
}

/** Iterated SHA-256; Apps Script has no native PBKDF2 or bcrypt. */
function hashAdminPassword_(password, salt) {
  var value = String(salt || '') + '|' + String(password || '');
  for (var i = 0; i < 12000; i++)
    value = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
  return value;
}

function adminGetSettings(adminToken) {
  requireAdmin_(adminToken);
  return readSettings_();
}

function adminSaveSettings(settings, adminToken) {
  requireAdmin_(adminToken);
  var allowed = [
    'office_name','coa_signatory','coa_designation',
    'report_prepared_by','report_prepared_title','report_reviewed_by','report_reviewed_title',
    'report_approved_by','report_approved_title',
    'coa_template_id','coa_template_name','coa_signature_id','coa_signature_name'
  ];
  var updates = {};
  allowed.forEach(function (key) {
    if (key in settings) updates[key] = safeTrim_(settings[key]).slice(0, 300);
  });
  return writeSettings_(updates);
}

// --------------------------- Tamper-evident audit log ---------------------------

var AUDITED_ACTIONS_ = {
  adminLogin: 'LOGIN', adminLogout: 'LOGOUT', adminSaveService: 'SERVICE_SAVE',
  adminSaveSettings: 'SETTINGS_SAVE', adminGenerateCoa: 'COA_GENERATE',
  adminSaveCoaDetails: 'COA_UPDATE', adminGenerateReport: 'REPORT_GENERATE',
  adminSaveServiceStats: 'SERVICE_STATS_SAVE', adminSaveUser: 'USER_SAVE',
  adminUploadCoaTemplate: 'TEMPLATE_UPLOAD', adminUploadSignature: 'SIGNATURE_UPLOAD'
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
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_AUDIT, [
    setupColumn_('timestamp'), setupColumn_('audit_id'), setupColumn_('actor_email'), setupColumn_('actor_role'),
    setupColumn_('action'), setupColumn_('target_type'), setupColumn_('target_id'), setupColumn_('outcome'),
    setupColumn_('details'), setupColumn_('request_id'), setupColumn_('previous_hash'), setupColumn_('entry_hash')
  ]).sheet;
}

function auditCanonical_(entry) {
  return [entry.timestamp, entry.audit_id, entry.actor_email, entry.actor_role, entry.action,
    entry.target_type, entry.target_id, entry.outcome, entry.details, entry.request_id, entry.previous_hash]
    .map(safeTrim_).join('|');
}

function appendAuditForRequest_(action, body, success, errorMessage, actor, requestContext) {
  var secret = PropertiesService.getScriptProperties().getProperty('AUDIT_HASH_SECRET');
  if (!secret) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var sh = ensureAuditSheet_(), hdr = getHeaderMap_(sh), target = auditTargetForRequest_(action, body);
    var lastRow = sh.getLastRow(), cHash = idxOf_(hdr, ['entry_hash']);
    var previous = lastRow >= 2 && cHash >= 0 ? safeTrim_(sh.getRange(lastRow, cHash + 1).getValue()) : '';
    var entry = {
      timestamp: Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd HH:mm:ss'),
      audit_id: 'AUD-' + Utilities.getUuid().replace(/-/g,'').slice(0, 16).toUpperCase(),
      actor_email: safeTrim_((actor || {}).email).toLowerCase(),
      actor_role: safeTrim_((actor || {}).role).toLowerCase(),
      action: AUDITED_ACTIONS_[action] || safeTrim_(action).toUpperCase(),
      target_type: target.type, target_id: target.id,
      outcome: success ? 'SUCCESS' : 'FAILURE',
      details: JSON.stringify(success ? (target.details || {}) : { error: safeTrim_(errorMessage).slice(0, 300) }),
      request_id: safeTrim_((requestContext || {}).requestId).slice(0, 100),
      previous_hash: previous
    };
    entry.entry_hash = hmac256Base64_(auditCanonical_(entry), secret);
    var row = new Array(sh.getLastColumn()).fill('');
    Object.keys(entry).forEach(function (key) { if (key in hdr) row[hdr[key]] = safeSheetValue_(entry[key]); });
    sh.appendRow(row);
    PropertiesService.getScriptProperties().setProperty('AUDIT_HEAD_HASH', entry.entry_hash);
  } finally { lock.releaseLock(); }
}

function adminGetAuditLog(filters, adminToken) {
  requireSuperadmin_(adminToken);
  filters = filters || {};
  var sh = ensureAuditSheet_();
  var expectedHead = PropertiesService.getScriptProperties().getProperty('AUDIT_HEAD_HASH') || '';
  if (sh.getLastRow() < 2) return { entries: [], total: 0, integrity: { valid: !expectedHead, checkedRows: 0 } };
  var hdr = getHeaderMap_(sh);
  var rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getDisplayValues();
  var secret = PropertiesService.getScriptProperties().getProperty('AUDIT_HASH_SECRET') || '';
  var integrity = true, previousShown = null;
  var entries = rows.map(function (row) {
    function cell(name) { return name in hdr ? safeTrim_(row[hdr[name]]) : ''; }
    return {
      timestamp: cell('timestamp'), audit_id: cell('audit_id'), actor_email: cell('actor_email'),
      actor_role: cell('actor_role'), action: cell('action'), target_type: cell('target_type'),
      target_id: cell('target_id'), outcome: cell('outcome'), details: cell('details'),
      request_id: cell('request_id'), previous_hash: cell('previous_hash'), entry_hash: cell('entry_hash')
    };
  });
  entries.forEach(function (entry) {
    if (!secret || !constantTimeEquals_(hmac256Base64_(auditCanonical_(entry), secret), entry.entry_hash) ||
        (previousShown !== null && entry.previous_hash !== previousShown)) integrity = false;
    previousShown = entry.entry_hash;
  });
  if (expectedHead && previousShown !== expectedHead) integrity = false;

  var action = safeTrim_(filters.action).toUpperCase(), outcome = safeTrim_(filters.outcome).toUpperCase();
  var query = safeTrim_(filters.query).toLowerCase();
  var filtered = entries.filter(function (entry) {
    return (!action || entry.action === action) && (!outcome || entry.outcome === outcome) &&
      (!query || [entry.actor_email, entry.target_id, entry.action, entry.details, entry.request_id].join(' ').toLowerCase().indexOf(query) >= 0);
  });
  var limit = Math.min(500, Math.max(25, Number(filters.limit) || 200));
  return {
    entries: filtered.slice(-limit).reverse().map(function (entry) {
      delete entry.previous_hash; delete entry.entry_hash;
      try { entry.details = JSON.parse(entry.details || '{}'); } catch (_) { entry.details = {}; }
      return entry;
    }),
    integrity: { valid: integrity, checkedRows: entries.length },
    total: filtered.length
  };
}
