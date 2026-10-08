# Cutover: moving the portal to the new backend

Phase 4 of the migration. The portal switches from Google Sheets and Apps
Script to Postgres on Supabase in one step, by setting `CSM_BACKEND` in
Vercel. Apps Script stays on as the worker that makes certificates, sends
email and builds reports; the sheets stay as a read-only archive.

Times below are Manila time. Allow 30 minutes for the switch itself.

## Before the day

1. **Supabase.** Upgrade the `osds_sysad` organization to Pro, so the
   database never pauses and is backed up daily. Upgrading is per
   organization: `osds-oms` moves to Pro with it, and each project's compute
   is billed.
2. **Production Apps Script** (the project behind `GAS_WEB_APP_URL`):
   1. Replace `Code.gs`, `Certificate.gs` and `Report.gs`, and `Export.gs`
      (it now also holds the rollback restore), with the versions in
      `google-apps-script/`. Add `Worker.gs` as a new file.
   2. Run `setupCsmWorker()` from the editor and copy the token from the log.
   3. Deploy → Manage deployments → edit → **New version** (same URL).

   The live portal keeps running on Apps Script, and certificate issue
   times stop showing as long dates from this step.
3. **Vercel** → Settings → Environment Variables (Production):
   - `DATABASE_URL` — the Supabase transaction pooler string.
   - `CSM_WORKER_TOKEN` — the token from step 2.2.
   - `AUDIT_HASH_SECRET` — from production's script properties.
   - Leave `CSM_WORKER_URL` unset (it defaults to `GAS_WEB_APP_URL`), and
     **do not set `CSM_BACKEND` yet**.

   Then deploy the current code. Functions move to Singapore (`sin1`) with
   this deploy; the portal still answers from Apps Script.
4. **Check.** Make `.env` match Vercel (the variables above, plus
   `PORTAL_BASE_URL`, `TURNSTILE_SECRET_KEY` and `GAS_WEB_APP_URL`; remove the
   staging `CSM_WORKER_URL`), then:

   ```
   npm run cutover:check
   ```

   Every line must read `ok`.
5. Tell the administrators: during the window, make no changes in the admin
   screens, and expect to sign in again afterwards. Clients may keep
   submitting; the catch-up below collects what arrives.

## The switch

1. Note the time. This is the cutover time, `T`.
2. In the Apps Script editor run `exportCsmData()`, and download the file
   into `.import/final.json`.
3. Import it, replacing the rehearsal data:

   ```
   npm run db:import -- .import/final.json
   npm run db:import -- .import/final.json --apply --replace
   npm run db:verify -- .import/final.json
   ```

   The dry run must show no errors; the verification must end with "All …
   checks give the same answers".
4. In Vercel set `CSM_BACKEND` to `postgres` and **redeploy** (a variable
   takes effect only on a new deployment). From here the portal answers from
   the database.
5. Try it: the survey lists the programs; a certificate code from an issued
   certificate verifies; an administrator signs in and the Overview shows the
   quarter's figures. In Vercel's logs, `[csm-perf]` lines now say
   `"backend":"postgres"`.
6. Catch-up: run `exportCsmData()` once more, download it to
   `.import/late.json`, and

   ```
   npm run db:import -- .import/late.json --catch-up
   npm run db:import -- .import/late.json --catch-up --apply
   ```

   It adds only responses Apps Script took after step 2, and skips any form
   that reached both backends.

## Afterwards

- Protect the Responses, Services, Settings, Users, Whitelist, ServiceStats,
  Reports and Audit sheets (Data → Protect sheets and ranges) so the archive
  is not edited by mistake.
- Delete the export files, from `.import/` and from Drive: they hold clients'
  email addresses and the administrators' password hashes.
- Keep the Apps Script deployment. It is the worker now, and `Worker.gs`
  calls into `Certificate.gs` and `Report.gs`.
- After two quiet weeks, remove `Diagnostics.gs` and `Export.gs`, and update
  the user manual's note that records are kept in Google Sheets.

## If it has to be undone

1. In Vercel remove `CSM_BACKEND` and redeploy. The portal answers from Apps
   Script again at once.
2. Collect what the new backend took since the switch:

   ```
   npm run db:rollback -- --since <T, e.g. 2026-10-10T08:00:00+08:00>
   ```

   Upload the file it writes (`.import/CSM rollback ….json`) to Drive and run
   `restoreFromNewBackend()` in the Apps Script editor. It adds the new
   responses and records the certificates issued since, and skips anything
   already in the sheet.
3. The file also lists other administrator actions since the switch — a
   program edited, a request declined, a response moved. Redo those by hand.
