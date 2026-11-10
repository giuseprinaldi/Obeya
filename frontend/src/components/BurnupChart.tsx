/* Body of a burn-up panel: the numbers, a plot of done against scope across the period, and a legend.
   The plot is an SVG stretched to whatever room the panel has, so lines are drawn in a 0-100 box with
   non-scaling strokes, and everything that must not stretch (dots, labels, the read-out) is HTML on top. */
import { useState, type CSSProperties, type PointerEvent } from "react";
import { burnPill, burnSummary, burnUnestimated, burnupView, idealAt, nearestPoint, type BurnPoint, type BurnupView } from "../logic/burnup";
import type { LiveData } from "../logic/progress";
import { clamp, fmtDate, fmtNum } from "../logic/util";
import type { BurnupPanel } from "../types";
import { useUi } from "../ui";

const pctX = (x: number): number => clamp(x, 0, 1) * 100;

function Plot({ v }: { v: BurnupView }) {
  const [hover, setHover] = useState<BurnPoint | null>(null);
  const y = (value: number): number => 100 - clamp(value / v.max, 0, 1) * 100;
  const at = (p: BurnPoint, value: number): string => `${pctX(p.x).toFixed(2)},${y(value).toFixed(2)}`;
  const first = v.points[0], last = v.points[v.points.length - 1];
  const doneLine = v.points.map((p) => at(p, p.done)).join(" ");
  const scopeLine = v.points.map((p) => at(p, p.total)).join(" ");
  const area = first && last && v.points.length > 1 ? `M${pctX(first.x).toFixed(2)},100 L${v.points.map((p) => at(p, p.done)).join(" L")} L${pctX(last.x).toFixed(2)},100 Z` : "";

  const track = (e: PointerEvent<HTMLDivElement>): void => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0) setHover(nearestPoint(v.points, (e.clientX - box.left) / box.width));
  };
  const unit = v.unit ? ` ${v.unit}` : "";

  return (
    <div className="burn-plot">
      <div className="burn-y" aria-hidden="true">
        <span className="sizer">{fmtNum(v.max)}</span>
        {v.ticks.map((t) => (
          <span key={t} style={{ bottom: `${(t / v.max) * 100}%` }}>
            {fmtNum(t)}
          </span>
        ))}
      </div>
      <div className="burn-area" onPointerMove={track} onPointerLeave={() => setHover(null)}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {v.ticks.map((t) => (
            <line key={t} className="grid" x1="0" x2="100" y1={y(t)} y2={y(t)} />
          ))}
          {v.todayX !== null ? <line className="today" x1={pctX(v.todayX)} x2={pctX(v.todayX)} y1="0" y2="100" /> : null}
          {v.total > 0 ? <line className="ideal" x1="0" y1="100" x2="100" y2={y(v.total)} /> : null}
          {area ? <path className="area" d={area} /> : null}
          {v.points.length > 1 ? <polyline className="scope" points={scopeLine} /> : null}
          {v.points.length > 1 ? <polyline className="done" points={doneLine} /> : null}
          {v.forecast && last ? <line className="forecast" x1={pctX(last.x)} y1={y(last.done)} x2={pctX(v.forecast.x)} y2={y(v.forecast.value)} /> : null}
        </svg>
        {last ? <span className="burn-dot scope" style={{ left: `${pctX(last.x)}%`, top: `${y(last.total)}%` }} /> : null}
        {last ? <span className="burn-dot done" style={{ left: `${pctX(last.x)}%`, top: `${y(last.done)}%` }} /> : null}
        {hover ? (
          <>
            <span className="burn-cross" style={{ left: `${pctX(hover.x)}%` }} />
            <div className={`burn-tip${hover.x > 0.6 ? " flip" : ""}`} style={{ left: `${pctX(hover.x)}%` }} role="status">
              <span className="when">{fmtDate(hover.d)}</span>
              <span className="tip-row">
                <i className="k done" />
                <b>{fmtNum(hover.done)}</b>
                {unit} done
              </span>
              <span className="tip-row">
                <i className="k scope" />
                <b>{fmtNum(hover.total)}</b>
                {unit} in scope
              </span>
              <span className="tip-row">
                <i className="k ideal" />
                <b>{fmtNum(Math.round(idealAt(v, hover.x)))}</b> at an even pace
              </span>
            </div>
          </>
        ) : null}
      </div>
      <div className="burn-x" aria-hidden="true">
        <span>{fmtDate(v.start)}</span>
        {v.todayX !== null && v.todayX > 0.12 && v.todayX < 0.88 ? (
          <span className="now" style={{ left: `${pctX(v.todayX)}%` }}>
            Today
          </span>
        ) : null}
        <span>{fmtDate(v.end)}</span>
      </div>
    </div>
  );
}

/** The same numbers as the plot, a week apart, for screen readers and anyone who cannot use the chart. */
function DataTable({ v }: { v: BurnupView }) {
  const rows = v.points.filter((_, i) => (v.points.length - 1 - i) % 7 === 0);
  return (
    <table className="sr-only">
      <caption>Done and scope, week by week</caption>
      <thead>
        <tr>
          <th>Date</th>
          <th>Done</th>
          <th>Scope</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.d}>
            <td>{fmtDate(p.d)}</td>
            <td>{fmtNum(p.done)}</td>
            <td>{fmtNum(p.total)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function BurnupBody({ panel, live }: { panel: BurnupPanel; live: LiveData; tv: boolean }) {
  const ui = useUi();
  const v = burnupView(panel, live);
  if (v.state === "unlinked") {
    return (
      <>
        <p className="empty">{v.message}</p>
        {ui.canEdit ? (
          <button type="button" className="add" style={{ marginTop: 10 }} onClick={() => ui.open({ kind: "panel", panelId: panel.id })}>
            Link this chart to Jira
          </button>
        ) : null}
      </>
    );
  }
  if (v.state !== "ok") {
    const failed = v.state === "error" || v.state === "noperiod";
    return (
      <p className={failed ? "pbar-note is-error" : "empty"} style={{ margin: 0 }} role={v.state === "error" ? "alert" : undefined}>
        {v.message}
      </p>
    );
  }
  const pill = burnPill(v);
  const color = v.status === "none" ? "var(--accent)" : `var(--${v.status})`;
  const period = [v.periodName, `${fmtDate(v.start)} to ${fmtDate(v.end)}`].filter(Boolean).join(" · ");
  return (
    <div className="burn" style={{ "--bc": color } as CSSProperties}>
      <div className="burn-head">
        <div className="burn-nums">
          <span className="burn-big">{fmtNum(v.done)}</span>
          <span className="burn-of">
            of {fmtNum(v.total)}
            {v.unit ? ` ${v.unit}` : ""} done
          </span>
          {pill ? <span className={`pill st-${pill.status}`}>{pill.text}</span> : null}
          {v.keyText ? (
            v.url ? (
              <a className="key" href={v.url} target="_blank" rel="noreferrer">
                {v.keyText}
              </a>
            ) : (
              <span className="key">{v.keyText}</span>
            )
          ) : null}
        </div>
        <div className="burn-sub">{[period, burnSummary(v), burnUnestimated(v)].filter(Boolean).join(" · ")}</div>
        {v.note ? <div className="burn-note">{v.note}</div> : null}
      </div>
      <Plot v={v} />
      <div className="burn-legend">
        <span>
          <i className="k done" />
          Done
        </span>
        <span>
          <i className="k scope" />
          Scope
        </span>
        <span>
          <i className="k ideal" />
          Even pace
        </span>
        {v.forecast ? (
          <span>
            <i className="k forecast" />
            Forecast
          </span>
        ) : null}
      </div>
      <DataTable v={v} />
    </div>
  );
}
