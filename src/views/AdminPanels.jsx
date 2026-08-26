import React, { useEffect, useRef, useState } from "react";
import {
  Check,
  ClipboardList,
  Download,
  ExternalLink,
  FileSignature,
  FileSpreadsheet,
  RefreshCw,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import {
  cacheKeys,
  generateCoa,
  generateReport,
  getAdminAuditLog,
  getAdminServices,
  getAdminSettings,
  getAdminUsers,
  getCoaRequests,
  getGeneratedReports,
  getServiceStats,
  saveAdminService,
  saveAdminSettings,
  saveAdminUser,
  saveCoaDetails,
  saveServiceStats,
  seedCache,
  uploadCoaTemplate,
  uploadSignature,
} from "../lib/api";
import { COURTESY_TITLES, OTHER_SERVICE_CODE } from "../lib/csm";
import { describePeriod } from "./PeriodPicker";
import {
  Skeleton,
  SkeletonLines,
  SkeletonRegion,
  SkeletonTable,
  Tip,
} from "./ui";

/** Shared notice strip so every panel reports success and failure the same way. */
function Feedback({ error, notice }) {
  return (
    <>
      {error && <div className="alert">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
    </>
  );
}

// ------------------------- Certificates of Appearance ------------------------

const COA_STATUSES = ["REQUESTED", "ISSUED", "ERROR"];

/** What each filter actually selects, since the button labels are terse. */
const COA_FILTER_HELP = {
  REQUESTED: "Clients who asked for a certificate that has not been issued yet",
  ISSUED: "Certificates already generated and emailed to the client",
  ERROR: "Attempts that failed. Check the details, then try issuing again",
};

/**
 * One key per unresolved issuance attempt, held in sessionStorage rather than
 * in component state. The attempt this protects is the one that timed out, and
 * the first thing an administrator does after a timeout is reload the page or
 * switch tabs — either of which would discard an in-memory key and let the
 * next click mint a second certificate and email the client twice.
 */
const ISSUE_KEY_STORE = "csm_coa_issue_keys";

const readIssueKeys = () => {
  try {
    return JSON.parse(sessionStorage.getItem(ISSUE_KEY_STORE) || "{}") || {};
  } catch {
    return {};
  }
};
const writeIssueKeys = (keys) => {
  try {
    sessionStorage.setItem(ISSUE_KEY_STORE, JSON.stringify(keys));
  } catch {
    /* a full or blocked store only costs us the retry guard, not the issuance */
  }
};
const issueKeyFor = (referenceId) => {
  const keys = readIssueKeys();
  if (!keys[referenceId]) {
    keys[referenceId] = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `coa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    writeIssueKeys(keys);
  }
  return keys[referenceId];
};
const clearIssueKey = (referenceId) => {
  const keys = readIssueKeys();
  if (keys[referenceId]) {
    delete keys[referenceId];
    writeIssueKeys(keys);
  }
};

/** Named once, so the placeholder table and the real one cannot drift apart. */
const COA_COLUMNS = [
  "Client",
  "Agency",
  "Purpose",
  "Date covered",
  "Status",
  "Actions",
];

/**
 * Said once on the header rather than on each row.
 *
 * A tooltip inside .table-scroll is clipped by it — the container needs
 * overflow-x for wide tables, which forces overflow-y, so a bubble is cut off
 * at the top row or the bottom one whichever way it opens. These three
 * explanations were identical on every row anyway.
 */
const COA_ACTIONS_HELP =
  "Edit changes the wording printed on the certificate. " +
  "PDF opens the issued file in the office's Drive — the client has their own copy by email. " +
  "Generate builds the PDF and emails it as an attachment; Reissue does it again, and the earlier certificate stays valid.";

export function CertificatePanel({ onError }) {
  const [rows, setRows] = useState([]),
    [status, setStatus] = useState("REQUESTED"),
    [loading, setLoading] = useState(true),
    [editing, setEditing] = useState(null),
    [busyId, setBusyId] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");

  // Tracks the filter a response belongs to, so switching tabs quickly cannot
  // leave the slower request's rows sitting under the newer tab.
  const wanted = useRef(status);
  const load = (nextStatus = status) => {
    wanted.current = nextStatus;
    setLoading(true);
    return getCoaRequests({ status: nextStatus })
      .then((result) => {
        if (wanted.current === nextStatus) setRows(result);
      })
      .catch((thrown) => {
        if (wanted.current === nextStatus) onError(thrown);
      })
      .finally(() => {
        if (wanted.current === nextStatus) setLoading(false);
      });
  };
  useEffect(() => {
    load(status);
  }, [status]);

  async function issue(row) {
    if (busyId) return;
    setBusyId(row.referenceId);
    setError("");
    setNotice("");
    try {
      const result = await generateCoa(
        row.referenceId,
        issueKeyFor(row.referenceId),
      );
      // Resolved, so a later deliberate reissue counts as a new attempt.
      clearIssueKey(row.referenceId);
      setNotice(
        `${result.duplicate ? "Already issued" : "Certificate issued"} for ${row.coaName}. ${result.emailStatus || ""}`.trim(),
      );
      await load();
    } catch (issueError) {
      // The key survives so the next click is recognised as the same attempt.
      setError(issueError.message);
    } finally {
      setBusyId("");
    }
  }

  /**
   * Closes the dialog and shows the edited row straight away.
   *
   * These are the words that get printed on someone's certificate, so the
   * person editing them wants to see the result, not a spinner. On failure the
   * row goes back to what it was and the dialog reopens with the edit intact,
   * so nothing typed is lost to a failed write.
   */
  async function saveDetails(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    const draft = editing;
    const previous = rows;
    setRows((current) =>
      current.map((row) =>
        row.referenceId === draft.referenceId ? { ...row, ...draft } : row,
      ),
    );
    setEditing(null);
    try {
      await saveCoaDetails(draft);
      setNotice("Certificate details saved.");
      await load();
    } catch (saveError) {
      setRows(previous);
      setEditing(draft);
      setError(saveError.message);
    }
  }

  return (
    <section className="stacked">
      <div className="filter-bar">
        {COA_STATUSES.map((option) => (
          <Tip
            key={option}
            placement="bottom"
            align="start"
            text={COA_FILTER_HELP[option] || option}
          >
            <button
              className={status === option ? "active" : ""}
              onClick={() => setStatus(option)}
            >
              {option === "REQUESTED"
                ? "Awaiting release"
                : option === "ISSUED"
                  ? "Issued"
                  : "Failed"}
            </button>
          </Tip>
        ))}
        <Tip
          className="push-right"
          placement="bottom"
          align="end"
          text="Re-read the list from the sheet"
        >
          <button
            className="mini-button"
            onClick={() => load()}
            disabled={loading}
          >
            <RefreshCw size={13} /> {loading ? "Loading…" : "Refresh"}
          </button>
        </Tip>
      </div>

      <Feedback error={error} notice={notice} />

      {loading && !rows.length ? (
        <SkeletonRegion
          label="Loading certificate requests"
          className="table-card"
        >
          <SkeletonTable columns={COA_COLUMNS} rows={5} />
        </SkeletonRegion>
      ) : (
        <div className={`table-card${loading ? " is-refreshing" : ""}`}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {COA_COLUMNS.map((column, index) => (
                    <th key={index}>
                      {column === "Actions" ? (
                        <Tip
                          align="end"
                          placement="bottom"
                          text={COA_ACTIONS_HELP}
                        >
                          <span tabIndex={0} className="th-help">
                            Actions
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
                  <tr key={row.referenceId}>
                    <td>
                      <strong>
                        {row.coaTitle} {row.coaName}
                      </strong>
                      <small>
                        {row.referenceId} · {row.email}
                      </small>
                    </td>
                    <td>{row.coaAgency}</td>
                    <td className="wrap-cell">{row.coaPurpose}</td>
                    <td>{row.coaDateCoverage}</td>
                    <td>
                      <span
                        className={`status-pill ${row.coaStatus === "ISSUED" ? "enabled" : row.coaStatus?.startsWith("ERROR") ? "failed" : "pending"}`}
                      >
                        {row.coaStatus}
                      </span>
                      {/* No tooltip: `td small` wraps, so the whole message is already on
                        screen. A bubble repeating the text under the cursor
                        would say nothing new. */}
                      {row.coaError && <small>{row.coaError}</small>}
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="mini-button"
                          onClick={() => setEditing({ ...row })}
                        >
                          Edit
                        </button>
                        {row.coaLink && (
                          <a
                            className="mini-button"
                            href={row.coaLink}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <ExternalLink size={12} /> PDF
                          </a>
                        )}
                        <button
                          className="mini-button primary"
                          disabled={busyId === row.referenceId}
                          onClick={() => issue(row)}
                        >
                          <FileSignature size={12} />
                          {busyId === row.referenceId
                            ? "Working…"
                            : row.coaStatus === "ISSUED"
                              ? "Reissue"
                              : "Generate"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rows.length && !loading && (
                  <tr>
                    <td colSpan={6} className="empty-cell">
                      No certificate requests with this status.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form
            className="modal"
            onClick={(event) => event.stopPropagation()}
            onSubmit={saveDetails}
          >
            <header>
              <h2>Certificate details</h2>
              <button type="button" onClick={() => setEditing(null)}>
                <X />
              </button>
            </header>
            <div className="modal-body">
              <label>
                Title
                <select
                  value={editing.coaTitle || "Mr."}
                  onChange={(event) =>
                    setEditing({ ...editing, coaTitle: event.target.value })
                  }
                >
                  {COURTESY_TITLES.map((title) => (
                    <option key={title}>{title}</option>
                  ))}
                </select>
              </label>
              <label>
                Name of client
                <input
                  required
                  value={editing.coaName || ""}
                  onChange={(event) =>
                    setEditing({ ...editing, coaName: event.target.value })
                  }
                />
              </label>
              <label className="full">
                Agency
                <input
                  required
                  value={editing.coaAgency || ""}
                  onChange={(event) =>
                    setEditing({ ...editing, coaAgency: event.target.value })
                  }
                />
              </label>
              <label className="full">
                Purpose
                <input
                  required
                  value={editing.coaPurpose || ""}
                  onChange={(event) =>
                    setEditing({ ...editing, coaPurpose: event.target.value })
                  }
                />
                <small>Completes “…for the purpose of ___.”</small>
              </label>
              <label>
                Date from
                <input
                  type="date"
                  required
                  value={editing.coaDateFrom || ""}
                  onChange={(event) =>
                    setEditing({ ...editing, coaDateFrom: event.target.value })
                  }
                />
              </label>
              <label>
                Date to (optional)
                <input
                  type="date"
                  min={editing.coaDateFrom || ""}
                  value={editing.coaDateTo || ""}
                  onChange={(event) =>
                    setEditing({ ...editing, coaDateTo: event.target.value })
                  }
                />
              </label>
            </div>
            <footer>
              <button
                type="button"
                className="button ghost"
                onClick={() => setEditing(null)}
              >
                Cancel
              </button>
              <Tip
                align="end"
                text="Save these details. They are what the certificate will print."
              >
                <button className="button primary">
                  <Check size={16} /> Save details
                </button>
              </Tip>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}

// -------------------------------- Reports ------------------------------------

export function ReportsPanel({ period, onError }) {
  const [stats, setStats] = useState([]),
    [reports, setReports] = useState([]),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [generating, setGenerating] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");

  // Guarded: switching period twice quickly must not let the abandoned request
  // overwrite the current one, nor raise an error for results already gone.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setNotice("");
    Promise.all([getServiceStats(period), getGeneratedReports()])
      .then(([serviceStats, generated]) => {
        if (stale) return;
        setStats(serviceStats);
        setReports(generated);
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

  const updateStat = (serviceId, key, value) =>
    setStats((rows) =>
      rows.map((row) =>
        row.service_id === serviceId ? { ...row, [key]: value } : row,
      ),
    );

  async function persist() {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveServiceStats(period, stats);
      setNotice("Client and transaction counts saved.");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function build() {
    setGenerating(true);
    setError("");
    setNotice("");
    try {
      // Persist first: the workbook reads these counts from the sheet, so an
      // unsaved edit would silently not appear in the generated report.
      await saveServiceStats(period, stats);
      const report = await generateReport(period);
      setNotice(
        `Report ready: ${report.name}. ${report.accessNote || ""}`.trim(),
      );
      setReports(await getGeneratedReports());
      // Opening is a convenience, not the record — the workbook is listed
      // below either way, and accessNote explains a refused share.
      if (report.url && !report.accessNote)
        window.open(report.url, "_blank", "noreferrer");
    } catch (buildError) {
      setError(buildError.message);
    } finally {
      setGenerating(false);
    }
  }

  if (loading)
    return (
      <SkeletonRegion label="Loading report inputs" className="stacked">
        <article className="panel">
          <div className="panel-head">
            <div>
              <Skeleton width={196} height={16} />
              <Skeleton
                width={300}
                height={11}
                style={{ display: "block", marginTop: 9 }}
              />
            </div>
            <Skeleton width={150} height={40} radius={11} />
          </div>
          <SkeletonTable
            columns={["Program", "Clients", "Transactions"]}
            rows={5}
          />
        </article>
        <article className="panel">
          <div className="panel-head">
            <Skeleton width={168} height={16} />
          </div>
          <SkeletonTable
            columns={["Report", "Period", "Generated", ""]}
            rows={3}
          />
        </article>
      </SkeletonRegion>
    );

  return (
    <section className="stacked">
      <Feedback error={error} notice={notice} />

      <article className="panel">
        <div className="panel-head">
          <div>
            <h2>Counts for {describePeriod(period)}</h2>
            <p>
              Respondents come from the survey. Clients served and volume of
              transactions are office records, so enter them here before
              generating the workbook.
            </p>
          </div>
          <Tip
            align="end"
            text="Store these counts against the selected period. The report reads them from the sheet."
          >
            <button
              className="button secondary"
              onClick={persist}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save counts"}
            </button>
          </Tip>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Program</th>
                <th>Respondents</th>
                <th>No. of clients</th>
                <th>Volume of transactions</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.service_id}>
                  <td>
                    <strong>{row.code}</strong>
                    <small>{row.name_en}</small>
                  </td>
                  <td>{row.respondents}</td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      className="cell-input"
                      value={row.clients ?? ""}
                      onChange={(event) =>
                        updateStat(
                          row.service_id,
                          "clients",
                          event.target.value,
                        )
                      }
                      aria-label={`Clients served for ${row.code}`}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      className="cell-input"
                      value={row.transactions ?? ""}
                      onChange={(event) =>
                        updateStat(
                          row.service_id,
                          "transactions",
                          event.target.value,
                        )
                      }
                      aria-label={`Transactions for ${row.code}`}
                    />
                  </td>
                  <td>
                    <input
                      className="cell-input wide"
                      value={row.remarks ?? ""}
                      onChange={(event) =>
                        updateStat(
                          row.service_id,
                          "remarks",
                          event.target.value,
                        )
                      }
                      aria-label={`Remarks for ${row.code}`}
                    />
                  </td>
                </tr>
              ))}
              {!stats.length && (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    No programs configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      <article className="panel generate-panel">
        <div>
          <h2>Generate the CSM Summary Report</h2>
          <p>
            Produces an Excel workbook in the ARTA layout: a CSM Summary sheet,
            a DATA sheet, and one worksheet per program for{" "}
            <b>{describePeriod(period)}</b>.
          </p>
        </div>
        <Tip
          align="end"
          text="Saves the counts above first, then builds the workbook. This can take a minute."
        >
          <button
            className="button primary large"
            onClick={build}
            disabled={generating}
          >
            <FileSpreadsheet size={18} />
            {generating ? "Generating…" : "Generate report"}
          </button>
        </Tip>
      </article>

      <article className="panel">
        <div className="panel-head">
          <h2>Generated reports</h2>
          <p>{reports.length} workbooks</p>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Report</th>
                <th>Period</th>
                <th>Generated</th>
                <th>By</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.report_id}>
                  <td>
                    <strong>{report.name}</strong>
                  </td>
                  <td>{report.period_label}</td>
                  <td>{report.created_at}</td>
                  <td>{report.created_by}</td>
                  <td>
                    <a
                      className="mini-button"
                      href={report.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={12} /> Open
                    </a>
                  </td>
                </tr>
              ))}
              {!reports.length && (
                <tr>
                  <td colSpan={5} className="empty-cell">
                    No reports generated yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}

// ------------------------------ Main programs --------------------------------

const blankService = {
  service_id: "",
  code: "",
  name_en: "",
  name_tl: "",
  category: "main",
  active: true,
  has_fees: false,
  sort_order: "",
};

export function ServicesPanel({ onError }) {
  const [services, setServices] = useState([]),
    [loading, setLoading] = useState(true),
    [form, setForm] = useState(blankService),
    [saving, setSaving] = useState(false),
    [pendingId, setPendingId] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");

  const load = () => getAdminServices().then(setServices).catch(onError);
  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  /**
   * Shows the change in the list before the server has confirmed it.
   *
   * Apps Script takes about a second to write and another to read back, so
   * this used to be: press Add, watch an unchanged list, wait, watch it
   * change. The row now appears at once and is marked as still saving. If the
   * write fails the list is put back exactly as it was and the form is
   * refilled, so nothing is lost and nothing pretends to have been saved.
   */
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");

    const previous = services;
    const draft = form;
    // A provisional id for a new row, replaced by the real one on confirmation.
    const optimisticId = draft.service_id || `pending-${Date.now()}`;
    const optimistic = { ...draft, service_id: optimisticId };
    setServices((current) =>
      current.some((service) => service.service_id === optimisticId)
        ? current.map((service) =>
            service.service_id === optimisticId ? optimistic : service,
          )
        : [...current, optimistic],
    );
    setPendingId(optimisticId);
    setForm(blankService);

    try {
      await saveAdminService(draft);
      setNotice(draft.service_id ? "Program updated." : "Program added.");
      // Read back rather than patching the provisional row in place: the
      // server assigns the id and the sort order, and the list is ordered by
      // the latter.
      await load();
    } catch (saveError) {
      setServices(previous);
      setForm(draft);
      setError(saveError.message);
    } finally {
      setPendingId("");
      setSaving(false);
    }
  }

  return (
    <section className="superadmin-grid">
      <form className="panel" onSubmit={save}>
        <div className="panel-head">
          <div>
            <h2>{form.service_id ? "Edit program" : "Add a main program"}</h2>
            <p>
              Main programs get their own worksheet and their own row in the CSM
              Summary Report.
            </p>
          </div>
          {form.service_id && (
            <button
              type="button"
              className="button ghost"
              onClick={() => setForm(blankService)}
            >
              Cancel
            </button>
          )}
        </div>
        <Feedback error={error} notice={notice} />
        <label>
          Short code <b>*</b>
          <input
            required
            maxLength={24}
            value={form.code}
            onChange={(event) =>
              setForm({ ...form, code: event.target.value.toUpperCase() })
            }
            placeholder="SIAP 3"
          />
          <small>
            Used as the report row label and worksheet name. Keep it short and
            stable — changing it starts a new series in the report.
          </small>
        </label>
        <label>
          Name (English) <b>*</b>
          <textarea
            required
            value={form.name_en}
            onChange={(event) =>
              setForm({ ...form, name_en: event.target.value })
            }
            placeholder="Application for …"
          />
        </label>
        <label>
          Name (Tagalog)
          <textarea
            value={form.name_tl}
            onChange={(event) =>
              setForm({ ...form, name_tl: event.target.value })
            }
            placeholder="Aplikasyon para sa …"
          />
          <small>Shown when a client switches the form to Tagalog.</small>
        </label>
        <div className="field-grid">
          <label>
            Category
            <select
              value={form.category}
              onChange={(event) =>
                setForm({ ...form, category: event.target.value })
              }
              disabled={form.code === OTHER_SERVICE_CODE}
            >
              <option value="main">Main program</option>
              <option value="other">Other services</option>
            </select>
          </label>
          <label>
            Sort order
            <input
              type="number"
              min="0"
              value={form.sort_order}
              onChange={(event) =>
                setForm({ ...form, sort_order: event.target.value })
              }
              placeholder="10"
            />
          </label>
        </div>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) =>
              setForm({ ...form, active: event.target.checked })
            }
          />{" "}
          Offered on the client form
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={form.has_fees}
            onChange={(event) =>
              setForm({ ...form, has_fees: event.target.checked })
            }
          />{" "}
          This program charges a fee
        </label>
        <small className="field-note">
          Only programs that charge a fee are asked SQD5 — “I paid a reasonable
          amount of fees for my transaction.” Everyone else is recorded as N/A,
          which the report excludes from every average rather than counting as
          zero. Clients of a program that does charge one cannot answer N/A —
          everybody who transacts there pays.
        </small>
        <button className="button primary" disabled={saving}>
          {saving
            ? "Saving…"
            : form.service_id
              ? "Update program"
              : "Add program"}
        </button>
      </form>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Configured programs</h2>
            <p>
              {loading
                ? "Loading…"
                : `${services.length} ${services.length === 1 ? "entry" : "entries"}`}
            </p>
          </div>
        </div>
        {loading ? (
          <SkeletonTable
            columns={["Program", "Category", "Status", ""]}
            rows={5}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Program</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {services.map((service) => {
                  const pending = service.service_id === pendingId;
                  return (
                    <tr
                      key={service.service_id}
                      className={pending ? "row-pending" : ""}
                    >
                      <td>
                        <strong>{service.code}</strong>
                        <small>{service.name_en}</small>
                      </td>
                      <td>
                        {service.category === "main" ? "Main program" : "Other"}
                        {service.has_fees && <small>Charges a fee</small>}
                      </td>
                      <td>
                        {pending ? (
                          <span className="status-pill pending">Saving…</span>
                        ) : (
                          <Tip
                            text={
                              service.active
                                ? "Offered on the client form."
                                : "Hidden from the client form. Existing responses keep it."
                            }
                          >
                            <span
                              tabIndex={0}
                              className={`status-pill ${service.active ? "enabled" : "disabled"}`}
                            >
                              {service.active ? "Active" : "Hidden"}
                            </span>
                          </Tip>
                        )}
                      </td>
                      <td>
                        <button
                          className="mini-button"
                          disabled={pending}
                          onClick={() =>
                            setForm({
                              ...service,
                              has_fees: service.has_fees === true,
                              sort_order: service.sort_order ?? "",
                            })
                          }
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {!services.length && (
                  <tr>
                    <td colSpan={4} className="empty-cell">
                      No programs configured yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

// -------------------------------- Settings -----------------------------------

/**
 * No placeholder text. These held named members of staff as examples, which put
 * real people's names into every empty field — an unset signatory read as a set
 * one at a glance, and the wrong name would have gone unnoticed until it was
 * printed on a certificate. The labels already say what each field is.
 */
const SETTING_FIELDS = [
  ["office_name", "Office name"],
  ["coa_signatory", "Certificate signatory"],
  ["coa_designation", "Signatory designation"],
  ["report_prepared_by", "Report prepared by"],
  ["report_prepared_title", "Prepared by — position"],
  ["report_reviewed_by", "Report reviewed by"],
  ["report_reviewed_title", "Reviewed by — position"],
  ["report_approved_by", "Report approved by"],
  ["report_approved_title", "Approved by — position"],
];

/** Whose name signs a certificate, and the files it is built from. */
const SIGNING_FIELDS = ["coa_signatory", "coa_designation"];

export function SettingsPanel({ onError, canSign = false }) {
  const [settings, setSettings] = useState({}),
    [loading, setLoading] = useState(true),
    [saving, setSaving] = useState(false),
    [uploading, setUploading] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");

  useEffect(() => {
    getAdminSettings()
      .then(setSettings)
      .catch(onError)
      .finally(() => setLoading(false));
  }, []);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    // What is on screen is already what was typed, so there is nothing to
    // render optimistically — but the previous values are kept so a failure
    // can put them back rather than leaving the form showing values the
    // server rejected as though they had been accepted.
    const previous = settings;
    try {
      const stored = await saveAdminSettings(settings);
      setSettings(stored);
      seedCache(cacheKeys.settings, stored);
      setNotice("Settings saved.");
    } catch (saveError) {
      setSettings(previous);
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }

  async function upload(kind, file) {
    if (!file) return;
    setUploading(kind);
    setError("");
    setNotice("");
    try {
      const result =
        kind === "template"
          ? await uploadCoaTemplate(file)
          : await uploadSignature(file);
      const next = {
        ...settings,
        [kind === "template" ? "coa_template_id" : "coa_signature_id"]:
          result.id,
        [kind === "template" ? "coa_template_name" : "coa_signature_name"]:
          result.name,
      };
      const stored = await saveAdminSettings(next);
      setSettings(stored);
      seedCache(cacheKeys.settings, stored);
      setNotice(`${result.name} uploaded.`);
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setUploading("");
    }
  }

  if (loading)
    return (
      <SkeletonRegion label="Loading office settings" className="stacked">
        <article className="panel">
          <div className="panel-head">
            <div>
              <Skeleton width={186} height={16} />
              <Skeleton
                width={330}
                height={11}
                style={{ display: "block", marginTop: 9 }}
              />
            </div>
            <Skeleton width={124} height={40} radius={11} />
          </div>
          <div className="settings-grid">
            {Array.from({ length: 9 }, (_, index) => (
              <div key={index}>
                <Skeleton width="52%" height={11} />
                <Skeleton
                  height={44}
                  radius={11}
                  style={{ display: "block", marginTop: 8, width: "100%" }}
                />
              </div>
            ))}
          </div>
        </article>
        <article className="panel">
          <div className="panel-head">
            <Skeleton width={210} height={16} />
          </div>
          <SkeletonLines lines={3} />
        </article>
      </SkeletonRegion>
    );

  return (
    <form className="stacked" onSubmit={save}>
      <Feedback error={error} notice={notice} />
      <article className="panel">
        <div className="panel-head">
          <div>
            <h2>Office and signatories</h2>
            <p>
              These values fill the certificate placeholders and the report's
              prepared / reviewed / approved block.
            </p>
          </div>
          <button className="button primary" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
        <div className="settings-grid">
          {SETTING_FIELDS.map(([key, label]) => {
            const locked = SIGNING_FIELDS.includes(key) && !canSign;
            return (
              <label key={key}>
                {label}
                <input
                  value={settings[key] || ""}
                  disabled={locked}
                  onChange={(event) =>
                    setSettings({ ...settings, [key]: event.target.value })
                  }
                />
                {locked && <small>Only a superadmin can change this.</small>}
              </label>
            );
          })}
        </div>
      </article>

      <article className="panel">
        <div className="panel-head">
          <div>
            <h2>Certificate of Appearance template</h2>
            <p>
              Upload the Word template. Supported placeholders:{" "}
              <code>
                {
                  "{{title}} {{name_of_client}} {{agency}} {{purpose}} {{date_coverage}} {{date_issued}} {{signatory}} {{designation}} {{Timestamp}}"
                }
              </code>
              , plus the optional <code>{"{{VerificationCode}}"}</code> and{" "}
              <code>{"{{QRCode}}"}</code>.
            </p>
          </div>
        </div>
        <div className="upload-row">
          <label className="upload">
            <Upload />
            <div>
              <strong>
                {settings.coa_template_name || "No template uploaded"}
              </strong>
              <span>
                {uploading === "template"
                  ? "Uploading…"
                  : "DOCX or Google Doc, up to 10 MB"}
              </span>
            </div>
            <input
              type="file"
              accept=".docx,.doc"
              disabled={!canSign}
              onChange={(event) => upload("template", event.target.files?.[0])}
            />
          </label>
          <label className="upload">
            <FileSignature />
            <div>
              <strong>
                {settings.coa_signature_name || "No e-signature uploaded"}
              </strong>
              <span>
                {uploading === "signature"
                  ? "Uploading…"
                  : "PNG, JPG, or WebP up to 2 MB — fills {{Signature}}"}
              </span>
            </div>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!canSign}
              onChange={(event) => upload("signature", event.target.files?.[0])}
            />
          </label>
        </div>
      </article>
    </form>
  );
}

// --------------------------------- Users -------------------------------------

const blankUser = {
  user_id: "",
  name: "",
  role: "admin",
  email: "",
  active: true,
  password: "",
};

export function UsersPanel({ onError }) {
  const [users, setUsers] = useState([]),
    [loading, setLoading] = useState(true),
    [form, setForm] = useState(blankUser),
    [saving, setSaving] = useState(false),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const load = () => getAdminUsers().then(setUsers).catch(onError);
  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);
  // Deliberately not optimistic. Everywhere else an optimistic row that fails
  // to save is an inconvenience; here it would show an account as created,
  // or as deactivated, when it is neither — and someone would act on that.
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      await saveAdminUser(form);
      setNotice(form.user_id ? "User updated." : "User added.");
      setForm(blankUser);
      await load();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="superadmin-grid">
      <form className="panel" onSubmit={save}>
        <div className="panel-head">
          <div>
            <h2>{form.user_id ? "Edit user" : "Add user"}</h2>
            <p>Passwords are stored only as salted hashes.</p>
          </div>
          {form.user_id && (
            <button
              type="button"
              className="button ghost"
              onClick={() => setForm(blankUser)}
            >
              Cancel
            </button>
          )}
        </div>
        <Feedback error={error} notice={notice} />
        <label>
          Name <b>*</b>
          <input
            required
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Email <b>*</b>
          <input
            required
            type="email"
            disabled={Boolean(form.user_id)}
            value={form.email}
            onChange={(event) =>
              setForm({ ...form, email: event.target.value })
            }
          />
        </label>
        <label>
          Role <b>*</b>
          <select
            value={form.role}
            onChange={(event) => setForm({ ...form, role: event.target.value })}
          >
            <option value="admin">Admin</option>
            <option value="superadmin">Superadmin</option>
          </select>
        </label>
        <label>
          {form.user_id ? "New password (optional)" : "Temporary password *"}
          <input
            required={!form.user_id}
            minLength={12}
            type="password"
            value={form.password}
            onChange={(event) =>
              setForm({ ...form, password: event.target.value })
            }
            autoComplete="new-password"
          />
          <small>At least 12 characters.</small>
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(event) =>
              setForm({ ...form, active: event.target.checked })
            }
          />{" "}
          Active account
        </label>
        <button className="button primary" disabled={saving}>
          {saving ? "Saving…" : form.user_id ? "Update user" : "Add user"}
        </button>
      </form>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Administrator accounts</h2>
            <p>
              {loading
                ? "Loading…"
                : `${users.length} ${users.length === 1 ? "account" : "accounts"}`}
            </p>
          </div>
        </div>
        {loading ? (
          <SkeletonTable
            columns={["User", "Role", "Status", "Updated", ""]}
            rows={4}
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.user_id || user.email}>
                    <td>
                      <strong>{user.name}</strong>
                      <small>
                        {user.email}
                        <br />
                        {user.user_id}
                      </small>
                    </td>
                    <td>{user.role}</td>
                    <td>
                      <span
                        className={`status-pill ${user.active ? "enabled" : "disabled"}`}
                      >
                        {user.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td>{user.updated_at || user.created_at || "—"}</td>
                    <td>
                      <button
                        className="mini-button"
                        onClick={() => setForm({ ...user, password: "" })}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

// --------------------------------- Audit -------------------------------------

export function AuditPanel({ onError }) {
  const [data, setData] = useState(null),
    [filters, setFilters] = useState({
      action: "",
      outcome: "",
      query: "",
      limit: 200,
    }),
    [loading, setLoading] = useState(true);
  const load = async (nextFilters = filters) => {
    setLoading(true);
    try {
      setData(await getAdminAuditLog(nextFilters));
    } catch (loadError) {
      onError(loadError);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const entries = data?.entries || [];
  const failures = entries.filter(
    (entry) => entry.outcome === "FAILURE",
  ).length;
  const logins = entries.filter(
    (entry) => entry.action === "LOGIN" && entry.outcome === "SUCCESS",
  ).length;
  const updateFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    if (key !== "query") load(next);
  };
  return (
    <section className="stacked">
      <section className="stats">
        <article>
          <span>Visible events</span>
          <strong>{entries.length}</strong>
          <i className="brand">
            <ClipboardList />
          </i>
        </article>
        <article>
          <span>Successful logins</span>
          <strong>{logins}</strong>
          <i className="teal">
            <ShieldCheck />
          </i>
        </article>
        <article>
          <span>Failed actions</span>
          <strong>{failures}</strong>
          <i className="gold">
            <X />
          </i>
        </article>
      </section>
      <section className="table-card">
        <div className="table-tools">
          <div>
            <h2>Administrator audit trail</h2>
            <p>
              {data?.total || 0} matching records · chain integrity{" "}
              <b
                className={
                  data?.integrity?.valid ? "integrity-good" : "integrity-bad"
                }
              >
                {data?.integrity?.valid ? "verified" : "warning"}
              </b>
            </p>
          </div>
          <div className="audit-filters">
            <select
              value={filters.action}
              onChange={(event) => updateFilter("action", event.target.value)}
            >
              <option value="">All actions</option>
              {[
                "LOGIN",
                "LOGOUT",
                "SERVICE_SAVE",
                "SETTINGS_SAVE",
                "COA_GENERATE",
                "COA_UPDATE",
                "REPORT_GENERATE",
                "SERVICE_STATS_SAVE",
                "USER_SAVE",
                "TEMPLATE_UPLOAD",
                "SIGNATURE_UPLOAD",
              ].map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
            <select
              value={filters.outcome}
              onChange={(event) => updateFilter("outcome", event.target.value)}
            >
              <option value="">All outcomes</option>
              <option value="SUCCESS">Success</option>
              <option value="FAILURE">Failure</option>
            </select>
            <form
              className="audit-search"
              onSubmit={(event) => {
                event.preventDefault();
                load();
              }}
            >
              <input
                value={filters.query}
                onChange={(event) =>
                  setFilters({ ...filters, query: event.target.value })
                }
                placeholder="Actor, target, request ID…"
                aria-label="Search audit records"
              />
              <button className="mini-button">Search</button>
            </form>
            <button
              className="mini-button"
              onClick={() => load()}
              disabled={loading}
            >
              {loading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
        {data?.integrity && !data.integrity.valid && (
          <div className="audit-integrity-warning">
            <ShieldCheck />
            {data.integrity.dropped > 0 ? (
              <>
                {data.integrity.dropped} audit{" "}
                {data.integrity.dropped === 1 ? "entry" : "entries"} could not
                be written, so this log has known gaps
                {data.integrity.droppedLast
                  ? ` (most recently ${data.integrity.droppedLast})`
                  : ""}
                . Check the Apps Script executions log.
              </>
            ) : (
              <>
                The audit hash chain does not match. A row may have been edited
                or deleted directly in Google Sheets.
              </>
            )}
          </div>
        )}
        <div className="table-scroll">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Outcome</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.audit_id}>
                  <td>{entry.timestamp}</td>
                  <td>
                    <strong>{entry.actor_email || "—"}</strong>
                    <small>{entry.actor_role}</small>
                  </td>
                  <td>{entry.action}</td>
                  <td>
                    {entry.target_type}
                    <small>{entry.target_id}</small>
                  </td>
                  <td>
                    <span
                      className={`status-pill ${entry.outcome === "SUCCESS" ? "enabled" : "failed"}`}
                    >
                      {entry.outcome}
                    </span>
                  </td>
                  <td className="wrap-cell">
                    {JSON.stringify(entry.details || {})}
                  </td>
                </tr>
              ))}
              {!entries.length && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    No audit records match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}
