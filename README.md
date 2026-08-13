# CHED-OSDS Client Satisfaction Measurement Portal

A bilingual (English / Tagalog) Client Satisfaction Measurement portal for the
Commission on Higher Education — Office of Student Development and Services,
with Certificate of Appearance issuance and ARTA-format report generation.

Built on the same architecture as the OSDS participant feedback portal — React +
Vite front end, a Google Apps Script + Google Sheets backend, and a same-origin
serverless proxy that holds the secrets — with **Vercel** in place of Netlify.

## What it does

| Capability | Where |
| --- | --- |
| Landing page | `/` |
| CSM survey (5 steps, EN/TL) | `/survey` |
| Certificate of Appearance verification | `/verification` |
| Administrator module | `/admin` |

The survey opens with the Certificate of Appearance question, then collects
client information, the three Citizen's Charter questions, the nine Service
Quality Dimensions, and optional suggestions. Every question carries its Tagalog
translation beside the English, and a header toggle switches which one leads.

Four main programs are measured separately, and administrators can add more:

1. Application for Certification of Eligibility for Admission to Medical/Dental
   Program (CEM/CED)
2. Application for Student Internship Program (SIAP) Phase 1
3. Application for Student Internship Program (SIAP) Phase 2
4. Request for Endorsement for Conversion/Extension of Visa of Foreign Students
   to the Bureau of Immigration

Anything else is recorded under **Other Services**, where the client names the
transaction.

## Project structure

```text
api/gas-proxy.mjs          Vercel function: Turnstile check + Apps Script bridge
public/                    Static files
src/
  lib/csm.js               Questions, regions, scales — English and Tagalog
  lib/api.js               API client and session storage
  router.js                Path-based route selection
  views/LandingPage.jsx    Public landing page
  views/SurveyForm.jsx     Five-step CSM form
  views/VerificationPage.jsx
  views/AdminViews.jsx     Admin shell, overview, responses
  views/AdminPanels.jsx    Certificates, reports, programs, settings, users, audit
  views/PeriodPicker.jsx   Quarter / year selector
  styles/                  base, landing, survey, admin, verification
google-apps-script/
  Code.gs                  Sheets schema, auth, sessions, audit, submissions
  Certificate.gs           Certificate of Appearance issuance
  Report.gs                CSM Summary Report workbook
vercel.json                Build, SPA rewrite, and security headers
```

## Run locally

1. `npm install`
2. Copy `.env.example` to `.env` and fill in what you have.
3. `npm run dev`

Without an API URL the app fails closed. For a UI-only walkthrough set
`VITE_ENABLE_DEMO_MODE=true` in `.env` — it is ignored in production builds.

To exercise the serverless function locally, use `npm run dev:vercel`, which
runs `vercel dev` so `/api/gas-proxy` is served alongside the app.

## Deploy the backend (Google Apps Script)

1. Create a Google Sheet for the portal and open **Extensions → Apps Script**.
2. Create `Code.gs`, `Certificate.gs`, and `Report.gs` with the contents of
   `google-apps-script/`, and paste `appsscript.json` into the manifest (enable
   **Show "appsscript.json" manifest file** in project settings first).
3. Run `setupCsmSheets()` once. It creates `Responses`, `Services`,
   `ServiceStats`, `Settings`, `Reports`, `Users`, `Whitelist`, and `Audit`,
   seeds the four main programs plus Other Services, installs a daily
   `pruneAdminSessions` trigger, and authorizes the Sheets, Drive, Docs, mail,
   and external-request scopes. It is safe to run again after an update —
   existing rows and recognized columns are preserved, missing columns are
   added, and the trigger is not duplicated. **Re-run it after pulling an
   update**, so new columns such as `SubmissionID` and `COAIssueKey` exist.
4. Run `setupCsmSecurity()` (or `logSubmitSharedToken()` to see the value in the
   execution log). Copy `submitSharedToken` — Apps Script keeps only its hash.
5. Edit the host account inside `seedUsers()`, replacing the email and
   `CHANGE_THIS_PASSWORD`, then run `seedUsers()` once. That account has the
   `superadmin` role.
6. Deploy → **New deployment** → **Web app**, Execute as **Me**, Who has access
   **Anyone**. Copy the `/exec` URL.

Drive folders for certificate templates, issued certificates, and generated
reports are created automatically on first use and remembered in `Settings`.

## Deploy the front end (Vercel)

Import the repository as a new Vercel project. `vercel.json` supplies the build
command, the SPA rewrite, and the CSP/HSTS headers, so no manual configuration
is needed.

In **Project Settings → Environment Variables** add:

```text
GAS_WEB_APP_URL=https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec
SUBMIT_SHARED_TOKEN=TOKEN_RETURNED_BY_setupCsmSecurity
TURNSTILE_SECRET_KEY=YOUR_CLOUDFLARE_TURNSTILE_SECRET_KEY
VITE_TURNSTILE_SITE_KEY=YOUR_CLOUDFLARE_TURNSTILE_SITE_KEY
PORTAL_BASE_URL=https://YOUR-PRODUCTION-DOMAIN
```

Redeploy after changing any of them — `VITE_TURNSTILE_SITE_KEY` is baked in at
build time. Do not set `VITE_ENABLE_DEMO_MODE` in Vercel; demo mode is ignored
outside the dev server.

Create a Cloudflare Turnstile widget for the production hostname. Client
submissions and admin logins are rejected by the proxy unless Cloudflare
validates a fresh token for the expected action and hostname. A token is bound
to the submission it was solved for, so the browser may retry that submission
but the same token cannot be replayed against a different one.

`PORTAL_BASE_URL` is what certificate QR codes and verification links point at,
and it is **required** — set it to the portal origin with no path and no
trailing slash, for example `https://csm.ched.gov.ph`. The proxy forwards only
this configured value and never the request's `Host` header, so a spoofed host
cannot repoint verification at another domain. Until it is set, certificates
are issued without a QR code or verification link and the admin module says so.

## Certificate of Appearance

Issuance is deliberately a two-step flow: a client asks for a certificate in the
survey's first question, and an administrator releases it from **Certificates**
after checking the details.

Upload the Word template in **Settings**. Supported placeholders:

```text
{{title}}  {{name_of_client}}  {{agency}}  {{purpose}}  {{date_coverage}}
{{date_issued}}  {{signatory}}  {{designation}}  {{Timestamp}}
```

Optional: `{{Signature}}` (replaced by the uploaded e-signature image),
`{{VerificationCode}}`, `{{VerificationUrl}}`, and `{{QRCode}}` (replaced by a QR
image pointing at `/verification`). Put `{{QRCode}}` in its own paragraph.

`{{date_coverage}}` is written to read on from the purpose — `on August 8, 2026`
or `from August 8, 2026 to August 9, 2026` — and `{{date_issued}}` renders as
`8th day of August 2026`, so the template's own sentences stay intact.

Set **Certificate signatory** and **Signatory designation** in Settings before
issuing; the backend refuses to release an unsigned certificate. Each issued
certificate is exported to PDF, shared by link, emailed to the client, and
recorded with a verification code that `/verification` can check.

## CSM Summary Report

**Reports** generates the ARTA-format workbook for either a quarter
(January–March, April–June, July–September, October–December) or a full calendar
year. The workbook contains:

- **CSM Summary** — demographics, Citizen's Charter counts, and a mean/median
  pair for each of the nine Service Quality Dimensions per program, with the
  overall score, respondent counts, and an overall rating row
- **One sheet per main program** — per-client ratings, mean and median, the
  rating distribution, and the prepared / reviewed / approved block
- **DATA** — the raw responses behind the numbers

Respondent counts come from the survey. **No. of Clients** and **Volume of
Transactions** are office records, so enter them on the Reports page before
generating; they are saved per period in the `ServiceStats` sheet. The names in
the signature block come from **Settings**.

Generated workbooks are stored in Drive and listed on the Reports page.

## Security

- The Apps Script URL, shared token, and Turnstile secret live only in the
  Vercel function; the browser never sees them.
- Every Apps Script request must present the shared token; the backend stores
  only its SHA-256 hash.
- Admin passwords are salted and iterated SHA-256, never stored in plain text.
  Sessions expire after six hours and logins throttle after five failures.
  Expired sessions are swept on each sign-in and by the daily
  `pruneAdminSessions` trigger, so the script property store cannot fill up and
  start refusing new sign-ins.
- The `Audit` sheet records logins, program changes, settings changes,
  certificate issuance, report generation, and user changes as an HMAC hash
  chain, so a row edited or deleted directly in Sheets is reported in the UI.
- Client answers, passwords, session tokens, and Turnstile tokens are never
  written to the audit log.
- A honeypot field, request-size limits, upload MIME and size validation,
  formula-injection escaping on every sheet write, and the CSP/HSTS headers in
  `vercel.json` round out the protections.
