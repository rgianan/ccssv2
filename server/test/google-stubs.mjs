/**
 * Drive, Docs, MailApp's attachments and UrlFetchApp, faked well enough for
 * Worker.gs to run end to end in the Apps Script harness. Everything asked of
 * them is written to `log`, so a test can check what the worker did: which
 * placeholders it filled, which folder it filed into, what it shared.
 */
export function googleStubs({ shareRefused = true } = {}) {
  const log = {
    replaced: {},
    files: [],
    folders: [],
    trashed: [],
    fetched: [],
  };
  let next = 0;
  const id = (prefix) => `${prefix}-${++next}`;

  const blob = (
    name,
    contentType = "application/octet-stream",
    bytes = [1],
  ) => ({
    getName: () => name,
    setName(value) {
      name = value;
      return this;
    },
    getContentType: () => contentType,
    getBytes: () => bytes,
    copyBlob() {
      return blob(name, contentType, bytes);
    },
  });

  const folder = (folderId, name) => ({
    getId: () => folderId,
    getName: () => name,
    createFile: (b) => {
      const fileId = id("file");
      const file = {
        getId: () => fileId,
        getName: () => b.getName(),
        getUrl: () => `https://drive.example/${fileId}`,
        getBlob: () => b,
        setSharing: () => {
          if (shareRefused) throw new Error("Sharing is restricted by policy.");
        },
        addViewer: () => {},
        getOwner: () => ({ getEmail: () => "owner@ched.gov.ph" }),
      };
      log.files.push({ folder: folderId, id: fileId, name: b.getName() });
      files.set(fileId, file);
      return file;
    },
  });
  const folders = new Map([["F-KNOWN", folder("F-KNOWN", "Known folder")]]);
  const files = new Map();

  const section = {
    replaceText: (pattern, value) => {
      log.replaced[pattern.replace(/\\/g, "")] = value;
    },
    findText: () => null,
  };

  const globals = {
    blob,
    MimeType: { GOOGLE_DOCS: "application/vnd.google-apps.document" },
    ScriptApp: { getOAuthToken: () => "oauth", getProjectTriggers: () => [] },
    DriveApp: {
      Access: { ANYONE_WITH_LINK: "ANYONE_WITH_LINK" },
      Permission: { VIEW: "VIEW" },
      getFolderById: (folderId) => {
        if (!folders.has(folderId)) throw new Error("No such folder.");
        return folders.get(folderId);
      },
      createFolder: (name) => {
        const created = folder(id("folder"), name);
        folders.set(created.getId(), created);
        log.folders.push(name);
        return created;
      },
      getFileById: (fileId) =>
        files.get(fileId) || {
          // The template, a Google Doc already.
          getMimeType: () => "application/vnd.google-apps.document",
          makeCopy: () => ({ getId: () => "working-doc" }),
          setTrashed: () => log.trashed.push(fileId),
          getBlob: () => blob(`${fileId}.bin`),
        },
    },
    DocumentApp: {
      openById: () => ({
        getBody: () => section,
        getHeader: () => null,
        getFooter: () => null,
        saveAndClose: () => {},
      }),
    },
    UrlFetchApp: {
      fetch: (url) => {
        log.fetched.push(url);
        return {
          getResponseCode: () => 200,
          getContentText: () => "",
          getBlob: () =>
            blob(
              url.includes("quickchart") ? "qr.png" : "certificate.pdf",
              "application/pdf",
            ),
        };
      },
    },
  };
  return { globals, log };
}
