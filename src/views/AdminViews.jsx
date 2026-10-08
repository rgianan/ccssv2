import React, { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  Bell,
  ChevronRight,
  ClipboardList,
  FileSignature,
  FileSpreadsheet,
  Inbox,
  LayoutGrid,
  ListChecks,
  LogIn,
  LogOut,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import {
  adminLogin,
  adminLogout,
  changeResponseService,
  getAdminOverview,
  getAdminResponses,
  getAdminServices,
  getCoaRequests,
  readAdminSession,
  storeAdminSession,
  validateAdminSession,
} from "../lib/api";
import { Brand, TurnstileWidget } from "./shared";
import {
  PanelBoundary,
  LoadFailed,
  Pager,
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

/**
 * The tabs, in two groups. They were one flat list of eight, in which the
 * four opened every day and the four opened to set the office up looked the
 * same. The id is also what the address carries (/admin#certificates).
 */
const TABS = [
  { id: "overview", label: "Overview", icon: LayoutGrid, group: "work" },
  { id: "responses", label: "Responses", icon: Inbox, group: "work" },
  {
    id: "certificates",
    label: "Certificates",
    icon: FileSignature,
    group: "work",
  },
  { id: "reports", label: "Reports", icon: FileSpreadsheet, group: "work" },
  { id: "services", label: "Programs", icon: ListChecks, group: "setup" },
  { id: "settings", label: "Settings", icon: Settings2, group: "setup" },
  {
    id: "users",
    label: "Users",
    icon: Users,
    group: "setup",
    superadmin: true,
  },
  {
    id: "audit",
    label: "Audit",
    icon: ClipboardList,
    group: "setup",
    superadmin: true,
  },
];
const NAV_GROUPS = [
  { id: "work", label: "Daily work" },
  { id: "setup", label: "Setup" },
];

/** The tabs an account may open: Users and Audit are the superadmin's. */
export const tabsFor = (isSuperadmin) =>
  TABS.filter((entry) => !entry.superadmin || isSuperadmin);

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

/**
 * Certificates waiting to be released, for the bell in the header.
 *
 * Asked for through getCoaRequests — the same read the Certificates tab makes
 * — so the poll and the panel share one cached answer instead of two round
 * trips for the same list, and opening the tab from the bell shows rows that
 * are already in hand. "REQUESTED" is the backend's own grouping, so it also
 * carries rows left at PROCESSING by an issuance that was cut off: still
 * unreleased work, and the reason a queue counting only REQUESTED could read
 * as empty while a client waited.
 */
const PENDING_POLL_MS = 120_000;

/** Per administrator: two people signing in from one machine keep their own. */
const seenKey = (email) => `csm.coa.seen.${String(email || "").toLowerCase()}`;

const readSeen = (email) => {
  try {
    const stored = JSON.parse(localStorage.getItem(seenKey(email)) || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    // A private window, or site data the browser refuses. The count is still
    // right; everything pending simply reads as new on each visit.
    return [];
  }
};

function usePendingCertificates(email, active) {
  const [pending, setPending] = useState([]),
    [seen, setSeen] = useState(() => readSeen(email)),
    [tick, setTick] = useState(0);

  useEffect(() => {
    setSeen(readSeen(email));
  }, [email]);

  useEffect(() => {
    if (!active) return;
    let stale = false;
    const poll = () =>
      getCoaRequests({ status: "REQUESTED" })
        .then((rows) => {
          if (!stale) setPending(rows);
        })
        // Deliberately silent. A count that could not be fetched is not worth
        // an error banner across whatever page the administrator is working
        // on, and reporting it through handleError would sign them out on an
        // expired session before the panel in front of them could say so.
        .catch(() => {});
    poll();
    const timer = setInterval(poll, PENDING_POLL_MS);
    // Coming back to the tab is exactly when a stale count gets noticed.
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      stale = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, tick]);

  return {
    pending,
    unseen: pending.filter((row) => !seen.includes(row.referenceId)),
    /** Refetch now — after an issuance, rather than up to two minutes later. */
    refresh: () => setTick((value) => value + 1),
    markSeen: () => {
      // The queue as it stands, not everything ever seen: a request that
      // leaves the queue never returns to it, so this cannot miss a new one
      // and cannot grow without bound either.
      const ids = pending.map((row) => row.referenceId);
      setSeen(ids);
      try {
        localStorage.setItem(seenKey(email), JSON.stringify(ids));
      } catch {
        /* See readSeen. */
      }
    },
  };
}

function CertificateBell({ pending, unseen, onOpen, onMarkSeen }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const count = pending.length;
  // The whole state in one string: a screen reader gets from the button what
  // the badge and the dot show everybody else.
  const label = count
    ? `Certificates: ${count} waiting to be issued${
        unseen.length ? `, ${unseen.length} new since you last looked` : ""
      }`
    : "Certificates: none waiting to be issued";

  return (
    <div className="bell-wrap" ref={wrap}>
      <button
        type="button"
        className={`bell${count ? " has-pending" : ""}${unseen.length ? " has-new" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          // Opening it is what counts as having looked.
          if (!open) onMarkSeen();
          setOpen((value) => !value);
        }}
      >
        <Bell size={17} />
        {count > 0 && (
          <span className="bell-count">{count > 99 ? "99+" : count}</span>
        )}
      </button>
      {open && (
        <div
          className="bell-panel"
          role="dialog"
          aria-label="Certificates waiting to be issued"
        >
          <header>
            <strong>Waiting to be issued</strong>
            <small>
              {count
                ? `${count} in the queue${unseen.length ? ` · ${unseen.length} new` : ""}`
                : "Nothing in the queue"}
            </small>
          </header>
          {count === 0 ? (
            <p className="bell-empty">
              Every certificate a client has asked for has been released.
            </p>
          ) : (
            <ul>
              {pending.slice(0, 5).map((row) => (
                <li key={row.referenceId}>
                  <strong>
                    {[row.coaTitle, row.coaName].filter(Boolean).join(" ") ||
                      row.referenceId}
                  </strong>
                  <small>
                    {row.coaAgency || "No agency recorded"}
                    {row.coaDateCoverage ? ` · ${row.coaDateCoverage}` : ""}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {count > 5 && (
            <p className="bell-more">and {count - 5} more in the queue</p>
          )}
          <button
            type="button"
            className="mini-button primary bell-open"
            onClick={() => {
              setOpen(false);
              onOpen();
            }}
          >
            <FileSignature size={12} /> Open the certificates queue
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The open tab, kept in the address as /admin#certificates.
 *
 * It used to live only in this component's state, so the address never
 * changed: a reload went back to Overview, the browser's Back button left the
 * admin altogether, and nothing could link to a tab. As the fragment, the
 * browser's own history does all three — and the server never sees it, so no
 * route had to be added.
 *
 * The fragment is kept as typed and checked against `ids` at each render,
 * rather than resolved once: before sign-in the role is unknown, and "#users"
 * resolved then would have been thrown away as not allowed and Overview shown
 * to the superadmin who had asked for Users.
 */
export function useTabInAddress(ids, fallback = "overview") {
  const read = () => {
    try {
      return decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return "";
    }
  };
  const [fragment, setFragment] = useState(read);
  useEffect(() => {
    const onChange = () => setFragment(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const tab = ids.includes(fragment) ? fragment : fallback;
  // Through the address, so there is one way a tab opens and Back undoes it.
  const setTab = (id) => {
    if (id !== read()) window.location.hash = id;
  };
  return [tab, setTab];
}

/**
 * The sidebar's tabs: links, in their two groups, with the number of
 * certificates waiting on the Certificates item — it showed only on the bell,
 * away from the thing it counts.
 */
export function AdminNav({ tabs, tab, pending = 0, onNavigate }) {
  return (
    <nav id="admin-nav" aria-label="Admin sections">
      {NAV_GROUPS.map((group) => {
        const entries = tabs.filter((entry) => entry.group === group.id);
        if (!entries.length) return null;
        return (
          <div
            className="nav-group"
            key={group.id}
            role="group"
            aria-labelledby={`nav-group-${group.id}`}
          >
            <p className="nav-group-label" id={`nav-group-${group.id}`}>
              {group.label}
            </p>
            {entries.map((entry) => {
              const Icon = entry.icon;
              const waiting = entry.id === "certificates" ? pending : 0;
              return (
                <Tip
                  key={entry.id}
                  block
                  placement="bottom"
                  text={PAGE_COPY[entry.id]?.[1] || entry.label}
                >
                  <a
                    href={`#${entry.id}`}
                    className={tab === entry.id ? "active" : ""}
                    aria-current={tab === entry.id ? "page" : undefined}
                    // The address does the navigating. This is for the tab
                    // already open: its link changes nothing in the address,
                    // so nothing else would close the phone menu it sits in.
                    onClick={onNavigate}
                  >
                    <Icon /> <span className="nav-label">{entry.label}</span>
                    {waiting > 0 && (
                      <span className="nav-count">
                        {waiting > 99 ? "99+" : waiting}
                        <span className="visually-hidden"> waiting</span>
                      </span>
                    )}
                  </a>
                </Tip>
              );
            })}
          </div>
        );
      })}
      <Tip block placement="bottom" text="Open the public portal">
        <a
          className="nav-portal"
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
  );
}

export function AdminDashboard() {
  const [session, setSession] = useState(readAdminSession),
    [period, setPeriod] = useState(currentPeriod),
    [error, setError] = useState(""),
    // The narrow-screen menu. Below 900px the sidebar is a bar with one button;
    // the tabs used to sit in a strip that ran off the right edge of the window.
    [menuOpen, setMenuOpen] = useState(false);

  async function signOut() {
    try {
      await adminLogout();
    } finally {
      setSession(null);
    }
  }

  // Any privileged call can come back with an expired session; drop straight to
  // the login screen instead of leaving a half-loaded dashboard on screen.
  //
  // Only for the backend's two "you are not signed in" answers. Matching any
  // mention of "forbidden" also signed out an administrator who had merely
  // lost superadmin rights ("superadmin access required"), and everyone at
  // once when the proxy's token was misconfigured — which signing out cannot
  // fix and whose message the login screen then hid.
  const handleError = (thrown) => {
    // No error: a panel that failed to load has loaded on a retry, and the
    // banner about the failed attempt comes down with it.
    if (!thrown) return setError("");
    const message = thrown?.message || "Something went wrong.";
    setError(message);
    if (/authorization required|session has expired/i.test(message))
      adminLogout().finally(() => setSession(null));
  };

  // A session restored from this tab carries the role it had at sign-in. It is
  // checked once on arrival, so a role changed since then shows the right
  // tabs — rather than a demoted administrator being offered Users and Audit
  // and meeting an error on every click. A fresh sign-in needs no check.
  const certificates = usePendingCertificates(
    session?.user?.email,
    Boolean(session),
  );

  const checkedToken = useRef("");
  useEffect(() => {
    const token = session?.token;
    if (!token || checkedToken.current === token) return;
    checkedToken.current = token;
    let stale = false;
    validateAdminSession()
      .then((current) => {
        if (stale || !current?.user) return;
        setSession((previous) => {
          if (!previous || previous.token !== token) return previous;
          const next = {
            ...previous,
            user: current.user,
            expiresAt: current.expiresAt,
          };
          storeAdminSession(next);
          return next;
        });
      })
      .catch((thrown) => {
        if (!stale) handleError(thrown);
      });
    return () => {
      stale = true;
    };
  }, [session?.token]);

  // Escape hides the list, and with it whichever tab had focus; focus goes back
  // to the button that opened it rather than falling to the page.
  const menuToggle = useRef(null);
  // Declared with the other hooks, above the sign-in return: what is allowed
  // is worked out from the session each render, signed in or not.
  const isSuperadmin = session?.user?.role?.toLowerCase() === "superadmin";
  const visibleTabs = tabsFor(isSuperadmin);
  const [tab, setTab] = useTabInAddress(visibleTabs.map((entry) => entry.id));
  // Arriving on a tab — by a link in the sidebar, the bell, Back or a typed
  // address — puts the last tab's error and the open menu away.
  useEffect(() => {
    setError("");
    setMenuOpen(false);
  }, [tab]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuToggle.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!session)
    return (
      <AdminLogin
        onAuthenticated={(fresh) => {
          checkedToken.current = fresh?.token || "";
          // Signing out happens from inside the open menu on a phone; without
          // this the next sign-in arrives with the menu still open.
          setMenuOpen(false);
          setSession(fresh);
        }}
      />
    );
  const [heading, sub] = PAGE_COPY[tab] || PAGE_COPY.overview;
  const usesPeriod = tab === "overview" || tab === "reports";

  return (
    <div className="admin-layout">
      <aside className={menuOpen ? "menu-open" : ""}>
        <Brand subtitle="Admin module" light />
        {/* Shown only below 900px. The tabs and the profile — with Sign out,
            which a hidden profile used to take with it — open under the bar,
            one full-width row each, so every label is read rather than
            guessed from an icon. */}
        <button
          ref={menuToggle}
          type="button"
          className="nav-toggle"
          aria-expanded={menuOpen}
          aria-controls="admin-nav"
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <X /> : <Menu />}
          {menuOpen ? "Close" : "Menu"}
        </button>
        <AdminNav
          tabs={visibleTabs}
          tab={tab}
          pending={certificates.pending.length}
          onNavigate={() => {
            setError("");
            setMenuOpen(false);
          }}
        />
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
          {/* No eyebrow over the title: the sidebar already names the office
              and the module on every page. */}
          <div className="page-title">
            <h1>{heading}</h1>
            <p>{sub}</p>
          </div>
          {/* The bell comes last so it is the rightmost thing in the header at
              every width. Its panel hangs from its right edge, and anywhere
              else in the row that edge is far enough from the window's for a
              320px panel to open off the left of the screen. */}
          <div className="header-tools">
            {usesPeriod && (
              <PeriodPicker period={period} onChange={setPeriod} />
            )}
            <CertificateBell
              pending={certificates.pending}
              unseen={certificates.unseen}
              onMarkSeen={certificates.markSeen}
              onOpen={() => setTab("certificates")}
            />
          </div>
        </header>
        {error && <div className="alert admin-alert">{error}</div>}

        <PanelBoundary resetKey={tab}>
          {tab === "overview" && (
            <OverviewPanel period={period} onError={handleError} />
          )}
          {tab === "responses" && <ResponsesPanel onError={handleError} />}
          {tab === "certificates" && (
            <CertificatePanel
              onError={handleError}
              onQueueChanged={certificates.refresh}
            />
          )}
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

/**
 * What each overview figure counts. Shown as the icon's tooltip and again in a
 * glossary under the cards: the tooltip needs a mouse — its icon cannot even
 * take keyboard focus — and these are the definitions a reader needs to trust
 * the numbers, N/A handling included.
 */
const STAT_HELP = {
  responses:
    "Submissions whose transaction date falls inside this reporting period.",
  overall:
    "The mean of every rated SQD answer in the period, weighted by respondent. N/A answers are left out rather than counted as zero.",
  certificates:
    "Issued counts this period. The awaiting figure spans every period, because a request left unissued does not expire.",
  charter:
    "Respondents who answered CC1 with one of the first three options — that is, who knew of a Citizen's Charter or saw this office's.",
};

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
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stale = false;
    setLoading(true);
    getAdminOverview(period)
      .then((result) => {
        if (stale) return;
        setData(result);
        if (failed) onError(null);
        setFailed(false);
      })
      .catch((thrown) => {
        if (stale) return;
        // The figures on screen are the previous period's. Kept, they stood
        // under this period's label as its own; with none, the cards read 0
        // responses and "No data" as though that had been counted.
        setData(null);
        setFailed(true);
        onError(thrown);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [period.type, period.year, period.quarter, attempt]);

  if (loading && !data) return <OverviewSkeleton />;
  if (failed)
    return (
      <LoadFailed
        what={`The overview for ${describePeriod(period)}`}
        onRetry={() => setAttempt((count) => count + 1)}
      />
    );
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
          <Tip align="end" text={STAT_HELP.responses}>
            <i className="brand">
              <Inbox />
            </i>
          </Tip>
        </article>
        <article>
          <span>Overall score</span>
          <strong>{overall ? overall.toFixed(2) : "—"}</strong>
          <small className="stat-note">{scoreLabel(overall)}</small>
          <Tip align="end" text={STAT_HELP.overall}>
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
          <Tip align="end" text={STAT_HELP.certificates}>
            <i className="teal">
              <FileSignature />
            </i>
          </Tip>
        </article>
        <article>
          <span>Aware of the Citizen's Charter</span>
          {/* Keyed on there being responses, not on the figure: 0% is a real
              result, and showing it as "—" read as "no data". */}
          <strong>
            {data?.totalResponses ? `${data.ccAwareness ?? 0}%` : "—"}
          </strong>
          <Tip align="end" text={STAT_HELP.charter}>
            <i className="brand">
              <ShieldCheck />
            </i>
          </Tip>
        </article>
      </section>
      <details className="info-details">
        <summary>How these figures are counted</summary>
        <dl>
          <dt>Responses</dt>
          <dd>{STAT_HELP.responses}</dd>
          <dt>Overall score</dt>
          <dd>{STAT_HELP.overall}</dd>
          <dt>Certificates issued</dt>
          <dd>{STAT_HELP.certificates}</dd>
          <dt>Aware of the Citizen's Charter</dt>
          <dd>{STAT_HELP.charter}</dd>
        </dl>
      </details>

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
            {/* "fit": a half-width card. At the usual 720px minimum the
                program name filled the view and the two figures the card is
                for sat out of sight to the right. */}
            <table className="fit">
              <thead>
                <tr>
                  <th>Program</th>
                  <th className="numeric">Respondents</th>
                  <th className="numeric">Overall</th>
                </tr>
              </thead>
              <tbody>
                {(data?.services || []).map((service) => (
                  <tr key={service.code}>
                    <td className="program-cell">
                      <strong>{service.code}</strong>
                      <small title={service.name}>{service.name}</small>
                    </td>
                    <td className="numeric">{service.respondents}</td>
                    <td className="numeric">
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

/**
 * Rows per page. At 100 the pager appeared only past 100 records, so on the
 * office's actual volume it never did and the list was one long scroll.
 */
const PAGE_SIZE = 25;

/**
 * What the certificate column's four words mean, said once on the header
 * rather than on every row.
 */
/** Every value the COA column can hold. A status missing from here is one the
 *  reader meets with nothing to explain it. One list, rendered twice: as the
 *  column header's tooltip, and as a glossary under the table that opens by tap
 *  — tooltips do not show at all on a device that cannot hover. */
const COA_STATUS_GLOSSARY = [
  ["REQUESTED", "Asked for, not yet issued."],
  ["PROCESSING", "Being issued now; if it stays, the attempt was cut off."],
  ["ISSUED", "Generated and emailed."],
  ["DECLINED", "The office refused it, with a reason on the Certificates tab."],
  ["ERROR", "The last attempt failed; retry from the Certificates tab."],
  ["NONE", "This client did not ask for one."],
];
const COA_COLUMN_HELP = COA_STATUS_GLOSSARY.map(
  ([status, meaning]) => `${status} — ${meaning}`,
).join(" ");

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

/**
 * Reclassifying one response, inside its details panel.
 *
 * It lives here rather than in the table because it is the one write on a tab
 * that is otherwise a record: the dense rows stay read-only at a glance, and
 * correcting a program is a deliberate step past "Details".
 */
function ChangeProgram({ row, onDone, onError }) {
  const [services, setServices] = useState(null),
    [serviceId, setServiceId] = useState(""),
    [otherService, setOtherService] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");

  useEffect(() => {
    let stale = false;
    getAdminServices()
      .then((list) => {
        if (stale) return;
        setServices(list);
        // Starts on the program the response already carries, so the select
        // reads as "this is where it sits" rather than proposing a move.
        const current = list.find((entry) => entry.code === row.serviceCode);
        setServiceId(current?.service_id || "");
        setOtherService(row.otherService || "");
      })
      .catch((thrown) => {
        if (!stale) setError(thrown.message);
      });
    return () => {
      stale = true;
    };
  }, [row.referenceId]);

  const chosen = services?.find((entry) => entry.service_id === serviceId);
  const needsDescription = chosen?.category === "other";

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await changeResponseService({
        referenceId: row.referenceId,
        serviceId,
        otherService,
      });
      onDone(
        result.unchanged
          ? `${row.referenceId} was already filed under ${result.serviceCode}.`
          : `${row.referenceId} moved to ${result.serviceCode}.`,
      );
    } catch (thrown) {
      setError(thrown.message);
      setBusy(false);
    }
  }

  if (error && !services)
    return <div className="alert reclassify-alert">{error}</div>;
  if (!services) return <Skeleton width={260} height={38} />;

  return (
    <form className="reclassify" onSubmit={submit}>
      <label>
        Program
        <div className="select-wrap">
          <select
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
            disabled={busy}
          >
            <option value="">Choose a program…</option>
            {services.map((entry) => (
              <option key={entry.service_id} value={entry.service_id}>
                {entry.code} — {entry.name_en}
                {/* A response from an earlier quarter can belong to a program
                    since withdrawn, so those stay selectable and are marked
                    rather than hidden. */}
                {entry.active === false ? " (withdrawn)" : ""}
              </option>
            ))}
          </select>
        </div>
      </label>
      {needsDescription && (
        <label>
          Transaction
          <input
            value={otherService}
            onChange={(event) => setOtherService(event.target.value)}
            placeholder="What the client came for"
            maxLength={200}
            disabled={busy}
          />
          <small>
            Named in the report's pooled Other Services row, which is the only
            place it appears.
          </small>
        </label>
      )}
      <div className="reclassify-actions">
        <button className="mini-button primary" disabled={busy || !serviceId}>
          {busy ? "Saving…" : "Save program"}
        </button>
        <small>
          The score follows the response; SQD5 is re-read under the new
          program's fee setting. Recorded in the audit log.
        </small>
      </div>
      {error && <div className="alert reclassify-alert">{error}</div>}
    </form>
  );
}

/**
 * One response's answers, in a panel at the side of the table.
 *
 * They used to open as a block between two rows, which pushed the rest of the
 * table down and lost the row it belonged to. Not modal: the table stays
 * usable, and choosing another reference shows that response here instead.
 * Focus moves to the heading on opening, and goes back to whatever opened the
 * panel when it is closed from inside; Escape inside the panel closes it.
 */
function ResponseDetails({ row, onClose, children }) {
  const title = useRef(null),
    returnTo = useRef(null);

  useEffect(() => {
    // Back to the row's reference on closing, however the panel was opened:
    // the Details button is out of the tab order, and Safari does not focus a
    // button it clicks, so what had focus then may be nowhere near the row.
    returnTo.current = document.querySelector(
      '.ref-toggle[aria-controls="response-details"]',
    );
    title.current?.focus();
  }, [row.referenceId]);

  // Only when the panel itself is closed. It also goes when a search or a page
  // change clears it, and focus taken back to the row then would be pulled out
  // of the search box, or onto a row about to be replaced.
  const close = () => {
    const target = returnTo.current;
    onClose();
    requestAnimationFrame(() => {
      if (target?.isConnected) target.focus();
    });
  };

  const client =
    [row.clientType, row.sex, row.age].filter(Boolean).join(" · ") || "—";
  return (
    <section
      id="response-details"
      className="response-sheet"
      role="dialog"
      aria-labelledby="response-details-title"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        close();
      }}
    >
      <header>
        <div>
          <h2 id="response-details-title" tabIndex={-1} ref={title}>
            {row.referenceId}
          </h2>
          <p>{[row.email, row.transactionDate].filter(Boolean).join(" · ")}</p>
        </div>
        <button
          type="button"
          className="sheet-close"
          aria-label="Close details"
          onClick={close}
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="sheet-body">
        <dl className="sheet-facts">
          <dt>Program</dt>
          <dd>
            <strong>{row.serviceCode}</strong> —{" "}
            {row.otherService || row.serviceName}
          </dd>
          <dt>Client</dt>
          <dd>{client}</dd>
          <dt>Region</dt>
          <dd>{row.region || "—"}</dd>
          <dt>Overall</dt>
          <dd>{row.overall ? row.overall.toFixed(2) : "—"}</dd>
          <dt>Certificate</dt>
          <dd>
            <span
              className={`status-pill ${row.coaStatus === "ISSUED" ? "enabled" : row.coaStatus === "REQUESTED" ? "pending" : "disabled"}`}
            >
              {row.coaStatus || "NONE"}
            </span>
          </dd>
        </dl>
        <section>
          <h3>Citizen's Charter</h3>
          <div className="answer-grid">
            {CC_QUESTIONS.map((question) => (
              <span key={question.id}>
                <b>{question.number}</b>
                {row[question.id] || "—"}
              </span>
            ))}
          </div>
        </section>
        <section>
          <h3>Service quality</h3>
          <ul className="sqd-answers">
            {SQD_QUESTIONS.map((question) => (
              <li key={question.id}>
                <span>
                  <b>{question.number}</b>{" "}
                  {question.dimension || "Overall satisfaction"}
                </span>
                <strong>{row[question.id] || "—"}</strong>
              </li>
            ))}
          </ul>
        </section>
        {row.suggestions && (
          <section>
            <h3>Suggestion</h3>
            <p className="answer-suggestion">{row.suggestions}</p>
          </section>
        )}
        <div className="sheet-reclassify">{children}</div>
      </div>
    </section>
  );
}

function ResponsesPanel({ onError }) {
  const [data, setData] = useState({ rows: [], total: 0, offset: 0 }),
    [query, setQuery] = useState(""),
    [draftQuery, setDraftQuery] = useState(""),
    [offset, setOffset] = useState(0),
    [loading, setLoading] = useState(true),
    [notice, setNotice] = useState(""),
    [reclassifying, setReclassifying] = useState(""),
    [reload, setReload] = useState(0),
    [failed, setFailed] = useState(false),
    [expanded, setExpanded] = useState("");
  const listTop = useRef(null);

  // The sheet is the source of truth for both filtering and paging, so the
  // count on screen is the real number of matches rather than however many
  // rows happened to fit in the last fetch.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    getAdminResponses({ query, offset, limit: PAGE_SIZE })
      .then((result) => {
        if (stale) return;
        setData(result);
        if (failed) onError(null);
        setFailed(false);
      })
      .catch((thrown) => {
        // A superseded request must not raise a banner — or, since
        // handleError signs out on authorization-shaped messages, drop the
        // administrator to the login screen mid-navigation.
        if (stale) return;
        // The rows on screen answer the search or page before this one; under
        // "Matching responses" they read as what the new search found.
        setData({ rows: [], total: 0, offset: 0 });
        setFailed(true);
        onError(thrown);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [query, offset, reload]);

  // A page past the end, when a reload finds fewer records than before (a
  // response moved out of a search), goes back to the last page there is.
  useEffect(() => {
    if (!loading && data.total && offset >= data.total)
      setOffset(Math.floor((data.total - 1) / PAGE_SIZE) * PAGE_SIZE);
  }, [loading, data.total, offset]);

  const rows = data.rows || [];
  const openRow = rows.find((row) => row.referenceId === expanded);
  const total = data.total || 0;
  const firstShown = total ? offset + 1 : 0;
  const lastShown = Math.min(offset + PAGE_SIZE, total);

  const search = (event) => {
    event.preventDefault();
    setExpanded("");
    setReclassifying("");
    setNotice("");
    setOffset(0);
    setQuery(draftQuery.trim());
  };

  // Collapsing a row puts away the form inside it, so reopening it later does
  // not resume a half-made change against a row that may since have moved.
  const toggleDetails = (referenceId) => {
    setNotice("");
    setReclassifying("");
    setExpanded(expanded === referenceId ? "" : referenceId);
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
          <Skeleton width={300} height={38} />
        </div>
        <SkeletonTable
          columns={RESPONSE_COLUMNS}
          rows={Math.min(PAGE_SIZE, 8)}
        />
      </SkeletonRegion>
    );
  if (failed)
    return (
      <LoadFailed
        what={query ? "The search results" : "The responses"}
        onRetry={() => setReload((value) => value + 1)}
      />
    );
  return (
    // The refreshing treatment goes on the results below, never on this
    // section: it disables pointer events, and putting it here meant the
    // search box dimmed and stopped accepting input for the duration of the
    // search it had just started.
    <section className="table-card" ref={listTop}>
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
            align="end"
            placement="bottom"
            text="Searches every record, not just the page on screen"
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
      <details className="info-details">
        <summary>What the COA statuses mean</summary>
        <dl>
          {COA_STATUS_GLOSSARY.map(([status, meaning]) => (
            <React.Fragment key={status}>
              <dt>{status}</dt>
              <dd>{meaning}</dd>
            </React.Fragment>
          ))}
        </dl>
      </details>
      {notice && (
        <div className="notice reclassify-notice" role="status">
          {notice}
        </div>
      )}
      <div className={`table-scroll${loading ? " is-refreshing" : ""}`}>
        <table>
          <thead>
            <tr>
              {RESPONSE_COLUMNS.map((column, index) => (
                <th
                  key={index}
                  className={column === "Overall" ? "numeric" : undefined}
                >
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
              <tr
                key={row.referenceId}
                className={
                  expanded === row.referenceId ? "row-open" : undefined
                }
              >
                <td>
                  {/* The reference opens the row. On a phone the table
                        scrolls inside its card and Details is the last of
                        eight columns, out of view; the reference is the first
                        thing on the row. */}
                  <button
                    type="button"
                    className="ref-toggle"
                    aria-expanded={expanded === row.referenceId}
                    aria-controls={
                      expanded === row.referenceId
                        ? "response-details"
                        : undefined
                    }
                    onClick={() => toggleDetails(row.referenceId)}
                  >
                    {row.referenceId}
                    <ChevronRight aria-hidden="true" />
                  </button>
                  <small>{row.email}</small>
                </td>
                <td>{row.transactionDate}</td>
                <td className="program-cell">
                  <strong>{row.serviceCode}</strong>
                  <small title={row.otherService || row.serviceName}>
                    {row.otherService || row.serviceName}
                  </small>
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
                  {/* Kept for the mouse, where the end of the row is where
                        people look for it; out of the tab order, since the
                        reference already does this and a second stop per row
                        is a hundred more presses of Tab. */}
                  <button
                    className="mini-button"
                    tabIndex={-1}
                    aria-expanded={expanded === row.referenceId}
                    onClick={() => toggleDetails(row.referenceId)}
                  >
                    {expanded === row.referenceId ? "Hide" : "Details"}
                  </button>
                </td>
              </tr>
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
      {openRow && (
        <ResponseDetails
          row={openRow}
          onClose={() => toggleDetails(openRow.referenceId)}
        >
          {reclassifying === openRow.referenceId ? (
            <ChangeProgram
              row={openRow}
              onError={onError}
              onDone={(message) => {
                setReclassifying("");
                setNotice(message);
                // The row on screen is from before the move.
                setReload((value) => value + 1);
              }}
            />
          ) : (
            <button
              className="mini-button"
              onClick={() => {
                setNotice("");
                setReclassifying(openRow.referenceId);
              }}
            >
              <ListChecks size={12} /> Change program
            </button>
          )}
        </ResponseDetails>
      )}
      <Pager
        page={offset / PAGE_SIZE + 1}
        pageSize={PAGE_SIZE}
        total={total}
        disabled={loading}
        listRef={listTop}
        onPage={(page) => {
          setExpanded("");
          setReclassifying("");
          setOffset((page - 1) * PAGE_SIZE);
        }}
      />
    </section>
  );
}
