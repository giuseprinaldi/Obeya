/* How a Jira-linked bar has moved: the change over the last week and a small line of percent done.
   Worked out from the daily history the server keeps for each link. */
import type { HistoryPoint } from "../types";
import { clamp, dayNumber, fmtNum } from "./util";

/** The change next to a bar looks this many days back. */
export const TREND_DAYS = 7;
/** The small line covers this many days. */
export const SPARK_DAYS = 30;

export interface BarTrend {
  /** Change in the done amount since `days` ago. */
  delta: number;
  /** Change in the total (the scope) over the same days. */
  scopeDelta: number;
  /** How far back the comparison reaches: TREND_DAYS, fewer while the history is still short,
      more when the server missed some days. */
  days: number;
  /** Percent done over the last SPARK_DAYS, oldest first, ending today. x runs 0 to 1 across those days. */
  points: { x: number; pct: number }[];
}

const pctOf = (done: number, total: number): number => (total > 0 ? clamp((done / total) * 100, 0, 100) : 0);

/** Null when there is nothing older than today to compare with. */
export function barTrend(history: HistoryPoint[] | undefined, now: { done: number; total: number }, today: string): BarTrend | null {
  const t = dayNumber(today);
  if (t === null) return null;
  const past = (history ?? [])
    .map((h) => ({ day: dayNumber(h.d), done: Number(h.done), total: Number(h.total) }))
    .filter((h): h is { day: number; done: number; total: number } => h.day !== null && h.day < t && isFinite(h.done) && isFinite(h.total))
    .sort((a, b) => a.day - b.day);
  if (!past.length) return null;
  // The newest point that is at least a week old; while the history is shorter than that, the oldest one.
  const ref = past.filter((h) => h.day <= t - TREND_DAYS).pop() ?? past[0]!;
  const points = past.filter((h) => h.day >= t - SPARK_DAYS).map((h) => ({ x: (h.day - (t - SPARK_DAYS)) / SPARK_DAYS, pct: pctOf(h.done, h.total) }));
  points.push({ x: 1, pct: pctOf(now.done, now.total) });
  return { delta: now.done - ref.done, scopeDelta: now.total - ref.total, days: t - ref.day, points };
}

/** "+4", "0" or "−2" (with a real minus sign). */
export const signed = (n: number): string => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(-n)}` : "0");

/** "+4 in 7d", "0 in 7d", "−2 in 3d". */
export function trendText(t: BarTrend): string {
  return `${signed(t.delta)} in ${t.days}d`;
}

/** The same in a full sentence, with what happened to the scope: for the tooltip and screen readers. */
export function trendTitle(t: BarTrend, unit: string): string {
  const days = `${t.days} ${t.days === 1 ? "day" : "days"}`;
  // "1 issue", "1 pt": the units arrive in the plural.
  const u = !unit ? "" : ` ${Math.abs(t.delta) === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit}`;
  const done =
    t.delta > 0 ? `${fmtNum(t.delta)}${u} more done than ${days} ago` : t.delta < 0 ? `${fmtNum(-t.delta)}${u} fewer done than ${days} ago` : `Nothing more done than ${days} ago`;
  const scope = t.scopeDelta > 0 ? `; the scope grew by ${fmtNum(t.scopeDelta)}` : t.scopeDelta < 0 ? `; the scope shrank by ${fmtNum(-t.scopeDelta)}` : "";
  return `${done}${scope}.`;
}

/** SVG polyline points for the small line, in a box of the given size. The scale follows the values,
    so small movements still show; a flat history is drawn as a flat line through the middle. */
export function sparkPath(points: BarTrend["points"], width: number, height: number, pad = 2): string {
  if (points.length < 2) return "";
  const values = points.map((p) => p.pct);
  const lo = Math.min(...values), hi = Math.max(...values);
  const y = (v: number): number => (hi === lo ? height / 2 : height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad));
  return points.map((p) => `${(pad + p.x * (width - 2 * pad)).toFixed(1)},${y(p.pct).toFixed(1)}`).join(" ");
}
