/* Turns untrusted room data (a pasted backup, a v1 prototype export, or whatever the server holds)
   into a complete v2 Room. Returns null when the input is not room data at all. */
import type {
  AccentKey,
  AutoSource,
  BarColor,
  BarDisplay,
  JiraSource,
  JiraSourceOptions,
  KanbanColumn,
  Measure,
  Pace,
  Panel,
  ProgressSort,
  Room,
  Severity,
  Source,
  Span,
  Stage,
  Theme,
  ValueFormat,
  Wall,
} from "../types";
import { parseIssueKey } from "./jira";
import { defaultDisplay } from "./progress";
import { clamp, uid } from "./util";

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const objs = (x: unknown): Obj[] => arr(x).filter(isObj);
const str = (x: unknown, d = ""): string => (typeof x === "string" ? x : typeof x === "number" && isFinite(x) ? String(x) : d);
const num = (x: unknown, d = 0): number => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return isFinite(n) ? n : d;
};
const numOrBlank = (x: unknown): number | "" => {
  const n = num(x, NaN);
  return isNaN(n) ? "" : n;
};
const oneOf = <T extends string>(x: unknown, options: readonly T[], d: T): T =>
  typeof x === "string" && (options as readonly string[]).includes(x) ? (x as T) : d;
const id = (x: unknown): string => str(x) || uid();

const THEMES: readonly Theme[] = ["auto", "light", "dark"];
const ACCENT_KEYS: readonly AccentKey[] = ["cobalt", "signal", "teal", "crimson", "graphite"];
const STAGE_NAMES: readonly Stage[] = ["Define", "Analyze", "Countermeasure", "Verify", "Closed"];
const SEVERITY_NAMES: readonly Severity[] = ["High", "Medium", "Low"];
const MEASURES: readonly Measure[] = ["count", "points"];
const COLORS: readonly BarColor[] = ["status", "accent", "good", "warn", "bad", "neutral"];
const FORMATS: readonly ValueFormat[] = ["percent", "fraction", "both"];
const SORTS: readonly ProgressSort[] = ["manual", "pct-desc", "pct-asc", "status"];

const span = (x: unknown): Span => {
  const n = num(x, 1);
  return n === 2 || n === 3 ? n : 1;
};

function jiraOptions(o: Obj): JiraSourceOptions {
  return {
    measure: oneOf(o.measure, MEASURES, "count"),
    includeSubtasks: o.includeSubtasks === true,
    doneStatuses: arr(o.doneStatuses).map((s) => str(s).trim()).filter(Boolean),
  };
}

function jiraSource(x: unknown): JiraSource | null {
  if (!isObj(x)) return null;
  if (x.kind === "issue") {
    const key = parseIssueKey(str(x.key));
    return key ? { kind: "issue", key, ...jiraOptions(x) } : null;
  }
  if (x.kind === "jql") {
    const jql = str(x.jql).trim();
    return jql ? { kind: "jql", jql, ...jiraOptions(x) } : null;
  }
  return null;
}

function source(x: unknown): Source {
  const j = jiraSource(x);
  if (j) return j;
  const o = isObj(x) ? x : {};
  return { kind: "manual", done: num(o.done), total: num(o.total), unit: str(o.unit) };
}

function autoSource(x: unknown): AutoSource | null {
  if (!isObj(x)) return null;
  const jql = str(x.jql).trim();
  if (!jql) return null;
  return { jql, limit: clamp(Math.round(num(x.limit, 12)), 1, 100), ...jiraOptions(x) };
}

function pace(x: unknown): Pace {
  if (!isObj(x)) return { kind: "none" };
  if (x.kind === "sprint" || x.kind === "pi") return { kind: x.kind };
  if (x.kind === "dates") return { kind: "dates", start: str(x.start), end: str(x.end) };
  return { kind: "none" };
}

function display(x: unknown): BarDisplay {
  const d = defaultDisplay();
  if (!isObj(x)) return d;
  return {
    color: oneOf(x.color, COLORS, d.color),
    valueFormat: oneOf(x.valueFormat, FORMATS, d.valueFormat),
    showInProgress: x.showInProgress === undefined ? d.showInProgress : x.showInProgress === true,
    pace: pace(x.pace),
  };
}

function panel(x: Obj): Panel | null {
  const base = { id: id(x.id), title: str(x.title, "Panel"), span: span(x.span) };
  const d = isObj(x.data) ? x.data : {};
  switch (x.type) {
    case "statement":
      return { ...base, type: "statement", data: { text: str(d.text), meta: str(d.meta) } };
    case "kpi":
      return {
        ...base,
        type: "kpi",
        data: {
          items: objs(d.items).map((k) => ({
            id: id(k.id),
            name: str(k.name),
            unit: str(k.unit),
            target: numOrBlank(k.target),
            actual: numOrBlank(k.actual),
            dir: k.dir === "down" ? "down" : "up",
            history: arr(k.history).map((h) => num(h, NaN)).filter((h) => !isNaN(h)),
          })),
        },
      };
    case "portfolio":
      return {
        ...base,
        type: "portfolio",
        data: {
          items: objs(d.items).map((p) => ({
            id: id(p.id),
            name: str(p.name),
            owner: str(p.owner),
            horizon: str(p.horizon),
            health: oneOf(p.health, ["on", "risk", "off"] as const, "on"),
            progress: clamp(num(p.progress), 0, 100),
            note: str(p.note),
            source: jiraSource(p.source),
          })),
        },
      };
    case "problems":
      return {
        ...base,
        type: "problems",
        data: {
          items: objs(d.items).map((p) => ({
            id: id(p.id),
            title: str(p.title),
            owner: str(p.owner),
            severity: oneOf(p.severity, SEVERITY_NAMES, "Medium"),
            stage: oneOf(p.stage, STAGE_NAMES, "Define"),
            problem: str(p.problem),
            cause: str(p.cause),
            countermeasure: str(p.countermeasure),
          })),
        },
      };
    case "actions":
      return {
        ...base,
        type: "actions",
        data: { items: objs(d.items).map((a) => ({ id: id(a.id), text: str(a.text), owner: str(a.owner), due: str(a.due), done: a.done === true })) },
      };
    case "kanban": {
      const columns: KanbanColumn[] = objs(d.columns).map((c) => ({ id: id(c.id), name: str(c.name, "Column"), wip: Math.max(0, Math.round(num(c.wip))) }));
      if (!columns.length) columns.push({ id: uid(), name: "To do", wip: 0 });
      const ids = new Set(columns.map((c) => c.id));
      const first = columns[0]!.id;
      return {
        ...base,
        type: "kanban",
        data: {
          columns,
          cards: objs(d.cards).map((c) => {
            const col = str(c.col);
            return { id: id(c.id), title: str(c.title), owner: str(c.owner), tag: str(c.tag), col: ids.has(col) ? col : first, blocked: c.blocked === true };
          }),
        },
      };
    }
    case "progress":
      return {
        ...base,
        type: "progress",
        data: {
          items: objs(d.items).map((b) => ({ id: id(b.id), label: str(b.label), owner: str(b.owner), note: str(b.note), source: source(b.source), ...display(b) })),
          auto: autoSource(d.auto),
          autoDisplay: display(d.autoDisplay),
          sort: oneOf(d.sort, SORTS, "manual"),
          showKeys: d.showKeys !== false,
        },
      };
    default:
      return null;
  }
}

function wall(x: Obj): Wall {
  return {
    id: id(x.id),
    name: str(x.name, "Wall"),
    subtitle: str(x.subtitle),
    panels: objs(x.panels).map(panel).filter((p): p is Panel => p !== null),
  };
}

/** True when the input has the shape of room data: an object with a walls array of walls. */
export function looksLikeRoom(x: unknown): x is Obj {
  return isObj(x) && Array.isArray(x.walls) && x.walls.every((w) => isObj(w) && Array.isArray(w.panels));
}

export function normalizeRoom(x: unknown): Room | null {
  if (!looksLikeRoom(x)) return null;
  const seen = new Set<string>();
  const walls = objs(x.walls).map(wall);
  for (const w of walls) {
    if (seen.has(w.id)) w.id = "w" + uid();
    seen.add(w.id);
  }
  return {
    v: 2,
    roomName: str(x.roomName, "Obeya Room") || "Obeya Room",
    theme: oneOf(x.theme, THEMES, "auto"),
    tvTheme: oneOf(x.tvTheme, THEMES, "dark"),
    accent: oneOf(x.accent, ACCENT_KEYS, "cobalt"),
    density: x.density === "compact" ? "compact" : "comfortable",
    rotate: Math.max(0, Math.round(num(x.rotate))),
    example: x.example === true,
    walls,
  };
}
