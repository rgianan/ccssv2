import React, { useId } from "react";

/**
 * Shared interface primitives: loading placeholders and tooltips.
 *
 * Both live here rather than in admin.css's chunk because the public survey
 * uses them too — the client waiting for the programme list sees the same
 * placeholder an administrator sees waiting for a table.
 */

/**
 * A single grey block standing in for content that has not arrived.
 *
 * Sized in the caller's units so the placeholder occupies the space the real
 * content will. That is the whole point of a skeleton over a spinner: nothing
 * moves when the data lands, so the eye does not have to find its place again.
 */
export function Skeleton({
  width,
  height = 14,
  radius = "var(--radius-control)",
  style,
  ...rest
}) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      style={{ width, height, borderRadius: radius, ...style }}
      {...rest}
    />
  );
}

/**
 * Announces once, for the whole region, instead of letting a screen reader
 * walk a wall of decorative blocks. Every Skeleton is aria-hidden, so this is
 * the only thing assistive technology hears while a panel loads.
 */
export function SkeletonRegion({ label, children, className = "" }) {
  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="visually-hidden">{label}</span>
      {children}
    </div>
  );
}

/** Lines of text of slightly uneven length, the way a paragraph actually sits. */
export function SkeletonLines({ lines = 3, width = "100%" }) {
  return (
    <>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          width={index === lines - 1 ? "62%" : width}
          style={{ display: "block", marginBottom: 8 }}
        />
      ))}
    </>
  );
}

/** A table's shape, so the header row and column widths do not jump. */
export function SkeletonTable({ columns, rows = 6 }) {
  return (
    <div className="table-scroll">
      <table className="skeleton-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((column, columnIndex) => (
                <td key={column}>
                  <Skeleton width={columnIndex === 0 ? "76%" : "52%"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * In place of a panel whose data did not arrive.
 *
 * A failed load used to render as the panel's ordinary state with whatever it
 * already held: "No programs configured yet", an audit log reading "0 records ·
 * chain integrity warning", a blank settings form with Save enabled — and, on
 * Reports, the previous period's counts under the new period's heading, where
 * Save wrote them to the wrong period. Nothing a panel has not loaded is shown
 * as though it had been, and nothing that writes is offered beside it.
 *
 * The reason is the banner the dashboard already raises; this says what did
 * not load and offers the retry. `inline` is for a list inside a card that
 * stays on screen, where a second card would be a box in a box.
 */
/**
 * The page numbers worth a button: the first, the last, and the current page
 * with its neighbours, with a gap marker between runs that do not meet.
 */
function pageList(page, count) {
  const shown = [
    ...new Set([1, page - 1, page, page + 1, count].filter(Boolean)),
  ]
    .filter((n) => n >= 1 && n <= count)
    .sort((a, b) => a - b);
  return shown.flatMap((n, i) =>
    i && n - shown[i - 1] > 1 ? [`gap-${n}`, n] : [n],
  );
}

/**
 * A long list's pages: which rows are on screen, and the way to the others.
 *
 * Nothing at all for a list that fits on one page. `listRef` is the list's
 * box: a page turned from the pager below a long table opens at its first row
 * rather than at the bottom of the next.
 */
export function Pager({ page, pageSize, total, onPage, disabled, listRef }) {
  const count = Math.ceil(total / pageSize);
  if (count <= 1) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const go = (next) => {
    onPage(next);
    if (listRef?.current?.getBoundingClientRect().top < 0)
      listRef.current.scrollIntoView({ block: "start" });
  };
  return (
    <nav className="pager" aria-label="Pages">
      <span className="pager-range">
        {first}–{last} of {total.toLocaleString()}
      </span>
      <div className="pager-pages">
        <button
          type="button"
          className="mini-button"
          disabled={disabled || page <= 1}
          onClick={() => go(page - 1)}
        >
          Previous
        </button>
        {pageList(page, count).map((n) =>
          typeof n === "string" ? (
            <span key={n} className="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={n}
              type="button"
              className={`mini-button${n === page ? " current" : ""}`}
              aria-current={n === page ? "page" : undefined}
              aria-label={`Page ${n}`}
              disabled={disabled}
              onClick={() => n !== page && go(n)}
            >
              {n}
            </button>
          ),
        )}
        <button
          type="button"
          className="mini-button"
          disabled={disabled || page >= count}
          onClick={() => go(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

export function LoadFailed({ what, onRetry, inline = false }) {
  const Box = inline ? "div" : "article";
  return (
    <Box className={inline ? "load-failed" : "panel load-failed"}>
      <h2>{what} could not be loaded</h2>
      <p>
        The reason is shown at the top of the page. Nothing has been changed.
      </p>
      <button type="button" className="button secondary" onClick={onRetry}>
        Try again
      </button>
    </Box>
  );
}

/**
 * Keeps one panel's render error inside that panel.
 *
 * React unmounts the whole tree when a render throws, so a single unexpected
 * response shape took the sidebar with it and left a white page — no error, no
 * navigation, nothing to click. The boundary is placed around the panel area
 * rather than the app, so the tabs stay usable and the reader can go somewhere
 * else while whatever broke stays broken.
 *
 * `resetKey` clears the error when the tab changes: the panel that threw is no
 * longer the one being rendered.
 */
export class PanelBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(previous) {
    if (previous.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: null });
  }
  componentDidCatch(error) {
    console.error("Panel failed to render:", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>This panel could not be displayed</h2>
            <p>
              The rest of the module still works — pick another tab, or reload
              to try again. If it keeps happening, the details below help
              identify the cause.
            </p>
          </div>
        </div>
        <p className="alert">
          {String(this.state.error?.message || this.state.error)}
        </p>
      </section>
    );
  }
}

/**
 * A tooltip that is actually readable by everything that needs to read it.
 *
 * `title` — which this replaces — waits about a second, cannot be styled,
 * never appears on touch, and is skipped by several screen readers. This
 * renders real text, shows it on hover *and* keyboard focus, and points the
 * trigger at it with aria-describedby so it is announced rather than guessed.
 *
 * The wrapper is inline-flex by default because most triggers are buttons in a
 * row; pass `block` for a trigger that has to keep filling its container.
 *
 * `className` puts a layout class on the wrapper rather than on the trigger.
 * The wrapper is what the parent lays out now, so a class like `push-right`
 * left on the trigger stops doing anything — it would be positioning a box
 * inside the box that actually moves.
 */
export function Tip({
  text,
  children,
  placement = "top",
  align = "center",
  block = false,
  className = "",
}) {
  const id = useId();
  if (!text) return children;
  return (
    <span
      className={`tip tip-${placement} tip-align-${align}${block ? " tip-block" : ""}${className ? " " + className : ""}`}
    >
      {React.cloneElement(React.Children.only(children), {
        "aria-describedby": id,
      })}
      <span role="tooltip" id={id} className="tip-bubble">
        {text}
      </span>
    </span>
  );
}
