/**
 * Worker.gs — the Google half of the new backend.
 *
 * Once the portal's records move to Postgres, Apps Script keeps only what
 * needs Google: making certificate PDFs from the Docs template, emailing them
 * and the decline notice through MailApp (free on the office's Workspace
 * account), building report workbooks, and filing uploaded templates and
 * signatures in Drive. The new backend sends everything each step needs and
 * records the outcome itself; nothing here reads or writes a sheet.
 *
 * Callable only with the worker token, which the browser-facing proxy never
 * holds. Run setupCsmWorker() once from the editor and copy the token it logs
 * into Vercel as CSM_WORKER_TOKEN.
 */

var WORKER_ACTIONS_ = {
  workerPing: workerPing_,
  workerMintCertificate: workerMintCertificate_,
  workerSendCertificateEmail: workerSendCertificateEmail_,
  workerSendDeclineEmail: workerSendDeclineEmail_,
  workerGenerateReport: workerGenerateReport_,
  workerUploadFile: workerUploadFile_
};

function isWorkerAction_(action) {
  return Object.prototype.hasOwnProperty.call(WORKER_ACTIONS_, action);
}

/**
 * Run once from the Apps Script editor, then copy the logged token into
 * Vercel as CSM_WORKER_TOKEN. Only its hash is kept here. Running it again
 * replaces the token, and the old one stops working at once.
 */
function setupCsmWorker() {
  var token = randomSecret_();
  PropertiesService.getScriptProperties().setProperty('WORKER_TOKEN_HASH', sha256Base64_(token));
  var result = {
    status: 'OK',
    workerToken: token,
    vercelVariable: 'CSM_WORKER_TOKEN',
    warning: 'Copy this token to Vercel now. Apps Script keeps only its hash.'
  };
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

function assertWorkerToken_(token) {
  var expected = PropertiesService.getScriptProperties().getProperty('WORKER_TOKEN_HASH');
  if (!expected) throw new Error('The worker is not configured. Run setupCsmWorker().');
  if (!token || !constantTimeEquals_(sha256Base64_(String(token)), expected))
    throw new Error('Forbidden: invalid worker token.');
}

/** doPost hands every worker action here, before the proxy-token check. */
function handleWorkerRequest_(body, action) {
  try {
    assertWorkerToken_(body.workerToken);
    delete body.workerToken;
    var data = WORKER_ACTIONS_[action](body);
    return jsonResponse_({ ok: true, data: data, perf: perfReport_(action, {}, true) });
  } catch (error) {
    return jsonResponse_({
      ok: false,
      error: error && error.message ? error.message : String(error),
      perf: perfReport_(action, {}, false)
    });
  }
}

/**
 * A folder kept by id, or a new one under `name` when there is none yet or
 * it can no longer be opened. The caller remembers the id it gets back —
 * getOrCreateFolder_ without the Settings sheet.
 */
function workerFolder_(folderId, name) {
  if (safeTrim_(folderId)) {
    try {
      var folder = DriveApp.getFolderById(folderId);
      folder.getName();
      return folder;
    } catch (_) {}
  }
  return DriveApp.createFolder(name);
}

/** Whether the worker answers, and how much email it can still send today. */
function workerPing_() {
  return { status: 'OK', timezone: timezone_(), mailQuota: MailApp.getRemainingDailyQuota() };
}

/**
 * Makes one certificate PDF. The backend has already checked the request and
 * chosen the verification code; this fills in the template and files the PDF.
 */
function workerMintCertificate_(body) {
  var record = body.record || {}, settings = body.settings || {};
  if (!safeTrim_(settings.coa_template_id))
    throw new Error('No Certificate of Appearance template is configured. Upload one in Settings.');
  var issuedOn = new Date(body.issuedOn);
  if (isNaN(issuedOn)) throw new Error('The worker was sent no issue time.');
  var folder = workerFolder_(body.outputFolderId, 'OSDS Certificates of Appearance');
  var minted = mintCoaPdf_(record, settings, folder,
    safeTrim_(body.verificationCode), safeTrim_(body.verificationUrl), issuedOn);
  return {
    fileId: minted.pdfFile.getId(),
    certificateUrl: minted.pdfFile.getUrl(),
    shared: minted.shared,
    outputFolderId: folder.getId()
  };
}

/**
 * Emails an issued certificate, attaching the PDF filed in Drive. Sent only
 * after the backend has recorded the issuance.
 */
function workerSendCertificateEmail_(body) {
  var pdfBlob = DriveApp.getFileById(safeTrim_(body.fileId)).getBlob();
  return {
    emailStatus: sendCoaEmail_(body.record || {}, safeTrim_(body.certificateUrl),
      safeTrim_(body.verificationCode), safeTrim_(body.verificationUrl), body.settings || {}, pdfBlob)
  };
}

function workerSendDeclineEmail_(body) {
  return {
    emailStatus: sendCoaDeclineEmail_(body.record || {}, safeTrim_(body.reason), body.settings || {})
  };
}

/**
 * Builds one CSM Summary Report from the records sent. The answer policy is
 * applied here, as buildReport_ applies it, so the workbook reads responses
 * exactly as it always has.
 */
function workerGenerateReport_(body) {
  var period = normalizePeriod_(body.period);
  var services = body.services || [];
  var records = applyAnswerPolicy_(body.records || [], services);
  if (!records.length)
    throw new Error('There are no responses for ' + period.label + ' yet.');
  var folder = workerFolder_(body.folderId, 'OSDS CSM Reports');
  var built = buildReportWorkbook_(period, body.settings || {}, services, records,
    body.stats || {}, folder, safeTrim_(body.actorEmail), body.adminEmails || []);
  return {
    fileId: built.file.getId(),
    name: built.file.getName(),
    url: built.file.getUrl(),
    accessNote: built.accessNote,
    folderId: folder.getId()
  };
}

/** Files an uploaded certificate template or signature image in Drive. */
function workerUploadFile_(body) {
  var file = body.file || {};
  if (body.kind === 'template') {
    if (!file.base64 || !file.filename) throw new Error('No file payload.');
    if (!/\.docx?$/i.test(file.filename))
      throw new Error('The certificate template must be a Word (.doc or .docx) file.');
    if (file.base64.length > 14000000) throw new Error('Templates must be 10 MB or smaller.');
  } else if (body.kind === 'signature') {
    if (!file.base64 || !file.filename ||
        !/^image\/(png|jpeg|webp)$/i.test(String(file.mimeType || '')) ||
        file.base64.length > 2800000)
      throw new Error('Please upload a PNG, JPG, or WebP signature image no larger than 2 MB.');
  } else {
    throw new Error('Unknown upload kind.');
  }
  var folder = workerFolder_(body.folderId, 'OSDS Certificate Templates');
  var created = folder.createFile(Utilities.newBlob(
    Utilities.base64Decode(file.base64),
    file.mimeType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    file.filename
  ));
  return { id: created.getId(), name: created.getName(), url: created.getUrl(), folderId: folder.getId() };
}
