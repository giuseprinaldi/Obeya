/* Jira-fed KPIs and flow boards. */
import { describe, expect, it } from "vitest";
import type { BoardCard, BoardColumn, BoardResult, KanbanPanel, KpiItem, KpiPanel, Metric, MetricResult, Room } from "../types";
import { boardHeight, boardView, defaultBoardSource, describeBoard, hideableColumns } from "./board";
import { withSettingsDefaults } from "./jira";
import { METRICS, METRIC_KINDS, defaultMetric, effectiveKpi, metricError, metricUnit, relabel } from "./kpi";
import { normalizeRoom } from "./normalize";
import type { LiveData } from "./progress";
import { seed } from "./seed";
import { badCount, chipList, panelStatus, signals } from "./status";
import { tvRowWeights } from "./tvlayout";

const live = (over: Partial<LiveData> = {}): LiveData => ({
  progress: {},
  auto: {},
  boards: {},
  metrics: {},
  burnups: {},
  deps: {},
  periods: { today: "2026-11-10", pi: null, nextPi: null, sprint: null },
  jiraConfigured: true,
  ...over,
});

const kpi = (over: Partial<KpiItem> = {}): KpiItem => ({ id: "k1", name: "Cycle time", unit: "", target: 4, actual: 9, dir: "down", history: [9, 9, 9], ...over });
const jiraKpi = (over: Partial<KpiItem> = {}): KpiItem => kpi({ metric: { ...defaultMetric("cycle_time"), boardId: 1 }, ...over });

const metricResult = (over: Partial<MetricResult> = {}): MetricResult => ({
  ok: true,
  value: 3.5,
  unit: "days",
  n: 23,
  detail: "23 items finished in the last 30 days",
  history: [5, 4.5, 3.5].map((value, i) => ({ d: `2026-10-${10 + i * 7}`, value })),
  fetchedAt: "2026-11-10T09:00:00Z",
  ...over,
});

const card = (key: string, over: Partial<BoardCard> = {}): BoardCard => ({
  key,
  title: `Work on ${key}`,
  url: `https://jira.example/browse/${key}`,
  type: "Story",
  assignee: "Priya",
  status: "In Progress",
  points: 3,
  blocked: false,
  blockedReason: "",
  ageDays: 5,
  ...over,
});
const column = (name: string, n: number, over: Partial<BoardColumn> = {}): BoardColumn => ({
  name,
  wip: 0,
  total: n,
  cards: Array.from({ length: n }, (_, i) => card(`${name.slice(0, 1).toUpperCase()}-${i + 1}`)),
  ...over,
});
const boardResult = (over: Partial<BoardResult> = {}): BoardResult => ({
  ok: true,
  boardName: "Platform board",
  boardType: "scrum",
  sprint: { name: "Sprint 23", start: "2026-11-02", end: "2026-11-15" },
  columns: [column("To do", 4), column("In progress", 5, { wip: 3 }), column("Review", 2, { wip: 2 }), column("Done", 9, { total: 14 })],
  blocked: 2,
  total: 25,
  fetchedAt: "2026-11-10T09:00:00Z",
  ...over,
});
const jiraBoard = (over: Partial<NonNullable<KanbanPanel["data"]["jira"]>> = {}): KanbanPanel => ({
  id: "b1",
  type: "kanban",
  title: "Program flow",
  span: 3,
  data: {
    columns: [
      { id: "c1", name: "To do", wip: 1 },
      { id: "c2", name: "Done", wip: 0 },
    ],
    cards: [
      { id: "m1", title: "Manual card", owner: "", tag: "", col: "c1", blocked: true },
      { id: "m2", title: "Another", owner: "", tag: "", col: "c1", blocked: false },
    ],
    jira: { ...defaultBoardSource(1), ...over },
  },
});

describe("effectiveKpi", () => {
  it("passes a hand-entered KPI through", () => {
    const e = effectiveKpi(kpi({ unit: "days", history: [7, 8, 9] }), live({ metrics: { k1: metricResult() } }));
    expect(e).toMatchObject({ state: "manual", jira: false, actual: 9, unit: "days", history: [7, 8, 9], status: "bad", trend: "▲", message: "" });
  });
  it("takes value, history and unit from Jira, and ignores the hand-entered ones", () => {
    const e = effectiveKpi(jiraKpi(), live({ metrics: { k1: metricResult() } }));
    expect(e).toMatchObject({ state: "ok", jira: true, actual: 3.5, unit: "days", history: [5, 4.5, 3.5], status: "good", trend: "▼", detail: "23 items finished in the last 30 days" });
  });
  it("keeps the unit typed on the KPI and judges against its target and direction", () => {
    const e = effectiveKpi(jiraKpi({ unit: "d", target: 3 }), live({ metrics: { k1: metricResult({ value: 3.2 }) } }));
    expect(e.unit).toBe("d");
    expect(e.status).toBe("warn");
    expect(effectiveKpi(jiraKpi({ target: 3, dir: "up" }), live({ metrics: { k1: metricResult({ value: 3.2 }) } })).status).toBe("good");
    expect(effectiveKpi(jiraKpi({ target: "" }), live({ metrics: { k1: metricResult() } })).status).toBe("none");
  });
  it("shows the last twelve history points", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ d: "2026-01-01", value: i }));
    const e = effectiveKpi(jiraKpi(), live({ metrics: { k1: metricResult({ history }) } }));
    expect(e.history).toHaveLength(12);
    expect(e.history[0]).toBe(8);
    expect(e.history[11]).toBe(19);
  });
  it("has no value and no status when there is nothing to measure", () => {
    const e = effectiveKpi(jiraKpi(), live({ metrics: { k1: metricResult({ value: null, detail: "No work was finished in the last 30 days", history: [] }) } }));
    expect(e).toMatchObject({ state: "empty", actual: "", status: "none", trend: "", message: "No work was finished in the last 30 days" });
  });
  it("never falls back to the hand-entered value while Jira is the source", () => {
    const waiting = effectiveKpi(jiraKpi(), live());
    expect(waiting).toMatchObject({ state: "loading", actual: "", status: "none", message: "Loading from Jira…", history: [] });
    expect(effectiveKpi(jiraKpi(), live({ jiraConfigured: false }))).toMatchObject({ state: "disconnected", actual: "", message: "Jira is not connected" });
    const failed = effectiveKpi(jiraKpi(), live({ metrics: { k1: metricResult({ ok: false, error: "Board 9 was not found in Jira." }) } }));
    expect(failed).toMatchObject({ state: "error", actual: "", status: "none", message: "Board 9 was not found in Jira." });
  });
  it("treats metric: null like no metric", () => {
    expect(effectiveKpi(kpi({ metric: null }), live()).state).toBe("manual");
  });
});

describe("metric options", () => {
  it("has an entry for every kind", () => {
    expect(METRIC_KINDS).toHaveLength(8);
    for (const k of METRIC_KINDS) expect(METRICS[k].explain.length).toBeGreaterThan(10);
  });
  it("fills in name, unit and direction for a new KPI", () => {
    expect(relabel({ name: "", unit: "", dir: "up" }, null, defaultMetric("cycle_time"))).toEqual({ name: "Cycle time", unit: "days", dir: "down" });
    expect(relabel({ name: " ", unit: "", dir: "down" }, null, defaultMetric("throughput"))).toEqual({ name: "Throughput", unit: "/ week", dir: "up" });
  });
  it("follows the kind while the labels are still the defaults", () => {
    const was = defaultMetric("cycle_time");
    expect(relabel({ name: "Cycle time", unit: "days", dir: "down" }, was, defaultMetric("scope_done"))).toEqual({ name: "Scope done", unit: "%", dir: "up" });
    expect(relabel({ name: "Cycle time", unit: "days", dir: "down" }, was, defaultMetric("blocked_now"))).toEqual({ name: "Blocked items", unit: "", dir: "down" });
  });
  it("keeps what the user typed", () => {
    const was = defaultMetric("cycle_time");
    expect(relabel({ name: "Time to ship", unit: "working days", dir: "up" }, was, defaultMetric("throughput"))).toEqual({ name: "Time to ship", unit: "working days", dir: "up" });
    // An existing manual KPI switched to Jira keeps its name and direction; only an empty unit is filled.
    expect(relabel({ name: "Lead time for change", unit: "", dir: "down" }, null, defaultMetric("lead_time"))).toEqual({ name: "Lead time for change", unit: "days", dir: "down" });
  });
  it("switches the unit of work in progress with its measure", () => {
    const items: Metric = defaultMetric("wip");
    const points: Metric = { ...items, measure: "points" };
    expect(metricUnit(items)).toBe("items");
    expect(metricUnit(points)).toBe("pts");
    expect(relabel({ name: "Work in progress", unit: "items", dir: "down" }, items, points).unit).toBe("pts");
  });
  it("requires a board or a query", () => {
    expect(metricError(defaultMetric("cycle_time"))).toContain("board or");
    expect(metricError({ ...defaultMetric("cycle_time"), boardId: 1 })).toBe("");
    expect(metricError({ ...defaultMetric("cycle_time"), jql: "project = PLAT" })).toBe("");
  });
  it("checks the look-back only for kinds that use it", () => {
    expect(metricError({ ...defaultMetric("lead_time"), boardId: 1, windowDays: 3 })).toContain("between 7 and 365");
    expect(metricError({ ...defaultMetric("lead_time"), boardId: 1, windowDays: NaN })).toContain("between 7 and 365");
    expect(metricError({ ...defaultMetric("scope_done"), boardId: 1, windowDays: 3 })).toBe("");
  });
  it("checks the unplanned rule", () => {
    const base = { ...defaultMetric("unplanned"), jql: "project = PLAT" };
    expect(metricError(base)).toContain("needs a board");
    expect(metricError({ ...base, boardId: 1 })).toBe("");
    expect(metricError({ ...base, unplanned: { rule: "labels", values: [] } })).toContain("label");
    expect(metricError({ ...base, unplanned: { rule: "types", values: [] } })).toContain("issue type");
    expect(metricError({ ...base, unplanned: { rule: "types", values: ["Bug"] } })).toBe("");
  });
});

describe("boardView", () => {
  it("is null for a manual board", () => {
    const manual = jiraBoard();
    manual.data.jira = null;
    expect(boardView(manual, live())).toBeNull();
  });
  it("trims each column to the card limit and counts the rest", () => {
    const v = boardView(jiraBoard({ maxCards: 3 }), live({ boards: { b1: boardResult() } }))!;
    expect(v.state).toBe("ok");
    expect(v.columns.map((c) => [c.name, c.cards.length, c.more])).toEqual([
      ["To do", 3, 1],
      ["In progress", 3, 2],
      ["Review", 2, 0],
      ["Done", 3, 11],
    ]);
  });
  it("shows totals and WIP limits from Jira", () => {
    const v = boardView(jiraBoard(), live({ boards: { b1: boardResult() } }))!;
    expect(v.columns.map((c) => c.countText)).toEqual(["4", "5 / 3 over", "2 / 2", "14"]);
    expect(v.columns.map((c) => c.over)).toEqual([false, true, false, false]);
    expect(v).toMatchObject({ overWip: 1, blocked: 2, total: 25 });
  });
  it("shows age only in the middle columns, and only when Jira reports it", () => {
    const columns = [column("To do", 1), column("In progress", 2), column("Done", 1)];
    columns[1]!.cards[1] = card("I-2", { ageDays: null });
    const v = boardView(jiraBoard(), live({ boards: { b1: boardResult({ columns }) } }))!;
    expect(v.columns.map((c) => c.cards.map((x) => x.age))).toEqual([[""], ["5d", ""], [""]]);
  });
  it("formats points and leaves them out when there is no estimate", () => {
    const columns = [column("To do", 3)];
    columns[0]!.cards[1] = card("T-2", { points: null });
    columns[0]!.cards[2] = card("T-3", { points: 1 });
    const v = boardView(jiraBoard(), live({ boards: { b1: boardResult({ columns }) } }))!;
    expect(v.columns[0]!.cards.map((c) => c.pointsText)).toEqual(["3 pts", "", "1 pt"]);
  });
  it("leaves out hidden columns even if the server sent them", () => {
    const v = boardView(jiraBoard({ hiddenColumns: ["to do "] }), live({ boards: { b1: boardResult() } }))!;
    expect(v.columns.map((c) => c.name)).toEqual(["In progress", "Review", "Done"]);
    // With "To do" gone, "In progress" is now the first column and shows no age.
    expect(v.columns[0]!.cards[0]!.age).toBe("");
  });
  it("names the board, the sprint and when it was read", () => {
    const v = boardView(jiraBoard(), live({ boards: { b1: boardResult() } }))!;
    expect(v.footer).toMatch(/^Platform board · Sprint 23 · read /);
    expect(boardView(jiraBoard(), live({ boards: { b1: boardResult({ sprint: null, boardName: "Data kanban" }) } }))!.footer).toMatch(/^Data kanban · read /);
  });
  it("says why there is no board", () => {
    expect(boardView(jiraBoard(), live())).toMatchObject({ state: "loading", message: "Loading from Jira…", columns: [] });
    expect(boardView(jiraBoard(), live({ jiraConfigured: false }))).toMatchObject({ state: "disconnected", message: "Jira is not connected" });
    expect(boardView(jiraBoard(), live({ boards: { b1: boardResult({ ok: false, error: "Board 1 was not found in Jira." }) } }))).toMatchObject({ state: "error", message: "Board 1 was not found in Jira.", total: 0 });
  });
  it("describes a board for the Check button", () => {
    expect(describeBoard(defaultBoardSource(1), boardResult())).toBe("Platform board (scrum), Sprint 23: 4 columns, 25 cards, 2 blocked.");
    expect(describeBoard(defaultBoardSource(2), boardResult({ boardName: "Data kanban", boardType: "kanban", sprint: null, columns: [column("Doing", 1)], blocked: 0 }))).toBe("Data kanban (kanban): 1 column, 1 card, 0 blocked.");
  });
  it("offers the columns Jira returned plus the ones already hidden", () => {
    expect(hideableColumns(["Backlog"], null, boardResult())).toEqual(["To do", "In progress", "Review", "Done", "Backlog"]);
    expect(hideableColumns(["done"], boardResult(), boardResult())).toEqual(["To do", "In progress", "Review", "Done"]);
    expect(hideableColumns([], undefined, boardResult({ ok: false }))).toEqual([]);
  });
  it("measures the tallest visible column for the TV layout", () => {
    const v = boardView(jiraBoard({ maxCards: 6 }), live({ boards: { b1: boardResult() } }))!;
    expect(boardHeight(v)).toBeCloseTo(6.4);
  });
});

describe("signals from Jira", () => {
  it("feeds a Jira board into the same counters as a manual one", () => {
    const panel = jiraBoard();
    const s = signals([panel], live({ boards: { b1: boardResult() } }));
    expect(s).toMatchObject({ blocked: 2, overWip: 1, items: 25, jiraFailing: 0 });
    expect(badCount(s)).toBe(2);
    expect(panelStatus(panel, live({ boards: { b1: boardResult() } }))).toBe("bad");
  });
  it("ignores the manual cards while Jira is the source", () => {
    expect(signals([jiraBoard()], live())).toMatchObject({ blocked: 0, overWip: 0, items: 0 });
    const manual = jiraBoard();
    manual.data.jira = null;
    expect(signals([manual], live())).toMatchObject({ blocked: 1, overWip: 1, items: 2 });
  });
  it("counts a failing board and a failing KPI as failing links, not as blocked or off target", () => {
    const board = jiraBoard();
    const kpis: KpiPanel = { id: "p", type: "kpi", title: "KPIs", span: 3, data: { items: [jiraKpi({ id: "a" }), jiraKpi({ id: "b" }), jiraKpi({ id: "c" }), kpi({ id: "d" })] } };
    const l = live({
      boards: { b1: boardResult({ ok: false, error: "No access" }) },
      metrics: { a: metricResult({ ok: false, error: "Bad JQL" }), b: metricResult({ value: 9 }), c: metricResult({ value: null }) },
    });
    const s = signals([board, kpis], l);
    expect(s).toMatchObject({ jiraFailing: 2, kpiBad: 2, kpiWarn: 0, blocked: 0 });
    expect(chipList(s).map((c) => c.text)).toEqual(["2 KPIs off target", "2 Jira links failing"]);
    expect(panelStatus(board, l)).toBe("warn");
  });
  it("gives a Jira board on a TV height for its visible cards", () => {
    const panel = jiraBoard({ maxCards: 2 });
    const empty = tvRowWeights([panel], live());
    const short = tvRowWeights([panel], live({ boards: { b1: boardResult() } }));
    panel.data.jira!.maxCards = 6;
    const tall = tvRowWeights([panel], live({ boards: { b1: boardResult() } }));
    expect(short[0]!).toBeGreaterThan(empty[0]!);
    expect(tall[0]!).toBeGreaterThan(short[0]!);
  });
});

describe("example room", () => {
  it("reads the delivery board and sprint KPIs from Jira, keeping the manual board as the fallback", () => {
    const delivery = seed("program").walls[2]!;
    const flow = delivery.panels.find((p) => p.type === "kanban") as KanbanPanel;
    expect(flow.data.jira).toEqual({ boardId: 1, jql: "", sprint: "active", hiddenColumns: [], maxCards: 6, doneDays: 14, staleDays: 7 });
    expect(flow.data.columns).toHaveLength(5);
    expect(flow.data.cards).toHaveLength(12);
    const health = delivery.panels.find((p) => p.type === "kpi") as KpiPanel;
    expect(health.data.items.map((k) => [k.name, k.metric?.kind, k.metric?.boardId, k.target])).toEqual([
      ["Scope done", "scope_done", 1, 100],
      ["Blocked days", "blocked_days", 1, 0],
      ["Unplanned work", "unplanned", 1, 15],
    ]);
    expect(health.data.items[0]!.metric!.measure).toBe("points");
    expect(health.data.items[1]!.metric!.windowDays).toBe(14);
    expect(health.data.items[2]!.metric!.unplanned).toEqual({ rule: "added_after_start" });
    for (const k of health.data.items) expect(metricError(k.metric!)).toBe("");
  });
  it("reads three flow KPIs on the performance wall from Jira and leaves the rest manual", () => {
    const items = (seed("program").walls[1]!.panels[0] as KpiPanel).data.items;
    expect(items.filter((k) => k.metric).map((k) => [k.name, k.metric!.kind, k.metric!.jql, k.metric!.windowDays, k.metric!.stat])).toEqual([
      ["Lead time for change", "lead_time", "project = PLAT", 30, "median"],
      ["Cycle time", "cycle_time", "project = PLAT", 30, "median"],
      ["Throughput", "throughput", "project = PLAT", 30, "median"],
    ]);
    expect(items.filter((k) => !k.metric).map((k) => k.name)).toEqual(["Deploys per week", "Change failure rate", "Proposals reviewed", "Review turnaround", "Stakeholder satisfaction"]);
  });
});

describe("normalizeRoom with Jira-fed panels", () => {
  const room = (panels: unknown[]): Room => normalizeRoom({ walls: [{ id: "w", panels }] }) as Room;
  const kpiPanel = (items: unknown[]): unknown => ({ id: "p", type: "kpi", title: "KPIs", data: { items } });

  it("accepts KPIs and boards saved before these fields existed", () => {
    const r = room([kpiPanel([{ id: "a", name: "Old", target: 1, actual: 2, dir: "up", history: [] }]), { id: "k", type: "kanban", title: "Flow", data: { columns: [{ id: "c", name: "To do", wip: 0 }], cards: [] } }]);
    expect((r.walls[0]!.panels[0] as KpiPanel).data.items[0]!.metric).toBeNull();
    expect((r.walls[0]!.panels[1] as KanbanPanel).data.jira).toBeNull();
  });
  it("keeps a valid metric and fills in what is missing", () => {
    const r = room([kpiPanel([{ id: "a", name: "Lead", metric: { kind: "lead_time", jql: " project = PLAT ", windowDays: 9999, stat: "mode", doneStatuses: ["Done", " "], unplanned: { rule: "labels", values: ["x", ""] } } }])]);
    expect((r.walls[0]!.panels[0] as KpiPanel).data.items[0]!.metric).toEqual({
      kind: "lead_time",
      boardId: null,
      jql: "project = PLAT",
      windowDays: 365,
      stat: "median",
      measure: "count",
      doneStatuses: ["Done"],
      unplanned: { rule: "labels", values: ["x"] },
    });
  });
  it("drops a malformed metric and keeps the KPI", () => {
    const r = room([
      kpiPanel([
        { id: "a", name: "Unknown kind", actual: 5, metric: { kind: "velocity", boardId: 1 } },
        { id: "b", name: "No scope", actual: 6, metric: { kind: "wip", boardId: null, jql: "  " } },
        { id: "c", name: "Not an object", actual: 7, metric: "cycle_time" },
        { id: "d", name: "Board as text", metric: { kind: "wip", boardId: "12" } },
      ]),
    ]);
    const items = (r.walls[0]!.panels[0] as KpiPanel).data.items;
    expect(items.map((k) => [k.name, k.actual, k.metric?.boardId ?? null])).toEqual([
      ["Unknown kind", 5, null],
      ["No scope", 6, null],
      ["Not an object", 7, null],
      ["Board as text", "", 12],
    ]);
    expect(items.slice(0, 3).every((k) => k.metric === null)).toBe(true);
  });
  it("keeps a valid board source, clamps its numbers, and drops one without a board", () => {
    const flow = (jira: unknown): KanbanPanel["data"] => {
      const data = { columns: [{ id: "c", name: "To do", wip: 0 }], cards: [{ id: "x", title: "Kept", col: "c" }], jira };
      return (room([{ id: "k", type: "kanban", title: "Flow", data }]).walls[0]!.panels[0] as KanbanPanel).data;
    };
    expect(flow({ boardId: 7, sprint: "everything", hiddenColumns: ["Backlog", 5], maxCards: 99, doneDays: -3 }).jira).toEqual({ boardId: 7, jql: "", sprint: "active", hiddenColumns: ["Backlog", "5"], maxCards: 30, doneDays: 0, staleDays: 7 });
    expect(flow({ boardId: 7, sprint: "all" }).jira).toMatchObject({ sprint: "all", maxCards: 6, doneDays: 14 });
    const dropped = flow({ jql: "project = PLAT" });
    expect(dropped.jira).toBeNull();
    expect(dropped.cards).toHaveLength(1);
    expect(flow("board 7").jira).toBeNull();
  });
});

describe("withSettingsDefaults", () => {
  it("fills in the settings an older server does not send", () => {
    const s = withSettingsDefaults({ jira: { piField: "customfield_1", storyPointsField: "", boardId: 3, showSummaries: false }, pis: [] });
    expect(s.jira).toEqual({ piField: "customfield_1", storyPointsField: "", boardId: 3, showSummaries: false, showAssignees: true, blocked: { flagged: true, statuses: [], labels: [], links: false } });
  });
  it("keeps what the server sent", () => {
    const sent = { piField: "", storyPointsField: "", boardId: null, showSummaries: true, showAssignees: false, blocked: { flagged: false, statuses: ["Blocked", " "], labels: ["waiting"], links: true } };
    expect(withSettingsDefaults({ jira: sent, pis: [{ name: "PI 1", start: "2026-01-01", end: "2026-03-01" }] })).toEqual({
      jira: { ...sent, blocked: { flagged: false, statuses: ["Blocked"], labels: ["waiting"], links: true } },
      pis: [{ name: "PI 1", start: "2026-01-01", end: "2026-03-01" }],
    });
  });
  it("copes with nothing at all", () => {
    expect(withSettingsDefaults(null).jira.blocked.flagged).toBe(true);
    expect(withSettingsDefaults({}).pis).toEqual([]);
  });
});
