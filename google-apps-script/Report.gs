/**
 * Report.gs — CSM Summary Report workbook.
 *
 * Reproduces the ARTA layout the office already submits: a CSM Summary sheet,
 * one worksheet per main program, and a DATA sheet of raw responses. The
 * reporting window is either a quarter or a whole calendar year, chosen by the
 * administrator.
 *
 * Respondent counts come from the survey. Clients served and volume of
 * transactions are office records entered in the admin Reports page and stored
 * in the ServiceStats sheet.
 */

var SQD_DIMENSIONS_ = [
  { key: 'sqd0', number: 'SQD0', dimension: '',
    en: 'I am satisfied with the service that I availed.',
    tl: 'Nasiyahan ako sa serbisyo na aking natanggap sa napuntahang tanggapan.' },
  { key: 'sqd1', number: 'SQD1', dimension: 'Responsiveness',
    en: 'I spent a reasonable amount of time for my transaction.',
    tl: 'Makatwiran ang oras na aking ginugol para sa pagproseso ng aking transaksyon.' },
  { key: 'sqd2', number: 'SQD2', dimension: 'Reliability (Quality)',
    en: "The office followed the transaction's requirements and steps based on the information provided.",
    tl: 'Ang opisina ay sumusunod sa mga kinakailangang dokumento at mga hakbang batay sa impormasyong ibinigay.' },
  { key: 'sqd3', number: 'SQD3', dimension: 'Access & Facilities',
    en: 'The steps (including payment) I needed to do for my transaction were easy and simple.',
    tl: 'Ang mga hakbang sa pagproseso, kasama na ang pagbabayad, ay madali at simple.' },
  { key: 'sqd4', number: 'SQD4', dimension: 'Communication',
    en: 'I easily found information about my transaction from the office or its website.',
    tl: 'Mabilis at madali akong nakahanap ng impormasyon tungkol sa aking transaksyon mula sa opisina o sa website nito.' },
  { key: 'sqd5', number: 'SQD5', dimension: 'Costs',
    en: 'I paid a reasonable amount of fees for my transaction.',
    tl: 'Nagbayad ako ng makatwirang halaga ng bayarin para sa aking transaksyon.' },
  { key: 'sqd6', number: 'SQD6', dimension: 'Integrity',
    en: 'I feel the office was fair to everyone, or walang palakasan, during my transaction.',
    tl: 'Pakiramdam ko ay patas ang opisina sa lahat, o walang palakasan, sa aking transaksyon.' },
  { key: 'sqd7', number: 'SQD7', dimension: 'Assurance',
    en: 'I was treated courteously by the staff, and (if asked for help) the staff was helpful.',
    tl: 'Magalang akong trinato ng mga tauhan, at (kung sakaling ako ay humingi ng tulong) alam ko na sila ay handang tumulong sa akin.' },
  { key: 'sqd8', number: 'SQD8', dimension: 'Outcome',
    en: 'I got what I needed from the government office, or (if denied) denial of request was sufficiently explained to me.',
    tl: 'Nakuha ko ang klase ng serbisyo na kailangan ko mula sa tanggapang ito, o (kung tinanggihan) sapat na naipaliwanag sa akin ang dahilan.' }
];

var CC_LABELS_ = {
  cc1: { text: 'CC1. Which of the following best describes your awareness of the CC?', options: ['1','2','3','4'] },
  cc2: { text: 'CC2. If aware of CC (answered 1-3 in CC1), would you say that the CC of this office was…', options: ['1','2','3','4','5'] },
  cc3: { text: 'CC3. If aware of CC (answered 1-3 in CC1), how much did the CC help you in your transaction?', options: ['1','2','3','4'] }
};

var REGION_ORDER_ = ['I','II','III','IV-A','IV-B','V','VI','VII','VIII','IX','X','XI','XII','NCR','CAR','CARAGA','BARMM','NIR'];

var REPORTS_FOLDER_SETTING = 'report_folder_id';

// SQD block on the CSM Summary sheet: column C starts a mean/median pair per SQD.
var SQD_FIRST_COLUMN_ = 3;
var OVERALL_COLUMN_ = SQD_FIRST_COLUMN_ + SQD_DIMENSIONS_.length * 2;      // U
var RESPONDENTS_COLUMN_ = OVERALL_COLUMN_ + 1;                              // V
var CLIENTS_COLUMN_ = OVERALL_COLUMN_ + 2;                                  // W
var TRANSACTIONS_COLUMN_ = OVERALL_COLUMN_ + 3;                             // X
var REMARKS_COLUMN_ = OVERALL_COLUMN_ + 4;                                  // Y

// -------------------------------- Entry points --------------------------------

function adminGetReports(adminToken) {
  requireAdmin_(adminToken);
  var sh = ensureReportsSheet_();
  if (sh.getLastRow() < 2) return [];
  var hdr = getHeaderMap_(sh);
  return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues()
    .map(function (row) {
      return {
        report_id: safeTrim_(row[hdr['report_id']]),
        name: safeTrim_(row[hdr['name']]),
        period_key: safeTrim_(row[hdr['period_key']]),
        period_label: safeTrim_(row[hdr['period_label']]),
        url: safeTrim_(row[hdr['url']]),
        created_at: row[hdr['created_at']] instanceof Date
          ? Utilities.formatDate(row[hdr['created_at']], timezone_(), 'yyyy-MM-dd HH:mm')
          : safeTrim_(row[hdr['created_at']]),
        created_by: safeTrim_(row[hdr['created_by']])
      };
    })
    .filter(function (entry) { return entry.report_id; })
    .reverse();
}

function ensureReportsSheet_() {
  return ensureSetupSheet_(SpreadsheetApp.getActiveSpreadsheet(), SHEET_REPORTS, [
    setupColumn_('report_id'), setupColumn_('name'), setupColumn_('period_key'), setupColumn_('period_label'),
    setupColumn_('file_id'), setupColumn_('url'), setupColumn_('created_at'), setupColumn_('created_by')
  ]).sheet;
}

function adminGenerateReport(periodInput, adminToken) {
  var session = requireAdmin_(adminToken);
  var period = normalizePeriod_(periodInput);
  var settings = readSettings_();
  var services = readServices_();
  var records = readResponses_().rows.filter(function (record) { return inPeriod_(record, period); });
  if (!records.length)
    throw new Error('There are no responses for ' + period.label + ' yet.');

  var stats = readServiceStats_(period.key);
  var workbookName = 'CSM Summary Report — OSDS — ' + period.label;
  var temporary = SpreadsheetApp.create(workbookName);

  try {
    buildSummarySheet_(temporary, period, settings, services, records, stats);
    services
      .filter(function (service) { return service.category === 'main'; })
      .forEach(function (service) {
        var serviceRecords = records.filter(function (record) { return record.serviceId === service.service_id; });
        buildServiceSheet_(temporary, period, settings, service, serviceRecords);
      });
    var otherRecords = records.filter(function (record) {
      return !services.some(function (service) {
        return service.category === 'main' && service.service_id === record.serviceId;
      });
    });
    if (otherRecords.length)
      buildServiceSheet_(temporary, period, settings,
        { code: 'OTHER', name_en: 'Other Services' }, otherRecords);
    buildDataSheet_(temporary, records);

    var defaultSheet = temporary.getSheetByName('Sheet1');
    if (defaultSheet && temporary.getSheets().length > 1) temporary.deleteSheet(defaultSheet);
    SpreadsheetApp.flush();

    var folder = getOrCreateFolder_(REPORTS_FOLDER_SETTING, 'OSDS CSM Reports');
    var xlsx = exportSpreadsheetAsXlsx_(temporary.getId());
    xlsx.setName(workbookName + '.xlsx');
    var file = folder.createFile(xlsx);

    var reportId = 'RPT-' + Utilities.getUuid().replace(/-/g,'').slice(0, 10).toUpperCase();
    recordGeneratedReport_(reportId, file, period, session.email);
    return { status: 'OK', report_id: reportId, name: file.getName(), url: file.getUrl(), period: period.key };
  } finally {
    // The temporary Google Sheet is scaffolding; only the exported file is kept.
    try { DriveApp.getFileById(temporary.getId()).setTrashed(true); } catch (_) {}
  }
}

function recordGeneratedReport_(reportId, file, period, actorEmail) {
  var sh = ensureReportsSheet_(), hdr = getHeaderMap_(sh), row = new Array(sh.getLastColumn()).fill('');
  row[hdr['report_id']] = reportId;
  row[hdr['name']] = file.getName();
  row[hdr['period_key']] = period.key;
  row[hdr['period_label']] = period.label;
  row[hdr['file_id']] = file.getId();
  row[hdr['url']] = file.getUrl();
  row[hdr['created_at']] = new Date();
  row[hdr['created_by']] = actorEmail;
  sh.appendRow(row);
}

function exportSpreadsheetAsXlsx_(spreadsheetId) {
  var response = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(spreadsheetId) +
    '/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet',
    { method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
  );
  if (response.getResponseCode() >= 300)
    throw new Error('Workbook export failed (' + response.getResponseCode() + '): ' + response.getContentText());
  return response.getBlob();
}

// ------------------------------ Sheet builders ---------------------------------

function countBy_(records, accessor) {
  var counts = {};
  records.forEach(function (record) {
    var key = accessor(record) || 'N/A';
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function writeRow_(sheet, row, startColumn, values) {
  if (!values.length) return;
  sheet.getRange(row, startColumn, 1, values.length).setValues([values]);
}

function styleHeaderRow_(sheet, row, startColumn, width) {
  sheet.getRange(row, startColumn, 1, width)
    .setFontWeight('bold').setBackground('#d8efe5').setFontColor('#0b4b3c')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
}

function styleSectionRow_(sheet, row, width) {
  sheet.getRange(row, 1, 1, width)
    .setFontWeight('bold').setBackground('#0b4b3c').setFontColor('#ffffff');
}

function buildSummarySheet_(ss, period, settings, services, records, stats) {
  var sheet = ss.insertSheet('CSM Summary', 0);
  var width = REMARKS_COLUMN_;

  sheet.getRange(1, 1, 1, width).merge()
    .setValue('CHED CLIENT SATISFACTION MEASUREMENT REPORT')
    .setFontSize(14).setFontWeight('bold').setHorizontalAlignment('center')
    .setBackground('#0b4b3c').setFontColor('#ffffff');
  sheet.getRange(3, 2).setValue('OFFICE:   ' + (settings.office_name || 'Office of Student Development and Services (OSDS)')).setFontWeight('bold');
  sheet.getRange(4, 2).setValue((period.type === 'year' ? 'PERIOD:   ' : 'QUARTER:   ') + period.label).setFontWeight('bold');

  // ---- I. Demographic questions ----
  sheet.getRange(6, 1).setValue('I.').setFontWeight('bold');
  sheet.getRange(6, 2).setValue('DEMOGRAPHIC QUESTIONS');
  styleSectionRow_(sheet, 6, width);

  var clientTypes = countBy_(records, function (record) { return record.clientType; });
  writeRow_(sheet, 7, 3, ['No. of Citizen','No. of Business','No. of Government','N/A','Total']);
  styleHeaderRow_(sheet, 7, 3, 5);
  sheet.getRange(8, 2).setValue('1. Client Type').setFontWeight('bold');
  writeRow_(sheet, 8, 3, [
    clientTypes['CITIZEN'] || 0, clientTypes['BUSINESS'] || 0, clientTypes['GOVERNMENT'] || 0,
    clientTypes['N/A'] || 0, records.length
  ]);

  var sexes = countBy_(records, function (record) { return record.sex; });
  writeRow_(sheet, 10, 3, ['No. of Male','No. of Female','N/A','Total']);
  styleHeaderRow_(sheet, 10, 3, 4);
  sheet.getRange(11, 2).setValue('2. Sex').setFontWeight('bold');
  writeRow_(sheet, 11, 3, [sexes['MALE'] || 0, sexes['FEMALE'] || 0, sexes['N/A'] || 0, records.length]);

  var brackets = countBy_(records, function (record) { return ageBracketOf_(record.age); });
  var bracketLabels = AGE_BRACKETS_.map(function (bracket) { return bracket.label; });
  writeRow_(sheet, 13, 3, ['No. of ' + bracketLabels[0], 'No. of ' + bracketLabels[1],
    'No. of ' + bracketLabels[2], 'No. of ' + bracketLabels[3], 'N/A', 'Total']);
  styleHeaderRow_(sheet, 13, 3, 6);
  sheet.getRange(14, 2).setValue('3. Age').setFontWeight('bold');
  writeRow_(sheet, 14, 3, bracketLabels.map(function (label) { return brackets[label] || 0; })
    .concat([brackets['N/A'] || 0, records.length]));

  var regions = countBy_(records, function (record) { return record.regionCode; });
  writeRow_(sheet, 16, 3, REGION_ORDER_.concat(['N/A','Total']));
  styleHeaderRow_(sheet, 16, 3, REGION_ORDER_.length + 2);
  sheet.getRange(17, 2).setValue('4. Region of Residence').setFontWeight('bold');
  writeRow_(sheet, 17, 3, REGION_ORDER_.map(function (code) { return regions[code] || 0; })
    .concat([regions['N/A'] || 0, records.length]));

  // ---- II. Citizen's Charter ----
  sheet.getRange(19, 1).setValue('II.').setFontWeight('bold');
  sheet.getRange(19, 2).setValue("QUESTIONS RELATED TO THE CITIZEN'S CHARTER");
  styleSectionRow_(sheet, 19, width);
  sheet.getRange(20, 2).setValue('*Opt stands for Option').setFontStyle('italic');

  var row = 21;
  ['cc1','cc2','cc3'].forEach(function (key) {
    var meta = CC_LABELS_[key];
    var counts = countBy_(records, function (record) { return record[key] || 'N/A'; });
    var headers = meta.options.map(function (option) { return 'Opt ' + option; }).concat(['N/A','Total']);
    writeRow_(sheet, row, 3, headers);
    styleHeaderRow_(sheet, row, 3, headers.length);
    sheet.getRange(row + 1, 2).setValue(meta.text).setWrap(true);
    writeRow_(sheet, row + 1, 3, meta.options.map(function (option) { return counts[option] || 0; })
      .concat([counts['N/A'] || 0, records.length]));
    row += 3;
  });

  // ---- III. Service Quality Dimensions ----
  var sqdSectionRow = row;
  sheet.getRange(sqdSectionRow, 1).setValue('III.').setFontWeight('bold');
  sheet.getRange(sqdSectionRow, 2).setValue('SERVICE QUALITY DIMENSIONS (SQD)');
  styleSectionRow_(sheet, sqdSectionRow, width);

  var titleRow = sqdSectionRow + 1, headerRow = titleRow + 1, subRow = headerRow + 1, firstDataRow = subRow + 1;
  sheet.getRange(titleRow, 2).setValue('Service Name').setFontWeight('bold');
  sheet.getRange(titleRow, SQD_FIRST_COLUMN_, 1, SQD_DIMENSIONS_.length * 2).merge()
    .setValue('Nine (9) service dimensions rating (1-5 Likert Scale)')
    .setFontWeight('bold').setHorizontalAlignment('center').setBackground('#eef5ed');

  SQD_DIMENSIONS_.forEach(function (dimension, index) {
    var column = SQD_FIRST_COLUMN_ + index * 2;
    sheet.getRange(headerRow, column, 1, 2).merge()
      .setValue((dimension.dimension ? dimension.dimension + '\n' : '') + '(' + dimension.number + ')');
    sheet.getRange(subRow, column).setValue('Mean');
    sheet.getRange(subRow, column + 1).setValue('Median');
  });
  [[OVERALL_COLUMN_, 'Overall Score'], [RESPONDENTS_COLUMN_, '¹No. of Respondents'],
   [CLIENTS_COLUMN_, '²No. of Clients'], [TRANSACTIONS_COLUMN_, '³Volume of Transactions'],
   [REMARKS_COLUMN_, 'Remarks']].forEach(function (entry) {
    sheet.getRange(headerRow, entry[0], 2, 1).merge().setValue(entry[1]);
  });
  styleHeaderRow_(sheet, headerRow, 1, width);
  styleHeaderRow_(sheet, subRow, 1, width);

  var reportRows = services
    .filter(function (service) { return service.category === 'main'; })
    .map(function (service) {
      return {
        code: service.code,
        name: service.name_en,
        stat: stats[service.service_id] || {},
        records: records.filter(function (record) { return record.serviceId === service.service_id; })
      };
    });
  var otherRecords = records.filter(function (record) {
    return !services.some(function (service) {
      return service.category === 'main' && service.service_id === record.serviceId;
    });
  });
  var otherService = services.filter(function (service) { return service.category === 'other'; })[0];
  if (otherRecords.length || otherService)
    reportRows.push({
      code: 'OTHER', name: 'Other Services',
      stat: (otherService && stats[otherService.service_id]) || {},
      records: otherRecords
    });

  var dataRow = firstDataRow;
  var meanMatrix = [], medianMatrix = [], overallScores = [];
  reportRows.forEach(function (entry, index) {
    sheet.getRange(dataRow, 1).setValue(index + 1);
    sheet.getRange(dataRow, 2).setValue(entry.name).setWrap(true);
    var means = [], medians = [];
    SQD_DIMENSIONS_.forEach(function (dimension, dimensionIndex) {
      var values = entry.records.map(function (record) { return record[dimension.key]; });
      var mean = round2_(meanOf_(values)), median = round2_(medianOf_(values));
      means.push(mean);
      medians.push(median);
      sheet.getRange(dataRow, SQD_FIRST_COLUMN_ + dimensionIndex * 2).setValue(mean);
      sheet.getRange(dataRow, SQD_FIRST_COLUMN_ + dimensionIndex * 2 + 1).setValue(median);
    });
    var scored = means.filter(function (value) { return value > 0; });
    var overall = scored.length ? round2_(scored.reduce(function (a, b) { return a + b; }, 0) / scored.length) : 0;
    overallScores.push(overall);
    meanMatrix.push(means);
    medianMatrix.push(medians);
    sheet.getRange(dataRow, OVERALL_COLUMN_).setValue(overall);
    sheet.getRange(dataRow, RESPONDENTS_COLUMN_).setValue(entry.records.length);
    sheet.getRange(dataRow, CLIENTS_COLUMN_).setValue(entry.stat.clients === '' || entry.stat.clients == null ? '' : Number(entry.stat.clients));
    sheet.getRange(dataRow, TRANSACTIONS_COLUMN_).setValue(entry.stat.transactions === '' || entry.stat.transactions == null ? '' : Number(entry.stat.transactions));
    sheet.getRange(dataRow, REMARKS_COLUMN_).setValue(entry.stat.remarks || '').setWrap(true);
    dataRow++;
  });

  var totalRow = dataRow;
  sheet.getRange(totalRow, 2).setValue('OVERALL RATING').setFontWeight('bold');
  SQD_DIMENSIONS_.forEach(function (dimension, dimensionIndex) {
    var columnMeans = meanMatrix.map(function (means) { return means[dimensionIndex]; }).filter(function (value) { return value > 0; });
    var columnMedians = medianMatrix.map(function (medians) { return medians[dimensionIndex]; }).filter(function (value) { return value > 0; });
    sheet.getRange(totalRow, SQD_FIRST_COLUMN_ + dimensionIndex * 2)
      .setValue(columnMeans.length ? round2_(columnMeans.reduce(function (a, b) { return a + b; }, 0) / columnMeans.length) : 0);
    sheet.getRange(totalRow, SQD_FIRST_COLUMN_ + dimensionIndex * 2 + 1)
      .setValue(columnMedians.length ? round2_(medianOf_(columnMedians)) : 0);
  });
  var scoredOverall = overallScores.filter(function (value) { return value > 0; });
  sheet.getRange(totalRow, OVERALL_COLUMN_)
    .setValue(scoredOverall.length ? round2_(scoredOverall.reduce(function (a, b) { return a + b; }, 0) / scoredOverall.length) : 0);
  sheet.getRange(totalRow, RESPONDENTS_COLUMN_).setValue(records.length);
  sheet.getRange(totalRow, CLIENTS_COLUMN_).setValue(
    reportRows.reduce(function (sum, entry) { return sum + (Number(entry.stat.clients) || 0); }, 0));
  sheet.getRange(totalRow, TRANSACTIONS_COLUMN_).setValue(
    reportRows.reduce(function (sum, entry) { return sum + (Number(entry.stat.transactions) || 0); }, 0));
  sheet.getRange(totalRow, 1, 1, width).setFontWeight('bold').setBackground('#eef5ed');
  sheet.getRange(firstDataRow, SQD_FIRST_COLUMN_, totalRow - firstDataRow + 1, OVERALL_COLUMN_ - SQD_FIRST_COLUMN_ + 1)
    .setNumberFormat('0.00');

  // ---- IV. Client feedback ----
  var feedbackRow = totalRow + 2;
  sheet.getRange(feedbackRow, 1).setValue('IV.').setFontWeight('bold');
  sheet.getRange(feedbackRow, 2).setValue('Summarize the feedback gathered from the clients who availed of the different services');
  styleSectionRow_(sheet, feedbackRow, width);
  var suggestions = records.filter(function (record) { return record.suggestions; });
  if (suggestions.length) {
    suggestions.forEach(function (record, index) {
      sheet.getRange(feedbackRow + 1 + index, 2)
        .setValue('• [' + record.serviceCode + '] ' + record.suggestions).setWrap(true);
    });
  } else {
    sheet.getRange(feedbackRow + 1, 2).setValue('No written feedback was submitted for this period.').setFontStyle('italic');
  }

  var footnoteRow = feedbackRow + Math.max(suggestions.length, 1) + 2;
  [
    '¹No. of Respondents - refers to the number of clients that opted to rate the service received through the CSM questionnaire',
    '²No. of Clients - refers to the number of clients served for the service',
    '³Volume of Transactions - refers to the number of transactions that have been made for the service'
  ].forEach(function (note, index) {
    sheet.getRange(footnoteRow + index, 2).setValue(note).setFontSize(9).setFontColor('#6d7f79');
  });

  sheet.setColumnWidth(1, 34);
  sheet.setColumnWidth(2, 320);
  for (var column = SQD_FIRST_COLUMN_; column <= OVERALL_COLUMN_; column++) sheet.setColumnWidth(column, 62);
  sheet.setColumnWidth(RESPONDENTS_COLUMN_, 82);
  sheet.setColumnWidth(CLIENTS_COLUMN_, 82);
  sheet.setColumnWidth(TRANSACTIONS_COLUMN_, 95);
  sheet.setColumnWidth(REMARKS_COLUMN_, 200);
  sheet.setFrozenColumns(2);
}

/** Sheet names may not repeat, and Sheets rejects several punctuation marks. */
function sheetNameFor_(code, existingNames) {
  var base = safeTrim_(code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 26) || 'SERVICE';
  var name = base, suffix = 2;
  while (existingNames.indexOf(name) >= 0) name = base.slice(0, 24) + suffix++;
  existingNames.push(name);
  return name;
}

function buildServiceSheet_(ss, period, settings, service, records) {
  var existing = ss.getSheets().map(function (sheet) { return sheet.getName(); });
  var sheet = ss.insertSheet(sheetNameFor_(service.code, existing));

  sheet.getRange(1, 1).setValue('OFFICE:').setFontWeight('bold');
  sheet.getRange(1, 2).setValue(settings.office_name || 'Office of Student Development and Services (OSDS)');
  sheet.getRange(2, 1).setValue(period.type === 'year' ? 'PERIOD:' : 'QUARTER:').setFontWeight('bold');
  sheet.getRange(2, 2).setValue(period.label);
  sheet.getRange(3, 1).setValue('SERVICE NAME:').setFontWeight('bold');
  sheet.getRange(3, 2, 1, 9).merge().setValue(service.name_en).setWrap(true);

  sheet.getRange(5, 1, 3, 1).merge().setValue('Client #')
    .setFontWeight('bold').setVerticalAlignment('middle').setHorizontalAlignment('center');
  sheet.getRange(5, 3, 1, 8).merge().setValue('Service Quality Dimensions Rating (1-5 Likert Scale)')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(6, 2, 2, 1).merge().setValue('SQD0')
    .setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle');
  SQD_DIMENSIONS_.slice(1).forEach(function (dimension, index) {
    sheet.getRange(6, 3 + index).setValue(dimension.dimension);
    sheet.getRange(7, 3 + index).setValue(dimension.number);
  });
  styleHeaderRow_(sheet, 5, 1, 10);
  styleHeaderRow_(sheet, 6, 1, 10);
  styleHeaderRow_(sheet, 7, 1, 10);

  var firstDataRow = 8;
  records.forEach(function (record, index) {
    var row = [('Client ' + (index + 1))].concat(SQD_DIMENSIONS_.map(function (dimension) {
      var value = Number(record[dimension.key]);
      return value >= 1 && value <= 5 ? value : 'N/A';
    }));
    sheet.getRange(firstDataRow + index, 1, 1, row.length).setValues([row]);
  });

  var meanRow = firstDataRow + Math.max(records.length, 1);
  var medianRow = meanRow + 1;
  sheet.getRange(meanRow, 1).setValue('Mean').setFontWeight('bold');
  sheet.getRange(medianRow, 1).setValue('Median').setFontWeight('bold');
  SQD_DIMENSIONS_.forEach(function (dimension, index) {
    var values = records.map(function (record) { return record[dimension.key]; });
    sheet.getRange(meanRow, 2 + index).setValue(round2_(meanOf_(values)));
    sheet.getRange(medianRow, 2 + index).setValue(round2_(medianOf_(values)));
  });
  sheet.getRange(meanRow, 2, 2, SQD_DIMENSIONS_.length).setNumberFormat('0.00')
    .setFontWeight('bold').setBackground('#eef5ed');

  var tallyRow = medianRow + 2;
  sheet.getRange(tallyRow, 1).setValue('In each SQD, how many clients have a rating of:').setFontWeight('bold');
  ['5','4','3','2','1','0 or N/A'].forEach(function (rating, index) {
    var row = tallyRow + 1 + index;
    sheet.getRange(row, 1).setValue(rating);
    SQD_DIMENSIONS_.forEach(function (dimension, dimensionIndex) {
      var count = records.filter(function (record) {
        var value = safeTrim_(record[dimension.key]);
        return rating === '0 or N/A' ? (value === 'N/A' || value === '' || value === '0') : value === rating;
      }).length;
      sheet.getRange(row, 2 + dimensionIndex).setValue(count);
    });
  });

  var signRow = tallyRow + 9;
  [['Prepared by:', settings.report_prepared_by, settings.report_prepared_title, 1],
   ['Reviewed by:', settings.report_reviewed_by, settings.report_reviewed_title, 5],
   ['Approved by:', settings.report_approved_by, settings.report_approved_title, 8]].forEach(function (block) {
    sheet.getRange(signRow, block[3]).setValue(block[0]).setFontWeight('bold');
    sheet.getRange(signRow + 2, block[3]).setValue(block[1] || '').setFontWeight('bold');
    sheet.getRange(signRow + 3, block[3]).setValue(block[2] || '');
  });

  sheet.setColumnWidth(1, 110);
  for (var column = 2; column <= 10; column++) sheet.setColumnWidth(column, 92);
  sheet.setFrozenRows(7);
}

function buildDataSheet_(ss, records) {
  var sheet = ss.insertSheet('DATA');
  var headers = ['Month','1. Client Type','2. Sex','3. Age','4. Region of Residence','5. Service Availed','CC1','CC2','CC3']
    .concat(SQD_DIMENSIONS_.map(function (dimension) {
      return dimension.number + '. ' + dimension.en + ' / ' + dimension.tl;
    }))
    .concat(['Email','Comments/Suggestions','Reference','Transaction Date']);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#0b4b3c').setFontColor('#ffffff').setWrap(true);

  if (records.length) {
    var rows = records.map(function (record) {
      return [
        record.month, record.clientType, record.sex, record.age || 'N/A',
        record.regionCode, record.serviceCode,
        record.cc1, record.cc2, record.cc3
      ]
        .concat(SQD_DIMENSIONS_.map(function (dimension) {
          var value = Number(record[dimension.key]);
          return value >= 1 && value <= 5 ? value : 'N/A';
        }))
        .concat([record.email, record.suggestions, record.referenceId, record.transactionDate]);
    });
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(6, 150);
}
