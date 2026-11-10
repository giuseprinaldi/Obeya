/* Shared contract between the React frontend and the Python API (backend/obeya).
   The room is one JSON document; Jira results are computed by the backend and
   delivered next to it, keyed by the id of the item that owns the link. */

export type Theme = "auto" | "light" | "dark";
export type AccentKey = "cobalt" | "signal" | "teal" | "crimson" | "graphite";
export type Status = "good" | "warn" | "bad" | "none";
export type Span = 1 | 2 | 3;

/* ---------- Jira links ---------- */

export type Measure = "count" | "points";

/** Options shared by every Jira-backed source. */
export interface JiraSourceOptions {
  /** Count issues, or sum story points. */
  measure: Measure;
  /** Descend into sub-tasks and count those instead of their parent stories. */
  includeSubtasks: boolean;
  /** Status names that count as done. Empty = use Jira's "Done" status category. */
  doneStatuses: string[];
}

/** A hand-entered bar with no Jira link. */
export interface ManualSource {
  kind: "manual";
  done: number;
  total: number;
  unit: string;
}

/** One Jira issue (epic, initiative, feature...). Progress = its descendants. */
export interface IssueSource extends JiraSourceOptions {
  kind: "issue";
  key: string;
}

/** A JQL query. Progress = the matching issues themselves (no descent).
    May use {PI}, {NEXT_PI}, {PREV_PI} and {PI_FIELD}. */
export interface JqlSource extends JiraSourceOptions {
  kind: "jql";
  jql: string;
}

export type JiraSource = IssueSource | JqlSource;
export type Source = ManualSource | JiraSource;

/** Panel-level query: every matching issue becomes its own bar,
    measured the same way as an IssueSource. */
export interface AutoSource extends JiraSourceOptions {
  jql: string;
  /** Maximum number of bars (1-100). */
  limit: number;
}

/** What "on pace" is measured against. Sprint and PI dates come from the server. */
export type Pace =
  | { kind: "none" }
  | { kind: "sprint" }
  | { kind: "pi" }
  | { kind: "dates"; start: string; end: string };

export type BarColor = "status" | "accent" | "good" | "warn" | "bad" | "neutral";
export type ValueFormat = "percent" | "fraction" | "both";

export interface BarDisplay {
  color: BarColor;
  valueFormat: ValueFormat;
  /** Draw a lighter segment for work in progress. */
  showInProgress: boolean;
  pace: Pace;
}

/* ---------- Jira flow boards and KPIs ---------- */

/** A flow board fed by a Jira board: columns, WIP limits and cards all come from Jira. */
export interface BoardSource {
  boardId: number;
  /** Extra JQL to narrow the board. May use the PI variables. "" = everything on the board. */
  jql: string;
  /** Scrum boards: only the active sprint, or everything on the board. Kanban boards ignore this. */
  sprint: "active" | "all";
  /** Names of board columns to leave out (for example "Backlog"). */
  hiddenColumns: string[];
  /** Cards shown per column before "+N more". 1-30. */
  maxCards: number;
  /** Last column: only show work finished in the last N days. 0 = no limit. */
  doneDays: number;
}

export type MetricKind =
  | "cycle_time" // days from first "in progress" to done, for work finished in the window
  | "lead_time" // days from created to done, for work finished in the window
  | "throughput" // items finished per week, averaged over the window
  | "blocked_days" // total days items spent blocked (flagged or in a blocked status) in the window
  | "scope_done" // % of the scope that is done right now
  | "wip" // items in progress right now
  | "blocked_now" // items blocked right now
  | "unplanned"; // % of the scope that is unplanned

/** How "unplanned" is decided for the unplanned metric. */
export type UnplannedRule =
  | { rule: "added_after_start" } // joined the active sprint after it started (needs boardId)
  | { rule: "labels"; values: string[] } // has one of these labels
  | { rule: "types"; values: string[] }; // is one of these issue types

/** A KPI whose value is worked out from Jira. Sub-tasks are never counted. */
export interface Metric {
  kind: MetricKind;
  /** Scope: a board, a JQL query, or both (the query then narrows the board). At least one
      is required. On a scrum board the right-now metrics (scope_done, wip, blocked_now,
      unplanned) look at the active sprint; the look-back metrics look at the whole board. */
  boardId: number | null;
  jql: string;
  /** Look-back in days for cycle_time, lead_time, throughput and blocked_days. 7-365. */
  windowDays: number;
  /** cycle_time and lead_time: which figure to report. */
  stat: "median" | "average" | "p85";
  /** scope_done, wip and unplanned: count issues or sum story points. */
  measure: Measure;
  /** Status names that count as done. Empty = the "Done" status category in Jira. */
  doneStatuses: string[];
  unplanned: UnplannedRule;
}

/* ---------- Room document ---------- */

export interface KpiItem {
  id: string;
  name: string;
  unit: string;
  target: number | "";
  actual: number | "";
  dir: "up" | "down";
  history: number[];
  /** Optional Jira metric. While it is set, the value and trend shown come from Jira and
      the hand-entered `actual` and `history` are kept but not shown, even when Jira has no
      answer yet. Target and direction stay manual. */
  metric?: Metric | null;
}

export interface PortfolioItem {
  id: string;
  name: string;
  owner: string;
  horizon: string;
  health: "on" | "risk" | "off";
  /** Manual progress 0-100. Ignored while `source` is set and has a result. */
  progress: number;
  note: string;
  /** Optional Jira link that drives the progress value. */
  source?: JiraSource | null;
}

export type Stage = "Define" | "Analyze" | "Countermeasure" | "Verify" | "Closed";
export type Severity = "High" | "Medium" | "Low";

export interface ProblemItem {
  id: string;
  title: string;
  owner: string;
  severity: Severity;
  stage: Stage;
  problem: string;
  cause: string;
  countermeasure: string;
}

export interface ActionItem {
  id: string;
  text: string;
  owner: string;
  /** ISO date (YYYY-MM-DD) or "". */
  due: string;
  done: boolean;
}

export interface KanbanColumn {
  id: string;
  name: string;
  /** 0 = no limit. */
  wip: number;
}

export interface KanbanCard {
  id: string;
  title: string;
  owner: string;
  tag: string;
  col: string;
  blocked: boolean;
}

export interface ProgressBarItem extends BarDisplay {
  id: string;
  /** Shown instead of the Jira summary when not empty. Required for manual and JQL bars. */
  label: string;
  owner: string;
  note: string;
  source: Source;
}

export type ProgressSort = "manual" | "pct-desc" | "pct-asc" | "status";

interface PanelBase {
  id: string;
  title: string;
  span: Span;
}
export interface StatementPanel extends PanelBase {
  type: "statement";
  data: { text: string; meta: string };
}
export interface KpiPanel extends PanelBase {
  type: "kpi";
  data: { items: KpiItem[] };
}
export interface PortfolioPanel extends PanelBase {
  type: "portfolio";
  data: { items: PortfolioItem[] };
}
export interface ProblemsPanel extends PanelBase {
  type: "problems";
  data: { items: ProblemItem[] };
}
export interface ActionsPanel extends PanelBase {
  type: "actions";
  data: { items: ActionItem[] };
}
export interface KanbanPanel extends PanelBase {
  type: "kanban";
  data: {
    columns: KanbanColumn[];
    cards: KanbanCard[];
    /** When set, the board is read-only and shows the Jira board instead of columns/cards. */
    jira?: BoardSource | null;
  };
}
export interface ProgressPanel extends PanelBase {
  type: "progress";
  data: {
    /** Hand-picked bars, in manual order. */
    items: ProgressBarItem[];
    /** Optional query whose matches are appended as bars. */
    auto: AutoSource | null;
    /** Display settings applied to the bars that `auto` produces. */
    autoDisplay: BarDisplay;
    sort: ProgressSort;
    /** Show the Jira key next to each bar. */
    showKeys: boolean;
  };
}

export type Panel =
  | StatementPanel
  | KpiPanel
  | PortfolioPanel
  | ProblemsPanel
  | ActionsPanel
  | KanbanPanel
  | ProgressPanel;
export type PanelType = Panel["type"];

export interface Wall {
  id: string;
  name: string;
  subtitle: string;
  panels: Panel[];
}

export interface Room {
  v: 2;
  roomName: string;
  theme: Theme;
  tvTheme: Theme;
  accent: AccentKey;
  density: "comfortable" | "compact";
  /** Seconds between wall rotations on a TV. 0 = stay on one wall. */
  rotate: number;
  /** True until the first edit; shows the "Example data" chip. */
  example: boolean;
  walls: Wall[];
}

/* ---------- Server responses ---------- */

export interface HistoryPoint {
  /** ISO date. */
  d: string;
  done: number;
  total: number;
}

/** Result for one Jira-linked bar. When ok is false only `error` is meaningful. */
export interface ProgressResult {
  ok: boolean;
  error?: string;
  /** Root issue details. Absent for JQL sources. */
  key?: string;
  title?: string;
  url?: string;
  issueType?: string;
  status?: string;
  unit: "issues" | "points";
  total: number;
  done: number;
  inProgress: number;
  todo: number;
  /** Number of work items counted. */
  issues: number;
  /** Counted items with no estimate (points measure only). */
  unestimated: number;
  byStatus: Record<string, number>;
  /** One snapshot per day, oldest first. */
  history: HistoryPoint[];
  fetchedAt: string;
}

export interface AutoResult {
  ok: boolean;
  error?: string;
  /** One entry per matching issue; each has key and title. */
  bars: ProgressResult[];
  /** True when more issues matched than the limit allows. */
  truncated: boolean;
  fetchedAt: string;
}

export interface BoardCard {
  key: string;
  /** Jira summary, or the key when summaries are switched off. */
  title: string;
  url: string;
  type: string;
  /** Display name, or "" when unassigned or when assignees are switched off. */
  assignee: string;
  status: string;
  points: number | null;
  blocked: boolean;
  /** Why it counts as blocked, e.g. "Flagged" or "Blocked by PLAT-9". "" when not blocked. */
  blockedReason: string;
  /** Whole days in the current status category. Null when Jira does not report it. */
  ageDays: number | null;
}

export interface BoardColumn {
  name: string;
  /** WIP limit from the Jira board. 0 = none. */
  wip: number;
  /** Issues in the column, which can be more than cards.length. */
  total: number;
  /** In board order; at most 30. The frontend trims to BoardSource.maxCards. */
  cards: BoardCard[];
}

/** Result for one Jira-fed flow board. When ok is false only `error` is meaningful. */
export interface BoardResult {
  ok: boolean;
  error?: string;
  boardName: string;
  /** "scrum" or "kanban". */
  boardType: string;
  /** The sprint shown, for scrum boards in "active" mode. */
  sprint: Period | null;
  columns: BoardColumn[];
  /** Blocked issues that are not in the last column. */
  blocked: number;
  /** All issues across the visible columns. */
  total: number;
  fetchedAt: string;
}

export interface MetricPoint {
  /** ISO date. */
  d: string;
  value: number;
}

/** Result for one Jira KPI. When ok is false only `error` is meaningful. */
export interface MetricResult {
  ok: boolean;
  error?: string;
  /** Null when there is nothing to measure yet (for example no work finished in the window). */
  value: number | null;
  /** Suggested unit: "days", "/ week", "%", "items" or "pts". */
  unit: string;
  /** How many issues the value is based on. */
  n: number;
  /** One line explaining the number, e.g. "23 items finished in the last 30 days". */
  detail: string;
  /** Oldest first. Weekly points for the look-back metrics, daily snapshots for the rest. */
  history: MetricPoint[];
  fetchedAt: string;
}

export interface Period {
  name: string;
  /** ISO dates, inclusive. */
  start: string;
  end: string;
}

export interface Periods {
  /** Server's date, so every screen agrees on "today". */
  today: string;
  pi: Period | null;
  nextPi: Period | null;
  /** Active sprint on the configured board. Null when no board is set. */
  sprint: Period | null;
}

export interface SyncInfo {
  /** False when the server has no Jira URL or token. */
  jiraConfigured: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
  intervalSeconds: number;
}

/** Who may edit. Screens and visitors are view-only whenever `locked` is true. */
export interface Access {
  /** Editing needs unlocking: a passcode is set, or the server only trusts signed-in editors. */
  locked: boolean;
  /** This browser may edit right now. Always true when `locked` is false. */
  canEdit: boolean;
  /** A passcode exists (so Customize offers "change" and "remove" rather than "set"). */
  passcodeSet: boolean;
  /** Name passed on by the sign-in proxy, when the server is set up to trust one. */
  user: string | null;
}

/** GET /api/state */
export interface ServerState {
  /** Null until the first save; the frontend then seeds a room and saves it. */
  room: Room | null;
  version: number;
  updatedAt: string | null;
  /** Keyed by ProgressBarItem.id or PortfolioItem.id. Missing = not fetched yet. */
  progress: Record<string, ProgressResult>;
  /** Keyed by ProgressPanel.id. */
  auto: Record<string, AutoResult>;
  /** Keyed by KanbanPanel.id, for boards with a Jira source. Missing = not fetched yet. */
  boards: Record<string, BoardResult>;
  /** Keyed by KpiItem.id, for KPIs with a metric. Missing = not fetched yet. */
  metrics: Record<string, MetricResult>;
  periods: Periods;
  sync: SyncInfo;
  /** Absent on an older server: treat as unlocked. */
  access: Access;
}

/** POST /api/unlock body. 200 -> Access (and a session cookie); 403 wrong passcode;
    429 too many wrong attempts. */
export interface UnlockRequest {
  passcode: string;
}

/** PUT /api/passcode body -> Access. Sets the first passcode (current ""), changes it, or
    removes it (next ""). 400 when next is shorter than 6 characters; 403 when current is wrong. */
export interface PasscodeRequest {
  current: string;
  next: string;
}

/** One line of GET /api/jira/diagnostics. */
export interface DiagnosticCheck {
  id: string;
  /** What was checked, e.g. "Token accepted". */
  label: string;
  /** skip = not run because an earlier check failed. */
  status: "pass" | "warn" | "fail" | "skip";
  /** What was found. */
  detail: string;
  /** What to do about a warn or fail. "" when there is nothing to do. */
  fix: string;
}

/** GET /api/jira/diagnostics */
export interface Diagnostics {
  /** No check failed (warnings allowed). */
  ok: boolean;
  ranAt: string;
  checks: DiagnosticCheck[];
}

/** PUT /api/room body. */
export interface SaveRoomRequest {
  room: Room;
  /** The version this edit was based on; 0 for the very first save. */
  baseVersion: number;
}
/** 200 response. */
export interface SaveRoomResponse {
  version: number;
  updatedAt: string;
}
/** 409 response: someone else saved first. */
export interface SaveRoomConflict {
  error: "conflict";
  version: number;
  room: Room;
}

export interface BlockedRule {
  /** The Flagged field in Jira (the "Add flag" action on a board). */
  flagged: boolean;
  /** Status names that mean blocked, e.g. "Blocked", "On hold". */
  statuses: string[];
  /** Labels that mean blocked. */
  labels: string[];
  /** Has an "is blocked by" link to an issue that is not done. */
  links: boolean;
}

/** GET and PUT /api/settings */
export interface Settings {
  jira: {
    /** Field id of the PI field, e.g. "customfield_10500". "" = not set. */
    piField: string;
    /** Field id of story points. "" = detect automatically. */
    storyPointsField: string;
    /** Board whose active sprint drives sprint pace. Null = none. */
    boardId: number | null;
    /** When false, Jira summaries never leave the server; bars and cards show keys only. */
    showSummaries: boolean;
    /** When false, assignee names never leave the server. */
    showAssignees: boolean;
    /** What counts as blocked, for cards and the blocked metrics. Any one rule is enough. */
    blocked: BlockedRule;
  };
  /** The PI calendar. Order does not matter. */
  pis: Period[];
}

/** GET /api/jira/status */
export interface JiraStatus {
  configured: boolean;
  ok: boolean;
  baseUrl: string | null;
  deployment: string | null;
  version: string | null;
  error: string | null;
}

/** GET /api/jira/fields */
export interface JiraField {
  id: string;
  name: string;
  custom: boolean;
}

/** GET /api/jira/boards */
export interface JiraBoard {
  id: number;
  name: string;
  type: string;
}

/** POST /api/jira/preview body: exactly one of the four. The response is the matching
    result type: ProgressResult, AutoResult, BoardResult or MetricResult. */
export interface PreviewRequest {
  source?: JiraSource;
  auto?: AutoSource;
  board?: BoardSource;
  metric?: Metric;
}

/** POST /api/sync response. */
export interface SyncResponse {
  ok: boolean;
  error: string | null;
  sources: number;
  durationMs: number;
}

/** Every non-2xx response body. A 401 means editing is locked for this browser: every
    endpoint except GET /api/state, GET /api/health, POST /api/unlock and POST /api/lock
    answers 401 until it is unlocked. */
export interface ApiError {
  error: string;
}
