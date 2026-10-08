import { createInterface } from "node:readline/promises";
import { setUserPassword } from "./auth.mjs";
import { database } from "./db.mjs";

/**
 * Creates an administrator, or sets a new password on one — seedUsers() in
 * Code.gs, without editing code to do it. The password is typed at a hidden
 * prompt and never shown or stored in plain text. Setting a new password
 * signs that account out everywhere.
 *
 *   npm run db:user          (reads DATABASE_URL from .env or .env.local)
 */

const rl = createInterface({ input: process.stdin, output: process.stdout });
let hidden = false;
rl._writeToOutput = (text) => {
  if (!hidden) rl.output.write(text);
  else if (/\r|\n/.test(text)) rl.output.write("\n");
};

const db = database();
try {
  const email = await rl.question("Email: ");
  const name = await rl.question("Name: ");
  const role =
    (await rl.question("Role (admin or superadmin) [admin]: ")) || "admin";
  hidden = true;
  const password = await rl.question("Password (12+ characters, hidden): ");
  const again = await rl.question("Password again: ");
  hidden = false;
  if (password !== again) throw new Error("The passwords do not match.");
  const user = await setUserPassword(db, { email, password, name, role });
  console.log(`Saved ${user.email} (${user.role}, ${user.user_id}).`);
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
} finally {
  rl.close();
  await db.end();
}
