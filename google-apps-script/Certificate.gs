/**
 * Certificate.gs — Certificate of Appearance issuance.
 *
 * The template is a Word document whose placeholders match the OSDS layout:
 *   {{title}} {{name_of_client}} {{agency}} {{purpose}} {{date_coverage}}
 *   {{date_issued}} {{signatory}} {{designation}} {{Timestamp}}
 * and, optionally, {{Signature}}, {{VerificationCode}}, {{VerificationUrl}},
 * and {{QRCode}}.
 *
 * Issuance is deliberately admin-triggered: a client asks for a certificate in
 * the survey, an administrator checks the details, then releases it.
 */

var COA_TEMPLATE_FOLDER_SETTING = 'coa_template_folder_id';
var COA_OUTPUT_FOLDER_SETTING = 'coa_output_folder_id';

// ------------------------------- Requests ------------------------------------

function adminGetCoaRequests(filters, adminToken) {
  requireAdmin_(adminToken);
  var wanted = safeTrim_(filters.status).toUpperCase();
  return readResponses_().rows
    .filter(function (record) {
      if (!record.coaRequested) return false;
      if (!wanted) return true;
      if (wanted === 'ERROR') return record.coaStatus.indexOf('ERROR') === 0;
      return record.coaStatus === wanted;
    })
    .reverse()
    .map(function (record) {
      return {
        referenceId: record.referenceId,
        email: record.email,
        coaTitle: record.coaTitle,
        coaName: record.coaName,
        coaAgency: record.coaAgency,
        coaPurpose: record.coaPurpose,
        coaDateFrom: record.coaDateFrom,
        coaDateTo: record.coaDateTo,
        coaDateCoverage: dateCoverage_(record.coaDateFrom, record.coaDateTo),
        coaStatus: record.coaStatus.indexOf('ERROR') === 0 ? 'ERROR' : record.coaStatus,
        coaError: record.coaStatus.indexOf('ERROR') === 0 ? record.coaStatus : '',
        coaLink: record.coaLink,
        coaIssuedAt: record.coaIssuedAt,
        verificationCode: record.verificationCode
      };
    });
}

function findResponseRow_(referenceId) {
  referenceId = safeTrim_(referenceId);
  if (!referenceId) throw new Error('A response reference is required.');
  var data = readResponses_();
  var record = data.rows.filter(function (row) { return row.referenceId === referenceId; })[0];
  if (!record) throw new Error('Response ' + referenceId + ' was not found.');
  return { record: record, sheet: data.sheet, header: data.header };
}

function writeResponseCells_(sheet, header, rowIndex, values) {
  Object.keys(values).forEach(function (name) {
    var col = idxOf_(header, [name]);
    if (col >= 0) sheet.getRange(rowIndex, col + 1).setValue(safeSheetValue_(values[name]));
  });
}

function adminSaveCoaDetails(payload, adminToken) {
  requireAdmin_(adminToken);
  var found = findResponseRow_(payload.referenceId);
  var name = safeTrim_(payload.coaName).slice(0, 160);
  var agency = safeTrim_(payload.coaAgency).slice(0, 200);
  var purpose = safeTrim_(payload.coaPurpose).slice(0, 300);
  var from = parseDate_(payload.coaDateFrom);
  var to = parseDate_(payload.coaDateTo);
  if (!name || !agency || !purpose || !from)
    throw new Error('Name, agency, purpose, and the date of appearance are all required.');
  if (to && to < from) throw new Error('The end date cannot be earlier than the start date.');

  writeResponseCells_(found.sheet, found.header, found.record.rowIndex, {
    coatitle: safeTrim_(payload.coaTitle).slice(0, 12),
    coaname: name,
    coaagency: agency,
    coapurpose: purpose,
    coadatefrom: Utilities.formatDate(from, timezone_(), 'yyyy-MM-dd'),
    coadateto: to ? Utilities.formatDate(to, timezone_(), 'yyyy-MM-dd') : ''
  });
  return { status: 'OK', referenceId: found.record.referenceId };
}

// ------------------------------- Formatting -----------------------------------

/** Reads naturally after "…for the purpose of {{purpose}} ". */
function dateCoverage_(from, to) {
  var start = parseDate_(from), end = parseDate_(to);
  if (!start) return '';
  if (!end || Utilities.formatDate(end, timezone_(), 'yyyy-MM-dd') === Utilities.formatDate(start, timezone_(), 'yyyy-MM-dd'))
    return 'on ' + longDate_(start);
  return 'from ' + longDate_(start) + ' to ' + longDate_(end);
}

/** Reads naturally after "Issued this ". */
function issuedPhrase_(date) {
  return ordinal_(date.getDate()) + ' day of ' + Utilities.formatDate(date, timezone_(), 'MMMM yyyy');
}

// ---------------------------- Document plumbing --------------------------------

/** replaceText takes a regular expression, so brace placeholders need escaping. */
function placeholderPattern_(token) {
  return token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function docSections_(doc) {
  var sections = [doc.getBody()];
  var header = doc.getHeader(), footer = doc.getFooter();
  if (header) sections.push(header);
  if (footer) sections.push(footer);
  return sections;
}

function replaceDocText_(doc, token, value) {
  var pattern = placeholderPattern_(token);
  docSections_(doc).forEach(function (section) {
    section.replaceText(pattern, String(value == null ? '' : value));
  });
}

/**
 * Swaps a text placeholder for an inline image. Each pass removes the matched
 * text first, so the loop terminates even if the token appears several times.
 */
function replaceDocImage_(doc, token, blob, widthPoints) {
  var pattern = placeholderPattern_(token);
  docSections_(doc).forEach(function (section) {
    for (var guard = 0; guard < 10; guard++) {
      var found = section.findText(pattern);
      if (!found) return;
      var element = found.getElement();
      element.asText().deleteText(found.getStartOffset(), found.getEndOffsetInclusive());
      var container = element.getParent();
      if (container && container.getType() === DocumentApp.ElementType.PARAGRAPH) {
        var image = container.asParagraph().appendInlineImage(blob);
        if (widthPoints) {
          var ratio = image.getHeight() / image.getWidth();
          image.setWidth(widthPoints).setHeight(Math.round(widthPoints * ratio));
        }
      }
    }
  });
}

/** Copies the stored template into a Google Doc, converting Word files. */
function createCoaWorkingCopy_(templateId, name, folder) {
  var file = DriveApp.getFileById(templateId);
  if (file.getMimeType() === MimeType.GOOGLE_DOCS)
    return file.makeCopy(name, folder).getId();

  var boundary = '-------csm314159265358979323846';
  var metadata = {
    name: name,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folder.getId()]
  };
  var blob = file.getBlob();
  var body =
    '\r\n--' + boundary + '\r\n' +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) + '\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: ' + (blob.getContentType() || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') + '\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' + Utilities.base64Encode(blob.getBytes()) +
    '\r\n--' + boundary + '--';

  var response = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method: 'post',
      contentType: 'multipart/related; boundary=' + boundary,
      payload: body,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }
  );
  if (response.getResponseCode() >= 300)
    throw new Error('Template conversion failed (' + response.getResponseCode() + '): ' + response.getContentText());
  return JSON.parse(response.getContentText()).id;
}

function driveExportPdf_(fileId) {
  var response = UrlFetchApp.fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/export?mimeType=application/pdf',
    { method: 'get', headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true }
  );
  if (response.getResponseCode() >= 300)
    throw new Error('PDF export failed (' + response.getResponseCode() + '): ' + response.getContentText());
  return response.getBlob().setName('certificate.pdf');
}

// -------------------------------- Issuance -------------------------------------

function adminGenerateCoa(responseId, adminToken) {
  requireAdmin_(adminToken);
  var found = findResponseRow_(responseId), record = found.record;
  if (!record.coaRequested) throw new Error('This response did not request a Certificate of Appearance.');
  if (!record.coaName || !record.coaAgency || !record.coaPurpose || !record.coaDateFrom)
    throw new Error('Complete the certificate details before issuing.');

  var settings = readSettings_();
  var templateId = safeTrim_(settings.coa_template_id);
  if (!templateId)
    throw new Error('No Certificate of Appearance template is configured. Upload one in Settings.');
  if (!safeTrim_(settings.coa_signatory) || !safeTrim_(settings.coa_designation))
    throw new Error('Set the certificate signatory and designation in Settings before issuing.');

  writeResponseCells_(found.sheet, found.header, record.rowIndex, { coastatus: 'PROCESSING' });
  SpreadsheetApp.flush();

  try {
    var outputFolder = getOrCreateFolder_(COA_OUTPUT_FOLDER_SETTING, 'OSDS Certificates of Appearance');
    var issuedOn = new Date();
    var docName = ('COA - ' + record.coaName + ' - ' + record.referenceId).slice(0, 180);
    var docId = createCoaWorkingCopy_(templateId, docName, outputFolder);

    var verificationCode = record.verificationCode || makeVerificationCode_();
    var baseUrl = portalBaseUrl_();
    var verificationUrl = baseUrl ? baseUrl + '/verification?code=' + encodeURIComponent(verificationCode) : '';

    var doc = DocumentApp.openById(docId);
    replaceDocText_(doc, '{{title}}', record.coaTitle);
    replaceDocText_(doc, '{{name_of_client}}', record.coaName);
    replaceDocText_(doc, '{{agency}}', record.coaAgency);
    replaceDocText_(doc, '{{purpose}}', record.coaPurpose);
    replaceDocText_(doc, '{{date_coverage}}', dateCoverage_(record.coaDateFrom, record.coaDateTo));
    replaceDocText_(doc, '{{date_issued}}', issuedPhrase_(issuedOn));
    replaceDocText_(doc, '{{signatory}}', settings.coa_signatory);
    replaceDocText_(doc, '{{designation}}', settings.coa_designation);
    replaceDocText_(doc, '{{Timestamp}}', Utilities.formatDate(issuedOn, timezone_(), 'MMMM d, yyyy \'at\' h:mm a'));
    replaceDocText_(doc, '{{VerificationCode}}', verificationCode);
    replaceDocText_(doc, '{{VerificationUrl}}', verificationUrl);

    if (safeTrim_(settings.coa_signature_id)) {
      try {
        replaceDocImage_(doc, '{{Signature}}', DriveApp.getFileById(settings.coa_signature_id).getBlob(), 150);
      } catch (signatureError) {
        replaceDocText_(doc, '{{Signature}}', '');
      }
    } else {
      replaceDocText_(doc, '{{Signature}}', '');
    }

    if (verificationUrl) {
      try {
        var qr = UrlFetchApp.fetch('https://quickchart.io/qr?size=300&margin=2&text=' + encodeURIComponent(verificationUrl))
          .getBlob().setName('verification-qr.png');
        replaceDocImage_(doc, '{{QRCode}}', qr, 90);
      } catch (qrError) {
        replaceDocText_(doc, '{{QRCode}}', '');
      }
    } else {
      replaceDocText_(doc, '{{QRCode}}', '');
    }

    doc.saveAndClose();

    var pdfBlob = driveExportPdf_(docId);
    pdfBlob.setName('Certificate of Appearance - ' + record.coaName + ' - ' + record.referenceId + '.pdf');
    var pdfFile = outputFolder.createFile(pdfBlob);
    try { pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
    // The working Google Doc has served its purpose; the PDF is the record.
    try { DriveApp.getFileById(docId).setTrashed(true); } catch (_) {}

    var certificateUrl = pdfFile.getUrl();
    var emailStatus = sendCoaEmail_(record, certificateUrl, verificationCode, verificationUrl, settings);

    writeResponseCells_(found.sheet, found.header, record.rowIndex, {
      coastatus: 'ISSUED',
      coalink: certificateUrl,
      coaissuedat: Utilities.formatDate(issuedOn, timezone_(), 'yyyy-MM-dd HH:mm'),
      verificationcode: verificationCode,
      verificationurl: verificationUrl
    });

    return {
      status: 'OK',
      referenceId: record.referenceId,
      certificateUrl: certificateUrl,
      verificationCode: verificationCode,
      emailStatus: emailStatus
    };
  } catch (error) {
    writeResponseCells_(found.sheet, found.header, record.rowIndex, {
      coastatus: 'ERROR: ' + String(error.message || error).slice(0, 400)
    });
    throw error;
  }
}

function sendCoaEmail_(record, certificateUrl, verificationCode, verificationUrl, settings) {
  if (!record.email) return 'No recipient email on file.';
  if (MailApp.getRemainingDailyQuota() < 1)
    return 'Certificate created, but the daily email quota is exhausted. Send the link manually.';
  var office = settings.office_name || 'Office of Student Development and Services (OSDS)';
  var salutation = safeTrim_(record.coaTitle + ' ' + record.coaName) || 'Sir/Madam';
  var text =
    'Dear ' + salutation + ',\n\n' +
    'Your Certificate of Appearance from the ' + office + ' is ready:\n' + certificateUrl + '\n\n' +
    (verificationUrl ? 'Verification code: ' + verificationCode + '\nVerify: ' + verificationUrl + '\n\n' : '') +
    'Thank you for answering our Client Satisfaction Measurement survey.';
  var html =
    '<p>Dear ' + escapeHtml_(salutation) + ',</p>' +
    '<p>Your Certificate of Appearance from the <b>' + escapeHtml_(office) + '</b> is ready:</p>' +
    '<p><a href="' + escapeHtml_(certificateUrl) + '">Open your certificate (PDF)</a></p>' +
    (verificationUrl
      ? '<p>Verification code: <b>' + escapeHtml_(verificationCode) + '</b><br>' +
        '<a href="' + escapeHtml_(verificationUrl) + '">Verify this certificate</a></p>'
      : '') +
    '<p>Thank you for answering our Client Satisfaction Measurement survey.</p>';
  MailApp.sendEmail({
    to: record.email,
    subject: 'Certificate of Appearance — ' + record.coaName,
    body: text,
    htmlBody: html,
    name: office
  });
  return 'Emailed to ' + record.email + '.';
}

// -------------------------------- Uploads --------------------------------------

function adminUploadCoaTemplate(fileObj, adminToken) {
  requireAdmin_(adminToken);
  if (!fileObj || !fileObj.base64 || !fileObj.filename) throw new Error('No file payload.');
  if (!/\.docx?$/i.test(fileObj.filename))
    throw new Error('The certificate template must be a Word (.doc or .docx) file.');
  if (fileObj.base64.length > 14000000) throw new Error('Templates must be 10 MB or smaller.');

  var folder = getOrCreateFolder_(COA_TEMPLATE_FOLDER_SETTING, 'OSDS Certificate Templates');
  var blob = Utilities.newBlob(
    Utilities.base64Decode(fileObj.base64),
    fileObj.mimeType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    fileObj.filename
  );
  var file = folder.createFile(blob);
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

function adminUploadSignature(fileObj, adminToken) {
  requireAdmin_(adminToken);
  if (!fileObj || !fileObj.base64 || !fileObj.filename ||
      !/^image\/(png|jpeg|webp)$/i.test(String(fileObj.mimeType || '')) ||
      fileObj.base64.length > 2800000)
    throw new Error('Please upload a PNG, JPG, or WebP signature image no larger than 2 MB.');
  var folder = getOrCreateFolder_(COA_TEMPLATE_FOLDER_SETTING, 'OSDS Certificate Templates');
  var blob = Utilities.newBlob(Utilities.base64Decode(fileObj.base64), fileObj.mimeType, fileObj.filename);
  var file = folder.createFile(blob);
  return { id: file.getId(), name: file.getName(), url: file.getUrl() };
}

// ------------------------------ Verification ------------------------------------

function verifyCertificate(code) {
  code = safeTrim_(code).toUpperCase();
  if (!/^OSDS-[A-F0-9]{20}$/.test(code)) return { valid: false };
  var record = readResponses_().rows.filter(function (row) {
    return row.verificationCode.toUpperCase() === code && row.coaStatus === 'ISSUED';
  })[0];
  if (!record) return { valid: false };
  return {
    valid: true,
    verificationCode: code,
    name: safeTrim_(record.coaTitle + ' ' + record.coaName),
    agency: record.coaAgency,
    purpose: record.coaPurpose,
    dateCoverage: dateCoverage_(record.coaDateFrom, record.coaDateTo),
    issuedAt: record.coaIssuedAt,
    certificateUrl: record.coaLink
  };
}
