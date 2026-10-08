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
