import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";
import { auditCanonical, auditHmac } from "../audit.mjs";
import {
  adminLogin,
  adminLogout,
  adminValidateSession,
  requireAdmin,
  requireSuperadmin,
  setUserPassword,
} from "../auth.mjs";
import { handleRequest } from "../dispatch.mjs";
import { legacyHash, legacyStored, verifyPassword } from "../passwords.mjs";
import { appsScript } from "./apps-script.mjs";
import { freshDatabase, NOW } from "./fixture.mjs";

process.env.TZ = "UTC";
process.env.AUDIT_HASH_SECRET = "audit"; // the harness's AUDIT_HASH_SECRET too

const PASSWORD = "correct horse battery";
const SALT =
  "3f1c2b9e-0d7a-4c55-9a1e-6b2f8e4d1c70aa61e2b4-55c1-4f0e-8d2b-91c7e3a5f6d4";

let db, gas;
before(async () => {
  db = await freshDatabase();
  gas = appsScript();
});

/** An account as the import will bring it over: Apps Script's hash and salt. */
async function legacyAccount(email, over = {}) {
  const values = {
    user_id: `U-${email.slice(0, 6)}`,
    name: "Portal Host",
    role: "superadmin",
    active: true,
    ...over,
  };
  await db.query(
    `insert into csm.admin_users (user_id, email, name, role, active, password_hash, credential_version)
     values ($1, $2, $3, $4, $5, $6, 'v1')`,
    [
      values.user_id,
      email,
      values.name,
      values.role,
      values.active,
      legacyStored(legacyHash(PASSWORD, SALT), SALT),
    ],
  );
}

const login = (email, password = PASSWORD, ip = "203.0.113.1", now = NOW) =>
  adminLogin({ db, now, requestContext: { clientIp: ip } }, email, password);
const refusal = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.message;
  }
};

describe("passwords carried over from Apps Script", () => {
  for (const [password, salt] of [
    [PASSWORD, SALT],
    ["pässwörd-✓ with ñ", "salt-ü"],
    ["", "no-such-account"],
  ])
    test(`hash the same as hashAdminPassword_ (${JSON.stringify(password).slice(0, 20)})`, () => {
      assert.equal(
        legacyHash(password, salt),
        gas.call("hashAdminPassword_(__p, __s)", { __p: password, __s: salt }),
      );
    });

  test("verify, and nothing else does", async () => {
    const stored = legacyStored(legacyHash(PASSWORD, SALT), SALT);
    assert.equal(await verifyPassword(PASSWORD, stored), true);
    assert.equal(await verifyPassword(`${PASSWORD} `, stored), false);
    assert.equal(await verifyPassword(PASSWORD, "garbage"), false);
  });
});

describe("audit hashes match Code.gs", () => {
  for (const [text, secret] of [
    [
      "2026-10-08 10:00:00|AUD-1|a@b.ph|superadmin|LOGIN|session|a@b.ph|SUCCESS|{}|sin1::x|",
      "audit",
    ],
    ["ü|ñ|✓", "kéy-".repeat(40)],
    ["", "short"],
  ])
    test(JSON.stringify(text).slice(0, 30), () => {
      assert.equal(
        auditHmac(text, secret),
        gas.call("hmac256Base64_(__t, __k)", { __t: text, __k: secret }),
      );
    });
});

describe("adminLogin", () => {
  before(async () => {
    await legacyAccount("host@ched.gov.ph");
    await legacyAccount("off@ched.gov.ph", { active: false, user_id: "U-off" });
  });
  beforeEach(() => db.query("delete from csm.login_attempts"));

  test("signs in with the Apps Script password, then moves it to scrypt", async () => {
    const session = await login("  HOST@ched.gov.ph ");
    assert.match(session.token, /^[0-9a-f]{64}$/);
    assert.deepEqual(session.user, {
      email: "host@ched.gov.ph",
      name: "Portal Host",
      role: "superadmin",
    });
    assert.equal(session.expiresAt, NOW.getTime() + 6 * 3600 * 1000);
    const [user] = await db.query(
      "select password_hash, credential_version from csm.admin_users where email = 'host@ched.gov.ph'",
    );
    assert.match(user.password_hash, /^scrypt\$/);
    assert.equal(user.credential_version, "v1");
    const [stored] = await db.query(
      "select token_hash from csm.admin_sessions",
    );
    assert.notEqual(stored.token_hash, session.token);
    // And the same password still works afterwards.
    assert.ok((await login("host@ched.gov.ph")).token);
  });

  test("gives one answer for a wrong password, an unknown email and a disabled account", async () => {
    for (const [email, password] of [
      ["host@ched.gov.ph", "wrong password!"],
      ["nobody@ched.gov.ph", PASSWORD],
      ["off@ched.gov.ph", PASSWORD],
    ])
      assert.equal(
        await refusal(login(email, password)),
        "Invalid email or password.",
      );
  });

  test("stops a device after five tries, and only that device", async () => {
    for (let i = 0; i < 5; i++)
      await refusal(
        login("host@ched.gov.ph", "wrong password!", "198.51.100.7"),
      );
    assert.equal(
      await refusal(login("host@ched.gov.ph", PASSWORD, "198.51.100.7")),
      "Too many sign-in attempts. Try again in 15 minutes.",
    );
    assert.ok(
      (await login("host@ched.gov.ph", PASSWORD, "198.51.100.8")).token,
    );
  });

  test("stops an account after thirty tries from anywhere", async () => {
    for (let i = 0; i < 30; i++)
      await refusal(
        login("host@ched.gov.ph", "wrong password!", `10.0.0.${i}`),
      );
    assert.equal(
      await refusal(login("host@ched.gov.ph", PASSWORD, "10.0.1.1")),
      "Too many sign-in attempts. Try again in 15 minutes.",
    );
  });

  test("forgets failed tries after fifteen minutes, and after a success", async () => {
    for (let i = 0; i < 5; i++)
      await refusal(login("host@ched.gov.ph", "wrong password!"));
    const later = new Date(NOW.getTime() + 15 * 60 * 1000 + 1000);
    assert.ok(
      (await login("host@ched.gov.ph", PASSWORD, "203.0.113.1", later)).token,
    );
    for (let i = 0; i < 4; i++)
      await refusal(
        login("host@ched.gov.ph", "wrong password!", "203.0.113.1", later),
      );
    await login("host@ched.gov.ph", PASSWORD, "203.0.113.1", later);
    assert.equal(
      (await db.query("select count(*)::int as n from csm.login_attempts"))[0]
        .n,
      0,
    );
  });
});

describe("sessions", () => {
  let token;
  before(async () => {
    await legacyAccount("staff@ched.gov.ph", {
      role: "admin",
      user_id: "U-staff",
      name: "Staff",
    });
  });
  beforeEach(async () => {
    await db.query("delete from csm.login_attempts");
    token = (await login("staff@ched.gov.ph")).token;
  });
  const ctx = (now = NOW) => ({ db, now });

  test("stand for their account's current name and role", async () => {
    await db.query(
      "update csm.admin_users set name = 'Renamed', role = 'superadmin' where user_id = 'U-staff'",
    );
    const { user } = await adminValidateSession(ctx(), token);
    assert.deepEqual(user, {
      email: "staff@ched.gov.ph",
      name: "Renamed",
      role: "superadmin",
    });
    await db.query(
      "update csm.admin_users set name = 'Staff', role = 'admin' where user_id = 'U-staff'",
    );
  });

  test("end after six hours", async () => {
    const later = new Date(NOW.getTime() + 6 * 3600 * 1000 + 1);
    assert.equal(
      await refusal(adminValidateSession(ctx(later), token)),
      "Your admin session has expired.",
    );
    // And are gone, not merely refused.
    assert.equal(
      await refusal(adminValidateSession(ctx(), token)),
      "Your admin session has expired.",
    );
  });

  test("end when the account is disabled", async () => {
    await db.query(
      "update csm.admin_users set active = false where user_id = 'U-staff'",
    );
    assert.equal(
      await refusal(requireAdmin(ctx(), token)),
      "Forbidden: administrator authorization required.",
    );
    await db.query(
      "update csm.admin_users set active = true where user_id = 'U-staff'",
    );
  });

  test("end when a new password is set, even the same one", async () => {
    await setUserPassword(db, {
      email: "staff@ched.gov.ph",
      password: PASSWORD,
      name: "Staff",
      role: "admin",
    });
    assert.equal(
      await refusal(adminValidateSession(ctx(), token)),
      "Your admin session has expired.",
    );
    assert.ok((await login("staff@ched.gov.ph")).token);
  });

  test("end at sign-out", async () => {
    assert.equal(await adminLogout(ctx(), token), true);
    assert.equal(
      await refusal(adminValidateSession(ctx(), token)),
      "Your admin session has expired.",
    );
  });

  test("an admin is not a superadmin", async () => {
    assert.equal((await requireAdmin(ctx(), token)).email, "staff@ched.gov.ph");
    assert.equal(
      await refusal(requireSuperadmin(ctx(), token)),
      "Forbidden: superadmin access required.",
    );
    assert.equal(
      await refusal(requireAdmin(ctx(), "not-a-token")),
      "Forbidden: administrator authorization required.",
    );
  });
});

describe("setUserPassword", () => {
  test("refuses what seedUser refused", async () => {
    assert.equal(
      await refusal(setUserPassword(db, { email: "x", password: PASSWORD })),
      "A valid user email is required.",
    );
    assert.equal(
      await refusal(
        setUserPassword(db, { email: "x@y.ph", password: "too short" }),
      ),
      "Admin passwords must contain at least 12 characters.",
    );
    assert.equal(
      await refusal(
        setUserPassword(db, {
          email: "x@y.ph",
          password: PASSWORD,
          role: "owner",
        }),
      ),
      "Role must be admin or superadmin.",
    );
  });
});

describe("the audit log", () => {
  const request = (body) =>
    handleRequest(body, {
      db,
      now: NOW,
      requestContext: { requestId: "sin1::audit", clientIp: "192.0.2.5" },
    });
  const entries = () =>
    db.query(
      `select logged_at as timestamp, audit_id, actor_email, actor_role, action, target_type,
              target_id, outcome, details, request_id, previous_hash, entry_hash
       from csm.audit_log order by seq`,
    );

  before(async () => {
    await legacyAccount("auditor@ched.gov.ph", { user_id: "U-audit" });
  });

  test("records sign-ins, failed ones and sign-outs, chained", async () => {
    const before = (await entries()).length;
    const failed = await request({
      action: "adminLogin",
      email: "Auditor@ched.gov.ph",
      password: "nope nope nope",
    });
    assert.equal(failed.error, "Invalid email or password.");
    const signedIn = await request({
      action: "adminLogin",
      email: "Auditor@ched.gov.ph",
      password: PASSWORD,
    });
    assert.equal(signedIn.ok, true);
    await request({
      action: "adminValidateSession",
      adminToken: signedIn.data.token,
    });
    await request({ action: "adminLogout", adminToken: signedIn.data.token });

    const all = await entries();
    const [fail, success, logout] = all.slice(before);
    assert.equal(all.length, before + 3, "validating a session is not audited");
    assert.deepEqual(
      [
        fail.action,
        fail.outcome,
        fail.actor_email,
        fail.actor_role,
        fail.target_type,
        fail.target_id,
        fail.details,
      ],
      [
        "LOGIN",
        "FAILURE",
        "auditor@ched.gov.ph",
        "",
        "session",
        "Auditor@ched.gov.ph",
        '{"error":"Invalid email or password."}',
      ],
    );
    assert.deepEqual(
      [
        success.outcome,
        success.actor_email,
        success.actor_role,
        success.details,
        success.request_id,
      ],
      ["SUCCESS", "auditor@ched.gov.ph", "superadmin", "{}", "sin1::audit"],
    );
    assert.deepEqual(
      [logout.action, logout.actor_email, logout.target_id],
      ["LOGOUT", "auditor@ched.gov.ph", "auditor@ched.gov.ph"],
    );
    assert.equal(success.timestamp, "2026-10-08 10:00:00");
    assert.match(success.audit_id, /^AUD-[0-9A-F]{16}$/);

    let previous = "";
    for (const entry of all) {
      assert.equal(entry.previous_hash, previous);
      assert.equal(entry.entry_hash, auditHmac(auditCanonical(entry), "audit"));
      previous = entry.entry_hash;
    }
    const [state] = await db.query("select head_hash from csm.audit_state");
    assert.equal(state.head_hash, previous);
  });

  test("verifies under Apps Script's own chain check", () => {
    return entries().then((all) => {
      const columns = [
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
        "entry_hash",
      ];
      gas.setSheet("Audit", [
        columns,
        ...all.map((e) => columns.map((c) => e[c])),
      ]);
      gas.props.AUDIT_HEAD_HASH = all.at(-1).entry_hash;
      gas.call(
        "requireSuperadmin_ = function () { return { email: 'a@b.ph', role: 'superadmin' }; }",
      );
      const log = gas.call("adminGetAuditLog({}, 't')");
      assert.equal(log.integrity.valid, true, JSON.stringify(log.integrity));
      assert.equal(log.integrity.checkedRows, all.length);

      // And Apps Script does notice an edit.
      gas.sheets.Audit.data[1][2] = "intruder@example.com";
      assert.equal(
        gas.call("adminGetAuditLog({}, 't')").integrity.valid,
        false,
      );
    });
  });

  test("cannot be edited or emptied", async () => {
    for (const statement of [
      "update csm.audit_log set actor_email = 'x'",
      "delete from csm.audit_log",
      "truncate csm.audit_log",
    ])
      assert.match(await refusal(db.query(statement)), /append-only/);
  });

  test("an entry that cannot be written does not undo the sign-in, and is counted", async () => {
    const failing = {
      ...db,
      transaction: async () => {
        throw new Error("disk full");
      },
    };
    const original = console.error;
    console.error = () => {};
    try {
      const reply = await handleRequest(
        {
          action: "adminLogin",
          email: "auditor@ched.gov.ph",
          password: PASSWORD,
        },
        { db: failing, now: NOW, requestContext: { clientIp: "192.0.2.9" } },
      );
      assert.equal(reply.ok, true);
    } finally {
      console.error = original;
    }
    const [state] = await db.query(
      "select dropped_count, dropped_last from csm.audit_state",
    );
    assert.equal(state.dropped_count, 1);
    assert.match(
      state.dropped_last,
      /^2026-10-08 10:00:00 adminLogin \(disk full\)$/,
    );
  });
});
