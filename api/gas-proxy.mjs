import { createHash } from "node:crypto";

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

/** Turnstile rejects a token that was already redeemed unless the retry sends
 *  the same idempotency key, so derive one deterministically from the token. */
const idempotencyKey = (token) => {
  const hash = createHash("sha256").update(token).digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};

function readBody(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (req.body && typeof req.body === "object")
    return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 6_000_000) reject(new Error("Request body is too large."));
    });
    req.on("end", () => resolve(raw));
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

  try {
    const body = await readBody(req);
    if (!body || body.length > 6_000_000)
      return send(res, 400, { ok: false, error: "Invalid request body." });

    const payload = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      return send(res, 400, { ok: false, error: "Invalid JSON request." });

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
            idempotency_key: idempotencyKey(turnstileToken),
            remoteip:
              req.headers["x-real-ip"] ||
              req.headers["x-forwarded-for"]?.split(",")[0]?.trim(),
          }),
          signal: AbortSignal.timeout(8_000),
        },
      ).then((response) => response.json());

      const expectedHostname = String(req.headers.host || "").split(":")[0];
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
    payload.portalBaseUrl = String(
      process.env.PORTAL_BASE_URL ||
        (req.headers.host ? `https://${req.headers.host}` : ""),
    ).trim();
    payload.requestContext = {
      requestId: String(req.headers["x-vercel-id"] || "").slice(0, 100),
    };

    const upstream = await fetch(gasUrl, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
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
