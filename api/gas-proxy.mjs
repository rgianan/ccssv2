import { createHash, randomUUID } from "node:crypto";

/**
 * Same-origin bridge between the browser and the Apps Script web app.
 *
 * The browser never learns GAS_WEB_APP_URL, SUBMIT_SHARED_TOKEN, or the
 * Turnstile secret: this function holds them, validates the Cloudflare token
 * for the two public actions, and forwards everything else untouched.
 *
 * With CSM_BACKEND=postgres it answers from the new backend in server/
 * instead, after the same checks; see answerFromDatabase.
 */

const SECURITY_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const send = (res, statusCode, payload) => {
  res.writeHead(statusCode, SECURITY_HEADERS);
  res.end(JSON.stringify(payload));
};

/**
 * Turnstile only honours an already-redeemed token when the retry presents the
 * same idempotency key, so the key has to be stable across the browser's
 * retries of one submission — and unique to everything else.
 *
 * Deriving it from the token alone did the first but not the second: one
 * solved challenge could then be replayed for unlimited submissions, which
 * left the survey's only bot control doing nothing. Binding it to the
 * submission satisfies both. A retry reuses the submission id and is admitted;
 * a token replayed against a fresh submission presents a key Cloudflare has
 * not seen and is rejected as spent.
 */
const idempotencyKey = (token, scope) => {
  const hash = createHash("sha256")
    .update(`${token}|${scope}`)
    .digest("hex")
    .slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

/** Logins are never retried automatically, so each attempt stands alone. */
const replayScopeFor = (payload) =>
  payload.action === "submitResponse" && payload.payload?.submissionId
    ? `submission:${String(payload.payload.submissionId).slice(0, 64)}`
    : `nonce:${randomUUID()}`;

/**
 * What to tell the browser when the web app answers with something that is
 * not JSON — which is never this project's code speaking: doPost() returns
 * JSON for every outcome, errors included, so anything else is one of
 * Google's own pages, served before or instead of running the script.
 *
 * The old message named one cause ("deployed as Execute as me, accessible to
 * Anyone") for all of them, and sent the office to check a setting that was
 * usually fine. Each page Google serves has a different remedy, so each gets
 * its own sentence. Returns `{ message, detail }`: the message is safe for any
 * visitor, the detail — status, title and the start of the page — goes to the
 * function log only, since a public survey submission sees these errors too.
 */
const explainNonJson = (status, text) => {
  const body = String(text || "");
  const title = (/<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1] || "").trim();
  const visible = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const has = (pattern) => pattern.test(visible) || pattern.test(title);
  const detail = `HTTP ${status}; title "${title}"; ${visible.slice(0, 400)}`;

  let message;
  if (!body.trim())
    message = `Apps Script returned an empty reply (HTTP ${status}). Try again; if it keeps happening, open the Apps Script project's Executions page for the failed run.`;
  else if (
    has(/accounts\.google\.com|sign in/i) ||
    /ServiceLogin|accounts\.google\.com/.test(body)
  )
    message =
      'Apps Script asked for a Google sign-in instead of answering. In Apps Script, open Deploy > Manage deployments and set the web app to Execute as "Me" and Who has access "Anyone".';
  else if (
    has(/authori[sz]ation (is )?(required|needed)|needs? (your )?permission/i)
  )
    message =
      "The Apps Script project needs to be authorized again. Open it in the script editor as its owner, run any function (setupCsmSheets, for one), accept the permissions prompt, then try again.";
  else if (has(/script function not found/i))
    message =
      "The deployed Apps Script version has no doPost. Open Deploy > Manage deployments, edit the web app and choose a new version of the current code.";
  else if (
    status === 404 ||
    has(
      /unable to open the file|page not found|requested url was not found|file does not exist/i,
    )
  )
    message =
      "The Apps Script web app was not found at the configured address. Check GAS_WEB_APP_URL in Vercel against the web app URL under Deploy > Manage deployments (it ends in /exec), then redeploy.";
  else if (has(/exceeded maximum execution time/i))
    message =
      "Apps Script ran out of time on this request. Try again; for a report, try a shorter period.";
  else if (
    status === 429 ||
    has(/too many (times|requests|simultaneous)|rate limit|quota/i)
  )
    message =
      "Google is limiting requests to the Apps Script project right now (a quota or rate limit). Wait a few minutes and try again.";
  else if (has(/(Syntax|Reference|Type|Range)Error/))
    message =
      "The Apps Script project failed to start because of an error in its code. Open the script editor, check that Code.gs, Certificate.gs and Report.gs are each pasted once and in full, save, and deploy a new version.";
  else if (
    status >= 500 ||
    has(
      /server error occurred|currently unavailable|try again later|temporarily/i,
    )
  )
    message = `Google's Apps Script service returned an error (HTTP ${status}). This is usually temporary — try again in a minute.`;
  else
    message = `Apps Script returned a page instead of data (HTTP ${status}${title ? `, "${title.slice(0, 60)}"` : ""}). Check the web app deployment under Deploy > Manage deployments.`;
  return { message, detail };
};

/**
 * The same timings as a Server-Timing header, which the browser's developer
 * tools show under a request's Timing tab: an administrator on a slow screen
 * can see where that request's time went without anyone opening a log.
 */
const serverTiming = (upstreamMs, perf) => {
  const metric = (name, value, label) =>
    Number.isFinite(value)
      ? `${name};dur=${Math.max(0, Math.round(value))};desc="${label}"`
      : "";
  return [
    metric("total", upstreamMs, "Proxy to Apps Script and back"),
    metric("script", perf.ms, "Inside Apps Script"),
    metric("startup", upstreamMs - perf.ms, "Reaching and starting the script"),
    metric("read", perf.readMs, "Reading the Responses sheet"),
    metric("lock", perf.lockWaitMs, "Waiting for another request"),
    metric("compute", perf.computeMs, "Building an uncached result"),
  ]
    .filter(Boolean)
    .join(", ");
};

function readBody(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (req.body && typeof req.body === "object")
    return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 6_000_000) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    // Joined as bytes and decoded once. Appending each chunk as a string
    // decoded it on its own, so a character whose UTF-8 bytes straddled a
    // chunk boundary — the ñ in a client's name — arrived as U+FFFD.
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Which backend answers. Apps Script until cutover; CSM_BACKEND=postgres
 * moves every action to the new backend in server/ at once — the two hold
 * separate data, so they are never mixed action by action.
 */
const usesDatabase = () =>
  String(process.env.CSM_BACKEND || "")
    .trim()
    .toLowerCase() === "postgres";

/** The new backend's timings, in the same header the Apps Script path sends. */
const databaseTiming = (perf) =>
  [
    `total;dur=${Math.max(0, Math.round(perf.ms))};desc="Inside the backend"`,
    `db;dur=${Math.max(0, Math.round(perf.dbMs))};desc="Database (${perf.queries} queries)"`,
  ].join(", ");

/**
 * Answers the request here, from the database, in the reply shape Apps Script
 * gives. Loaded only when used, so the Apps Script path never pays for the
 * database driver.
 */
async function answerFromDatabase(res, payload) {
  const action = String(payload.action || "").slice(0, 60);
  let reply;
  try {
    const { database } = await import("../server/db.mjs");
    const { handleRequest } = await import("../server/dispatch.mjs");
    reply = await handleRequest(payload, {
      db: database(),
      requestContext: payload.requestContext,
    });
  } catch (error) {
    // Only configuration fails out here; handleRequest answers its own errors.
    console.error(`[csm-backend] ${action}:`, error);
    return send(res, 500, { ok: false, error: error.message || String(error) });
  }
  const { perf } = reply;
  delete reply.perf;
  console.log(
    `[csm-perf] ${JSON.stringify({
      backend: "postgres",
      action,
      requestId: payload.requestContext.requestId,
      ok: reply.ok !== false,
      ...perf,
    })}`,
  );
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "server-timing": databaseTiming(perf),
  });
  res.end(JSON.stringify(reply));
}

export default async function handler(req, res) {
  if (req.method !== "POST")
    return send(res, 405, { ok: false, error: "Method not allowed." });

  const database = usesDatabase();
  const gasUrl = String(process.env.GAS_WEB_APP_URL || "").trim();
  if (
    !database &&
    !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gasUrl)
  )
    return send(res, 500, {
      ok: false,
      error:
        "The Apps Script backend is not configured. Set GAS_WEB_APP_URL in Vercel to the deployed /exec URL.",
    });

  const sharedToken = String(process.env.SUBMIT_SHARED_TOKEN || "").trim();
  if (!database && sharedToken.length < 64)
    return send(res, 500, {
      ok: false,
      error:
        "The submit security token is not configured. Set SUBMIT_SHARED_TOKEN in Vercel.",
    });

  // Read and parsed apart from the upstream call below, so a malformed or
  // oversized request is answered as the caller's error rather than reported
  // as "Unable to reach Apps Script".
  let payload;
  try {
    const body = await readBody(req);
    if (body.length > 6_000_000) throw new Error("Request body is too large.");
    payload = body ? JSON.parse(body) : null;
  } catch (error) {
    return send(res, 400, {
      ok: false,
      error: /too large/i.test(error.message || "")
        ? "Request body is too large."
        : "Invalid JSON request.",
    });
  }

  try {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return send(res, 400, { ok: false, error: "Invalid JSON request." });

    // The worker's actions make official certificates and send the office's
    // email. Only the new backend asks for them, with a token this function
    // never holds; from a browser they are not actions at all.
    if (/^worker/i.test(String(payload.action || "")))
      return send(res, 400, {
        ok: false,
        error: `Unknown action: ${String(payload.action).slice(0, 60)}`,
      });
    delete payload.workerToken;

    // Read before the Turnstile check, which needs the hostname out of it.
    const portalBaseUrl = String(process.env.PORTAL_BASE_URL || "")
      .trim()
      .replace(/\/+$/, "");
    if (portalBaseUrl && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(portalBaseUrl))
      return send(res, 500, {
        ok: false,
        error:
          "PORTAL_BASE_URL is malformed. Set it to the portal origin, for example https://csm.ched.gov.ph — no path, no trailing slash.",
      });

    // Vercel sets x-real-ip and overwrites x-forwarded-for itself, so neither
    // can be supplied by the caller.
    const clientIp = String(
      req.headers["x-real-ip"] ||
        req.headers["x-forwarded-for"]?.split(",")[0] ||
        "",
    )
      .trim()
      .slice(0, 64);

    const protectedActions = {
      submitResponse: "client_submit",
      adminLogin: "admin_login",
    };
    const expectedAction = protectedActions[payload.action];
    if (expectedAction) {
      const turnstileSecret = String(
        process.env.TURNSTILE_SECRET_KEY || "",
      ).trim();
      const turnstileToken = String(
        payload.turnstileToken || payload.payload?.turnstileToken || "",
      ).trim();
      if (!turnstileSecret)
        return send(res, 500, {
          ok: false,
          error: "Turnstile is not configured on the server.",
        });
      if (!turnstileToken)
        return send(res, 400, {
          ok: false,
          error: "Please complete the security verification.",
        });

      const verification = await fetch(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            secret: turnstileSecret,
            response: turnstileToken,
            idempotency_key: idempotencyKey(
              turnstileToken,
              replayScopeFor(payload),
            ),
            remoteip: clientIp || undefined,
          }),
          signal: AbortSignal.timeout(8_000),
        },
      )
        .then((response) => response.json())
        // Cloudflare unreachable is not "Apps Script unreachable", which is
        // what the catch below would have said.
        .catch(() => null);
      if (!verification)
        return send(res, 503, {
          ok: false,
          error:
            "Security verification is temporarily unavailable. Please try again.",
        });

      // Cloudflare reports the hostname that solved the challenge; comparing it
      // to the configured origin is what ties a token to this portal. That
      // comparison is only worth making against a value the caller cannot
      // choose — deriving it from the Host header, as this did, let the request
      // supply both sides of its own check. PORTAL_BASE_URL is the same value
      // the certificate links are built from, and it is set on the server.
      // Where it is unset there is nothing trustworthy to compare against, so
      // the check is skipped rather than performed against the request's own
      // header; Turnstile site keys are domain-locked in Cloudflare regardless.
      const expectedHostname = portalBaseUrl
        ? new URL(portalBaseUrl).hostname
        : "";
      if (
        !verification.success ||
        verification.action !== expectedAction ||
        (expectedHostname && verification.hostname !== expectedHostname)
      )
        return send(res, 403, {
          ok: false,
          error: "Security verification expired or failed. Please try again.",
        });

      delete payload.turnstileToken;
      if (payload.payload) delete payload.payload.turnstileToken;
    }

    // Only the configured value, never the request's Host header. The backend
    // stores whatever base URL it is handed and points every future
    // certificate QR code and verification link at it, so a spoofed Host on a
    // single unauthenticated call was enough to redirect verification to an
    // attacker's domain permanently. An unset variable now sends nothing and
    // the backend keeps what it already has.
    //
    // "Sends nothing" has to include the caller's own copy. The browser's JSON
    // is forwarded as-is, so a request that carried its own portalBaseUrl used
    // to reach the backend untouched whenever the variable was unset — the
    // same persistent redirect, one field over from the Host header.
    delete payload.portalBaseUrl;
    if (portalBaseUrl) payload.portalBaseUrl = portalBaseUrl;
    payload.requestContext = {
      requestId: String(req.headers["x-vercel-id"] || "").slice(0, 100),
      // Keys the sign-in throttle per device. Used as a hashed cache key only;
      // the backend never writes it to a sheet or the audit log.
      clientIp,
    };

    if (database) return await answerFromDatabase(res, payload);

    payload.proxyToken = sharedToken;
    const upstreamStarted = performance.now();
    const upstream = await fetch(gasUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      // Under the function's 60s ceiling (vercel.json) with room for the 8s
      // Turnstile check. At 60s Vercel killed the function first, and the
      // browser got the platform's error page instead of this function's JSON
      // — reported as "Redeploy the current Vercel source".
      signal: AbortSignal.timeout(50_000),
    });
    const responseText = await upstream.text();
    const upstreamMs = Math.round(performance.now() - upstreamStarted);
    let reply;
    try {
      reply = JSON.parse(responseText);
    } catch {
      const { message, detail } = explainNonJson(upstream.status, responseText);
      // The page itself, for whoever reads the function log: the browser gets
      // the remedy, not Google's markup.
      console.error(
        `Apps Script non-JSON reply to "${String(payload.action || "").slice(0, 60)}": ${detail}`,
      );
      return send(res, 502, { ok: false, error: message });
    }
    // Phase 0 of the migration: the backend reports where its time went. That
    // is logged here beside the round trip, whose remainder is the cost of
    // reaching and starting the script, and is never sent on to the browser.
    const perf = reply && typeof reply === "object" ? reply.perf : null;
    const headers = { ...SECURITY_HEADERS };
    if (perf && typeof perf === "object") {
      delete reply.perf;
      console.log(
        `[csm-perf] ${JSON.stringify({
          action: String(payload.action || "").slice(0, 60),
          requestId: payload.requestContext.requestId,
          ok: reply.ok !== false,
          upstreamMs,
          scriptMs: perf.ms,
          startupMs: Number.isFinite(perf.ms) ? upstreamMs - perf.ms : null,
          perf,
        })}`,
      );
      headers["server-timing"] = serverTiming(upstreamMs, perf);
    }
    res.writeHead(upstream.ok ? 200 : 502, headers);
    res.end(perf ? JSON.stringify(reply) : responseText);
  } catch (error) {
    send(res, 502, {
      ok: false,
      error: `Unable to reach Apps Script: ${error.message || String(error)}`,
    });
  }
}

/* Named alongside the default export so tests exercise this module rather than
   a copy of it. Vercel invokes the default export and ignores these. */
export {
  databaseTiming,
  explainNonJson,
  idempotencyKey,
  replayScopeFor,
  serverTiming,
};
