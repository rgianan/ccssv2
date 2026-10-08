import { createHmac, randomUUID } from "node:crypto";
import { officeSecond } from "./dates.mjs";
import { normalizePeriod } from "./periods.mjs";
import { safeTrim } from "./records.mjs";

/**
 * The tamper-evident audit log, as Code.gs keeps it: one entry per privileged
 * action, each carrying the HMAC of its own fields and of the entry before.
 * The fields, their order, their limits and the hash are unchanged, so the
 * chain imported from the Audit sheet verifies here and continues unbroken.
 */

export const AUDITED_ACTIONS = {
  adminLogin: "LOGIN",
  adminLogout: "LOGOUT",
  adminSaveService: "SERVICE_SAVE",
  adminSaveSettings: "SETTINGS_SAVE",
  adminGenerateCoa: "COA_GENERATE",
  adminSaveCoaDetails: "COA_UPDATE",
  adminGenerateReport: "REPORT_GENERATE",
  adminDeclineCoa: "COA_DECLINE",
  adminReopenCoa: "COA_REOPEN",
  adminChangeResponseService: "RESPONSE_RECLASSIFY",
  adminSaveServiceStats: "SERVICE_STATS_SAVE",
  adminSaveUser: "USER_SAVE",
  adminUploadCoaTemplate: "TEMPLATE_UPLOAD",
  adminUploadSignature: "SIGNATURE_UPLOAD",
  csmDataReset: "DATA_RESET",
};

export const isAudited = (action) => Object.hasOwn(AUDITED_ACTIONS, action);

/** HMAC-SHA256, base64url without padding: hmac256Base64_ in Code.gs. */
export const auditHmac = (text, secret) =>
  createHmac("sha256", String(secret ?? ""))
    .update(String(text ?? ""), "utf8")
    .digest("base64url");

const CANONICAL_FIELDS = [
  "timestamp",
  "audit_id",
  "actor_email",
  "actor_role",
  "action",
  "target_type",
  "target_id",
  "outcome",
  "details",
  "request_id",
  "previous_hash",
];

export const auditCanonical = (entry) =>
  CANONICAL_FIELDS.map((field) => safeTrim(entry[field])).join("|");

/**
 * What an action acted on, as auditTargetForRequest_ describes it — read from
 * the request, except for a reclassified response, whose programmes come from
 * the row itself (`moved`, filled in by the action).
 */
export function auditTarget(action, body, actor, { moved, now } = {}) {
  const payload = body.payload || {};
  switch (action) {
    case "adminLogin":
    case "adminLogout":
      return { type: "session", id: safeTrim(body.email || actor?.email) };
    case "adminSaveService":
      return {
        type: "service",
        id: safeTrim(payload.service_id || payload.code),
        details: {
          code: safeTrim(payload.code),
          category: safeTrim(payload.category),
        },
      };
    case "adminSaveSettings":
      return {
        type: "settings",
        id: "Settings",
        details: {
          keys: Object.keys(body.settings || {})
            .join(",")
            .slice(0, 200),
        },
      };
    case "adminGenerateCoa":
    case "adminSaveCoaDetails":
      return {
        type: "certificate",
        id: safeTrim(body.responseId || payload.referenceId),
      };
    case "adminDeclineCoa":
      return {
        type: "certificate",
        id: safeTrim(payload.referenceId),
        // The reason is the decision; whether the client was told is how the
        // office answers "did anyone ever get back to them".
        details: {
          reason: safeTrim(payload.reason).slice(0, 200),
          notified: payload.notify !== false,
        },
      };
    case "adminReopenCoa":
      return { type: "certificate", id: safeTrim(payload.referenceId) };
    case "adminChangeResponseService": {
      const m = moved || {};
      return {
        type: "response",
        id: safeTrim(payload.referenceId),
        details: m.unchanged
          ? { from: m.from || "", to: m.to || "", changed: false }
          : { from: m.from || "", to: m.to || "" },
      };
    }
    case "adminGenerateReport":
      return { type: "report", id: normalizePeriod(body.period, now).key };
    case "adminSaveServiceStats":
      return {
        type: "report_stats",
        id: normalizePeriod(body.period, now).key,
        details: { rows: (body.rows || []).length },
      };
    case "adminSaveUser":
      return {
        type: "user",
        id: safeTrim(payload.user_id || payload.email).toLowerCase(),
        details: {
          role: safeTrim(payload.role).toLowerCase(),
          active: payload.active !== false,
        },
      };
    case "adminUploadCoaTemplate":
    case "adminUploadSignature":
      return { type: "file", id: safeTrim(payload.filename).slice(0, 180) };
    default:
      return { type: "system", id: "" };
  }
}

/**
 * Appends one entry. Serialised on the audit_state row, so two appends can
 * never both take the same entry as their previous one.
 *
 * Like Code.gs, a missing secret writes nothing; unlike it, that is logged,
 * since an unrecorded privileged action should never pass unnoticed.
 */
export async function appendAudit(
  db,
  {
    action,
    body,
    success,
    errorMessage,
    actor,
    requestContext,
    moved,
    now = new Date(),
  },
) {
  const secret = process.env.AUDIT_HASH_SECRET;
  if (!secret) {
    console.error(
      `[csm-audit] AUDIT_HASH_SECRET is not set; ${action} was not recorded.`,
    );
    return null;
  }
  const target = auditTarget(action, body, actor, { moved, now });
  try {
    return await db.transaction(async (tx) => {
      await tx.query("select 1 from csm.audit_state for update");
      const [last] = await tx.query(
        "select entry_hash from csm.audit_log order by seq desc limit 1",
      );
      const entry = {
        timestamp: officeSecond(now),
        audit_id: `AUD-${randomUUID().replace(/-/g, "").slice(0, 16).toUpperCase()}`,
        // Bounded because the sign-in form puts whatever was typed as the
        // email into both of these, before anyone is authenticated.
        actor_email: safeTrim(actor?.email).toLowerCase().slice(0, 254),
        actor_role: safeTrim(actor?.role).toLowerCase(),
        action: AUDITED_ACTIONS[action] || safeTrim(action).toUpperCase(),
        target_type: target.type,
        target_id: safeTrim(target.id).slice(0, 254),
        outcome: success ? "SUCCESS" : "FAILURE",
        details: JSON.stringify(
          success
            ? target.details || {}
            : { error: safeTrim(errorMessage).slice(0, 300) },
        ),
        request_id: safeTrim(requestContext?.requestId).slice(0, 100),
        previous_hash: last ? last.entry_hash : "",
      };
      entry.entry_hash = auditHmac(auditCanonical(entry), secret);
      await tx.query(
        `insert into csm.audit_log (logged_at, audit_id, actor_email, actor_role, action, target_type,
           target_id, outcome, details, request_id, previous_hash, entry_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          entry.timestamp,
          entry.audit_id,
          entry.actor_email,
          entry.actor_role,
          entry.action,
          entry.target_type,
          entry.target_id,
          entry.outcome,
          entry.details,
          entry.request_id,
          entry.previous_hash,
          entry.entry_hash,
        ],
      );
      await tx.query("update csm.audit_state set head_hash = $1", [
        entry.entry_hash,
      ]);
      return entry;
    });
  } catch (error) {
    // A log documented as tamper-evident must never lose an entry quietly:
    // the gap is counted and reported beside the chain check.
    try {
      await db.query(
        `update csm.audit_state
         set dropped_count = dropped_count + 1, dropped_last = $1`,
        [
          `${officeSecond(now)} ${safeTrim(action)} (${safeTrim(error?.message).slice(0, 120)})`,
        ],
      );
    } catch {}
    throw error;
  }
}
