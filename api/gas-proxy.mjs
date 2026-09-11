import { createHash, randomUUID } from "node:crypto";

/**
 * Same-origin bridge between the browser and the Apps Script web app.
 *
 * The browser never learns GAS_WEB_APP_URL, SUBMIT_SHARED_TOKEN, or the
 * Turnstile secret: this function holds them, validates the Cloudflare token
 * for the two public actions, and forwards everything else untouched.
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

export default async function handler(req, res) {
  if (req.method !== "POST")
    return send(res, 405, { ok: false, error: "Method not allowed." });

  const gasUrl = String(process.env.GAS_WEB_APP_URL || "").trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(gasUrl))
    return send(res, 500, {
      ok: false,
      error:
        "The Apps Script backend is not configured. Set GAS_WEB_APP_URL in Vercel to the deployed /exec URL.",
    });

  const sharedToken = String(process.env.SUBMIT_SHARED_TOKEN || "").trim();
  if (sharedToken.length < 64)
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

    payload.proxyToken = sharedToken;
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
    try {
      JSON.parse(responseText);
    } catch {
      throw new Error(
        "Apps Script did not return JSON. Confirm the web app is deployed as Execute as me and accessible to Anyone.",
      );
    }
    res.writeHead(upstream.ok ? 200 : 502, SECURITY_HEADERS);
    res.end(responseText);
  } catch (error) {
    send(res, 502, {
      ok: false,
      error: `Unable to reach Apps Script: ${error.message || String(error)}`,
    });
  }
}

/* Named alongside the default export so tests exercise this module rather than
   a copy of it. Vercel invokes the default export and ignores these. */
export { idempotencyKey, replayScopeFor };
