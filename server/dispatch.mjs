import { measured } from "./db.mjs";
import {
  getPortalConfig,
  submitResponse,
  verifyCertificate,
} from "./actions/public.mjs";
import {
  adminGetAuditLog,
  adminGetCoaRequests,
  adminGetOverview,
  adminGetReports,
  adminGetResponses,
  adminGetServices,
  adminGetServiceStats,
  adminGetSettings,
  adminGetUsers,
} from "./actions/admin-reads.mjs";
import {
  adminChangeResponseService,
  adminDeclineCoa,
  adminReopenCoa,
  adminSaveCoaDetails,
  adminSaveService,
  adminSaveServiceStats,
  adminSaveSettings,
  adminSaveUser,
} from "./actions/admin-writes.mjs";
import {
  adminGenerateCoa,
  adminGenerateReport,
  adminUploadCoaTemplate,
  adminUploadSignature,
} from "./actions/google.mjs";
import { appendAudit, isAudited } from "./audit.mjs";
import {
  adminLogin,
  adminLogout,
  adminValidateSession,
  getAdminSession,
} from "./auth.mjs";
import { UserError } from "./errors.mjs";
import { safeTrim } from "./records.mjs";
import { defaultWorker } from "./worker.mjs";

/**
 * The new backend's doPost: one request in the {action, …} form the browser
 * already sends, one reply in the {ok, data} or {ok: false, error} form it
 * already reads, and an audit entry for every privileged action.
 *
 * Every action the browser sends is answered here once CSM_BACKEND switches
 * the proxy over; until then Apps Script answers them all.
 */

const ACTIONS = {
  getPortalConfig: (ctx) => getPortalConfig(ctx),
  submitResponse: (ctx, body) => submitResponse(ctx, body.payload || {}),
  verifyCertificate: (ctx, body) => verifyCertificate(ctx, body.code),
  adminLogin: (ctx, body) => adminLogin(ctx, body.email, body.password),
  adminLogout: (ctx, body) => adminLogout(ctx, body.adminToken),
  adminValidateSession: (ctx, body) =>
    adminValidateSession(ctx, body.adminToken),
  adminGetOverview: (ctx, body) =>
    adminGetOverview(ctx, body.period || {}, body.adminToken),
  adminGetResponses: (ctx, body) =>
    adminGetResponses(ctx, body.filters || {}, body.adminToken),
  adminGetCoaRequests: (ctx, body) =>
    adminGetCoaRequests(ctx, body.filters || {}, body.adminToken),
  adminGetServices: (ctx, body) => adminGetServices(ctx, body.adminToken),
  adminGetSettings: (ctx, body) => adminGetSettings(ctx, body.adminToken),
  adminGetServiceStats: (ctx, body) =>
    adminGetServiceStats(ctx, body.period || {}, body.adminToken),
  adminGetReports: (ctx, body) => adminGetReports(ctx, body.adminToken),
  adminGetUsers: (ctx, body) => adminGetUsers(ctx, body.adminToken),
  adminGetAuditLog: (ctx, body) =>
    adminGetAuditLog(ctx, body.filters || {}, body.adminToken),
  adminSaveService: (ctx, body) =>
    adminSaveService(ctx, body.payload || {}, body.adminToken),
  adminSaveSettings: (ctx, body) =>
    adminSaveSettings(ctx, body.settings || {}, body.adminToken),
  adminSaveServiceStats: (ctx, body) =>
    adminSaveServiceStats(
      ctx,
      body.period || {},
      body.rows || [],
      body.adminToken,
    ),
  adminSaveUser: (ctx, body) =>
    adminSaveUser(ctx, body.payload || {}, body.adminToken),
  adminChangeResponseService: (ctx, body) =>
    adminChangeResponseService(ctx, body.payload || {}, body.adminToken),
  adminSaveCoaDetails: (ctx, body) =>
    adminSaveCoaDetails(ctx, body.payload || {}, body.adminToken),
  adminDeclineCoa: (ctx, body) =>
    adminDeclineCoa(ctx, body.payload || {}, body.adminToken),
  adminReopenCoa: (ctx, body) =>
    adminReopenCoa(ctx, body.payload || {}, body.adminToken),
  adminGenerateCoa: (ctx, body) =>
    adminGenerateCoa(
      ctx,
      body.responseId,
      body.issueKey,
      body.adminToken,
      body.expectedStatus,
    ),
  adminGenerateReport: (ctx, body) =>
    adminGenerateReport(ctx, body.period || {}, body.adminToken),
  adminUploadCoaTemplate: (ctx, body) =>
    adminUploadCoaTemplate(ctx, body.payload || {}, body.adminToken),
  adminUploadSignature: (ctx, body) =>
    adminUploadSignature(ctx, body.payload || {}, body.adminToken),
};

export { UserError };

const TEMPORARY =
  "The database is temporarily unavailable. Please try again in a moment.";

/**
 * Who is acting, resolved before the action runs: a sign-in names the email
 * it was attempted for, anything else the session's holder. Logging out
 * ends the session, so its holder has to be known first.
 */
async function auditActorForRequest(ctx, action, body) {
  if (action === "adminLogin")
    return { email: safeTrim(body.email).toLowerCase(), role: "" };
  const session = await getAdminSession(ctx, body.adminToken);
  return session
    ? { email: session.email, role: session.role }
    : { email: "", role: "" };
}

function auditActorForResult(action, data, fallback) {
  if (action === "adminLogin" && data?.user)
    return {
      email: safeTrim(data.user.email).toLowerCase(),
      role: safeTrim(data.user.role).toLowerCase(),
    };
  return fallback || { email: "", role: "" };
}

export async function handleRequest(
  body,
  { db, requestContext = {}, now = new Date(), worker = defaultWorker() },
) {
  const started = performance.now();
  const action = safeTrim(body?.action);
  const { db: timed, stats } = measured(db);
  const perf = () => ({
    ms: Math.round(performance.now() - started),
    queries: stats.queries,
    dbMs: Math.round(stats.dbMs),
  });
  const ctx = { db: timed, now, requestContext, worker };
  const audited = Object.hasOwn(ACTIONS, action) && isAudited(action);
  const audit = (entry) =>
    appendAudit(timed, {
      action,
      body,
      requestContext,
      now,
      moved: ctx.moved,
      ...entry,
    });
  let actor = null;
  try {
    if (!Object.hasOwn(ACTIONS, action))
      throw new UserError(`Unknown action: ${action}`);
    if (audited) actor = await auditActorForRequest(ctx, action, body);
    const data = await ACTIONS[action](ctx, body);
    if (audited)
      // The action has happened; failing to record it is logged and counted
      // as a dropped entry, not reported as the action failing.
      await audit({
        success: true,
        actor: auditActorForResult(action, data, actor),
      }).catch((error) =>
        console.error(`[csm-audit] ${action} not recorded:`, error),
      );
    return { ok: true, data, perf: perf() };
  } catch (error) {
    if (audited)
      await audit({
        success: false,
        errorMessage: error?.message || String(error),
        actor,
      }).catch(() => {});
    if (error instanceof UserError)
      return { ok: false, error: error.message, perf: perf() };
    console.error(
      `[csm-backend] ${action} failed (request ${safeTrim(requestContext.requestId) || "-"}):`,
      error,
    );
    // "temporarily" is one of the words the browser retries a submission on.
    return { ok: false, error: TEMPORARY, perf: perf() };
  }
}
