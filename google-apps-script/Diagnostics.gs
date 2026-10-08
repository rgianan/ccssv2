/**
 * Phase 0 of the backend migration: how big the spreadsheet is, and how long
 * each kind of read takes against it.
 *
 * Run csmDiagnostics() once from the Apps Script editor (choose it in the
 * function list, then Run). It only reads: no sheet, setting or session is
 * changed. The log ends with a block between "CSM DIAGNOSTICS BEGIN" and
 * "CSM DIAGNOSTICS END" — copy that block and send it back.
 *
 * Delete this file once the migration is done.
 */
function csmDiagnostics() {
  var started = Date.now();
  var report = {
    generatedAt: Utilities.formatDate(new Date(), timezone_(), "yyyy-MM-dd'T'HH:mm:ssXXX"),
    timezone: timezone_(),
    sheets: [],
    responses: {},
    properties: {},
    timings: {}
  };

  // --- How big each sheet is. Allocated cells, not just the used ones, count
  // towards the spreadsheet's 10 million cell limit and slow every open.
  var ss = SpreadsheetApp.getActiveSpreadsheet(), allocated = 0;
  ss.getSheets().forEach(function (sheet) {
    var cells = sheet.getMaxRows() * sheet.getMaxColumns();
    allocated += cells;
    report.sheets.push({
      name: sheet.getName(),
      usedRows: sheet.getLastRow(),
      usedColumns: sheet.getLastColumn(),
      allocatedRows: sheet.getMaxRows(),
      allocatedColumns: sheet.getMaxColumns(),
      allocatedCells: cells
    });
  });
  report.allocatedCells = allocated;
  report.percentOfCellLimit = Math.round(allocated / 100000) / 100;

  // --- What the Responses sheet holds, by year.
  var sh = ss.getSheetByName(SHEET_RESPONSES);
  if (sh && sh.getLastRow() >= 2) {
    var hdr = getHeaderMap_(sh), col = responseFieldColumns_(hdr);
    var values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    var byYear = {}, byStatus = {}, blank = 0, real = 0;
    values.forEach(function (row) {
      if (!cellText_(row, col.referenceId)) { blank++; return; }
      real++;
      var date = col.transactionDate >= 0 ? fmtDate_(row[col.transactionDate]) : '';
      var year = String(date).slice(0, 4) || 'unknown';
      byYear[year] = (byYear[year] || 0) + 1;
      var status = col.coaStatus >= 0 ? (safeTrim_(row[col.coaStatus]).toUpperCase() || 'NONE') : 'NONE';
      byStatus[status] = (byStatus[status] || 0) + 1;
    });
    report.responses = {
      rows: real,
      blankRows: blank,
      columns: sh.getLastColumn(),
      byTransactionYear: byYear,
      byCertificateStatus: byStatus
    };
  }

  // --- Script properties hold the admin sessions; every sign-in check reads them.
  var props = PropertiesService.getScriptProperties().getProperties(), propBytes = 0, sessions = 0;
  Object.keys(props).forEach(function (key) {
    propBytes += key.length + String(props[key]).length;
    if (key.indexOf(SESSION_PROPERTY_PREFIX_) === 0) sessions++;
  });
  report.properties = { count: Object.keys(props).length, adminSessions: sessions, approxBytes: propBytes, limitBytes: 500000 };

  // --- How long each kind of work takes. Three runs each; the median is what
  // to compare. The first run of a read can be slower than the others.
  var month = Number(Utilities.formatDate(new Date(), timezone_(), 'M'));
  var period = normalizePeriod_({
    type: 'quarter',
    year: Utilities.formatDate(new Date(), timezone_(), 'yyyy'),
    quarter: String(Math.floor((month - 1) / 3) + 1)
  });
  var probes = {
    listSheets: function () { SpreadsheetApp.getActiveSpreadsheet().getSheets(); },
    readAllResponses: function () { readResponses_(); },
    readOnePageOfResponses: function () { readResponseWindow_(0, 25); },
    certificateLookupWorstCase: function () {
      var sheet = ss.getSheetByName(SHEET_RESPONSES);
      if (!sheet) return;
      var columns = responseFieldColumns_(getHeaderMap_(sheet));
      findResponseByColumn_(sheet, columns, columns.verificationCode, 'NO-SUCH-CODE-0000');
    },
    overviewThisQuarterUncached: function () { computeOverview_(period); },
    readPrograms: function () { readServices_(); },
    readSettings: function () { readSettings_(); },
    cacheRead: function () { CacheService.getScriptCache().get('CSM_DIAGNOSTICS_PROBE'); },
    propertyRead: function () { PropertiesService.getScriptProperties().getProperty(RESULT_VERSION_PROPERTY_); },
    lockAcquireAndRelease: function () {
      var lock = LockService.getDocumentLock();
      if (lock.tryLock(5000)) lock.releaseLock();
    }
  };
  Object.keys(probes).forEach(function (name) {
    var samples = [];
    for (var i = 0; i < 3; i++) {
      var t = Date.now();
      try {
        probes[name]();
        samples.push(Date.now() - t);
      } catch (error) {
        samples.push('error: ' + String(error && error.message || error).slice(0, 120));
        break;
      }
    }
    var numbers = samples.filter(function (s) { return typeof s === 'number'; }).sort(function (a, b) { return a - b; });
    report.timings[name] = {
      medianMs: numbers.length ? numbers[Math.floor(numbers.length / 2)] : null,
      samplesMs: samples
    };
  });
  report.timings.overviewPeriod = period.key;
  report.totalRunMs = Date.now() - started;

  // --- A readable summary, then the block to send back.
  var lines = [];
  lines.push('Responses: ' + (report.responses.rows || 0) + ' rows' +
    (report.responses.blankRows ? ' (+' + report.responses.blankRows + ' blank)' : '') +
    ', ' + (report.responses.columns || 0) + ' columns');
  Object.keys(report.responses.byTransactionYear || {}).sort().forEach(function (year) {
    lines.push('  ' + year + ': ' + report.responses.byTransactionYear[year]);
  });
  lines.push('Allocated cells: ' + allocated + ' (' + report.percentOfCellLimit + '% of the limit)');
  lines.push('Script properties: ' + report.properties.count + ' (' + sessions + ' admin sessions, ~' + propBytes + ' bytes)');
  Object.keys(probes).forEach(function (name) {
    lines.push('  ' + name + ': ' + report.timings[name].medianMs + ' ms (median of ' + report.timings[name].samplesMs.join(', ') + ')');
  });
  Logger.log(lines.join('\n'));
  Logger.log('CSM DIAGNOSTICS BEGIN\n' + JSON.stringify(report, null, 1) + '\nCSM DIAGNOSTICS END');
  return report;
}
