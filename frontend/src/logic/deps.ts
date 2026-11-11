/* Dependencies and risks: what a dependencies panel shows from the server's reading of Jira's issue
   links, and how a manual risk register is ordered and judged. */
import type { DepIssue, DepSource, DependenciesPanel, Dependency, RiskItem, Roam, Severity, Status } from "../types";
import { missingReason, type LiveData } from "./progress";
import { clamp } from "./util";

/* ---------- Dependencies ---------- */

export const DEP_LIMIT_MIN = 1;
export const DEP_LIMIT_MAX = 50;

export const defaultDepSource = (jql = ""): DepSource => ({ jql, linkTypes: [], showDone: false, limit: 12 });

/** Query presets offered in the panel settings. */
export const DEP_PRESETS: { label: string; jql: string }[] = [
  { label: "Current PI", jql: '{PI_FIELD} = "{PI}"' },
  { label: "Current sprint", jql: "sprint in openSprints()" },
  { label: "Open work in a project", jql: "project = PLAT AND statusCategory != Done" },
];

/** "waiting": work that is under way cannot finish until something unfinished does: the one to act on.
    "open": a dependency that is not settled yet, on work that has not started.
    "done": settled: the issue waited on is done, or the waiting issue finished anyway. */
export type DepState = "waiting" | "open" | "done";

export function depState(d: Dependency): DepState {
  if (d.on.category === "done" || d.waiting.category === "done") return "done";
  return d.waiting.category === "indeterminate" ? "waiting" : "open";
}

export const isCrossTeam = (d: Dependency): boolean => !!d.waiting.project && !!d.on.project && d.waiting.project !== d.on.project;

export interface DepRow {
  id: string;
  state: DepState;
  /** "Waiting now", "Open" or "Settled". */
  label: string;
  status: Status;
  waiting: DepIssue;
  on: DepIssue;
  crossTeam: boolean;
  type: string;
}

const LABEL: Record<DepState, [string, Status]> = {
  waiting: ["Waiting now", "bad"],
  open: ["Open", "none"],
  done: ["Settled", "good"],
};

export type DepsState = "ok" | "unlinked" | "error" | "loading" | "disconnected";

export interface DepsView {
  state: DepsState;
  /** Shown instead of the list when state is not "ok". */
  message: string;
  rows: DepRow[];
  /** Counts over everything the server sent, not just the rows shown. */
  waiting: number;
  open: number;
  done: number;
  crossTeam: number;
  /** Rows left out by the limit. */
  more: number;
  /** One line under the list: totals, and what is not shown. "" when there is nothing to add. */
  footer: string;
  /** Shown when there is nothing to list. */
  empty: string;
}

const none = (state: Exclude<DepsState, "ok">, message: string): DepsView => ({ state, message, rows: [], waiting: 0, open: 0, done: 0, crossTeam: 0, more: 0, footer: "", empty: "" });

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function depsView(panel: DependenciesPanel, live: LiveData): DepsView {
  const src = panel.data.source;
  if (!src) return none("unlinked", "Choose the Jira query whose dependencies to show in the panel settings.");
  const r = live.deps[panel.id];
  if (!r) {
    const m = missingReason(live);
    return none(m.state, m.message);
  }
  if (!r.ok) return none("error", r.error || "Jira could not read these dependencies.");

  const all = (r.deps ?? []).map((d, i): DepRow => {
    const state = depState(d);
    const [label, status] = LABEL[state];
    return { id: `${d.waiting.key}>${d.on.key}:${d.type}:${i}`, state, label, status, waiting: d.waiting, on: d.on, crossTeam: isCrossTeam(d), type: d.type };
  });
  const waiting = all.filter((d) => d.state === "waiting").length;
  const done = all.filter((d) => d.state === "done").length;
  const open = all.length - waiting - done;
  const live_ = all.filter((d) => d.state !== "done");
  const listed = src.showDone ? all : live_;
  const limit = clamp(Math.round(Number(src.limit) || 12), DEP_LIMIT_MIN, DEP_LIMIT_MAX);
  const rows = listed.slice(0, limit);
  // The server sends at most 200; anything beyond that is counted but cannot be listed.
  const more = listed.length - rows.length + Math.max(0, r.total - all.length);

  const parts: string[] = [];
  if (waiting + open) parts.push(`${count(waiting + open, "open dependency", "open dependencies")}${waiting ? `, ${waiting} holding up work under way` : ""}`);
  const cross = live_.filter((d) => d.crossTeam).length;
  if (cross) parts.push(`${cross} across teams`);
  if (done && !src.showDone) parts.push(`${done} settled, not shown`);
  if (more > 0) parts.push(`${more} more not shown`);
  const empty = rows.length
    ? ""
    : done && !src.showDone
      ? `Nothing is waiting on anything: all ${count(done, "dependency", "dependencies")} here are settled.`
      : `No dependencies between the ${count(r.scope, "issue")} this query finds. They are read from Jira's issue links.`;
  return { state: "ok", message: "", rows, waiting, open, done, crossTeam: cross, more, footer: rows.length ? parts.join(" · ") : "", empty };
}

/* ---------- Risks (ROAM) ---------- */

export const ROAMS: Roam[] = ["Open", "Owned", "Accepted", "Mitigated", "Resolved"];

/** What each ROAM state means, for the editor. */
export const ROAM_HINT = "Open: nobody has taken it yet. Owned: someone is working on it. Accepted: we live with it. Mitigated: its effect has been reduced. Resolved: no longer a risk.";

/** A risk still needs attention while it is open or owned. */
export const riskLive = (r: Pick<RiskItem, "roam">): boolean => r.roam === "Open" || r.roam === "Owned";

/** Red for a high-impact risk nobody has taken, amber for anything else still live, green once it is dealt with. */
export function riskStatus(r: Pick<RiskItem, "roam" | "impact">): Status {
  if (!riskLive(r)) return "good";
  return r.roam === "Open" && r.impact === "High" ? "bad" : "warn";
}

const IMPACT_ORDER: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };

/** Live risks first, the biggest and least looked-after at the top; dealt-with risks last. */
export function sortRisks(items: RiskItem[]): RiskItem[] {
  const idx = new Map(items.map((r, i) => [r.id, i] as const));
  return items.slice().sort(
    (a, b) =>
      Number(!riskLive(a)) - Number(!riskLive(b)) ||
      (IMPACT_ORDER[a.impact] ?? 1) - (IMPACT_ORDER[b.impact] ?? 1) ||
      ROAMS.indexOf(a.roam) - ROAMS.indexOf(b.roam) ||
      (idx.get(a.id) ?? 0) - (idx.get(b.id) ?? 0),
  );
}
