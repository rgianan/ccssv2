/**
 * Browser API client. Every production call goes through /api/gas-proxy so the
 * Apps Script URL and shared token stay on the server.
 */

const GAS_URL = import.meta.env.VITE_GAS_WEB_APP_URL || "";
const USE_PROXY =
  import.meta.env.PROD || import.meta.env.VITE_USE_PROXY === "true";
const REMOTE_URL = USE_PROXY ? "/api/gas-proxy" : GAS_URL;
const HAS_REMOTE = Boolean(REMOTE_URL);
const DEMO_MODE =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEMO_MODE === "true";

const SESSION_KEY = "csm_admin_session";

export const readAdminSession = () => {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (session?.expiresAt && session.expiresAt > Date.now()) return session;
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  } catch {
    return null;
  }
};
export const storeAdminSession = (session) =>
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
export const clearAdminSession = () => {
  sessionStorage.removeItem(SESSION_KEY);
  // Nothing read under one account may survive into the next. The cache holds
  // responses, certificate requests and the audit log — leaving it in place
  // would hand the next person to sign in on this machine a view of data their
  // own account might not be allowed to see.
  clearCache();
};
const adminToken = () => readAdminSession()?.token || "";

// ------------------------------- Read cache ----------------------------------

/**
 * Apps Script answers a read in roughly a second, so every tab switch used to
 * cost one. The dashboard's reads are of things that change when an
 * administrator changes them, and every one of those goes through this module,
 * so a short-lived cache with explicit invalidation is safe: the entry that
 * could go stale is dropped by the write that would have staled it.
 *
 * In memory only, and only for the life of the tab. Nothing here belongs in
 * storage that outlives the session.
 */
const cacheStore = new Map();
const inFlight = new Map();

/** Long enough that flicking between tabs is instant, short enough that a
 *  change made in another tab appears without a reload. */
const READ_TTL_MS = 60_000;
const CONFIG_TTL_MS = 10 * 60_000;

/**
 * Handed out as a copy. A cached array returned by reference becomes shared
 * mutable state the moment a panel sorts or splices it, and the corruption
 * surfaces later, somewhere else, as data that was never fetched that way.
 */
const copyOf = (value) =>
  typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value ?? null));

function cachedCall(key, ttl, run) {
  const hit = cacheStore.get(key);
  if (hit && Date.now() - hit.at < ttl) return Promise.resolve(copyOf(hit.value));
  // Two panels mounting at once must not become two identical round trips.
  const pending = inFlight.get(key);
  if (pending) return pending.then(copyOf);
  const request = run()
    .then((value) => {
      cacheStore.set(key, { at: Date.now(), value });
      inFlight.delete(key);
      return value;
    })
    .catch((error) => {
      inFlight.delete(key);
      throw error;
    });
  inFlight.set(key, request);
  return request.then(copyOf);
}

/** Drops every entry whose key starts with any of these prefixes. */
export const invalidate = (...prefixes) => {
  for (const key of [...cacheStore.keys()])
    if (prefixes.some((prefix) => key.startsWith(prefix))) cacheStore.delete(key);
};

/**
 * Writes a value straight into the cache. Used after an optimistic update so
 * that leaving a tab and coming back shows what the screen already showed,
 * rather than briefly reverting to the version before the edit.
 */
export const seedCache = (key, value) =>
  cacheStore.set(key, { at: Date.now(), value });

export const clearCache = () => {
  cacheStore.clear();
  inFlight.clear();
};

/**
 * Guarantees a list to callers that render one.
 *
 * Every read below that is documented as returning rows goes through this. A
 * panel that maps over its result should not be able to blank the whole
 * dashboard because a backend returned `{}` — React unmounts the tree on a
 * render error, and one panel's surprise became a white screen with the
 * navigation gone and no way back.
 */
const listOf = (value) => (Array.isArray(value) ? value : []);

/** Cache keys, named once so a panel seeding one cannot misspell it. */
export const cacheKeys = {
  services: "adminGetServices",
  settings: "adminGetSettings",
  users: "adminGetUsers",
  reports: "adminGetReports",
  overview: (period) => `adminGetOverview:${JSON.stringify(period)}`,
  responses: (filters) => `adminGetResponses:${JSON.stringify(filters)}`,
  coaRequests: (filters) => `adminGetCoaRequests:${JSON.stringify(filters)}`,
  serviceStats: (period) => `adminGetServiceStats:${JSON.stringify(period)}`,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requireBackend = () => {
  if (!HAS_REMOTE)
    throw new Error(
      "The production backend is not configured. Set GAS_WEB_APP_URL in Vercel.",
    );
};

async function remote(action, payload = {}, attempt = 0) {
  try {
    const response = await fetch(REMOTE_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action, ...payload }),
    });
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      throw new Error(
        /^\s*</.test(responseText)
          ? "The backend returned a webpage instead of API data. Redeploy the current Vercel source and confirm GAS_WEB_APP_URL uses the Apps Script /exec URL."
          : "The backend returned an invalid response. Check the Vercel function logs for gas-proxy.",
      );
    }
    if (!response.ok || data.ok === false)
      throw new Error(data.error || "Request failed");
    return data.data ?? data;
  } catch (error) {
    // Apps Script serializes writes with a document lock; a burst of submissions
    // surfaces as a transient lock error rather than a real failure.
    const retryable =
      /lock|busy|simultaneous|too many|network|fetch|temporar|timeout/i.test(
        String(error?.message || error),
      );
    if (action === "submitResponse" && retryable && attempt < 5) {
      await sleep(
        Math.min(12000, 750 * 2 ** attempt) + Math.floor(Math.random() * 700),
      );
      return remote(action, payload, attempt + 1);
    }
    throw error;
  }
}

// `async` matters: requireBackend() throws, and callers chain .catch() on the
// result. A synchronous throw would escape that chain and blank the page.
const call = async (action, payload = {}) => {
  requireBackend();
  return remote(action, payload);
};
const adminCall = (action, payload = {}) =>
  call(action, { ...payload, adminToken: adminToken() });

// ------------------------------- Public -------------------------------------

const demoConfig = {
  officeName: "Office of Student Development and Services (OSDS)",
  services: [
    {
      service_id: "S-DEMO1",
      code: "CEM/CED",
      name_en:
        "Application for Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)",
      name_tl:
        "Aplikasyon para sa Certification of Eligibility for Admission to Medical/Dental Program (CEM/CED)",
      category: "main",
      active: true,
    },
    {
      service_id: "S-DEMO2",
      code: "OTHER",
      name_en: "Other Services",
      name_tl: "Iba pang Serbisyo",
      category: "other",
      active: true,
    },
  ],
};

export async function getPortalConfig() {
  if (DEMO_MODE && !HAS_REMOTE) return demoConfig;
  return cachedCall("getPortalConfig", CONFIG_TTL_MS, () =>
    call("getPortalConfig"),
  );
}

/**
 * Forces the next read to go to the server. The survey calls this when the
 * backend has told it the programme list it is holding is out of date, which
 * is precisely the moment a cached copy would be wrong.
 */
export const refreshPortalConfig = () => {
  invalidate("getPortalConfig");
  return getPortalConfig();
};

export async function submitResponse(payload, turnstileToken = "") {
  if (DEMO_MODE && !HAS_REMOTE) {
    await sleep(600);
    return { status: "OK", referenceId: "CSM-DEMO0000", coaRequested: false };
  }
  return call("submitResponse", { payload, turnstileToken });
}

export const verifyCertificate = (code) => call("verifyCertificate", { code });

// ------------------------------- Admin --------------------------------------

export async function adminLogin(email, password, turnstileToken = "") {
  const session = await call("adminLogin", { email, password, turnstileToken });
  // Whatever the previous occupant of this tab read is not this account's to see.
  clearCache();
  storeAdminSession(session);
  return session;
}

export async function adminLogout() {
  try {
    if (HAS_REMOTE && adminToken())
      await remote("adminLogout", { adminToken: adminToken() });
  } finally {
    clearAdminSession();
  }
}

export const getAdminOverview = (period) =>
  cachedCall(cacheKeys.overview(period), READ_TTL_MS, () =>
    adminCall("adminGetOverview", { period }),
  );
export const getAdminResponses = (filters = {}) =>
  cachedCall(cacheKeys.responses(filters), READ_TTL_MS, () =>
    adminCall("adminGetResponses", { filters }),
  );

export const getCoaRequests = (filters = {}) =>
  cachedCall(cacheKeys.coaRequests(filters), READ_TTL_MS, () =>
    adminCall("adminGetCoaRequests", { filters }),
  ).then(listOf);

/**
 * Every write below drops what it invalidates before returning, so the caller's
 * next read cannot be served a copy from before the change. Certificate work
 * touches the response row as well as the request list, and both the dashboard
 * and the report read from responses — hence the wider sweeps.
 */
export const saveCoaDetails = async (payload) => {
  const result = await adminCall("adminSaveCoaDetails", { payload });
  invalidate("adminGetCoaRequests", "adminGetResponses");
  return result;
};
export const generateCoa = async (responseId, issueKey) => {
  const result = await adminCall("adminGenerateCoa", { responseId, issueKey });
  invalidate("adminGetCoaRequests", "adminGetResponses", "adminGetOverview");
  return result;
};

export const getAdminServices = () =>
  cachedCall(cacheKeys.services, READ_TTL_MS, () =>
    adminCall("adminGetServices"),
  ).then(listOf);
export const saveAdminService = async (payload) => {
  const result = await adminCall("adminSaveService", { payload });
  // The public programme list and the fee flag both come from this sheet, so
  // the survey's own cached config has to go with it.
  invalidate("adminGetServices", "getPortalConfig", "adminGetOverview");
  return result;
};

export const getServiceStats = (period) =>
  cachedCall(cacheKeys.serviceStats(period), READ_TTL_MS, () =>
    adminCall("adminGetServiceStats", { period }),
  ).then(listOf);
export const saveServiceStats = async (period, rows) => {
  const result = await adminCall("adminSaveServiceStats", { period, rows });
  invalidate("adminGetServiceStats");
  return result;
};

export const generateReport = async (period) => {
  const result = await adminCall("adminGenerateReport", { period });
  invalidate("adminGetReports");
  return result;
};
export const getGeneratedReports = () =>
  cachedCall(cacheKeys.reports, READ_TTL_MS, () =>
    adminCall("adminGetReports"),
  ).then(listOf);

export const getAdminSettings = () =>
  cachedCall(cacheKeys.settings, READ_TTL_MS, () =>
    adminCall("adminGetSettings"),
  );
export const saveAdminSettings = async (settings) => {
  const result = await adminCall("adminSaveSettings", { settings });
  invalidate("adminGetSettings");
  return result;
};

export const getAdminUsers = () =>
  cachedCall(cacheKeys.users, READ_TTL_MS, () =>
    adminCall("adminGetUsers"),
  ).then(listOf);
export const saveAdminUser = async (payload) => {
  const result = await adminCall("adminSaveUser", { payload });
  invalidate("adminGetUsers");
  return result;
};

// Deliberately uncached: a tamper-evident log read from a copy is not a read
// of the log.
export const getAdminAuditLog = (filters = {}) =>
  adminCall("adminGetAuditLog", { filters });

export async function uploadCoaTemplate(file) {
  if (!file || file.size > 10 * 1024 * 1024)
    throw new Error("Certificate templates must be 10 MB or smaller.");
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const result = await adminCall("adminUploadCoaTemplate", {
    payload: { filename: file.name, mimeType: file.type, base64 },
  });
  invalidate("adminGetSettings");
  return result;
}

export async function uploadSignature(file) {
  if (!file || file.size > 2 * 1024 * 1024)
    throw new Error("E-signature images must be 2 MB or smaller.");
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const result = await adminCall("adminUploadSignature", {
    payload: { filename: file.name, mimeType: file.type, base64 },
  });
  invalidate("adminGetSettings");
  return result;
}
