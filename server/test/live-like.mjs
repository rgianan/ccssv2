import { appsScript } from "./apps-script.mjs";
import { buildDataset, loadIntoGas } from "./dataset.mjs";
import { SERVICES } from "./fixture.mjs";

export const PASSWORD = "correct horse battery";

/** The harness's sheets, made to look like a live spreadsheet's. */
export function liveLikeSheets() {
  const data = buildDataset();
  const gas = appsScript({ services: SERVICES });
  loadIntoGas(gas, data);
  const rows = gas.sheets.Responses.data;
  const col = (name) => gas.headers.indexOf(name);
  rows.slice(1).forEach((row, i) => {
    // Sheets turns typed dates into date cells, and so the issue time text.
    if (i % 2 === 0)
      row[col("TransactionDate")] = new Date(
        `${row[col("TransactionDate")]}T00:00:00+08:00`,
      );
    if (row[col("COAIssuedAt")] && i % 3 === 0)
      row[col("COAIssuedAt")] = new Date(
        `${row[col("COAIssuedAt")].replace(" ", "T")}:00+08:00`,
      );
    // Older forms let an answer be skipped.
    if (i === 5) row[col("CC2")] = "";
    if (i === 6) row[col("SQD3")] = "";
  });
  gas.setSheet("Responses", rows);
  // One account whose password is known, hashed as Apps Script hashed it.
  const users = gas.sheets.Users.data;
  users[1][1] = gas.call("hashAdminPassword_(__p, 's1')", { __p: PASSWORD });
  users[1][2] = "s1";
  gas.setSheet("Users", users);
  // A few real audit entries, written by doPost itself.
  gas.props.SUBMIT_SHARED_TOKEN_HASH = gas.call("sha256Base64_('p')");
  for (const body of [
    {
      action: "adminSaveService",
      payload: { service_id: "S-FREE", code: "SIAP 1", name_en: "Internship" },
    },
    { action: "adminSaveSettings", settings: { office_name: "OSDS" } },
    { action: "adminSaveService", payload: { code: "", name_en: "x" } },
  ])
    gas.call("doPost({ postData: { contents: __c } })", {
      __c: JSON.stringify({ ...body, proxyToken: "p", adminToken: "t" }),
    });
  return { gas, data };
}
