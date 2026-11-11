/* Status rules: what counts as off target, late, blocked or behind, and how that rolls up. */
import type { ActionItem, Panel, Status } from "../types";
import { boardView } from "./board";
import { burnupView } from "./burnup";
import { depsView, riskLive, riskStatus } from "./deps";
import { effectiveKpi } from "./kpi";
import { resolveBars, type LiveData } from "./progress";

export { kpiStatus } from "./kpi";

export const isLate = (a: ActionItem, today: string): boolean => !a.done && !!a.due && a.due < today;

export interface Signals {
  kpiBad: number;
  kpiWarn: number;
  blocked: number;
  overWip: number;
  late: number;
  openHigh: number;
  open: number;
  off: number;
  risk: number;
  /** Progress bars and burn-up charts behind pace. */
  barBad: number;
  /** Progress bars and burn-up charts at risk of falling behind. */
  barWarn: number;
  /** Jira links that failed: bars, panel queries, Jira KPIs, Jira boards and burn-up charts. */
  jiraFailing: number;
  /** Work under way that has gone quiet: in-progress Jira cards nobody has updated, and started bars
      with no progress, each for as long as its panel's threshold. */
  stale: number;
  /** Work under way that is held up by a dependency on something unfinished. */
  waiting: number;
  items: number;
}

export function signals(panels: Panel[], live: LiveData): Signals {
  const s: Signals = { kpiBad: 0, kpiWarn: 0, blocked: 0, overWip: 0, late: 0, openHigh: 0, open: 0, off: 0, risk: 0, barBad: 0, barWarn: 0, jiraFailing: 0, stale: 0, waiting: 0, items: 0 };
  const today = live.periods.today;
  for (const p of panels) {
    switch (p.type) {
      case "kpi":
        for (const k of p.data.items) {
          s.items++;
          const e = effectiveKpi(k, live);
          if (e.state === "error") s.jiraFailing++;
          if (e.status === "bad") s.kpiBad++;
          else if (e.status === "warn") s.kpiWarn++;
        }
        break;
      case "kanban": {
        const board = boardView(p, live);
        if (board) {
          // A Jira-fed board feeds the same counters as a manual one.
          if (board.state === "error") s.jiraFailing++;
          s.items += board.total;
          s.blocked += board.blocked;
          s.overWip += board.overWip;
          s.stale += board.stale;
          break;
        }
        const cols = p.data.columns;
        const last = cols.length ? cols[cols.length - 1]!.id : null;
        for (const c of p.data.cards) {
          s.items++;
          if (c.blocked && c.col !== last) s.blocked++;
        }
        for (const c of cols) {
          if (Number(c.wip) > 0 && p.data.cards.filter((x) => x.col === c.id).length > Number(c.wip)) s.overWip++;
        }
        break;
      }
      case "actions":
        for (const a of p.data.items) {
          s.items++;
          if (isLate(a, today)) s.late++;
        }
        break;
      case "problems":
        for (const x of p.data.items) {
          s.items++;
          if (x.stage !== "Closed") {
            s.open++;
            if (x.severity === "High") s.openHigh++;
          }
        }
        break;
      case "portfolio":
        for (const x of p.data.items) {
          s.items++;
          if (x.health === "off") s.off++;
          else if (x.health === "risk") s.risk++;
        }
        break;
      case "progress": {
        const r = resolveBars(p, live);
        if (r.autoFailed) s.jiraFailing++;
        for (const b of r.bars) {
          if (b.state === "error") s.jiraFailing++;
          if (b.state !== "ok") continue;
          s.items++;
          if (b.status === "bad") s.barBad++;
          else if (b.status === "warn") s.barWarn++;
          if (b.stale) s.stale++;
        }
        break;
      }
      case "burnup": {
        // A chart counts like one bar: behind pace, at risk, or a link that failed.
        const v = burnupView(p, live);
        if (v.state === "error") s.jiraFailing++;
        if (v.state !== "ok" || v.total <= 0) break;
        s.items++;
        if (v.status === "bad") s.barBad++;
        else if (v.status === "warn") s.barWarn++;
        break;
      }
      case "risks":
        // A live risk keeps the panel amber, like an open problem; a high one nobody has taken is red.
        for (const r of p.data.items) {
          s.items++;
          if (riskLive(r)) s.open++;
          if (riskStatus(r) === "bad") s.openHigh++;
        }
        break;
      case "dependencies": {
        const v = depsView(p, live);
        if (v.state === "error") s.jiraFailing++;
        s.items += v.waiting + v.open;
        s.waiting += v.waiting;
        break;
      }
      case "statement":
        break;
    }
  }
  return s;
}

/** Things that need attention now: these raise the red flag on a wall's tab. */
export const badCount = (s: Signals): number => s.kpiBad + s.blocked + s.late + s.openHigh + s.off + s.barBad + s.waiting;

/** Things to watch on a wall's screen in the room plan. */
export const watchCount = (s: Signals): number => s.kpiWarn + s.risk + s.overWip + s.barWarn + s.jiraFailing + s.stale;

export function panelStatus(p: Panel, live: LiveData): Status {
  if (p.type === "statement") return "none";
  const s = signals([p], live);
  if (badCount(s)) return "bad";
  if (watchCount(s) + s.open) return "warn";
  return s.items ? "good" : "none";
}

export function wallStatus(s: Signals): Status {
  return badCount(s) ? "bad" : watchCount(s) ? "warn" : "good";
}

export interface Chip {
  text: string;
  status: Status;
}

export function chipList(s: Signals): Chip[] {
  const out: Chip[] = [];
  const add = (n: number, label: string, status: Status): void => {
    if (n) out.push({ text: `${n} ${label}`, status });
  };
  add(s.kpiBad, s.kpiBad > 1 ? "KPIs off target" : "KPI off target", "bad");
  add(s.off, "off track", "bad");
  add(s.blocked, "blocked", "bad");
  add(s.late, "late", "bad");
  add(s.openHigh, "high severity", "bad");
  add(s.barBad, "behind pace", "bad");
  add(s.waiting, "waiting on a dependency", "bad");
  add(s.kpiWarn, "near target", "warn");
  add(s.risk + s.barWarn, "at risk", "warn");
  add(s.overWip, "over WIP", "warn");
  add(s.stale, "stale", "warn");
  add(s.jiraFailing, s.jiraFailing > 1 ? "Jira links failing" : "Jira link failing", "warn");
  if (!out.length) out.push({ text: "All clear", status: "good" });
  return out;
}
