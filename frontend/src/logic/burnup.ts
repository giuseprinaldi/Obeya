/* Burn-up chart: done against scope, day by day, across a PI, a sprint or chosen dates.
   Turns the panel's settings plus the server's daily history into what gets drawn. */
import type { BurnPeriod, BurnupPanel, Status } from "../types";
import { UNIT, barStatus, expectedPct, missingReason, paceDates, type LiveData } from "./progress";
import { addDays, clamp, dayNumber, fmtDate, fmtNum } from "./util";

/** The forecast looks at the pace over this many days, and needs at least FORECAST_MIN of them. */
export const FORECAST_DAYS = 14;
export const FORECAST_MIN = 3;

export const defaultBurnPeriod = (): BurnPeriod => ({ kind: "pi" });

/** "unlinked": no Jira link yet. "noperiod": the PI, sprint or dates it should cover are not known. */
export type BurnState = "ok" | "unlinked" | "noperiod" | "error" | "loading" | "disconnected";

export interface BurnPoint {
  /** ISO date. */
  d: string;
  /** 0 at the first day of the period, 1 at the last. */
  x: number;
  done: number;
  total: number;
}

export interface BurnForecast {
  /** Where the dashed line ends: the day the work would be finished, or the last day of the period. */
  x: number;
  value: number;
  /** "At this pace: done by Dec 3" and the like. */
  text: string;
}

export interface BurnupView {
  state: BurnState;
  /** Shown instead of the chart when state is not "ok". */
  message: string;
  /** The linked issue, for a chart that follows one. */
  keyText: string;
  url: string;
  /** "PI 26.4", "Sprint 14" or "" for chosen dates. */
  periodName: string;
  start: string;
  end: string;
  unit: string;
  /** One point per known day, oldest first, ending today (or on the last day once the period is over). */
  points: BurnPoint[];
  done: number;
  total: number;
  pct: number;
  /** Issues in scope with no estimate, which a chart in story points cannot count. */
  unestimated: number;
  /** Where today falls, 0 to 1. Null before the period starts and after it ends. */
  todayX: number | null;
  /** Percent that should be done by today, on a straight line from nothing at the start to everything at the end. */
  expected: number | null;
  status: Status;
  /** Top of the value axis, and the values to label on it (0 first). */
  max: number;
  ticks: number[];
  forecast: BurnForecast | null;
  /** One line under the numbers: the forecast, or why there is none. "" when there is nothing to say. */
  note: string;
}

const blank = (state: Exclude<BurnState, "ok">, message: string, over: Partial<BurnupView> = {}): BurnupView => ({
  state,
  message,
  keyText: "",
  url: "",
  periodName: "",
  start: "",
  end: "",
  unit: "",
  points: [],
  done: 0,
  total: 0,
  pct: 0,
  unestimated: 0,
  todayX: null,
  expected: null,
  status: state === "error" ? "warn" : "none",
  max: 1,
  ticks: [0, 1],
  forecast: null,
  note: "",
  ...over,
});

/** Round axis values: 0 and up to four more, in steps of 1, 2 or 5 times a power of ten, reaching at least `top`. */
export function axisTicks(top: number): number[] {
  const t = isFinite(top) && top > 0 ? top : 1;
  const rough = t / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = Math.max(1, ([1, 2, 5, 10].find((m) => m * pow >= rough) ?? 10) * pow);
  const out: number[] = [];
  for (let v = 0; v < t + step - 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/** What a period setting is called in a sentence, when its dates are not known. */
function missingPeriod(period: BurnPeriod): string {
  if (period.kind === "pi") return "There is no current PI. Add the PI calendar in Jira settings.";
  if (period.kind === "sprint") return "There is no active sprint. Choose the board to follow in Jira settings.";
  return "Give the chart a start and an end date in the panel settings.";
}

function forecastOf(points: BurnPoint[], done: number, total: number, unit: string, today: string, end: string, span: number): { forecast: BurnForecast | null; note: string } {
  const t = dayNumber(today), e = dayNumber(end);
  const none = { forecast: null, note: "" };
  if (t === null || e === null || total <= 0) return none;
  if (done >= total) return { forecast: null, note: "Everything in scope is done." };
  if (t >= e) return none;
  // The pace is measured from the newest point that is at least two weeks old, or the oldest one there is.
  const dated = points.map((p) => ({ day: dayNumber(p.d) ?? t, done: p.done })).filter((p) => p.day < t);
  const ref = dated.filter((p) => p.day <= t - FORECAST_DAYS).pop() ?? dated[0];
  if (!ref || t - ref.day < FORECAST_MIN) return none;
  const days = t - ref.day;
  const rate = (done - ref.done) / days;
  if (rate <= 0) return { forecast: null, note: `Nothing has been finished in the last ${days} days.` };
  const startDay = e - span;
  const finish = t + Math.ceil((total - done) / rate);
  if (finish <= e) {
    return { forecast: { x: (finish - startDay) / span, value: total, text: `At this pace: done by ${fmtDate(addDays(today, finish - t))}` }, note: "" };
  }
  const value = done + rate * (e - t);
  return { forecast: { x: 1, value, text: `At this pace: ${fmtNum(Math.round(value))} of ${fmtNum(total)}${unit ? ` ${unit}` : ""} by ${fmtDate(end)}` }, note: "" };
}

export function burnupView(panel: BurnupPanel, live: LiveData): BurnupView {
  const src = panel.data.source;
  if (!src) return blank("unlinked", "Link this chart to a Jira issue or query in the panel settings.");
  const r = live.burnups[panel.id];
  const keyText = src.kind === "issue" ? r?.key || src.key : "";
  const link = { keyText, url: (r?.ok ? r.url : "") || "" };
  if (!r) {
    const m = missingReason(live);
    return blank(m.state, m.message, link);
  }
  if (!r.ok) return blank("error", r.error || "Jira could not read this link.", link);

  const dates = paceDates(panel.data.period, live.periods);
  const s = dates ? dayNumber(dates.start) : null, e = dates ? dayNumber(dates.end) : null;
  if (!dates || s === null || e === null || e < s) return blank("noperiod", missingPeriod(panel.data.period), link);
  const today = live.periods.today;
  const t = dayNumber(today) ?? e;
  const span = Math.max(1, e - s);
  const unit = UNIT[r.unit] ?? "issues";

  // The stored days inside the period, then today as the server sees it right now.
  const byDay = new Map<number, BurnPoint>();
  for (const h of r.history ?? []) {
    const day = dayNumber(h.d);
    if (day === null || day < s || day > e || day > t || !isFinite(Number(h.done)) || !isFinite(Number(h.total))) continue;
    byDay.set(day, { d: h.d.slice(0, 10), x: (day - s) / span, done: Number(h.done), total: Number(h.total) });
  }
  if (t >= s && t <= e) byDay.set(t, { d: today, x: (t - s) / span, done: r.done, total: r.total });
  const points = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);

  // Once the period is over the chart stands as it ended, not as the link looks today.
  const last = points[points.length - 1];
  const done = t > e && last ? last.done : r.done;
  const total = t > e && last ? last.total : r.total;
  const pct = total > 0 ? clamp((done / total) * 100, 0, 100) : 0;
  const expected = total > 0 ? expectedPct(panel.data.period, live.periods) : null;
  const { forecast, note } = forecastOf(points, done, total, unit, today, dates.end, span);
  const ticks = axisTicks(Math.max(total, forecast?.value ?? 0, ...points.map((p) => p.total)));

  let line = forecast?.text ?? note;
  if (t < s) line = `${dates.name || "The chart"} starts on ${fmtDate(dates.start)}.`;
  else if (total <= 0) line = r.unit === "points" ? "Nothing in scope has an estimate yet." : "Nothing in scope yet.";

  return {
    state: "ok",
    message: "",
    ...link,
    periodName: dates.name,
    start: dates.start,
    end: dates.end,
    unit,
    points,
    done,
    total,
    pct,
    unestimated: r.unit === "points" && t <= e ? r.unestimated || 0 : 0,
    todayX: t >= s && t <= e ? (t - s) / span : null,
    expected,
    status: total > 0 && t >= s ? barStatus(pct, expected) : "none",
    max: ticks[ticks.length - 1] ?? 1,
    ticks,
    forecast,
    note: line,
  };
}

/** The pill in the chart's header, only when it says something the numbers do not. */
export function burnPill(v: BurnupView): { text: string; status: Status } | null {
  if (v.state !== "ok" || v.total <= 0) return null;
  if (v.pct >= 100) return { text: "Done", status: "good" };
  if (v.status === "bad") return { text: "Behind", status: "bad" };
  if (v.status === "warn") return { text: "At risk", status: "warn" };
  if (v.status === "good" && v.expected !== null) return { text: "On pace", status: "good" };
  return null;
}

/** "56% done, 55% expected by today" for the line under the numbers and for screen readers. */
export function burnSummary(v: BurnupView): string {
  if (v.state !== "ok" || v.total <= 0) return "";
  const head = `${Math.round(v.pct)}% done`;
  if (v.expected === null || v.pct >= 100) return head;
  return `${head}, ${Math.round(v.expected)}% expected by today`;
}

/** "4 unestimated", for a chart in story points with issues it cannot count. "" otherwise. */
export const burnUnestimated = (v: BurnupView): string => (v.unestimated > 0 ? `${v.unestimated} unestimated` : "");

/** The point nearest to a position along the chart (0 to 1), for the hover read-out. */
export function nearestPoint(points: BurnPoint[], x: number): BurnPoint | null {
  let best: BurnPoint | null = null;
  for (const p of points) if (!best || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
  return best;
}

/** What the straight "ideal" line reads at a position along the chart. */
export const idealAt = (v: BurnupView, x: number): number => v.total * clamp(x, 0, 1);
