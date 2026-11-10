/* Progress bars: turning a bar's settings plus the server's Jira result into what gets drawn. */
import type {
  AutoResult,
  BarDisplay,
  BoardResult,
  JiraSourceOptions,
  MetricResult,
  Pace,
  Periods,
  PortfolioItem,
  ProgressBarItem,
  ProgressPanel,
  ProgressResult,
  Status,
} from "../types";
import { clamp, daysBetween, fmtNum } from "./util";

/** Everything the server sends next to the room. */
export interface LiveData {
  progress: Record<string, ProgressResult>;
  auto: Record<string, AutoResult>;
  /** Jira-fed flow boards, keyed by panel id. */
  boards: Record<string, BoardResult>;
  /** Jira-fed KPIs, keyed by KPI id. */
  metrics: Record<string, MetricResult>;
  periods: Periods;
  jiraConfigured: boolean;
}

export const defaultDisplay = (): BarDisplay => ({
  color: "status",
  valueFormat: "both",
  showInProgress: true,
  pace: { kind: "none" },
});

export const defaultJiraOptions = (): JiraSourceOptions => ({
  measure: "count",
  includeSubtasks: false,
  doneStatuses: [],
});

/** Points behind pace that still count as on pace, and the limit before a bar is "behind". */
export const PACE_OK = 5;
export const PACE_RISK = 20;

/** Where a bar should be today: linear between the period's start and end. Null when unknown. */
export function expectedPct(pace: Pace, periods: Periods): number | null {
  let start: string, end: string;
  if (pace.kind === "none") return null;
  if (pace.kind === "sprint") {
    if (!periods.sprint) return null;
    ({ start, end } = periods.sprint);
  } else if (pace.kind === "pi") {
    if (!periods.pi) return null;
    ({ start, end } = periods.pi);
  } else {
    ({ start, end } = pace);
  }
  const span = daysBetween(start, end);
  const gone = daysBetween(start, periods.today);
  if (span === null || gone === null || span < 0) return null;
  if (gone <= 0) return 0;
  if (gone >= span) return 100;
  return (gone / span) * 100;
}

export function barStatus(pct: number, expected: number | null): Status {
  if (pct >= 100) return "good";
  if (expected === null) return "none";
  const behind = expected - pct;
  if (behind <= PACE_OK) return "good";
  return behind <= PACE_RISK ? "warn" : "bad";
}

export type BarState = "ok" | "error" | "loading" | "disconnected";

/** One bar, ready to draw. */
export interface BarView {
  /** Unique within the panel. */
  id: string;
  /** The hand-picked item behind this bar; null for bars produced by the panel's query. */
  itemId: string | null;
  label: string;
  keyText: string;
  url: string;
  owner: string;
  note: string;
  display: BarDisplay;
  state: BarState;
  /** Shown instead of the track when state is not "ok". */
  message: string;
  pct: number;
  /** Width of the in-progress segment, in percent of the track. */
  wipPct: number;
  done: number;
  total: number;
  unit: string;
  unestimated: number;
  /** Set when there is nothing to measure yet (total is 0). */
  emptyText: string;
  expected: number | null;
  status: Status;
}

const UNIT: Record<ProgressResult["unit"], string> = { issues: "issues", points: "pts" };

function measured(
  base: Pick<BarView, "id" | "itemId" | "label" | "keyText" | "url" | "owner" | "note" | "display">,
  n: { done: number; total: number; inProgress: number; unit: string; unestimated: number; emptyText: string },
  periods: Periods,
): BarView {
  const has = n.total > 0;
  const pct = has ? clamp((n.done / n.total) * 100, 0, 100) : 0;
  const wipPct = has ? clamp((n.inProgress / n.total) * 100, 0, 100 - pct) : 0;
  const expected = has ? expectedPct(base.display.pace, periods) : null;
  return {
    ...base,
    state: "ok",
    message: "",
    pct,
    wipPct,
    done: n.done,
    total: n.total,
    unit: n.unit,
    unestimated: n.unestimated,
    emptyText: has ? "" : n.emptyText,
    expected,
    status: has ? barStatus(pct, expected) : "none",
  };
}

function unavailable(
  base: Pick<BarView, "id" | "itemId" | "label" | "keyText" | "url" | "owner" | "note" | "display">,
  state: Exclude<BarState, "ok">,
  message: string,
): BarView {
  return {
    ...base,
    state,
    message,
    pct: 0,
    wipPct: 0,
    done: 0,
    total: 0,
    unit: "",
    unestimated: 0,
    emptyText: "",
    expected: null,
    status: state === "error" ? "warn" : "none",
  };
}

/** Why a linked item has no result: still loading, or Jira is not set up on the server. */
export function missingReason(live: LiveData): { state: "loading" | "disconnected"; message: string } {
  return live.jiraConfigured
    ? { state: "loading", message: "Loading from Jira…" }
    : { state: "disconnected", message: "Jira is not connected" };
}

function fromResult(
  base: Pick<BarView, "id" | "itemId" | "label" | "keyText" | "url" | "owner" | "note" | "display">,
  r: ProgressResult,
  periods: Periods,
): BarView {
  if (!r.ok) return unavailable(base, "error", r.error || "Jira could not read this link.");
  return measured(
    base,
    {
      done: r.done,
      total: r.total,
      inProgress: r.inProgress,
      unit: UNIT[r.unit] ?? "issues",
      unestimated: r.unit === "points" ? r.unestimated : 0,
      emptyText: r.unit === "points" ? "No estimates yet" : "No issues yet",
    },
    periods,
  );
}

function displayOf(b: BarDisplay): BarDisplay {
  return { color: b.color, valueFormat: b.valueFormat, showInProgress: b.showInProgress, pace: b.pace };
}

export function itemBar(item: ProgressBarItem, live: LiveData): BarView {
  const src = item.source;
  const display = displayOf(item);
  if (src.kind === "manual") {
    const base = { id: item.id, itemId: item.id, label: item.label || "Untitled", keyText: "", url: "", owner: item.owner, note: item.note, display };
    return measured(
      base,
      { done: Number(src.done) || 0, total: Number(src.total) || 0, inProgress: 0, unit: src.unit, unestimated: 0, emptyText: "No total set" },
      live.periods,
    );
  }
  const r = live.progress[item.id];
  const key = src.kind === "issue" ? r?.key || src.key : "";
  const label = item.label || (r?.ok ? r.title : "") || key || "Jira query";
  const base = { id: item.id, itemId: item.id, label, keyText: key, url: (r?.ok ? r.url : "") || "", owner: item.owner, note: item.note, display };
  if (!r) {
    const m = missingReason(live);
    return unavailable(base, m.state, m.message);
  }
  return fromResult(base, r, live.periods);
}

const STATUS_ORDER: Record<Status, number> = { bad: 0, warn: 1, none: 2, good: 3 };

function sortBars(bars: BarView[], sort: ProgressPanel["data"]["sort"]): BarView[] {
  if (sort === "manual") return bars;
  const idx = new Map(bars.map((b, i) => [b.id, i] as const));
  const waiting = (b: BarView): number => (b.state === "ok" || b.state === "error" ? 0 : 1);
  const tie = (a: BarView, b: BarView): number => (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0);
  return bars.slice().sort((a, b) => {
    if (sort === "status") return waiting(a) - waiting(b) || STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.pct - b.pct || tie(a, b);
    const ka = a.state === "ok" ? 0 : 1, kb = b.state === "ok" ? 0 : 1;
    if (ka !== kb) return ka - kb;
    return (sort === "pct-asc" ? a.pct - b.pct : b.pct - a.pct) || tie(a, b);
  });
}

export interface PanelBars {
  bars: BarView[];
  /** A line under the bars about the panel's query: still loading, failed, or cut off at the limit. */
  autoNote: string;
  /** True when the panel's query itself failed. */
  autoFailed: boolean;
}

/** Hand-picked bars followed by the bars the panel's query produces, sorted as the panel asks. */
export function resolveBars(panel: ProgressPanel, live: LiveData): PanelBars {
  const d = panel.data;
  const bars = d.items.map((it) => itemBar(it, live));
  let autoNote = "", autoFailed = false;
  if (d.auto) {
    const res = live.auto[panel.id];
    if (!res) {
      autoNote = missingReason(live).message;
    } else if (!res.ok) {
      autoFailed = true;
      autoNote = res.error || "The Jira query for this panel failed.";
    } else {
      const picked = new Set(d.items.map((it) => (it.source.kind === "issue" ? it.source.key.toUpperCase() : "")).filter(Boolean));
      res.bars.forEach((r, i) => {
        const key = r.key || "";
        if (key && picked.has(key.toUpperCase())) return;
        const base = {
          id: `auto:${key || i}`,
          itemId: null,
          label: (r.ok ? r.title : "") || key || "Jira issue",
          keyText: key,
          url: (r.ok ? r.url : "") || "",
          owner: "",
          note: "",
          display: displayOf(d.autoDisplay),
        };
        bars.push(fromResult(base, r, live.periods));
      });
      if (res.truncated) autoNote = `Showing the first ${res.bars.length} matches. Raise the limit in the panel settings to see more.`;
      else if (!res.bars.length) autoNote = "The Jira query for this panel matches nothing right now.";
    }
  }
  return { bars: sortBars(bars, d.sort), autoNote, autoFailed };
}

/** "62%", "31 / 50 pts" or both, per the bar's format. */
export function valueText(b: BarView): string {
  const pct = `${Math.round(b.pct)}%`;
  const frac = `${fmtNum(b.done)} / ${fmtNum(b.total)}${b.unit ? " " + b.unit : ""}`;
  if (b.display.valueFormat === "percent") return pct;
  if (b.display.valueFormat === "fraction") return frac;
  return `${pct} · ${frac}`;
}

/** The pill next to a bar, only when it says something the bar does not. */
export function barPill(b: BarView): { text: string; status: Status } | null {
  if (b.state !== "ok" || b.emptyText) return null;
  if (b.pct >= 100) return { text: "Done", status: "good" };
  if (b.status === "bad") return { text: "Behind", status: "bad" };
  if (b.status === "warn") return { text: "At risk", status: "warn" };
  return null;
}

/** CSS colour for a bar's fill. */
export function barColor(b: BarView): string {
  const c = b.display.color;
  if (c === "accent") return "var(--accent)";
  if (c === "neutral") return "var(--muted)";
  if (c === "good" || c === "warn" || c === "bad") return `var(--${c})`;
  return b.status === "none" ? "var(--accent)" : `var(--${b.status})`;
}

export interface PortfolioProgress {
  pct: number;
  /** True when the value comes from Jira. */
  live: boolean;
  keyText: string;
  url: string;
  /** Why the manual value is shown although the row is linked. */
  reason: string;
}

/** Progress for a portfolio row: from Jira when it is linked and the link works, else the manual value. */
export function portfolioProgress(item: PortfolioItem, live: LiveData): PortfolioProgress {
  const manual = clamp(Number(item.progress) || 0, 0, 100);
  const src = item.source;
  if (!src) return { pct: manual, live: false, keyText: "", url: "", reason: "" };
  const r = live.progress[item.id];
  const keyText = src.kind === "issue" ? r?.key || src.key : "";
  if (!r) return { pct: manual, live: false, keyText, url: "", reason: missingReason(live).message };
  if (!r.ok) return { pct: manual, live: false, keyText, url: "", reason: r.error || "Jira could not read this link." };
  if (r.total <= 0) {
    return { pct: manual, live: false, keyText, url: r.url || "", reason: r.unit === "points" ? "No estimates yet" : "No issues yet" };
  }
  return { pct: clamp((r.done / r.total) * 100, 0, 100), live: true, keyText, url: r.url || "", reason: "" };
}
