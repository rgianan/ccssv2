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
export function Skeleton({ width, height = 14, radius = 6, style, ...rest }) {
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
    <div className={className} role="status" aria-live="polite" aria-busy="true">
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
        <p className="alert">{String(this.state.error?.message || this.state.error)}</p>
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
 */
export function Tip({
  text,
  children,
  placement = "top",
  align = "center",
  block = false,
}) {
  const id = useId();
  if (!text) return children;
  return (
    <span
      className={`tip tip-${placement} tip-align-${align}${block ? " tip-block" : ""}`}
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
