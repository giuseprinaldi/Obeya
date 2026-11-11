/* Example walls and room templates. Everything here is example data, and is marked as such on screen. */
import type {
  ActionsPanel,
  AccentKey,
  BarDisplay,
  BurnPeriod,
  BurnupPanel,
  DependenciesPanel,
  RisksPanel,
  Roam,
  JiraSource,
  KanbanPanel,
  KpiPanel,
  Metric,
  Panel,
  PanelType,
  PortfolioItem,
  PortfolioPanel,
  ProblemsPanel,
  ProgressBarItem,
  ProgressPanel,
  Room,
  Severity,
  Span,
  Stage,
  StatementPanel,
  Wall,
} from "../types";
import { defaultBoardSource } from "./board";
import { defaultDepSource } from "./deps";
import { defaultMetric } from "./kpi";
import { defaultDisplay, defaultJiraOptions } from "./progress";
import { BAR_STALE_DEFAULT } from "./stale";
import { dayOffset, uid } from "./util";

export const ACCENTS: Record<AccentKey, { name: string; l: string; d: string }> = {
  cobalt: { name: "Cobalt", l: "#2756c9", d: "#7ea2ff" },
  signal: { name: "Signal orange", l: "#c4521a", d: "#ff9a5c" },
  teal: { name: "Teal", l: "#0d7c7d", d: "#45c6c2" },
  crimson: { name: "Crimson", l: "#ad2843", d: "#ff7a91" },
  graphite: { name: "Graphite", l: "#3a4756", d: "#b9c6d4" },
};

export const STAGES: Stage[] = ["Define", "Analyze", "Countermeasure", "Verify", "Closed"];
export const SEVERITIES: Severity[] = ["High", "Medium", "Low"];

export const PANEL_TYPES: Record<PanelType, { label: string; desc: string; item: string }> = {
  statement: { label: "Statement", desc: "True north, goal or focus", item: "" },
  kpi: { label: "KPI tracker", desc: "Actual vs target with trend", item: "KPI" },
  portfolio: { label: "Portfolio", desc: "Initiatives with health and progress", item: "Initiative" },
  progress: { label: "Progress bars", desc: "Jira-linked or manual progress", item: "Bar" },
  burnup: { label: "Burn-up chart", desc: "Done against scope over a PI or sprint", item: "" },
  dependencies: { label: "Dependencies", desc: "What waits on what, from Jira links", item: "" },
  risks: { label: "Risks", desc: "Risk register with ROAM status", item: "Risk" },
  problems: { label: "Problem solving", desc: "Problems moving through A3 stages", item: "Problem" },
  actions: { label: "Action tracker", desc: "Owners, due dates, done", item: "Action" },
  kanban: { label: "Flow board", desc: "Columns with WIP limits", item: "Card" },
};

/** "initiative", "card", "KPI": the item name as it reads inside a sentence. */
export const itemNoun = (type: PanelType): string => {
  const n = PANEL_TYPES[type].item;
  return n === "KPI" ? n : n.toLowerCase();
};

export const SPANS: [Span, string][] = [
  [1, "One third"],
  [2, "Two thirds"],
  [3, "Full width"],
];

/** An empty panel of the given type, as created by "Add panel". */
export function newPanel(type: PanelType, title: string, span: Span): Panel {
  const base = { id: uid(), title, span };
  switch (type) {
    case "statement":
      return { ...base, type, data: { text: "Write the statement here.", meta: "" } };
    case "kanban":
      return {
        ...base,
        type,
        data: {
          columns: [
            { id: uid(), name: "To do", wip: 0 },
            { id: uid(), name: "Doing", wip: 3 },
            { id: uid(), name: "Done", wip: 0 },
          ],
          cards: [],
          jira: null,
        },
      };
    case "progress":
      return { ...base, type, data: { items: [], auto: null, autoDisplay: defaultDisplay(), sort: "manual", showKeys: true, showTrend: true, staleDays: BAR_STALE_DEFAULT } };
    case "burnup":
      return { ...base, type, data: { source: null, period: { kind: "pi" } } };
    case "dependencies":
      return { ...base, type, data: { source: null } };
    case "risks":
      return { ...base, type, data: { items: [] } };
    case "kpi":
      return { ...base, type, data: { items: [] } };
    case "portfolio":
      return { ...base, type, data: { items: [] } };
    case "problems":
      return { ...base, type, data: { items: [] } };
    case "actions":
      return { ...base, type, data: { items: [] } };
  }
}

/* ---------- Builders for the example content ---------- */

type KpiRow = [name: string, unit: string, target: number, actual: number, dir: "up" | "down", history: number[], metric?: Metric];
type PortfolioRow = [name: string, owner: string, health: PortfolioItem["health"], progress: number, horizon: string, note: string, issueKey?: string];
type ProblemRow = [title: string, owner: string, severity: Severity, stage: Stage, problem: string, cause: string, countermeasure: string];
type ActionRow = [text: string, owner: string, dueInDays: number, done: boolean];
type CardRow = [title: string, column: number, owner: string, tag: string, blocked?: boolean];
type RiskRow = [title: string, owner: string, impact: Severity, roam: Roam, note: string];

const issueLink = (key: string): JiraSource => ({ kind: "issue", key, ...defaultJiraOptions() });

const P = {
  statement: (title: string, text: string, meta: string, span: Span = 1): StatementPanel => ({ id: uid(), type: "statement", title, span, data: { text, meta } }),
  kpi: (title: string, rows: KpiRow[], span: Span = 3): KpiPanel => ({
    id: uid(),
    type: "kpi",
    title,
    span,
    data: { items: rows.map(([name, unit, target, actual, dir, history, metric]) => ({ id: uid(), name, unit, target, actual, dir, history, metric: metric ?? null })) },
  }),
  portfolio: (title: string, rows: PortfolioRow[], span: Span = 3): PortfolioPanel => ({
    id: uid(),
    type: "portfolio",
    title,
    span,
    data: {
      items: rows.map(([name, owner, health, progress, horizon, note, issueKey]) => ({
        id: uid(),
        name,
        owner,
        health,
        progress,
        horizon,
        note,
        source: issueKey ? issueLink(issueKey) : null,
      })),
    },
  }),
  problems: (title: string, rows: ProblemRow[], span: Span = 2): ProblemsPanel => ({
    id: uid(),
    type: "problems",
    title,
    span,
    data: { items: rows.map(([t, owner, severity, stage, problem, cause, countermeasure]) => ({ id: uid(), title: t, owner, severity, stage, problem, cause, countermeasure })) },
  }),
  actions: (title: string, rows: ActionRow[], span: Span = 1): ActionsPanel => ({
    id: uid(),
    type: "actions",
    title,
    span,
    data: { items: rows.map(([text, owner, off, done]) => ({ id: uid(), text, owner, due: dayOffset(off), done })) },
  }),
  kanban: (title: string, cols: [string, number][], cards: CardRow[], span: Span = 3, jira: KanbanPanel["data"]["jira"] = null): KanbanPanel => {
    const columns = cols.map(([name, wip]) => ({ id: uid(), name, wip }));
    return {
      id: uid(),
      type: "kanban",
      title,
      span,
      data: {
        columns,
        cards: cards.map(([t, ci, owner, tag, blocked]) => ({ id: uid(), title: t, col: columns[ci]?.id ?? columns[0]!.id, owner, tag, blocked: !!blocked })),
        jira,
      },
    };
  },
  progress: (title: string, items: ProgressBarItem[], extra: Partial<ProgressPanel["data"]>, span: Span = 3): ProgressPanel => ({
    id: uid(),
    type: "progress",
    title,
    span,
    data: { items, auto: null, autoDisplay: defaultDisplay(), sort: "manual", showKeys: true, showTrend: true, staleDays: BAR_STALE_DEFAULT, ...extra },
  }),
  burnup: (title: string, source: JiraSource, period: BurnPeriod, span: Span = 2): BurnupPanel => ({ id: uid(), type: "burnup", title, span, data: { source, period } }),
  dependencies: (title: string, jql: string, span: Span = 2): DependenciesPanel => ({ id: uid(), type: "dependencies", title, span, data: { source: defaultDepSource(jql) } }),
  risks: (title: string, rows: RiskRow[], span: Span = 1): RisksPanel => ({
    id: uid(),
    type: "risks",
    title,
    span,
    data: { items: rows.map(([t, owner, impact, roam, note]) => ({ id: uid(), title: t, owner, impact, roam, note })) },
  }),
};

const paced = (pace: BarDisplay["pace"]): BarDisplay => ({ ...defaultDisplay(), pace });

/** The Jira board and scope the example room reads from. They exist in the fake Jira; on a real one, pick your own. */
const EXAMPLE_BOARD = 1;
const EXAMPLE_SCOPE = "project = PLAT";
const onBoard = (kind: Metric["kind"], over: Partial<Metric> = {}): Metric => ({ ...defaultMetric(kind), boardId: EXAMPLE_BOARD, ...over });
const inScope = (kind: Metric["kind"], over: Partial<Metric> = {}): Metric => ({ ...defaultMetric(kind), jql: EXAMPLE_SCOPE, ...over });

type WallSeed = Omit<Wall, "id">;

export const LIBRARY: Record<string, { name: string; build: () => WallSeed }> = {
  direction: {
    name: "Direction",
    build: () => ({
      name: "Direction",
      subtitle: "Why we exist and where we are heading",
      panels: [
        P.statement("True north", "Every architecture decision is visible, traceable and made at the speed the mission needs.", "Owner: leadership team · Reviewed quarterly", 2),
        P.statement("Focus this quarter", "Two delivery teams use the proposal pipeline every sprint.", "Checked at the monthly ops review", 1),
        P.portfolio(
          "Strategic portfolio",
          [
            ["Feature proposal pipeline", "Program lead", "risk", 45, "Q4 2026", "Hosting and sign-in still open", "PLAT-1"],
            ["Data platform modernization", "Data lead", "on", 70, "Q1 2027", "Models in review", "DATA-1"],
            ["Architecture decision records", "Chief architect", "on", 85, "Q4 2026", "Template adopted by 3 teams"],
            ["Toolchain security review", "Security liaison", "off", 20, "Q4 2026", "Waiting on exception decision"],
            ["Team onboarding playbook", "Scrum master", "on", 55, "Q1 2027", ""],
          ],
          3,
        ),
      ],
    }),
  },
  performance: {
    name: "Performance",
    build: () => ({
      name: "Performance",
      subtitle: "Are we getting better? Targets, actuals and trend",
      panels: [
        P.kpi(
          "Delivery and flow",
          [
            ["Lead time for change", "days", 5, 7.5, "down", [12, 11, 10, 9.5, 8, 7.5], inScope("lead_time")],
            ["Cycle time", "days", 4, 4.5, "down", [7, 6.5, 6, 5, 5.2, 4.5], inScope("cycle_time")],
            ["Throughput", "/ week", 6, 5, "up", [3, 4, 4, 5, 6, 5], inScope("throughput")],
            ["Deploys per week", "", 10, 9, "up", [4, 5, 6, 7, 8, 9]],
            ["Change failure rate", "%", 10, 14, "down", [18, 17, 15, 16, 15, 14]],
            ["Proposals reviewed", "/ month", 12, 13, "up", [5, 7, 8, 10, 11, 13]],
            ["Review turnaround", "days", 3, 2.5, "down", [6, 5, 4.5, 4, 3, 2.5]],
            ["Stakeholder satisfaction", "/ 5", 4.2, 3.9, "up", [3.4, 3.5, 3.7, 3.6, 3.8, 3.9]],
          ],
          3,
        ),
        // The epics of the current PI, measured by the story points under them: it follows the PI by itself.
        P.burnup("PI burn-up", { kind: "jql", jql: 'issuetype = Epic AND {PI_FIELD} = "{PI}"', descend: true, ...defaultJiraOptions(), measure: "points" }, { kind: "pi" }, 2),
        P.burnup("Sprint burn-up", { kind: "jql", jql: "sprint in openSprints()", descend: false, ...defaultJiraOptions(), measure: "points" }, { kind: "sprint" }, 1),
      ],
    }),
  },
  delivery: {
    name: "Delivery",
    build: () => ({
      name: "Delivery",
      subtitle: "Current sprint flow across the program",
      panels: [
        P.statement("Sprint goal", "Pilot users submit a proposal and get an AI review back in under ten minutes.", "Sprint 14 · Demo Friday", 1),
        P.kpi(
          "Sprint health",
          [
            ["Scope done", "%", 100, 62, "up", [0, 10, 22, 35, 48, 62], onBoard("scope_done", { measure: "points" })],
            ["Blocked days", "days", 0, 3, "down", [0, 1, 1, 2, 3, 3], onBoard("blocked_days", { windowDays: 14 })],
            ["Unplanned work", "%", 15, 12, "down", [5, 8, 9, 10, 12, 12], onBoard("unplanned")],
          ],
          2,
        ),
        P.progress(
          "PI objectives",
          [
            {
              id: uid(),
              label: "Sprint scope",
              owner: "",
              note: "",
              source: { kind: "jql", jql: "sprint in openSprints()", descend: false, ...defaultJiraOptions(), measure: "points" },
              ...paced({ kind: "sprint" }),
            },
          ],
          {
            auto: { jql: 'issuetype = Epic AND {PI_FIELD} = "{PI}"', limit: 12, ...defaultJiraOptions() },
            autoDisplay: paced({ kind: "pi" }),
          },
          3,
        ),
        P.kanban(
          "Program flow",
          [["Backlog", 0], ["Ready", 0], ["In progress", 3], ["Review", 2], ["Done", 0]],
          [
            ["Audit log", 0, "", "Backend"],
            ["Upload error states", 0, "", "Frontend"],
            ["Approval gate UI", 1, "Tom", "Frontend"],
            ["Jira epic preview", 1, "Marcus", "Integration"],
            ["Template reformatter", 2, "Marcus", "AI"],
            ["AI review prompt v2", 2, "Joe", "AI"],
            ["Proposal schema", 2, "Dana", "Backend"],
            ["Sign-in spike", 2, "Dana", "Infra", true],
            ["Proposal upload form", 3, "Priya", "Frontend"],
            ["Review result view", 3, "Priya", "Frontend"],
            ["Repo scaffold", 4, "Joe", "Infra"],
            ["CI pipeline", 4, "Dana", "Infra"],
          ],
          3,
          // The manual columns and cards above stay as the fallback when the Jira source is switched off.
          defaultBoardSource(EXAMPLE_BOARD),
        ),
      ],
    }),
  },
  teamhealth: {
    name: "Team health",
    build: () => ({
      name: "Team health",
      subtitle: "How the team is working, not just what it ships",
      panels: [
        P.statement("Working agreements", "Pull before you push. Raise blockers within a day. Finish reviews before starting new work.", "Revisited every retro", 1),
        P.kpi(
          "Team signals",
          [
            ["Velocity", "pts", 40, 36, "up", [30, 33, 35, 38, 34, 36]],
            ["Say / do ratio", "%", 85, 78, "up", [70, 72, 80, 76, 79, 78]],
            ["Cycle time", "days", 4, 4.5, "down", [7, 6.5, 6, 5, 5.2, 4.5]],
            ["Team morale", "/ 5", 4, 4.1, "up", [3.6, 3.8, 3.7, 3.9, 4, 4.1]],
          ],
          2,
        ),
      ],
    }),
  },
  problems: {
    name: "Problems & actions",
    build: () => ({
      name: "Problems & actions",
      subtitle: "What is in the way, and who is moving it",
      panels: [
        P.problems(
          "Problems and impediments",
          [
            ["Hosting VM cannot reach the AI service", "Infra lead", "High", "Analyze", "Requests from the VM time out after 30 seconds.", "Outbound proxy rule not confirmed.", "Request the firewall change, then retest from the VM."],
            ["Reviews pile up at sprint end", "Chief architect", "Medium", "Countermeasure", "Most reviews land in the last two days of the sprint.", "Work is batched into review late.", "WIP limit of 2 in Review and a daily review slot."],
            ["Proposal template drift", "Scrum master", "Low", "Verify", "Teams submit older template versions.", "The template lives in several places.", "One template link inside the intake form."],
            ["No owner for ticket planning stage", "Program lead", "Medium", "Define", "Epic and story creation has no stage owner.", "", ""],
          ],
          2,
        ),
        P.actions(
          "Actions",
          [
            ["Confirm outbound access from the VM", "Infra lead", -2, false],
            ["Book demo slot with pilot teams", "Scrum master", 1, false],
            ["Draft ADR for review storage", "Chief architect", 3, false],
            ["Assign owner for ticket planning", "Program lead", 2, false],
            ["Retro on review countermeasure", "Scrum master", 7, false],
            ["Publish template link in intake form", "Scrum master", -5, true],
          ],
          1,
        ),
      ],
    }),
  },
  dependencies: {
    name: "Dependencies & risks",
    build: () => ({
      name: "Dependencies & risks",
      subtitle: "What we are waiting on, and what could go wrong",
      panels: [
        // Both example projects, so dependencies between the two programs show up.
        P.dependencies("Dependencies", "project in (PLAT, DATA)", 2),
        P.risks(
          "Risks",
          [
            ["Hosting decision slips past the PI", "Program lead", "High", "Open", "No owner on the infrastructure side yet"],
            ["AI service quota too low for the pilot", "Infra lead", "High", "Owned", "Quota increase requested; answer due next week"],
            ["Two teams change the proposal schema at once", "Chief architect", "Medium", "Mitigated", "Schema changes go through one review slot"],
            ["Pilot teams short of time in December", "Scrum master", "Medium", "Accepted", "Demo moved a week earlier"],
            ["Template library not ready for the demo", "Scrum master", "Low", "Resolved", "Descoped from this PI"],
          ],
          1,
        ),
      ],
    }),
  },
};

export const TEMPLATES: Record<string, { name: string; desc: string; walls: string[] }> = {
  program: { name: "Program room", desc: "Leadership and program management", walls: ["direction", "performance", "delivery", "problems", "dependencies"] },
  leadership: { name: "Leadership room", desc: "Strategy, KPIs, problems, actions", walls: ["direction", "performance", "problems"] },
  team: { name: "Team delivery", desc: "Sprint flow and team health", walls: ["delivery", "teamhealth", "problems"] },
};

export function buildWall(key: string): Wall {
  const lib = LIBRARY[key];
  if (!lib) return { id: "w" + uid(), name: "Wall", subtitle: "", panels: [] };
  return { id: `${key}-${uid().slice(0, 4)}`, ...lib.build() };
}

export function seed(tpl = "program"): Room {
  const t = TEMPLATES[tpl] ?? TEMPLATES.program!;
  return {
    v: 2,
    roomName: "Program Obeya",
    theme: "auto",
    tvTheme: "dark",
    accent: "cobalt",
    density: "comfortable",
    rotate: 0,
    example: true,
    walls: t.walls.map(buildWall),
  };
}
