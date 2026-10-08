import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

/**
 * Administrator passwords.
 *
 * Accounts carried over from Apps Script hold its scheme: 12,000 rounds of
 * SHA-256, each round hashing the previous round's base64url text (padding
 * included), starting from "salt|password". It is reproduced exactly, so
 * every existing password still works; an account is moved to scrypt the
 * first time it signs in here.
 */

const LEGACY_ROUNDS = 12000;
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 32 };

/** Base64url with its padding: the text Apps Script hashed on each round. */
const paddedBase64Url = (bytes) =>
  bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

export function legacyHash(password, salt) {
  let text = `${String(salt ?? "")}|${String(password ?? "")}`;
  let bytes = Buffer.from(text, "utf8");
  for (let i = 0; i < LEGACY_ROUNDS; i++) {
    text = paddedBase64Url(createHash("sha256").update(bytes).digest());
    bytes = Buffer.from(text, "ascii");
  }
  return text;
}

/** The stored form of a password carried over from the Users sheet. */
export const legacyStored = (hash, salt) =>
  `sha256x${LEGACY_ROUNDS}$${salt}$${hash}`;

async function scryptKey(password, salt, { N, r, p, keyLength }) {
  return scrypt(String(password ?? ""), salt, keyLength, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

const sameText = (a, b) => {
  const left = Buffer.from(String(a)),
    right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * Whether `password` is the one `stored` was made from. A stored value of an
 * unknown shape matches nothing.
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored ?? "").split("$");
  if (parts[0] === `sha256x${LEGACY_ROUNDS}` && parts.length === 3)
    return sameText(legacyHash(password, parts[1]), parts[2]);
  if (parts[0] === "scrypt" && parts.length === 6) {
    const [, N, r, p, salt, key] = parts;
    const expected = Buffer.from(key, "base64url");
    const actual = await scryptKey(password, Buffer.from(salt, "base64url"), {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      keyLength: expected.length,
    });
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  return false;
}

export const needsRehash = (stored) =>
  !String(stored ?? "").startsWith(
    `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$`,
  );

/**
 * Spent on a sign-in for an email that matches no account, so that answer
 * takes as long as a wrong password does — otherwise timing alone would show
 * which addresses are administrators.
 */
const DECOY = hashPassword("decoy-password-that-matches-nothing");
export async function decoyVerify(password) {
  await verifyPassword(password, await DECOY);
  return false;
}
