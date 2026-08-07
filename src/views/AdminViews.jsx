import React, { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  ClipboardList,
  FileSignature,
  FileSpreadsheet,
  Inbox,
  LayoutGrid,
  ListChecks,
  LogIn,
  LogOut,
  Search,
  Settings2,
  ShieldCheck,
  Users,
} from "lucide-react";
import {
  adminLogin,
  adminLogout,
  getAdminOverview,
  getAdminResponses,
  readAdminSession,
} from "../lib/api";
import { Brand, TurnstileWidget } from "./shared";
import { CC_QUESTIONS, SQD_QUESTIONS } from "../lib/csm";
import { PeriodPicker, currentPeriod, describePeriod } from "./PeriodPicker";
import {
  AuditPanel,
  CertificatePanel,
  ReportsPanel,
  ServicesPanel,
  SettingsPanel,
  UsersPanel,
} from "./AdminPanels";
import { navigate } from "../router";

function AdminLogin({ onAuthenticated }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [turnstileToken, setTurnstileToken] = useState(""),
    [turnstileReset, setTurnstileReset] = useState(0);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!turnstileToken)
        throw new Error("Please complete the security verification.");
      onAuthenticated(await adminLogin(email, password, turnstileToken));
    } catch (loginError) {
      setError(loginError.message || "Unable to sign in.");
      setTurnstileToken("");
      setTurnstileReset((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="admin-login-page">
      <form className="admin-login-card" onSubmit={submit}>
        <Brand subtitle="Administrator module" />
        <p className="eyebrow">
          <ShieldCheck size={15} /> Restricted access
        </p>
        <h1>Admin sign in</h1>
        <p>Use an administrator account created for the CSM portal.</p>
        <label>
          Email address
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            placeholder="admin@ched.gov.ph"
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            placeholder="Enter your password"
          />
        </label>
        <TurnstileWidget
          action="admin_login"
          onToken={setTurnstileToken}
          resetKey={turnstileReset}
        />
        {error && <div className="alert">{error}</div>}
        <button
          className="button primary login-submit"
          disabled={busy || !turnstileToken}
          title="Sign in to the protected admin module"
        >
          <LogIn size={18} /> {busy ? "Signing in…" : "Sign in"}
        </button>
        <a
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          Back to the client portal
        </a>
      </form>
    </main>
  );
}

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "responses", label: "Responses", icon: Inbox },
  { id: "certificates", label: "Certificates", icon: FileSignature },
  { id: "reports", label: "Reports", icon: FileSpreadsheet },
  { id: "services", label: "Programs", icon: ListChecks },
  { id: "settings", label: "Settings", icon: Settings2 },
  { id: "users", label: "Users", icon: Users, superadmin: true },
  { id: "audit", label: "Audit", icon: ClipboardList, superadmin: true },
];

const PAGE_COPY = {
  overview: ["Overview", "Scores and volumes for the selected reporting period."],
  responses: ["Responses", "Every Client Satisfaction Measurement submission."],
  certificates: [
    "Certificates of Appearance",
    "Issue the certificates clients asked for, and reissue when details change.",
  ],
  reports: [
    "CSM Summary Report",
    "Generate the ARTA-format workbook by quarter or for a full year.",
  ],
  services: [
    "Main programs",
    "Add and maintain the programs measured separately in the report.",
  ],
  settings: [
    "Office settings",
    "Signatories, certificate template, and report preparers.",
  ],
  users: ["Users", "Create and maintain administrator access."],
  audit: ["Audit log", "Review administrator access and privileged changes."],
};

export function AdminDashboard() {
  const [session, setSession] = useState(readAdminSession),
    [tab, setTab] = useState("overview"),
    [period, setPeriod] = useState(currentPeriod),
    [error, setError] = useState("");

  async function signOut() {
    try {
      await adminLogout();
    } finally {
      setSession(null);
    }
  }

  // Any privileged call can come back with an expired session; drop straight to
  // the login screen instead of leaving a half-loaded dashboard on screen.
  const handleError = (thrown) => {
    const message = thrown?.message || "Something went wrong.";
    setError(message);
    if (/session|expired|authorization|forbidden/i.test(message))
      adminLogout().finally(() => setSession(null));
  };

  if (!session) return <AdminLogin onAuthenticated={setSession} />;
  const isSuperadmin = session.user?.role?.toLowerCase() === "superadmin";
  const visibleTabs = TABS.filter((entry) => !entry.superadmin || isSuperadmin);
  const [heading, sub] = PAGE_COPY[tab] || PAGE_COPY.overview;
  const usesPeriod = tab === "overview" || tab === "reports";

  return (
    <div className="admin-layout">
      <aside>
        <Brand subtitle="Admin module" light />
        <nav>
          {visibleTabs.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                className={tab === entry.id ? "active" : ""}
                onClick={() => {
                  setTab(entry.id);
                  setError("");
                }}
                title={PAGE_COPY[entry.id]?.[1] || entry.label}
              >
                <Icon /> {entry.label}
              </button>
            );
          })}
          <a
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
            title="Open the public portal"
          >
            <BarChart3 /> Client portal
          </a>
        </nav>
        <div className="admin-profile">
          <span>
            {(session.user?.name || session.user?.email || "A")
              .split(/\s+/)
              .map((part) => part[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <div>
            <strong>{session.user?.name || session.user?.email}</strong>
            <small>{session.user?.role || "Administrator"}</small>
          </div>
          <button
            className="profile-logout"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out of the admin module"
          >
            <LogOut />
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <header>
          <div>
            <p className="eyebrow">CHED-OSDS · Client Satisfaction Measurement</p>
            <h1>{heading}</h1>
            <p>{sub}</p>
          </div>
          {usesPeriod && <PeriodPicker period={period} onChange={setPeriod} />}
        </header>
        {error && <div className="alert admin-alert">{error}</div>}

        {tab === "overview" && (
          <OverviewPanel period={period} onError={handleError} />
        )}
        {tab === "responses" && <ResponsesPanel onError={handleError} />}
        {tab === "certificates" && <CertificatePanel onError={handleError} />}
        {tab === "reports" && (
          <ReportsPanel period={period} onError={handleError} />
        )}
        {tab === "services" && <ServicesPanel onError={handleError} />}
        {tab === "settings" && <SettingsPanel onError={handleError} />}
        {tab === "users" && isSuperadmin && <UsersPanel onError={handleError} />}
        {tab === "audit" && isSuperadmin && <AuditPanel onError={handleError} />}
      </main>
    </div>
  );
}

const scoreLabel = (value) =>
  value >= 4.5
    ? "Outstanding"
    : value >= 4
      ? "Very Satisfactory"
      : value >= 3
        ? "Satisfactory"
        : value > 0
          ? "Needs improvement"
          : "No data";

function OverviewPanel({ period, onError }) {
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    getAdminOverview(period)
      .then(setData)
      .catch(onError)
      .finally(() => setLoading(false));
  }, [period.type, period.year, period.quarter]);

  if (loading && !data)
    return <section className="panel-loading">Loading overview…</section>;
  const overall = data?.overall || 0;
  const maxServiceScore = 5;

  return (
    <>
      <section className="stats">
        <article>
          <span>Responses · {describePeriod(period)}</span>
          <strong>{data?.totalResponses ?? 0}</strong>
          <i className="green">
            <Inbox />
          </i>
        </article>
        <article>
          <span>Overall score</span>
          <strong>{overall ? overall.toFixed(2) : "—"}</strong>
          <small className="stat-note">{scoreLabel(overall)}</small>
          <i className="gold">
            <BarChart3 />
          </i>
        </article>
        <article>
          <span>Certificates issued</span>
          <strong>{data?.coa?.issued ?? 0}</strong>
          <small className="stat-note">
            {data?.coa?.pending ?? 0} awaiting release (all periods)
          </small>
          <i className="blue">
            <FileSignature />
          </i>
        </article>
        <article>
          <span>Aware of the Citizen's Charter</span>
          <strong>{data?.ccAwareness ? `${data.ccAwareness}%` : "—"}</strong>
          <i className="green">
            <ShieldCheck />
          </i>
        </article>
      </section>

      <section className="panel-grid">
        <article className="panel">
          <div className="panel-head">
            <h2>Service Quality Dimensions</h2>
            <p>Mean rating per dimension for this period</p>
          </div>
          <ul className="bar-list">
            {SQD_QUESTIONS.map((question) => {
              const value = data?.sqd?.[question.id]?.mean || 0;
              return (
                <li key={question.id}>
                  <span className="bar-label">
                    <b>{question.number}</b>
                    {question.dimension || "Overall satisfaction"}
                  </span>
                  <span className="bar-track">
                    <i style={{ width: `${(value / maxServiceScore) * 100}%` }} />
                  </span>
                  <span className="bar-value">
                    {value ? value.toFixed(2) : "—"}
                  </span>
                </li>
              );
            })}
          </ul>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>By program</h2>
            <p>Overall score and respondent count</p>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Program</th>
                  <th>Respondents</th>
                  <th>Overall</th>
                </tr>
              </thead>
              <tbody>
                {(data?.services || []).map((service) => (
                  <tr key={service.code}>
                    <td>
                      <strong>{service.code}</strong>
                      <small>{service.name}</small>
                    </td>
                    <td>{service.respondents}</td>
                    <td>
                      {service.overall ? service.overall.toFixed(2) : "—"}
                    </td>
                  </tr>
                ))}
                {!data?.services?.length && (
                  <tr>
                    <td colSpan={3} className="empty-cell">
                      No responses in this period yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Citizen's Charter</h2>
            <p>Answer counts for CC1–CC3</p>
          </div>
          <div className="cc-grid">
            {CC_QUESTIONS.map((question) => (
              <div key={question.id}>
                <h3>{question.number}</h3>
                <ul>
                  {question.options.map((option) => (
                    <li key={option.value}>
                      <span>
                        {option.value === "N/A"
                          ? "N/A"
                          : `Option ${option.value}`}
                      </span>
                      <b>{data?.cc?.[question.id]?.[option.value] || 0}</b>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Demographics</h2>
            <p>Client type, sex, and age bracket</p>
          </div>
          <div className="demo-grid">
            {[
              ["Client type", data?.clientTypes],
              ["Sex", data?.sexes],
              ["Age bracket", data?.ageBrackets],
            ].map(([label, entries]) => (
              <div key={label}>
                <h3>{label}</h3>
                <ul>
                  {Object.entries(entries || {}).map(([key, count]) => (
                    <li key={key}>
                      <span>{key}</span>
                      <b>{count}</b>
                    </li>
                  ))}
                  {!Object.keys(entries || {}).length && (
                    <li className="empty-cell">No data</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  );
}

function ResponsesPanel({ onError }) {
  const [rows, setRows] = useState([]),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true),
    [expanded, setExpanded] = useState("");
  useEffect(() => {
    getAdminResponses({ limit: 500 })
      .then(setRows)
      .catch(onError)
      .finally(() => setLoading(false));
  }, []);
  const filtered = useMemo(
    () =>
      rows.filter((row) =>
        [row.referenceId, row.email, row.serviceName, row.region, row.clientType]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [rows, query],
  );
  if (loading) return <section className="panel-loading">Loading responses…</section>;
  return (
    <section className="table-card">
      <div className="table-tools">
        <div>
          <h2>All responses</h2>
          <p>{filtered.length} records</p>
        </div>
        <label className="search">
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search reference, email, program…"
          />
        </label>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th>Date</th>
              <th>Program</th>
              <th>Client</th>
              <th>Region</th>
              <th>Overall</th>
              <th>COA</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <React.Fragment key={row.referenceId}>
                <tr>
                  <td>
                    <strong>{row.referenceId}</strong>
                    <small>{row.email}</small>
                  </td>
                  <td>{row.transactionDate}</td>
                  <td>
                    <strong>{row.serviceCode}</strong>
                    <small>{row.otherService || row.serviceName}</small>
                  </td>
                  <td>
                    {row.clientType}
                    <small>
                      {[row.sex, row.age].filter(Boolean).join(" · ") || "—"}
                    </small>
                  </td>
                  <td>{row.region}</td>
                  <td>{row.overall ? row.overall.toFixed(2) : "—"}</td>
                  <td>
                    <span
                      className={`status-pill ${row.coaStatus === "ISSUED" ? "enabled" : row.coaStatus === "REQUESTED" ? "pending" : "disabled"}`}
                    >
                      {row.coaStatus || "NONE"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="mini-button"
                      onClick={() =>
                        setExpanded(
                          expanded === row.referenceId ? "" : row.referenceId,
                        )
                      }
                      title="Show the full answer set"
                    >
                      {expanded === row.referenceId ? "Hide" : "Details"}
                    </button>
                  </td>
                </tr>
                {expanded === row.referenceId && (
                  <tr className="detail-row">
                    <td colSpan={8}>
                      <div className="answer-grid">
                        {CC_QUESTIONS.map((question) => (
                          <span key={question.id}>
                            <b>{question.number}</b>
                            {row[question.id] || "—"}
                          </span>
                        ))}
                        {SQD_QUESTIONS.map((question) => (
                          <span key={question.id}>
                            <b>{question.number}</b>
                            {row[question.id] || "—"}
                          </span>
                        ))}
                      </div>
                      {row.suggestions && (
                        <p className="answer-suggestion">
                          <b>Suggestion:</b> {row.suggestions}
                        </p>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {!filtered.length && (
              <tr>
                <td colSpan={8} className="empty-cell">
                  No responses match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
