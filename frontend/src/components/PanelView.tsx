/* One panel on a wall: the frame (title, status stripe, tools) and the body for each panel type. */
import { useState, type CSSProperties, type DragEvent } from "react";
import { boardView, type BoardCardView } from "../logic/board";
import { effectiveKpi } from "../logic/kpi";
import { barColor, barPill, portfolioProgress, resolveBars, valueText, type BarView, type LiveData } from "../logic/progress";
import { PANEL_TYPES, STAGES, itemNoun } from "../logic/seed";
import { isLate, panelStatus } from "../logic/status";
import { signed, sparkPath, trendTitle } from "../logic/trend";
import { clamp, fmtDate, fmtNum } from "../logic/util";
import { store } from "../store";
import type {
  ActionsPanel,
  KanbanPanel,
  KpiPanel,
  Panel,
  PortfolioPanel,
  ProblemsPanel,
  ProgressPanel,
  Severity,
  StatementPanel,
  Status,
  Wall,
} from "../types";
import { findPanel, useUi } from "../ui";
import { BurnupBody } from "./BurnupChart";
import { DependenciesBody, RisksBody } from "./DepsRisks";

const HEALTH: Record<"on" | "risk" | "off", [string, Status]> = {
  on: ["On track", "good"],
  risk: ["At risk", "warn"],
  off: ["Off track", "bad"],
};
const SEV: Record<Severity, Status> = { High: "bad", Medium: "warn", Low: "none" };
const SEV_ORDER: Severity[] = ["High", "Medium", "Low"];

interface BodyProps<P extends Panel> {
  panel: P;
  live: LiveData;
  tv: boolean;
}

/* ---------- Statement ---------- */

function StatementBody({ panel }: BodyProps<StatementPanel>) {
  const ui = useUi();
  return (
    <button className="statement" type="button" disabled={!ui.canEdit} onClick={() => ui.open({ kind: "panel", panelId: panel.id })} aria-label={ui.canEdit ? `Edit ${panel.title}` : undefined}>
      <q>{panel.data.text}</q>
      {panel.data.meta ? <span className="meta">{panel.data.meta}</span> : null}
    </button>
  );
}

/* ---------- KPI ---------- */

function Spark({ history, target }: { history: number[]; target: number | "" }) {
  const h = history.map(Number).filter(isFinite).slice(-12);
  if (h.length < 2) return null;
  const W = 180, H = 38, p = 3;
  const t = target === "" ? NaN : Number(target);
  const vals = isFinite(t) ? h.concat([t]) : h;
  let mn = Math.min(...vals), mx = Math.max(...vals);
  if (mn === mx) {
    mn -= 1;
    mx += 1;
  }
  const x = (i: number): number => p + (i * (W - 2 * p)) / (h.length - 1);
  const y = (v: number): number => H - p - ((v - mn) * (H - 2 * p)) / (mx - mn);
  const pts = h.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const lastX = x(h.length - 1).toFixed(1);
  const area = `M${x(0).toFixed(1)},${H - p} L${pts.join(" L")} L${lastX},${H - p} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {isFinite(t) ? <line className="tl" x1={p} x2={W - p} y1={y(t).toFixed(1)} y2={y(t).toFixed(1)} /> : null}
      <path className="area" d={area} />
      <polyline className="ln" points={pts.join(" ")} />
      <circle className="dot" cx={lastX} cy={y(h[h.length - 1]!).toFixed(1)} r="3" />
    </svg>
  );
}

function KpiBody({ panel, live }: BodyProps<KpiPanel>) {
  const ui = useUi();
  if (!panel.data.items.length) return <p className="empty">No KPIs yet. Add one to start tracking against a target.</p>;
  return (
    <div className="kpis">
      {panel.data.items.map((k) => {
        // effectiveKpi decides the value, unit, history, status and trend, whether hand-entered or from Jira.
        const e = effectiveKpi(k, live);
        const waiting = e.state === "loading" || e.state === "disconnected" || e.state === "error";
        return (
          <button
            key={k.id}
            type="button"
            className={`kpi st-${e.state === "error" ? "warn" : e.status}${e.state === "error" ? " is-error" : ""}`}
            title={e.detail || undefined}
            disabled={!ui.canEdit}
            onClick={() => ui.open({ kind: "item", panelId: panel.id, itemId: k.id })}
          >
            <span className="name">
              {k.name}
              {e.jira ? <span className="tag kpi-src">Jira</span> : null}
            </span>
            {waiting ? (
              <span className="kpi-msg" role={e.state === "error" ? "alert" : undefined}>
                {e.message}
              </span>
            ) : (
              <span className="val">
                <span className="big">{fmtNum(e.actual)}</span>
                <span className="unit">{e.unit}</span>
                <span className="trend">{e.trend}</span>
              </span>
            )}
            <span className="tgt">
              Target {k.dir === "down" ? "≤" : "≥"} {fmtNum(k.target)} {e.unit}
            </span>
            {e.state === "empty" ? <span className="kpi-msg">{e.message}</span> : null}
            <Spark history={e.history} target={k.target} />
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Portfolio ---------- */

function KeyChip({ text, url }: { text: string; url: string }) {
  if (!text) return null;
  return url ? (
    <a className="key" href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  ) : (
    <span className="key">{text}</span>
  );
}

function PortfolioBody({ panel, live }: BodyProps<PortfolioPanel>) {
  const ui = useUi();
  if (!panel.data.items.length) return <p className="empty">No initiatives yet.</p>;
  return (
    <div className="rows portfolio">
      {panel.data.items.map((x) => {
        const [label, st] = HEALTH[x.health] ?? HEALTH.on;
        const pr = portfolioProgress(x, live);
        const pct = Math.round(pr.pct);
        const sub = [x.owner, x.note, pr.reason ? `${pr.reason}, showing the manual value` : ""].filter(Boolean).join(" · ");
        return (
          <div className="row" key={x.id}>
            <div style={{ minWidth: 0 }}>
              <button type="button" className="row-btn" disabled={!ui.canEdit} onClick={() => ui.open({ kind: "item", panelId: panel.id, itemId: x.id })}>
                <span className="rt">{x.name}</span>
              </button>
              <KeyChip text={pr.keyText || (x.source?.kind === "jql" ? "JQL" : "")} url={pr.url} />
              <div className="rs">{sub}</div>
            </div>
            <span className={`pill st-${st}`}>{label}</span>
            <div className="bar-track" title={`${pct}% complete${pr.live ? ", from Jira" : ""}`}>
              <div className="bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="horizon">
              {pct}% · {x.horizon}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Progress bars ---------- */

const SPARK_W = 56, SPARK_H = 18;

/** How the bar has moved: a small line of percent done over the last month, and the change over the last week. */
function BarTrendCell({ bar }: { bar: BarView }) {
  const t = bar.trend;
  if (!t) return <div className="pbar-trend" />;
  const line = sparkPath(t.points, SPARK_W, SPARK_H);
  const end = line.split(" ").pop()?.split(",");
  return (
    <div className="pbar-trend" title={trendTitle(t, bar.unit)} style={{ "--bc": barColor(bar) } as CSSProperties}>
      {line && end ? (
        <svg className="pbar-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} width={SPARK_W} height={SPARK_H} aria-hidden="true">
          <polyline points={line} />
          <circle cx={end[0]} cy={end[1]} r="2.5" />
        </svg>
      ) : null}
      <span aria-label={trendTitle(t, bar.unit)}>
        <b>{signed(t.delta)}</b> in {t.days}d
      </span>
    </div>
  );
}

function ProgressRow({ bar, panel, showKeys, showTrend }: { bar: BarView; panel: ProgressPanel; showKeys: boolean; showTrend: boolean }) {
  const ui = useUi();
  const pill = barPill(bar);
  const sub = [bar.owner, bar.note, bar.unestimated > 0 ? `${bar.unestimated} unestimated` : ""].filter(Boolean).join(" · ");
  const edit = (): void => (bar.itemId ? ui.open({ kind: "bar", panelId: panel.id, itemId: bar.itemId }) : ui.open({ kind: "panel", panelId: panel.id }));
  return (
    <div className={`pbar st-${bar.status}${bar.state === "error" ? " is-error" : ""}`}>
      <div className="pbar-label">
        <button type="button" className="row-btn" disabled={!ui.canEdit} onClick={edit} aria-label={ui.canEdit ? `Edit ${bar.label}` : undefined}>
          <span className="rt">{bar.label}</span>
        </button>
        {showKeys && bar.keyText !== bar.label ? <KeyChip text={bar.keyText} url={bar.url} /> : null}
        {sub ? <div className="rs">{sub}</div> : null}
      </div>
      {bar.state !== "ok" ? (
        <div className="pbar-msg" role={bar.state === "error" ? "alert" : undefined}>
          {bar.message}
        </div>
      ) : bar.emptyText ? (
        <div className="pbar-msg">{bar.emptyText}</div>
      ) : (
        <>
          <div
            className="pbar-track"
            style={{ "--bc": barColor(bar) } as CSSProperties}
            role="img"
            aria-label={`${Math.round(bar.pct)}% done${bar.expected !== null ? `, ${Math.round(bar.expected)}% expected by today` : ""}`}
          >
            <div className="pbar-segs">
              <div className="pbar-fill" style={{ width: `${bar.pct}%` }} />
              {bar.display.showInProgress && bar.wipPct > 0 ? <div className="pbar-wip" style={{ width: `${bar.wipPct}%` }} /> : null}
            </div>
            {bar.expected !== null && bar.pct < 100 ? (
              <div className="pbar-pace" style={{ left: `${clamp(bar.expected, 0, 100)}%` }} title={`Expected by today: ${Math.round(bar.expected)}%`} />
            ) : null}
          </div>
          {showTrend ? <BarTrendCell bar={bar} /> : null}
          <div className="pbar-val">
            <span>{valueText(bar)}</span>
            {pill ? <span className={`pill st-${pill.status}`}>{pill.text}</span> : null}
          </div>
        </>
      )}
    </div>
  );
}

function ProgressBody({ panel, live, tv }: BodyProps<ProgressPanel>) {
  const { bars, autoNote, autoFailed } = resolveBars(panel, live);
  if (!bars.length && !autoNote) {
    return <p className="empty">No bars yet. Add one and link it to a Jira epic or initiative, or fill the panel from a Jira query in the panel settings.</p>;
  }
  // The trend column only takes up room once at least one bar has a day to compare with.
  const showTrend = panel.data.showTrend && bars.some((b) => b.trend);
  return (
    <>
      <div className={`pbars${showTrend ? " with-trend" : ""}`}>
        {bars.map((b) => (
          <ProgressRow key={b.id} bar={b} panel={panel} showKeys={panel.data.showKeys} showTrend={showTrend} />
        ))}
      </div>
      {autoNote && !(tv && !autoFailed && bars.length > 0) ? <p className={`pbar-note${autoFailed ? " is-error" : ""}`}>{autoNote}</p> : null}
    </>
  );
}

/* ---------- Problems ---------- */

function ProblemsBody({ panel }: BodyProps<ProblemsPanel>) {
  const ui = useUi();
  if (!panel.data.items.length) return <p className="empty">No open problems. Add one when something blocks the plan.</p>;
  const closed = (s: string): number => (s === "Closed" ? 1 : 0);
  const items = panel.data.items
    .slice()
    .sort((a, b) => closed(a.stage) - closed(b.stage) || SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
  return (
    <div className="rows problems">
      {items.map((x) => {
        const si = Math.max(0, STAGES.indexOf(x.stage));
        return (
          <div className={`row st-${SEV[x.severity] ?? "none"}`} key={x.id}>
            <span className="sev" role="img" aria-label={`${x.severity} severity`} />
            <button type="button" className="row-btn" disabled={!ui.canEdit} onClick={() => ui.open({ kind: "item", panelId: panel.id, itemId: x.id })}>
              <div className="rt">{x.title}</div>
              <div className="rs">
                {[x.severity, x.owner].filter(Boolean).join(" · ")}
                {x.countermeasure ? ` · Next: ${x.countermeasure}` : ""}
              </div>
              <div className="stages" aria-hidden="true">
                {STAGES.map((s, i) => (
                  <i key={s} className={i <= si ? "on" : ""} />
                ))}
              </div>
            </button>
            <span className="stage-l">{x.stage}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Actions ---------- */

function ActionsBody({ panel, live }: BodyProps<ActionsPanel>) {
  const ui = useUi();
  if (!panel.data.items.length) return <p className="empty">No actions yet.</p>;
  const today = live.periods.today;
  const items = panel.data.items.slice().sort((a, b) => Number(a.done) - Number(b.done) || String(a.due).localeCompare(String(b.due)));
  const toggle = (itemId: string, done: boolean): void =>
    store.commit((room) => {
      const f = findPanel(room, panel.id);
      if (f?.panel.type !== "actions") return;
      const it = f.panel.data.items.find((a) => a.id === itemId);
      if (it) it.done = done;
    });
  return (
    <div className="rows actions">
      {items.map((a) => {
        const late = isLate(a, today);
        return (
          <div className={`row${a.done ? " done" : ""}`} key={a.id}>
            <input type="checkbox" checked={a.done} disabled={!ui.canEdit} onChange={(e) => toggle(a.id, e.target.checked)} aria-label={`Mark ${a.text} done`} />
            <button type="button" className="row-btn" disabled={!ui.canEdit} onClick={() => ui.open({ kind: "item", panelId: panel.id, itemId: a.id })}>
              <div className="rt">{a.text}</div>
              <div className="rs">{a.owner}</div>
            </button>
            <span className={`due${late ? " late" : ""}`}>{a.done ? "Done" : late ? `Late · ${fmtDate(a.due)}` : a.due === today ? "Today" : fmtDate(a.due)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Flow board ---------- */

function JiraCard({ card, tv }: { card: BoardCardView; tv: boolean }) {
  const body = (
    <>
      {card.title}
      <span className="cmeta">
        {card.key && card.key !== card.title ? <span className="key">{card.key}</span> : null}
        {card.assignee ? <span>{card.assignee}</span> : null}
        {card.type ? <span className="tag">{card.type}</span> : null}
        {card.pointsText ? <span>{card.pointsText}</span> : null}
        {card.blocked ? (
          <span className="blk" title={card.blockedReason || undefined}>
            Blocked
          </span>
        ) : null}
        {card.age ? (
          <span className="age" title={`${card.age.slice(0, -1)} days in this stage`}>
            {card.age}
          </span>
        ) : null}
        {card.staleText ? (
          <span className="stale" title={card.staleTitle}>
            {card.staleText}
          </span>
        ) : null}
      </span>
    </>
  );
  const cls = `card jira${card.blocked ? " blocked" : ""}`;
  // In the editor a card opens the issue in Jira. A TV has nobody to click it.
  return card.url && !tv ? (
    <a className={cls} href={card.url} target="_blank" rel="noopener noreferrer" draggable={false}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** A flow board fed by a Jira board: same look as a manual one, but read-only. */
function JiraBoardBody({ panel, live, tv }: BodyProps<KanbanPanel>) {
  const view = boardView(panel, live);
  if (!view) return null;
  if (view.state !== "ok") {
    return (
      <p className={view.state === "error" ? "pbar-note is-error" : "empty"} style={{ margin: 0 }} role={view.state === "error" ? "alert" : undefined}>
        {view.message}
      </p>
    );
  }
  return (
    <>
      <div className="board">
        {view.columns.map((c, i) => (
          <div key={`${i}:${c.name}`} className={`col${c.over ? " over" : ""}`}>
            <div className="col-head">
              <span>{c.name}</span>
              <span className="wip">{c.countText}</span>
            </div>
            {c.cards.map((card) => (
              <JiraCard key={card.key} card={card} tv={tv} />
            ))}
            {c.more > 0 ? <div className="col-more">+{c.more} more</div> : null}
          </div>
        ))}
      </div>
      {view.columns.length ? null : <p className="empty">This board has no columns to show.</p>}
      {view.footer ? <p className="board-foot">{view.footer}</p> : null}
    </>
  );
}

function KanbanBody(props: BodyProps<KanbanPanel>) {
  return props.panel.data.jira ? <JiraBoardBody {...props} /> : <ManualBoardBody {...props} />;
}

function ManualBoardBody({ panel }: BodyProps<KanbanPanel>) {
  const ui = useUi();
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);

  const drop = (e: DragEvent<HTMLDivElement>, colId: string): void => {
    e.preventDefault();
    setDropCol(null);
    if (!ui.canEdit) return;
    const [pid, cardId] = (e.dataTransfer.getData("text/plain") || "").split("|");
    if (pid !== panel.id || !cardId) return;
    store.commit((room) => {
      const f = findPanel(room, panel.id);
      if (f?.panel.type !== "kanban") return;
      const d = f.panel.data;
      const card = d.cards.find((c) => c.id === cardId);
      if (!card || card.col === colId) return;
      card.col = colId;
      d.cards = d.cards.filter((c) => c !== card).concat(card);
    });
  };

  return (
    <div className="board">
      {panel.data.columns.map((c) => {
        const cards = panel.data.cards.filter((x) => x.col === c.id);
        const over = Number(c.wip) > 0 && cards.length > Number(c.wip);
        return (
          <div
            key={c.id}
            className={`col${over ? " over" : ""}${dropCol === c.id ? " drop" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropCol(c.id);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropCol(null);
            }}
            onDrop={(e) => drop(e, c.id)}
          >
            <div className="col-head">
              <span>{c.name}</span>
              <span className="wip">
                {cards.length}
                {Number(c.wip) > 0 ? ` / ${c.wip}` : ""}
                {over ? " over" : ""}
              </span>
            </div>
            {cards.map((x) => (
              <button
                key={x.id}
                type="button"
                className={`card${x.blocked ? " blocked" : ""}${dragging === x.id ? " dragging" : ""}`}
                disabled={!ui.canEdit}
                draggable={ui.canEdit}
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", `${panel.id}|${x.id}`);
                  e.dataTransfer.effectAllowed = "move";
                  setDragging(x.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setDropCol(null);
                }}
                onClick={() => ui.open({ kind: "item", panelId: panel.id, itemId: x.id })}
              >
                {x.title}
                <span className="cmeta">
                  {x.owner ? <span>{x.owner}</span> : null}
                  {x.tag ? <span className="tag">{x.tag}</span> : null}
                  {x.blocked ? <span className="blk">Blocked</span> : null}
                </span>
              </button>
            ))}
            {ui.canEdit ? (
              <button type="button" className="add" onClick={() => ui.open({ kind: "item", panelId: panel.id, col: c.id })}>
                + Card
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- Frame ---------- */

function Body({ panel, live, tv }: BodyProps<Panel>) {
  switch (panel.type) {
    case "statement":
      return <StatementBody panel={panel} live={live} tv={tv} />;
    case "kpi":
      return <KpiBody panel={panel} live={live} tv={tv} />;
    case "portfolio":
      return <PortfolioBody panel={panel} live={live} tv={tv} />;
    case "progress":
      return <ProgressBody panel={panel} live={live} tv={tv} />;
    case "burnup":
      return <BurnupBody panel={panel} live={live} tv={tv} />;
    case "dependencies":
      return <DependenciesBody panel={panel} live={live} tv={tv} />;
    case "risks":
      return <RisksBody panel={panel} live={live} tv={tv} />;
    case "problems":
      return <ProblemsBody panel={panel} live={live} tv={tv} />;
    case "actions":
      return <ActionsBody panel={panel} live={live} tv={tv} />;
    case "kanban":
      return <KanbanBody panel={panel} live={live} tv={tv} />;
  }
}

export function PanelView({ panel, wall, live, tv }: { panel: Panel; wall: Wall; live: LiveData; tv: boolean }) {
  const ui = useUi();
  const T = PANEL_TYPES[panel.type];
  const st = panelStatus(panel, live);
  const i = wall.panels.indexOf(panel);

  const move = (dir: number): void =>
    store.commit((room) => {
      const f = findPanel(room, panel.id);
      if (!f) return;
      const from = f.wall.panels.indexOf(f.panel), to = from + dir;
      if (to < 0 || to >= f.wall.panels.length) return;
      f.wall.panels.splice(from, 1);
      f.wall.panels.splice(to, 0, f.panel);
    });

  const addItem = (): void => ui.open(panel.type === "progress" ? { kind: "bar", panelId: panel.id } : { kind: "item", panelId: panel.id });
  // A TV shows no controls, and neither does a browser that may not edit.
  const controls = !tv && ui.canEdit;

  return (
    <section className={`panel span-${panel.span || 1} st-${st}`}>
      <header className="panel-head">
        <h3>{panel.title}</h3>
        <span className="ptype">{T.label}</span>
        {!controls ? null : (
          <div className="tools">
            <button type="button" className="icon-btn" onClick={() => move(-1)} aria-label={`Move ${panel.title} earlier`} disabled={i === 0}>
              ←
            </button>
            <button type="button" className="icon-btn" onClick={() => move(1)} aria-label={`Move ${panel.title} later`} disabled={i === wall.panels.length - 1}>
              →
            </button>
            <button type="button" className="icon-btn" onClick={() => ui.open({ kind: "panel", panelId: panel.id })} aria-label={`Edit panel ${panel.title}`}>
              Edit
            </button>
          </div>
        )}
      </header>
      <div className="panel-body">
        <Body panel={panel} live={live} tv={tv} />
      </div>
      {controls && T.item && panel.type !== "kanban" ? (
        <div className="panel-foot">
          <button type="button" className="add" onClick={addItem}>
            + Add {itemNoun(panel.type)}
          </button>
        </div>
      ) : null}
    </section>
  );
}
