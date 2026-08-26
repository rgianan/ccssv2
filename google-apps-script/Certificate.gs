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
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
  if (!sh) throw new Error("Sheet 'Responses' not found. Run setupCsmSheets().");
  var hdr = getHeaderMap_(sh), col = responseFieldColumns_(hdr);
  var record = findResponseByColumn_(sh, col, col.referenceId, referenceId);
  if (!record) throw new Error('Response ' + referenceId + ' was not found.');
  return { record: record, sheet: sh, header: hdr };
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
  // These details are what /verification shows, so a cached answer is now stale.
  invalidateCertificateCache_(found.record.verificationCode);
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

/**
 * Issuance is serialised. Two administrators releasing the same request, or
 * one clicking again after the proxy's 60s timeout while the first pass is
 * still running, would otherwise each mint a PDF and email the client.
 */
function adminGenerateCoa(responseId, issueKey, adminToken) {
  requireAdmin_(adminToken);
  // Resolve the output folder before taking the lock: creating it writes to
  // Settings, which acquires and releases this same script lock, and that
  // nested release would drop the guard for the rest of the issuance.
  var outputFolder = getOrCreateFolder_(COA_OUTPUT_FOLDER_SETTING, 'OSDS Certificates of Appearance');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(45000))
    throw new Error('Another certificate is being issued right now. Wait a moment, then refresh the list before trying again.');
  try {
    return issueCoa_(responseId, safeTrim_(issueKey).slice(0, 64), outputFolder);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function issueCoa_(responseId, issueKey, outputFolder) {
  var found = findResponseRow_(responseId), record = found.record;
  // A reissue that fails must not erase the fact that a valid certificate is
  // already in the client's hands, so remember what the register said first.
  var previousStatus = record.coaStatus;

  // The admin who saw the proxy time out clicks Generate again, and the click
  // carries the key of the attempt that timed out. Reissuing is a real feature,
  // so it cannot be blocked outright — but the same attempt, retried, hands
  // back the certificate that already went out instead of minting a second one
  // and emailing the client twice. A deliberate reissue arrives with a new key.
  if (issueKey && record.coaIssueKey === issueKey && record.coaStatus === 'ISSUED')
    return {
      status: 'OK',
      referenceId: record.referenceId,
      certificateUrl: record.coaLink,
      verificationCode: record.verificationCode,
      emailStatus: 'This certificate was already issued and emailed on ' + (record.coaIssuedAt || 'an earlier attempt') + '.',
      duplicate: true
    };

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
    var issuedOn = new Date();
    var docName = ('COA - ' + record.coaName + ' - ' + record.referenceId).slice(0, 180);
    var docId = createCoaWorkingCopy_(templateId, docName, outputFolder);

    var verificationCode = record.verificationCode || makeVerificationCode_();
    var baseUrl = portalBaseUrl_();
    var verificationUrl = baseUrl ? baseUrl + '/verification?code=' + encodeURIComponent(verificationCode) : '';
    // Worth saying out loud: without it the QR code and verification link are
    // silently left blank on a document that is supposed to be checkable.
    var setupNote = baseUrl
      ? ''
      : 'PORTAL_BASE_URL is not set in Vercel, so this certificate carries no QR code or verification link.';

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
    var shared = shareFileByLink_(pdfFile);
    // The working Google Doc has served its purpose; the PDF is the record.
    try { DriveApp.getFileById(docId).setTrashed(true); } catch (_) {}

    var certificateUrl = pdfFile.getUrl();

    // Record the issuance before sending: a client must never be holding a
    // certificate link that the office register still reports as unissued.
    writeResponseCells_(found.sheet, found.header, record.rowIndex, {
      coastatus: 'ISSUED',
      coalink: certificateUrl,
      coaissuedat: Utilities.formatDate(issuedOn, timezone_(), 'yyyy-MM-dd HH:mm'),
      coaissuekey: issueKey,
      verificationcode: verificationCode,
      verificationurl: verificationUrl
    });
    SpreadsheetApp.flush();
    invalidateCertificateCache_(verificationCode);

    // The certificate exists and is recorded; a mail failure is worth
    // reporting but must not roll the record back to ERROR.
    //
    // The PDF itself goes with the mail. A link is only useful to someone the
    // file is shared with, and this Workspace forbids link sharing, so the
    // client was being sent a certificate they could not open. The attachment
    // does not depend on any sharing policy; the link is included only when
    // sharing actually succeeded, and the Drive copy remains the office record.
    var emailStatus;
    try {
      emailStatus = sendCoaEmail_(
        record, shared ? certificateUrl : '', verificationCode,
        verificationUrl, settings, pdfBlob,
      );
    } catch (mailError) {
      emailStatus = 'The certificate was issued, but the email could not be sent (' +
        String(mailError && mailError.message || mailError).slice(0, 160) +
        '). Send the link manually.';
    }

    return {
      status: 'OK',
      referenceId: record.referenceId,
      certificateUrl: certificateUrl,
      verificationCode: verificationCode,
      emailStatus: safeTrim_([setupNote, emailStatus].join(' '))
    };
  } catch (error) {
    // A failed first issuance leaves ERROR for the admin to act on. A failed
    // reissue returns the row to ISSUED, because the earlier certificate and
    // its link are still valid — and leaving PROCESSING would strand the row.
    writeResponseCells_(found.sheet, found.header, record.rowIndex, {
      coastatus: previousStatus === 'ISSUED'
        ? 'ISSUED'
        : 'ERROR: ' + String(error.message || error).slice(0, 400)
    });
    // Either way the cached verification answer may no longer match the row.
    invalidateCertificateCache_(record.verificationCode);
    throw error;
  }
}

/**
 * Sends the certificate to the client as an attachment.
 *
 * `certificateUrl` is blank whenever link sharing was refused, because a Drive
 * link to a file the recipient has no access to is worse than no link at all —
 * it looks like the office sent something broken. The PDF is attached either
 * way, so delivery never depends on a sharing policy the office may not
 * control.
 */
function sendCoaEmail_(record, certificateUrl, verificationCode, verificationUrl, settings, pdfBlob) {
  if (!record.email) return 'No recipient email on file.';
  if (MailApp.getRemainingDailyQuota() < 1)
    return 'Certificate created, but the daily email quota is exhausted. Send it manually.';
  var office = settings.office_name || 'Office of Student Development and Services (OSDS)';
  var salutation = safeTrim_(record.coaTitle + ' ' + record.coaName) || 'Sir/Madam';

  // Settled before either body is written. Both of them tell the client where
  // the certificate is, so composing them first and attaching afterwards meant
  // a refused copyBlob() sent a mail promising an attachment that was not
  // there — and when link sharing had also been refused, that mail carried no
  // certificate and no link at all.
  var attachments = null;
  if (pdfBlob) {
    try {
      // A certificate PDF is a few hundred kilobytes, far inside the 25 MB cap.
      attachments = [pdfBlob.copyBlob()];
    } catch (attachError) {
      console.error('Certificate attachment skipped: ' +
        String(attachError && attachError.message || attachError));
    }
  }

  // Nothing to hand over: say so plainly rather than describe a delivery that
  // did not happen. The office still holds the file and the admin is told.
  var whereItIs = attachments
    ? 'is attached to this email as a PDF'
    : certificateUrl
      ? 'is ready'
      : 'has been issued, but could not be delivered with this message';
  var closing = attachments || certificateUrl
    ? ''
    : 'Please reply to this email and the office will send it to you.\n\n';

  var text =
    'Dear ' + salutation + ',\n\n' +
    'Your Certificate of Appearance from the ' + office + ' ' + whereItIs + '.\n\n' +
    (certificateUrl ? 'You can open it here:\n' + certificateUrl + '\n\n' : '') +
    closing +
    (verificationUrl ? 'Verification code: ' + verificationCode + '\nVerify: ' + verificationUrl + '\n\n' : '') +
    'Thank you for answering our Client Satisfaction Measurement survey.';

  var message = {
    to: record.email,
    subject: 'Certificate of Appearance — ' + record.coaName,
    body: text,
    htmlBody: coaEmailHtml_({
      office: office,
      salutation: salutation,
      certificateUrl: certificateUrl,
      verificationCode: verificationCode,
      verificationUrl: verificationUrl,
      attached: !!attachments
    }),
    name: office
  };
  if (attachments) message.attachments = attachments;

  MailApp.sendEmail(message);
  if (attachments) return 'Emailed to ' + record.email + ' with the certificate attached.';
  if (certificateUrl) return 'Emailed to ' + record.email + ' with a link to the certificate.';
  return 'Emailed to ' + record.email + ', but neither an attachment nor a link could be included. Send the PDF from Drive.';
}

/** The office mark, forced to PNG: email clients proxy images and several of
 *  them cannot decode the WebP that `f-auto` would negotiate. */
var COA_EMAIL_LOGO_ = 'https://ik.imagekit.io/k2qmtccm6/CHED_Logo_New.png?tr=w-120,q-85';

/**
 * The certificate email, laid out as a mail client will actually render it.
 *
 * Tables and inline styles throughout, because Gmail discards <style> blocks
 * and neither flexbox nor grid can be relied on. Everything is sized in pixels
 * and the palette is written out rather than referenced, since custom
 * properties do not survive either.
 *
 * The banner is a solid colour with white text rather than a background image,
 * so the header still reads when a client blocks images — which most do by
 * default, and this is the first email a stranger receives from the office.
 */
function coaEmailHtml_(view) {
  var BLUE = '#0032a0', DEEP = '#001b5e', INK = '#16223c', BODY = '#4d5563',
      MUTED = '#66748a', LINE = '#dae2ec', WASH = '#f5f8fc';
  var esc = escapeHtml_;

  function button(href, label) {
    return '' +
      '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 0;">' +
        '<tr><td bgcolor="' + BLUE + '" style="border-radius:10px;">' +
          '<a href="' + esc(href) + '" ' +
             'style="display:inline-block;padding:14px 26px;font:700 14px/1 -apple-system,BlinkMacSystemFont,' +
             '&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none;' +
             'border-radius:10px;">' + esc(label) + '</a>' +
        '</td></tr>' +
      '</table>';
  }

  var intro = view.attached
    ? 'Your <b>Certificate of Appearance</b> from the ' + esc(view.office) +
      ' is <b>attached to this email</b> as a PDF.'
    : 'Your <b>Certificate of Appearance</b> from the ' + esc(view.office) + ' is ready.';

  return '' +
'<!doctype html><html><body style="margin:0;padding:0;background:' + WASH + ';">' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' + WASH + '" style="background:' + WASH + ';padding:28px 12px;">' +
 '<tr><td align="center">' +
  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid ' + LINE + ';border-radius:14px;overflow:hidden;">' +

   // Banner
   '<tr><td bgcolor="' + DEEP + '" style="background:' + DEEP + ';padding:22px 30px;">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
     '<td width="40" style="padding-right:12px;">' +
      '<img src="' + COA_EMAIL_LOGO_ + '" width="40" height="40" alt="" ' +
        'style="display:block;width:40px;height:40px;border:0;">' +
     '</td>' +
     '<td style="font:700 14px/1.35 -apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;">' +
      'Commission on Higher Education' +
      '<div style="font-weight:400;font-size:12px;color:#b9cbe8;padding-top:2px;">' + esc(view.office) + '</div>' +
     '</td>' +
    '</tr></table>' +
   '</td></tr>' +

   // Body
   '<tr><td style="padding:30px;font:400 14px/1.65 -apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;color:' + BODY + ';">' +
    '<div style="font:700 11px/1 -apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.14em;text-transform:uppercase;color:#5074a9;padding-bottom:10px;">' +
      'Certificate of Appearance</div>' +
    '<h1 style="margin:0 0 18px;font:700 24px/1.25 -apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;color:' + INK + ';">' +
      'Your certificate is ready</h1>' +
    '<p style="margin:0 0 14px;">Dear ' + esc(view.salutation) + ',</p>' +
    '<p style="margin:0;">' + intro + '</p>' +
    (view.certificateUrl ? button(view.certificateUrl, 'Open your certificate (PDF)') : '') +

    // Verification panel
    (view.verificationCode
      ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
          'style="margin:26px 0 0;background:' + WASH + ';border:1px solid ' + LINE + ';border-radius:10px;">' +
         '<tr><td style="padding:16px 18px;">' +
          '<div style="font:700 10px/1 -apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;letter-spacing:0.12em;text-transform:uppercase;color:' + MUTED + ';padding-bottom:8px;">' +
            'Verification code</div>' +
          '<div style="font:700 15px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:' + INK + ';letter-spacing:0.04em;word-break:break-all;">' +
            esc(view.verificationCode) + '</div>' +
          (view.verificationUrl
            ? '<div style="padding-top:8px;"><a href="' + esc(view.verificationUrl) + '" ' +
              'style="font-size:12.5px;color:' + BLUE + ';text-decoration:underline;">Confirm this certificate is genuine</a></div>'
            : '') +
         '</td></tr>' +
        '</table>'
      : '') +

    // Keepsake note. The fallback URL is only printed when there is a link
    // worth falling back to — a Drive URL nobody outside the office can open
    // is not one.
    '<p style="margin:24px 0 0;font-size:12.5px;color:' + MUTED + ';">' +
      'Please keep this email for your records.' +
      (view.certificateUrl
        ? ' If the button does not work, copy this link:<br>' +
          '<a href="' + esc(view.certificateUrl) + '" style="color:' + BLUE + ';word-break:break-all;">' +
            esc(view.certificateUrl) + '</a>'
        : '') +
    '</p>' +
    '<p style="margin:18px 0 0;font-size:12.5px;color:' + MUTED + ';">' +
      'Thank you for answering our Client Satisfaction Measurement survey.</p>' +
   '</td></tr>' +

   // Footer
   '<tr><td bgcolor="' + WASH + '" style="background:' + WASH + ';border-top:1px solid ' + LINE + ';padding:18px 30px;' +
     'font:400 11.5px/1.6 -apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,Roboto,Helvetica,Arial,sans-serif;color:' + MUTED + ';">' +
     esc(view.office) + '<br>Commission on Higher Education' +
   '</td></tr>' +

  '</table>' +
 '</td></tr>' +
'</table></body></html>';
}

// -------------------------------- Uploads --------------------------------------

function adminUploadCoaTemplate(fileObj, adminToken) {
  // The template decides what an issued certificate says; same gate as the
  // signatory setting it is used with.
  requireSuperadmin_(adminToken);
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
  requireSuperadmin_(adminToken);
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

var COA_VERIFY_CACHE_PREFIX_ = 'COA_VERIFY_';

/**
 * Public and unauthenticated, so it must stay cheap: the malformed-code check
 * costs nothing, a hit is served from cache, and a miss scans the verification
 * code column alone rather than parsing the whole sheet.
 */
function verifyCertificate(code) {
  code = safeTrim_(code).toUpperCase();
  if (!/^OSDS-[A-F0-9]{20}$/.test(code)) return { valid: false };

  var cache = CacheService.getScriptCache(), cacheKey = COA_VERIFY_CACHE_PREFIX_ + code;
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_RESPONSES);
  if (!sh) return { valid: false };
  var col = responseFieldColumns_(getHeaderMap_(sh));
  var record = findResponseByColumn_(sh, col, col.verificationCode, code);
  if (!record || record.coaStatus !== 'ISSUED') return { valid: false };

  var result = {
    valid: true,
    verificationCode: code,
    name: safeTrim_(record.coaTitle + ' ' + record.coaName),
    agency: record.coaAgency,
    purpose: record.coaPurpose,
    dateCoverage: dateCoverage_(record.coaDateFrom, record.coaDateTo),
    issuedAt: record.coaIssuedAt
    // Deliberately no certificate link. The stored one points into the office's
    // Drive, which opens for staff and shows "Request access" to everybody
    // else — a dead end on a page whose whole job is to reassure a stranger
    // that the document in their hand is genuine. The details above are the
    // verification; the client already holds the PDF, attached to their email.
  };
  // Only a positive is cached, and issuance clears it: a code that is not yet
  // released must start verifying the moment it is.
  try { cache.put(cacheKey, JSON.stringify(result), 21600); } catch (_) {}
  return result;
}

function invalidateCertificateCache_(verificationCode) {
  var code = safeTrim_(verificationCode).toUpperCase();
  if (code) try { CacheService.getScriptCache().remove(COA_VERIFY_CACHE_PREFIX_ + code); } catch (_) {}
}
