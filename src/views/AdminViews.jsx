import React, { useEffect, useRef, useState } from "react";
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
import {
  PanelBoundary,
  Skeleton,
  SkeletonLines,
  SkeletonRegion,
  SkeletonTable,
  Tip,
} from "./ui";
import { CC_QUESTIONS, SQD_QUESTIONS, ccTallyOptions } from "../lib/csm";
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
// Loaded with this chunk, not with the public bundle: a client filling the
// survey has no use for the admin stylesheet.
import "../styles/admin.css";

function AdminLogin({ onAuthenticated }) {
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [turnstileToken, setTurnstileToken] = useState(""),
    [turnstileReset, setTurnstileReset] = useState(0);
  /**
   * A ref, not the `busy` flag: two clicks landing in the same tick both read
   * the pre-render state and both submit. Each attempt is scoped to its own
   * server-side nonce — necessarily, or a solved challenge could be replayed
   * for unlimited password guesses — so the second request would be rejected
   * as a spent token and show the user a security error for a double-click.
   */
  const submitting = useRef(false);
  async function submit(event) {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
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
      submitting.current = false;
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
        <Tip text="Sign in to the protected admin module" block>
          <button
            className="button primary login-submit"
            disabled={busy || !turnstileToken}
          >
            <LogIn size={18} /> {busy ? "Signing in…" : "Sign in"}
          </button>
        </Tip>
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
  overview: [
    "Overview",
    "Scores and volumes for the selected reporting period.",
  ],
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
              <Tip
                key={entry.id}
                block
                placement="bottom"
                text={PAGE_COPY[entry.id]?.[1] || entry.label}
              >
                <button
                  className={tab === entry.id ? "active" : ""}
                  aria-current={tab === entry.id ? "page" : undefined}
                  onClick={() => {
                    setTab(entry.id);
                    setError("");
                  }}
                >
                  <Icon /> {entry.label}
                </button>
              </Tip>
            );
          })}
          <Tip block placement="bottom" text="Open the public portal">
            <a
              href="/"
              onClick={(event) => {
                event.preventDefault();
                navigate("/");
              }}
            >
              <BarChart3 /> Client portal
            </a>
          </Tip>
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
          <Tip text="Sign out of the admin module" placement="top" align="end">
            <button
              className="profile-logout"
              onClick={signOut}
              aria-label="Sign out"
            >
              <LogOut />
            </button>
          </Tip>
        </div>
      </aside>

      <main className="admin-main">
        <header>
          <div>
            <p className="eyebrow">
              CHED-OSDS · Client Satisfaction Measurement
            </p>
            <h1>{heading}</h1>
            <p>{sub}</p>
          </div>
          {usesPeriod && <PeriodPicker period={period} onChange={setPeriod} />}
        </header>
        {error && <div className="alert admin-alert">{error}</div>}

        <PanelBoundary resetKey={tab}>
          {tab === "overview" && (
            <OverviewPanel period={period} onError={handleError} />
          )}
          {tab === "responses" && <ResponsesPanel onError={handleError} />}
          {tab === "certificates" && <CertificatePanel onError={handleError} />}
          {tab === "reports" && (
            <ReportsPanel period={period} onError={handleError} />
          )}
          {tab === "services" && <ServicesPanel onError={handleError} />}
          {tab === "settings" && (
            <SettingsPanel onError={handleError} canSign={isSuperadmin} />
          )}
          {tab === "users" && isSuperadmin && (
            <UsersPanel onError={handleError} />
          )}
          {tab === "audit" && isSuperadmin && (
            <AuditPanel onError={handleError} />
          )}
        </PanelBoundary>
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

/**
 * The overview's own shape, drawn before the numbers arrive.
 *
 * It mirrors the real layout closely enough that nothing shifts when the data
 * lands — four cards, then the same four panels in the same grid. A spinner in
 * the middle of the page would have cost a full reflow at exactly the moment
 * the reader started looking.
 */
function OverviewSkeleton() {
  return (
    <SkeletonRegion label="Loading the overview for this period">
      <section className="stats">
        {Array.from({ length: 4 }, (_, index) => (
          <article key={index}>
            <Skeleton width="58%" height={11} />
            <Skeleton
              width="42%"
              height={26}
              style={{ display: "block", margin: "10px 0 6px" }}
            />
            <Skeleton width="66%" height={10} />
          </article>
        ))}
      </section>
      <section className="panel-grid">
        {Array.from({ length: 4 }, (_, index) => (
          <article className="panel" key={index}>
            <div className="panel-head">
              <Skeleton width="46%" height={16} />
              <Skeleton
                width="70%"
                height={11}
                style={{ display: "block", marginTop: 8 }}
              />
            </div>
            <SkeletonLines lines={6} />
          </article>
        ))}
      </section>
    </SkeletonRegion>
  );
}

function OverviewPanel({ period, onError }) {
  const [data, setData] = useState(null),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let stale = false;
    setLoading(true);
    getAdminOverview(period)
      .then((result) => {
        if (!stale) setData(result);
      })
      .catch((thrown) => {
        if (!stale) onError(thrown);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [period.type, period.year, period.quarter]);

  if (loading && !data) return <OverviewSkeleton />;
  const overall = data?.overall || 0;
  const maxServiceScore = 5;

  return (
    // Dimmed rather than replaced while a new period loads: the previous
    // period's figures stay readable, and swapping them for a skeleton on every
    // period change would make the picker feel like it reloaded the page.
    <div className={loading ? "is-refreshing" : ""}>
      <section className="stats">
        <article>
          <span>Responses · {describePeriod(period)}</span>
          <strong>{(data?.totalResponses ?? 0).toLocaleString()}</strong>
          <Tip
            align="end"
            text="Submissions whose transaction date falls inside this reporting period."
          >
            <i className="brand">
              <Inbox />
            </i>
          </Tip>
        </article>
        <article>
          <span>Overall score</span>
          <strong>{overall ? overall.toFixed(2) : "—"}</strong>
          <small className="stat-note">{scoreLabel(overall)}</small>
          <Tip
            align="end"
            text="The mean of every rated SQD answer in the period, weighted by respondent. N/A answers are left out rather than counted as zero."
          >
            <i className="gold">
              <BarChart3 />
            </i>
          </Tip>
        </article>
        <article>
          <span>Certificates issued</span>
          <strong>{(data?.coa?.issued ?? 0).toLocaleString()}</strong>
          <small className="stat-note">
            {(data?.coa?.pending ?? 0).toLocaleString()} awaiting release (all
            periods)
          </small>
          <Tip
            align="end"
            text="Issued counts this period. The awaiting figure spans every period, because a request left unissued does not expire."
          >
            <i className="teal">
              <FileSignature />
            </i>
          </Tip>
        </article>
        <article>
          <span>Aware of the Citizen's Charter</span>
          <strong>{data?.ccAwareness ? `${data.ccAwareness}%` : "—"}</strong>
          <Tip
            align="end"
            text="Respondents who answered CC1 with one of the first three options — that is, who knew of a Citizen's Charter or saw this office's."
          >
            <i className="brand">
              <ShieldCheck />
            </i>
          </Tip>
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
                    <i
                      style={{ width: `${(value / maxServiceScore) * 100}%` }}
                    />
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
                  {ccTallyOptions(question).map((option) => (
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
    </div>
  );
}

const PAGE_SIZE = 100;

/**
 * What the certificate column's four words mean, said once on the header
 * rather than on every row.
 */
const COA_COLUMN_HELP =
  "REQUESTED — asked for, not yet issued. ISSUED — generated and emailed. " +
  "ERROR — the last attempt failed; retry from the Certificates tab. " +
  "NONE — this client did not ask for one.";

/** Named once, so the placeholder table and the real one cannot drift apart. */
const RESPONSE_COLUMNS = [
  "Reference",
  "Date",
  "Program",
  "Client",
  "Region",
  "Overall",
  "COA",
  "",
];

function ResponsesPanel({ onError }) {
  const [data, setData] = useState({ rows: [], total: 0, offset: 0 }),
    [query, setQuery] = useState(""),
    [draftQuery, setDraftQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(true),
    [expanded, setExpanded] = useState("");

  // The sheet is the source of truth for both filtering and paging, so the
  // count on screen is the real number of matches rather than however many
  // rows happened to fit in the last fetch.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    getAdminResponses({ query, offset, limit: PAGE_SIZE })
      .then((result) => {
        if (!stale) setData(result);
      })
      .catch((thrown) => {
        // A superseded request must not raise a banner — or, since
        // handleError signs out on authorization-shaped messages, drop the
        // administrator to the login screen mid-navigation.
        if (!stale) onError(thrown);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [query, offset]);

  const rows = data.rows || [];
  const total = data.total || 0;
  const firstShown = total ? offset + 1 : 0;
  const lastShown = Math.min(offset + PAGE_SIZE, total);

  const search = (event) => {
    event.preventDefault();
    setExpanded("");
    setOffset(0);
    setQuery(draftQuery.trim());
  };

  if (loading && !rows.length)
    return (
      <SkeletonRegion label="Loading responses" className="table-card">
        <div className="table-tools">
          <div>
            <Skeleton width={168} height={17} />
            <Skeleton
              width={232}
              height={11}
              style={{ display: "block", marginTop: 9 }}
            />
          </div>
          <Skeleton width={300} height={38} radius={10} />
        </div>
        <SkeletonTable
          columns={RESPONSE_COLUMNS}
          rows={Math.min(PAGE_SIZE, 8)}
        />
      </SkeletonRegion>
    );
  return (
    // The refreshing treatment goes on the results below, never on this
    // section: it disables pointer events, and putting it here meant the
    // search box dimmed and stopped accepting input for the duration of the
    // search it had just started.
    <section className="table-card">
      <div className="table-tools">
        <div>
          <h2>{query ? "Matching responses" : "All responses"}</h2>
          <p>
            {total
              ? `Showing ${firstShown}–${lastShown} of ${total.toLocaleString()} records`
              : "No records"}
            {query && " · filtered"}
          </p>
        </div>
        <form className="search" onSubmit={search}>
          <Search />
          <input
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search reference, email, program…"
            aria-label="Search responses"
          />
          {/* Filtering happens on the server now, so the search needs a visible
              trigger — pressing Enter is not a discoverable affordance. */}
          <Tip
            placement="bottom"
            text="Searches the whole sheet, not just the page on screen"
          >
            <button className="mini-button">Search</button>
          </Tip>
          {query && (
            <Tip
              placement="bottom"
              align="end"
              text="Clear the search and show every response"
            >
              <button
                type="button"
                className="mini-button"
                onClick={() => {
                  setDraftQuery("");
                  setOffset(0);
                  setQuery("");
                }}
              >
                Clear
              </button>
            </Tip>
          )}
        </form>
      </div>
      <div className={`table-scroll${loading ? " is-refreshing" : ""}`}>
        <table>
          <thead>
            <tr>
              {RESPONSE_COLUMNS.map((column, index) => (
                <th key={index}>
                  {/* align="end" because the column sits at the far side of a
                      scroll container, which clips a centred bubble. */}
                  {column === "COA" ? (
                    <Tip text={COA_COLUMN_HELP} placement="bottom" align="end">
                      <span tabIndex={0} className="th-help">
                        COA
                      </span>
                    </Tip>
                  ) : (
                    column
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
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
                  <td className="numeric">
                    {row.overall ? row.overall.toFixed(2) : "—"}
                  </td>
                  <td>
                    {/* The explanation lives on the column header, not here.
                        A tooltip per row would make every pill a tab stop —
                        a hundred of them, to define a word already spelled
                        out in the cell. */}
                    <span
                      className={`status-pill ${row.coaStatus === "ISSUED" ? "enabled" : row.coaStatus === "REQUESTED" ? "pending" : "disabled"}`}
                    >
                      {row.coaStatus || "NONE"}
                    </span>
                  </td>
                  <td>
                    <button
                      className="mini-button"
                      aria-expanded={expanded === row.referenceId}
                      onClick={() =>
                        setExpanded(
                          expanded === row.referenceId ? "" : row.referenceId,
                        )
                      }
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
            {!rows.length && (
              <tr>
                <td colSpan={8} className="empty-cell">
                  {query
                    ? "No responses match this search."
                    : "No responses recorded yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {total > PAGE_SIZE && (
        <div className="pager">
          <Tip align="start" text="Show the previous 100 records">
            <button
              className="mini-button"
              disabled={offset === 0 || loading}
              onClick={() => {
                setExpanded("");
                setOffset(Math.max(0, offset - PAGE_SIZE));
              }}
            >
              Previous
            </button>
          </Tip>
          <span>
            {firstShown}–{lastShown} of {total.toLocaleString()}
          </span>
          <Tip align="end" text="Show the next 100 records">
            <button
              className="mini-button"
              disabled={lastShown >= total || loading}
              onClick={() => {
                setExpanded("");
                setOffset(offset + PAGE_SIZE);
              }}
            >
              Next
            </button>
          </Tip>
        </div>
      )}
    </section>
  );
}
