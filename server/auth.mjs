import { createHash, randomBytes, randomUUID } from "node:crypto";
import { UserError } from "./errors.mjs";
import {
  decoyVerify,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "./passwords.mjs";
import { safeTrim } from "./records.mjs";

/**
 * Signing in, sessions, and the checks every admin action starts with —
 * adminLogin, adminLogout, adminValidateSession, requireAdmin_ and
 * requireSuperadmin_ in Code.gs, with the same messages. The admin screens
 * sign out on "authorization required" and "session has expired", so those
 * words are part of the contract.
 */

const SESSION_MS = 6 * 60 * 60 * 1000;

/**
 * Sign-in attempts are counted per account and device (email plus the client
 * address the proxy reports), the limit a guesser meets, and per account
 * alone, set higher, which caps guessing spread across many addresses. A
 * per-account limit alone would let anyone who knows an administrator's email
 * keep them locked out.
 */
const DEVICE_LIMIT = 5;
const ACCOUNT_LIMIT = 30;
const WINDOW_MS = 15 * 60 * 1000;

const sha256 = (text) =>
  createHash("sha256").update(String(text), "utf8").digest("base64url");
const tokenHash = (token) => sha256(`session|${token}`);
const throttleKey = (text) => sha256(`login|${text || "unknown"}`).slice(0, 32);

export const newCredentialVersion = () => randomBytes(12).toString("base64url");

export async function adminLogin(
  { db, now = new Date(), requestContext = {} },
  email,
  password,
) {
  email = safeTrim(email).toLowerCase();
  password = String(password ?? "");
  const clientIp = safeTrim(requestContext.clientIp).slice(0, 64);
  const keys = [throttleKey(`${email}|${clientIp}`), throttleKey(email)];

  const counts = await db.query(
    "select key, attempts from csm.login_attempts where key in ($1, $2) and expires_at > $3",
    [...keys, now],
  );
  const attemptsOf = (key) =>
    counts.find((row) => row.key === key)?.attempts || 0;
  if (
    attemptsOf(keys[0]) >= DEVICE_LIMIT ||
    attemptsOf(keys[1]) >= ACCOUNT_LIMIT
  )
    throw new UserError("Too many sign-in attempts. Try again in 15 minutes.");
  // Counted before the password is checked, and cleared below if it was right.
  for (const key of keys)
    await db.query(
      `insert into csm.login_attempts (key, attempts, expires_at) values ($1, 1, $2)
       on conflict (key) do update set
         attempts = case when csm.login_attempts.expires_at > $3
                         then csm.login_attempts.attempts + 1 else 1 end,
         expires_at = excluded.expires_at`,
      [key, new Date(now.getTime() + WINDOW_MS), now],
    );

  const [user] = await db.query(
    `select user_id, email, name, role, active, password_hash, credential_version
     from csm.admin_users where email = $1`,
    [email],
  );
  // Checked whether or not the account exists, and whether or not it is
  // active, so no answer comes back sooner than a wrong password's would.
  const matches = user
    ? await verifyPassword(password, user.password_hash)
    : await decoyVerify(password);
  if (!user || !user.active || !matches)
    throw new UserError("Invalid email or password.");

  await db.query("delete from csm.login_attempts where key in ($1, $2)", keys);
  // Sign-ins are rare: the natural moment to clear out what has expired.
  await db.query("delete from csm.login_attempts where expires_at <= $1", [
    now,
  ]);
  await db.query("delete from csm.admin_sessions where expires_at <= $1", [
    now,
  ]);

  // Moved off Apps Script's hash the first time the password is seen here.
  // The credential version stays: it is the same password.
  if (needsRehash(user.password_hash))
    await db.query(
      "update csm.admin_users set password_hash = $1 where user_id = $2",
      [await hashPassword(password), user.user_id],
    );

  const token = randomBytes(32).toString("hex");
  const expiresAt = now.getTime() + SESSION_MS;
  await db.query(
    `insert into csm.admin_sessions (token_hash, user_id, credential_version, created_at, expires_at)
     values ($1, $2, $3, $4, $5)`,
    [
      tokenHash(token),
      user.user_id,
      user.credential_version,
      now,
      new Date(expiresAt),
    ],
  );
  return {
    token,
    user: {
      email: user.email,
      name: safeTrim(user.name) || user.email,
      role: user.role,
    },
    expiresAt,
  };
}

/**
 * The session a token opens, or null. Valid only while unexpired, while its
 * account is active, and while the account's password is the one it was
 * opened under; name and role are always the account's current ones.
 * Remembered for the rest of the request, which may ask more than once.
 */
export async function getAdminSession(ctx, token) {
  token = safeTrim(token);
  if (!token) return null;
  const memo = (ctx.sessions ??= new Map());
  if (memo.has(token)) return memo.get(token);

  const [row] = await ctx.db.query(
    `select s.expires_at, s.credential_version as opened_under, u.user_id, u.email, u.name,
            u.role, u.active, u.credential_version
     from csm.admin_sessions s join csm.admin_users u using (user_id)
     where s.token_hash = $1`,
    [tokenHash(token)],
  );
  const now = ctx.now ?? new Date();
  let session = null;
  if (row) {
    const valid =
      new Date(row.expires_at) > now &&
      row.active &&
      row.opened_under === row.credential_version;
    if (valid)
      session = {
        userId: row.user_id,
        email: row.email,
        name: safeTrim(row.name) || row.email,
        role: row.role,
        expiresAt: new Date(row.expires_at).getTime(),
      };
    else
      await ctx.db.query(
        "delete from csm.admin_sessions where token_hash = $1",
        [tokenHash(token)],
      );
  }
  memo.set(token, session);
  return session;
}

export async function adminValidateSession(ctx, token) {
  const session = await getAdminSession(ctx, token);
  if (!session) throw new UserError("Your admin session has expired.");
  return {
    user: { email: session.email, name: session.name, role: session.role },
    expiresAt: session.expiresAt,
  };
}

export async function adminLogout(ctx, token) {
  token = safeTrim(token);
  (ctx.sessions ??= new Map()).set(token, null);
  await ctx.db.query("delete from csm.admin_sessions where token_hash = $1", [
    tokenHash(token),
  ]);
  return true;
}

export async function requireAdmin(ctx, token) {
  const session = await getAdminSession(ctx, token);
  if (!session)
    throw new UserError("Forbidden: administrator authorization required.");
  return session;
}

export async function requireSuperadmin(ctx, token) {
  const session = await requireAdmin(ctx, token);
  if (session.role !== "superadmin")
    throw new UserError("Forbidden: superadmin access required.");
  return session;
}

/**
 * Moves one session onto its account's new credential version, so a
 * superadmin who changes their own password keeps the tab they did it from.
 */
export async function restampSession(db, token, credentialVersion) {
  await db.query(
    "update csm.admin_sessions set credential_version = $2 where token_hash = $1",
    [tokenHash(safeTrim(token)), credentialVersion],
  );
}

/**
 * Creates an account or sets a new password on one — seedUser in Code.gs.
 * A new password gets a new credential version, which ends every session
 * opened with the old one. An existing account keeps its id; `userId` names
 * a new one.
 */
export async function setUserPassword(
  db,
  { email, password, name, role = "admin", active = true, userId },
) {
  email = safeTrim(email).toLowerCase();
  password = String(password ?? "");
  name = safeTrim(name) || email;
  role = safeTrim(role).toLowerCase() || "admin";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new UserError("A valid user email is required.");
  if (password.length < 12)
    throw new UserError("Admin passwords must contain at least 12 characters.");
  if (!["admin", "superadmin"].includes(role))
    throw new UserError("Role must be admin or superadmin.");
  const [user] = await db.query(
    `insert into csm.admin_users (user_id, email, name, role, active, password_hash, credential_version)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (email) do update set
       name = excluded.name, role = excluded.role, active = excluded.active,
       password_hash = excluded.password_hash,
       credential_version = excluded.credential_version, updated_at = now()
     returning user_id, email, name, role, active, credential_version, created_at, updated_at`,
    [
      userId || `U-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
      email,
      name,
      role,
      active !== false,
      await hashPassword(password),
      newCredentialVersion(),
    ],
  );
  return user;
}
