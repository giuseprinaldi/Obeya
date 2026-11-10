/* KPIs: the hand-entered or Jira-fed value behind a tile, and the options each Jira metric takes. */
import type { KpiItem, Metric, MetricKind, Status } from "../types";
import { missingReason, type LiveData } from "./progress";

/** Green, amber or red for a value against its target. "none" without a value or a target. */
export function kpiStatus(k: Pick<KpiItem, "actual" | "target" | "dir">): Status {
  const a = Number(k.actual), t = Number(k.target);
  if (k.actual === "" || k.actual == null || k.target === "" || k.target == null || !isFinite(a) || !isFinite(t)) return "none";
  if (k.dir === "down") {
    if (a <= t) return "good";
    return (t === 0 ? a <= 1 : a <= t * 1.1) ? "warn" : "bad";
  }
  if (a >= t) return "good";
  return a >= t * 0.9 ? "warn" : "bad";
}

/** "manual" = hand-entered. The others are Jira: a value, nothing to measure yet, a failed
    metric, or no answer from the server yet (loading, or Jira is not connected). */
export type KpiState = "manual" | "ok" | "empty" | "error" | "loading" | "disconnected";

export interface EffectiveKpi {
  state: KpiState;
  /** True when the item has a Jira metric, whatever its state. */
  jira: boolean;
  /** The number on the tile. "" when there is none to show. */
  actual: number | "";
  /** Sparkline values, oldest first. */
  history: number[];
  unit: string;
  status: Status;
  /** "▲", "▼", "→" or "" from the last two history values. */
  trend: string;
  /** Shown in the tile in place of a value: why there is none. "" when there is a value. */
  message: string;
  /** One line explaining a Jira value. "" for hand-entered KPIs. */
  detail: string;
}

const SPARK_POINTS = 12;

function trendOf(history: number[]): string {
  const h = history.filter((n) => isFinite(n));
  if (h.length < 2) return "";
  const diff = h[h.length - 1]! - h[h.length - 2]!;
  if (Math.abs(diff) < 1e-9) return "→";
  return diff > 0 ? "▲" : "▼";
}

/** The one place that decides what a KPI tile shows: its value, history, unit, status and trend.
    A KPI with a Jira metric never falls back to its hand-entered value. */
export function effectiveKpi(item: KpiItem, live: LiveData): EffectiveKpi {
  if (!item.metric) {
    const history = item.history.map(Number).filter((n) => isFinite(n));
    return { state: "manual", jira: false, actual: item.actual, history, unit: item.unit, status: kpiStatus(item), trend: trendOf(history), message: "", detail: "" };
  }
  const none = { jira: true, actual: "" as const, history: [], unit: item.unit, status: "none" as const, trend: "", detail: "" };
  const r = live.metrics[item.id];
  if (!r) {
    const m = missingReason(live);
    return { ...none, state: m.state, message: m.message };
  }
  if (!r.ok) return { ...none, state: "error", message: r.error || "Jira could not work out this KPI." };
  const unit = item.unit || r.unit || "";
  const history = (r.history ?? []).map((p) => Number(p.value)).filter((n) => isFinite(n)).slice(-SPARK_POINTS);
  if (r.value === null || r.value === undefined || !isFinite(Number(r.value))) {
    return { ...none, state: "empty", unit, history, message: r.detail || "Nothing to measure yet", detail: r.detail || "" };
  }
  const actual = Number(r.value);
  return {
    state: "ok",
    jira: true,
    actual,
    history,
    unit,
    status: kpiStatus({ actual, target: item.target, dir: item.dir }),
    trend: trendOf(history),
    message: "",
    detail: r.detail || "",
  };
}

/* ---------- Jira metrics ---------- */

export interface MetricInfo {
  label: string;
  /** One line under the picker saying what the number means. */
  explain: string;
  /** Defaults filled into the KPI when the kind is picked. */
  name: string;
  unit: string;
  dir: "up" | "down";
  /** Which options apply to this kind. */
  window: boolean;
  stat: boolean;
  measure: boolean;
}

export const METRICS: Record<MetricKind, MetricInfo> = {
  cycle_time: { label: "Cycle time", explain: "Days from first in progress to done, for work finished in the look-back window.", name: "Cycle time", unit: "days", dir: "down", window: true, stat: true, measure: false },
  lead_time: { label: "Lead time", explain: "Days from created to done, for work finished in the look-back window.", name: "Lead time", unit: "days", dir: "down", window: true, stat: true, measure: false },
  throughput: { label: "Throughput", explain: "Items finished per week, averaged over the look-back window.", name: "Throughput", unit: "/ week", dir: "up", window: true, stat: false, measure: false },
  scope_done: { label: "Scope done", explain: "Share of the scope that is done right now.", name: "Scope done", unit: "%", dir: "up", window: false, stat: false, measure: true },
  wip: { label: "Work in progress", explain: "How much is in progress right now.", name: "Work in progress", unit: "items", dir: "down", window: false, stat: false, measure: true },
  blocked_now: { label: "Blocked items", explain: "Items blocked right now, by the rules under Blocked means in Jira settings.", name: "Blocked items", unit: "", dir: "down", window: false, stat: false, measure: false },
  blocked_days: { label: "Blocked days", explain: "Total days items spent blocked during the look-back window.", name: "Blocked days", unit: "days", dir: "down", window: true, stat: false, measure: false },
  unplanned: { label: "Unplanned work", explain: "Share of the scope that is unplanned, by the rule chosen below.", name: "Unplanned work", unit: "%", dir: "down", window: false, stat: false, measure: true },
};

export const METRIC_KINDS = Object.keys(METRICS) as MetricKind[];

export const WINDOW_MIN = 7;
export const WINDOW_MAX = 365;

export const defaultMetric = (kind: MetricKind = "cycle_time"): Metric => ({
  kind,
  boardId: null,
  jql: "",
  windowDays: 30,
  stat: "median",
  measure: "count",
  doneStatuses: [],
  unplanned: { rule: "added_after_start" },
});

/** The unit a kind defaults to. Work in progress follows its measure. */
export function metricUnit(m: Pick<Metric, "kind" | "measure">): string {
  if (m.kind === "wip") return m.measure === "points" ? "pts" : "items";
  return METRICS[m.kind].unit;
}

export interface KpiLabels {
  name: string;
  unit: string;
  dir: "up" | "down";
}

/** Name, unit and direction after the metric changes from `prev` to `next` (prev is null when the KPI
    was not Jira-fed before). Name and unit are replaced with the new defaults only when they are empty
    or still the old defaults, so anything the user typed is kept; the direction follows the name. */
export function relabel(current: KpiLabels, prev: Pick<Metric, "kind" | "measure"> | null, next: Pick<Metric, "kind" | "measure">): KpiLabels {
  const name = current.name.trim(), unit = current.unit.trim();
  const freshName = !name || (prev !== null && name === METRICS[prev.kind].name);
  const freshUnit = !unit || (prev !== null && unit === metricUnit(prev));
  return {
    name: freshName ? METRICS[next.kind].name : current.name,
    unit: freshUnit ? metricUnit(next) : current.unit,
    dir: freshName ? METRICS[next.kind].dir : current.dir,
  };
}

/** What stops a metric from being saved, or "". */
export function metricError(m: Metric): string {
  if (m.boardId === null && !m.jql.trim()) return "Choose a board or enter a Jira query, so the KPI knows which work to measure.";
  const info = METRICS[m.kind];
  if (info.window && !(Number.isFinite(m.windowDays) && m.windowDays >= WINDOW_MIN && m.windowDays <= WINDOW_MAX)) {
    return `The look-back window must be between ${WINDOW_MIN} and ${WINDOW_MAX} days.`;
  }
  if (m.kind === "unplanned") {
    if (m.unplanned.rule === "added_after_start" && m.boardId === null) return "\"Added after the sprint started\" needs a board. Choose one, or pick another rule.";
    if (m.unplanned.rule !== "added_after_start" && !m.unplanned.values.length) {
      return m.unplanned.rule === "labels" ? "List at least one label that marks unplanned work." : "List at least one issue type that counts as unplanned.";
    }
  }
  return "";
}
