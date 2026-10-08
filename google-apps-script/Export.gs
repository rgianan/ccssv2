/**
 * Export.gs — phase 3 of the migration: everything the import needs, as one
 * JSON file in your Drive.
 *
 * Run exportCsmData() from the Apps Script editor (choose it in the function
 * list, then Run). It only reads the sheets. The file holds every response,
 * clients' email addresses included, and the administrators' password hashes:
 * download it, run the import, then delete it from Drive and from your
 * computer.
 *
 * Delete this file once the migration is done.
 */

var EXPORT_FORMAT_ = 'csm-export-1';
var EXPORT_PROPERTIES_ = ['AUDIT_HEAD_HASH', 'AUDIT_DROPPED_COUNT', 'AUDIT_DROPPED_LAST', 'PORTAL_BASE_URL'];

/**
 * Every sheet as stored: values, not displayed text, row for row, header
 * first. A date cell becomes {"$date": "<the instant>"}; the import reads it
 * in the zones named here, as Apps Script did.
 */
function buildCsmExport_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var data = {
    format: EXPORT_FORMAT_,
    exportedAt: new Date().toISOString(),
    scriptTimeZone: timezone_(),
    spreadsheetTimeZone: spreadsheetTimeZone_(),
    sheets: {},
    properties: {}
  };
  [SHEET_RESPONSES, SHEET_SERVICES, SHEET_SERVICE_STATS, SHEET_SETTINGS,
    SHEET_REPORTS, SHEET_USERS, SHEET_WHITELIST, SHEET_AUDIT].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh || sh.getLastRow() < 1 || sh.getLastColumn() < 1) { data.sheets[name] = null; return; }
    data.sheets[name] = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues()
      .map(function (row) {
        return row.map(function (cell) { return isDate_(cell) ? { $date: cell.toISOString() } : cell; });
      });
  });
  var props = PropertiesService.getScriptProperties();
  EXPORT_PROPERTIES_.forEach(function (key) {
    var value = props.getProperty(key);
    if (value !== null) data.properties[key] = value;
  });
  return data;
}

function exportCsmData() {
  var data = buildCsmExport_();
  var name = 'CSM export ' + Utilities.formatDate(new Date(), timezone_(), 'yyyy-MM-dd HHmm') + '.json';
  var file = DriveApp.createFile(Utilities.newBlob(JSON.stringify(data), 'application/json', name));
  var counts = {};
  Object.keys(data.sheets).forEach(function (sheet) {
    counts[sheet] = data.sheets[sheet] ? data.sheets[sheet].length - 1 : 'missing';
  });
  Logger.log('Rows per sheet: ' + JSON.stringify(counts));
  Logger.log('Saved "' + name + '" to your Drive: ' + file.getUrl() + '\n' +
    'It holds every response, clients\' email addresses included, and the administrators\' password hashes. ' +
    'Download it, run the import, then delete it from Drive and from your computer.');
  return { status: 'OK', file: file.getUrl(), rows: counts };
}

// --------------------------------- Rollback ----------------------------------

/**
 * Undoing a cutover: puts back what the new backend took after it, from the
 * file `npm run db:rollback` makes ("CSM rollback …json"). Upload that file
 * to Drive, then run this from the editor. Responses already in the sheet are
 * left alone, so running it twice adds nothing twice. Other administrator
 * actions the file lists — a program edited, a request declined — are for
 * redoing by hand.
 */
function restoreFromNewBackend() {
  var files = DriveApp.searchFiles("title contains 'CSM rollback' and trashed = false"), newest = null;
  while (files.hasNext()) {
    var file = files.next();
    if (!newest || file.getDateCreated() > newest.getDateCreated()) newest = file;
  }
  if (!newest)
    throw new Error('Upload the file npm run db:rollback made (named "CSM rollback …") to Drive first.');
  var result = restoreRows_(JSON.parse(newest.getBlob().getDataAsString()));
  Logger.log('From "' + newest.getName() + '": ' + JSON.stringify(result));
  return result;
}

function restoreRows_(data) {
  if (!data || data.format !== 'csm-rollback-1')
    throw new Error('That is not a file from npm run db:rollback.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = ensureResponseColumns_(), hdr = getHeaderMap_(sh), lastCol = sh.getLastColumn();
    var col = responseFieldColumns_(hdr), rowOf = {};
    if (sh.getLastRow() >= 2)
      sh.getRange(2, col.referenceId + 1, sh.getLastRow() - 1, 1).getValues().forEach(function (cell, i) {
        var ref = safeTrim_(cell[0]).toUpperCase();
        if (ref) rowOf[ref] = i + 2;
      });

    // Written as submitResponse and issueCoa_ write them: times as dates, the
    // issue time and notice version as text, everything else made safe.
    function asCell(header, value) {
      if (value === '' || value === null || value === undefined) return '';
      if (header === 'Timestamp' || header === 'privacy_notice_presented_at') return new Date(value);
      if (header === 'COAIssuedAt' || header === 'privacy_notice_version') return "'" + value;
      return safeSheetValue_(value);
    }

    var added = [], skipped = [], rows = [];
    (data.responses || []).forEach(function (response) {
      var ref = safeTrim_(response.ResponseID).toUpperCase();
      if (!ref || rowOf[ref]) { skipped.push(response.ResponseID); return; }
      var row = new Array(lastCol).fill('');
      Object.keys(response).forEach(function (header) {
        var at = idxOf_(hdr, [header.toLowerCase()]);
        if (at >= 0) row[at] = asCell(header, response[header]);
      });
      rows.push(row);
      added.push(response.ResponseID);
      rowOf[ref] = -1;
    });
    if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, lastCol).setValues(rows);

    var updated = [];
    (data.certificateUpdates || []).forEach(function (update) {
      var rowIndex = rowOf[safeTrim_(update.ResponseID).toUpperCase()];
      if (!(rowIndex > 0)) return;
      var cells = {};
      Object.keys(update).forEach(function (header) {
        if (header === 'ResponseID') return;
        cells[header.toLowerCase()] = header === 'COAIssuedAt' && update[header] ? "'" + update[header] : update[header];
      });
      writeResponseCells_(sh, hdr, rowIndex, cells);
      invalidateCertificateCache_(update.VerificationCode);
      updated.push(update.ResponseID);
    });
    invalidateResultCache_();
    return {
      status: 'OK', added: added, skipped: skipped, certificatesUpdated: updated,
      otherActionsToRedo: (data.otherActions || []).length
    };
  } finally {
    lock.releaseLock();
  }
}
