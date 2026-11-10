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

/* ---------- Room document ---------- */

export interface KpiItem {
  id: string;
  name: string;
  unit: string;
  target: number | "";
  actual: number | "";
  dir: "up" | "down";
  history: number[];
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
  data: { columns: KanbanColumn[]; cards: KanbanCard[] };
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
  periods: Periods;
  sync: SyncInfo;
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

/** GET and PUT /api/settings */
export interface Settings {
  jira: {
    /** Field id of the PI field, e.g. "customfield_10500". "" = not set. */
    piField: string;
    /** Field id of story points. "" = detect automatically. */
    storyPointsField: string;
    /** Board whose active sprint drives sprint pace. Null = none. */
    boardId: number | null;
    /** When false, Jira summaries never leave the server; bars show keys only. */
    showSummaries: boolean;
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

/** POST /api/jira/preview body: exactly one of source or auto. */
export interface PreviewRequest {
  source?: JiraSource;
  auto?: AutoSource;
}

/** POST /api/sync response. */
export interface SyncResponse {
  ok: boolean;
  error: string | null;
  sources: number;
  durationMs: number;
}

/** Every non-2xx response body. */
export interface ApiError {
  error: string;
}
