import { describe, expect, it } from "vitest";
import type { AutoResult, KpiItem, Periods, ProgressBarItem, ProgressPanel, ProgressResult, Room } from "../types";
import { parseIssueKey, parseStatusList } from "./jira";
import { looksLikeRoom, normalizeRoom } from "./normalize";
import { bumpName, calendarError, calendarNotice, nextPi, periodLine, piContaining, roomUsesPi } from "./periods";
import { barPill, barStatus, defaultDisplay, defaultJiraOptions, expectedPct, itemBar, portfolioProgress, resolveBars, valueText, type LiveData } from "./progress";
import { seed } from "./seed";
import { badCount, chipList, isLate, kpiStatus, panelStatus, signals } from "./status";
import { gridRows, tvRowWeights } from "./tvlayout";
import { addDays, dayNumber, daysBetween, todayISO } from "./util";

const periods = (over: Partial<Periods> = {}): Periods => ({
  today: "2026-11-10",
  pi: { name: "PI 26.4", start: "2026-10-05", end: "2026-12-13" },
  nextPi: null,
  sprint: { name: "Sprint 14", start: "2026-11-02", end: "2026-11-15" },
  ...over,
});

const live = (over: Partial<LiveData> = {}): LiveData => ({ progress: {}, auto: {}, periods: periods(), jiraConfigured: true, ...over });

const result = (over: Partial<ProgressResult> = {}): ProgressResult => ({
  ok: true,
  key: "PLAT-1",
  title: "Feature proposal pipeline",
  url: "https://jira.example/browse/PLAT-1",
  issueType: "Epic",
  status: "In Progress",
  unit: "issues",
  total: 50,
  done: 31,
  inProgress: 6,
  todo: 13,
  issues: 50,
  unestimated: 0,
  byStatus: {},
  history: [],
  fetchedAt: "2026-11-10T09:00:00Z",
  ...over,
});

const issueBar = (over: Partial<ProgressBarItem> = {}): ProgressBarItem => ({
  id: "b1",
  label: "",
  owner: "",
  note: "",
  source: { kind: "issue", key: "PLAT-1", ...defaultJiraOptions() },
  ...defaultDisplay(),
  ...over,
});

const progressPanel = (data: Partial<ProgressPanel["data"]> = {}): ProgressPanel => ({
  id: "p1",
  type: "progress",
  title: "PI objectives",
  span: 3,
  data: { items: [], auto: null, autoDisplay: defaultDisplay(), sort: "manual", showKeys: true, ...data },
});

describe("dates", () => {
  it("counts days and rejects impossible dates", () => {
    expect(daysBetween("2026-10-05", "2026-12-13")).toBe(69);
    expect(addDays("2026-12-13", 1)).toBe("2026-12-14");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(dayNumber("2026-02-30")).toBeNull();
    expect(dayNumber("")).toBeNull();
  });
});

describe("parseIssueKey", () => {
  it("accepts bare keys in any case", () => {
    expect(parseIssueKey("PLAT-12")).toBe("PLAT-12");
    expect(parseIssueKey("  plat-12 ")).toBe("PLAT-12");
    expect(parseIssueKey("A2_B-7")).toBe("A2_B-7");
  });
  it("pulls the key out of Jira links", () => {
    expect(parseIssueKey("https://jira.example.com/browse/PLAT-12")).toBe("PLAT-12");
    expect(parseIssueKey("https://jira.example.com/browse/plat-12?focusedCommentId=5#c")).toBe("PLAT-12");
    expect(parseIssueKey("https://jira.example.com/secure/RapidBoard.jspa?rapidView=3&selectedIssue=DATA-4&x=1")).toBe("DATA-4");
    expect(parseIssueKey("https://x.atlassian.net/jira/software/projects/PLAT/issues/PLAT-9")).toBe("PLAT-9");
  });
  it("rejects everything else", () => {
    for (const bad of ["", "   ", "PLAT", "12", "PLAT-", "-12", "PLAT 12", "PLAT-12 extra", "https://jira.example.com/projects/PLAT"]) {
      expect(parseIssueKey(bad)).toBeNull();
    }
  });
  it("splits status lists", () => {
    expect(parseStatusList(" Done, Closed ,, ")).toEqual(["Done", "Closed"]);
    expect(parseStatusList("")).toEqual([]);
  });
});

describe("kpiStatus", () => {
  const k = (over: Partial<KpiItem>): KpiItem => ({ id: "k", name: "", unit: "", target: 10, actual: 10, dir: "up", history: [], ...over });
  it("higher is better", () => {
    expect(kpiStatus(k({ actual: 10 }))).toBe("good");
    expect(kpiStatus(k({ actual: 9 }))).toBe("warn");
    expect(kpiStatus(k({ actual: 8.9 }))).toBe("bad");
  });
  it("lower is better, including a target of zero", () => {
    expect(kpiStatus(k({ dir: "down", target: 5, actual: 5 }))).toBe("good");
    expect(kpiStatus(k({ dir: "down", target: 5, actual: 5.5 }))).toBe("warn");
    expect(kpiStatus(k({ dir: "down", target: 5, actual: 7.5 }))).toBe("bad");
    expect(kpiStatus(k({ dir: "down", target: 0, actual: 1 }))).toBe("warn");
    expect(kpiStatus(k({ dir: "down", target: 0, actual: 3 }))).toBe("bad");
  });
  it("has no status without a value or a target", () => {
    expect(kpiStatus(k({ actual: "" }))).toBe("none");
    expect(kpiStatus(k({ target: "" }))).toBe("none");
  });
});

describe("pace and bar status", () => {
  it("expects linear progress across the period", () => {
    // PI: Oct 5 to Dec 13 is 69 days; Nov 10 is day 36.
    expect(expectedPct({ kind: "pi" }, periods())).toBeCloseTo((36 / 69) * 100, 5);
    expect(expectedPct({ kind: "sprint" }, periods())).toBeCloseTo((8 / 13) * 100, 5);
    expect(expectedPct({ kind: "dates", start: "2026-11-01", end: "2026-11-21" }, periods())).toBeCloseTo(45, 5);
  });
  it("clamps before the start and after the end", () => {
    expect(expectedPct({ kind: "dates", start: "2026-12-01", end: "2026-12-31" }, periods())).toBe(0);
    expect(expectedPct({ kind: "dates", start: "2026-01-01", end: "2026-01-31" }, periods())).toBe(100);
  });
  it("is unknown without a pace, a period or valid dates", () => {
    expect(expectedPct({ kind: "none" }, periods())).toBeNull();
    expect(expectedPct({ kind: "sprint" }, periods({ sprint: null }))).toBeNull();
    expect(expectedPct({ kind: "pi" }, periods({ pi: null }))).toBeNull();
    expect(expectedPct({ kind: "dates", start: "", end: "2026-12-31" }, periods())).toBeNull();
    expect(expectedPct({ kind: "dates", start: "2026-12-31", end: "2026-12-01" }, periods())).toBeNull();
  });
  it("grades how far behind a bar is", () => {
    expect(barStatus(100, 10)).toBe("good");
    expect(barStatus(40, null)).toBe("none");
    expect(barStatus(60, 50)).toBe("good");
    expect(barStatus(45, 50)).toBe("good");
    expect(barStatus(44.9, 50)).toBe("warn");
    expect(barStatus(30, 50)).toBe("warn");
    expect(barStatus(29.9, 50)).toBe("bad");
  });
});

describe("bars", () => {
  it("draws a linked bar from its result", () => {
    const b = itemBar(issueBar({ pace: { kind: "pi" } }), live({ progress: { b1: result() } }));
    expect(b.state).toBe("ok");
    expect(b.label).toBe("Feature proposal pipeline");
    expect(b.keyText).toBe("PLAT-1");
    expect(b.pct).toBe(62);
    expect(b.wipPct).toBe(12);
    expect(b.status).toBe("good");
    expect(valueText(b)).toBe("62% · 31 / 50 issues");
    expect(barPill(b)).toBeNull();
  });
  it("prefers the bar's own label and formats points", () => {
    const b = itemBar(issueBar({ label: "Pipeline", valueFormat: "fraction" }), live({ progress: { b1: result({ unit: "points", done: 12, total: 40, unestimated: 3 }) } }));
    expect(b.label).toBe("Pipeline");
    expect(valueText(b)).toBe("12 / 40 pts");
    expect(b.unestimated).toBe(3);
  });
  it("flags a bar that is behind pace, and one that is done", () => {
    const behind = itemBar(issueBar({ pace: { kind: "pi" } }), live({ progress: { b1: result({ done: 5 }) } }));
    expect(behind.status).toBe("bad");
    expect(barPill(behind)).toEqual({ text: "Behind", status: "bad" });
    const done = itemBar(issueBar({ pace: { kind: "pi" } }), live({ progress: { b1: result({ done: 50, inProgress: 0 }) } }));
    expect(barPill(done)).toEqual({ text: "Done", status: "good" });
  });
  it("shows why a bar has no value", () => {
    expect(itemBar(issueBar(), live()).message).toBe("Loading from Jira…");
    const off = itemBar(issueBar(), live({ jiraConfigured: false }));
    expect(off.state).toBe("disconnected");
    expect(off.message).toBe("Jira is not connected");
    expect(off.status).toBe("none");
    const failed = itemBar(issueBar(), live({ progress: { b1: result({ ok: false, error: "PLAT-1 was not found in Jira" }) } }));
    expect(failed.state).toBe("error");
    expect(failed.status).toBe("warn");
    expect(failed.message).toBe("PLAT-1 was not found in Jira");
    expect(failed.label).toBe("PLAT-1");
  });
  it("treats an unestimated points bar as empty, not as behind", () => {
    const b = itemBar(issueBar({ pace: { kind: "pi" } }), live({ progress: { b1: result({ unit: "points", done: 0, total: 0, inProgress: 0, unestimated: 8 }) } }));
    expect(b.emptyText).toBe("No estimates yet");
    expect(b.status).toBe("none");
    expect(barPill(b)).toBeNull();
  });
  it("draws a manual bar without Jira", () => {
    const b = itemBar(issueBar({ label: "Sites live", source: { kind: "manual", done: 3, total: 12, unit: "sites" } }), live({ jiraConfigured: false }));
    expect(b.state).toBe("ok");
    expect(b.pct).toBe(25);
    expect(valueText(b)).toBe("25% · 3 / 12 sites");
  });
  it("adds the query's bars after the hand-picked ones, without repeating a key", () => {
    const auto: AutoResult = {
      ok: true,
      truncated: true,
      fetchedAt: "",
      bars: [result({ key: "PLAT-1", title: "Dup" }), result({ key: "PLAT-2", title: "Second", done: 10 }), result({ key: "PLAT-3", ok: false, error: "No access" })],
    };
    const panel = progressPanel({ items: [issueBar()], auto: { jql: "x", limit: 3, ...defaultJiraOptions() } });
    const r = resolveBars(panel, live({ progress: { b1: result() }, auto: { p1: auto } }));
    expect(r.bars.map((b) => b.keyText)).toEqual(["PLAT-1", "PLAT-2", "PLAT-3"]);
    expect(r.bars[0]!.itemId).toBe("b1");
    expect(r.bars[1]!.itemId).toBeNull();
    expect(r.bars[2]!.state).toBe("error");
    expect(r.autoNote).toContain("first 3");
  });
  it("sorts by completion and by status", () => {
    const items = [issueBar({ id: "a" }), issueBar({ id: "b" }), issueBar({ id: "c" })];
    const progress = { a: result({ done: 25 }), b: result({ done: 5 }), c: result({ done: 45 }) };
    const ids = (sort: ProgressPanel["data"]["sort"]): string[] => resolveBars(progressPanel({ items, sort }), live({ progress })).bars.map((b) => b.id);
    expect(ids("manual")).toEqual(["a", "b", "c"]);
    expect(ids("pct-asc")).toEqual(["b", "a", "c"]);
    expect(ids("pct-desc")).toEqual(["c", "a", "b"]);
    const paced = items.map((i) => ({ ...i, pace: { kind: "pi" as const } }));
    expect(resolveBars(progressPanel({ items: paced, sort: "status" }), live({ progress })).bars.map((b) => b.id)).toEqual(["b", "a", "c"]);
  });
  it("reports a failed or pending panel query", () => {
    const panel = progressPanel({ auto: { jql: "x", limit: 3, ...defaultJiraOptions() } });
    expect(resolveBars(panel, live()).autoNote).toBe("Loading from Jira…");
    const failed = resolveBars(panel, live({ auto: { p1: { ok: false, error: "Bad JQL", bars: [], truncated: false, fetchedAt: "" } } }));
    expect(failed.autoFailed).toBe(true);
    expect(failed.autoNote).toBe("Bad JQL");
  });
});

describe("portfolio progress", () => {
  const item = { id: "i1", name: "x", owner: "", horizon: "", health: "on" as const, progress: 45, note: "" };
  it("uses the manual value when not linked", () => {
    expect(portfolioProgress(item, live())).toMatchObject({ pct: 45, live: false, reason: "" });
  });
  it("uses Jira when the link works", () => {
    const linked = { ...item, source: { kind: "issue" as const, key: "PLAT-1", ...defaultJiraOptions() } };
    expect(portfolioProgress(linked, live({ progress: { i1: result() } }))).toMatchObject({ pct: 62, live: true, keyText: "PLAT-1" });
  });
  it("falls back to the manual value and says why", () => {
    const linked = { ...item, source: { kind: "issue" as const, key: "PLAT-1", ...defaultJiraOptions() } };
    expect(portfolioProgress(linked, live({ jiraConfigured: false }))).toMatchObject({ pct: 45, live: false, reason: "Jira is not connected" });
    expect(portfolioProgress(linked, live({ progress: { i1: result({ ok: false, error: "Not found" }) } }))).toMatchObject({ pct: 45, reason: "Not found" });
  });
});

describe("signals", () => {
  it("counts bars behind pace and failing links", () => {
    const panel = progressPanel({ items: [issueBar({ id: "a", pace: { kind: "pi" } }), issueBar({ id: "b", pace: { kind: "pi" } }), issueBar({ id: "c" })] });
    const l = live({ progress: { a: result({ done: 5 }), b: result({ done: 20 }), c: result({ ok: false, error: "x" }) } });
    const s = signals([panel], l);
    expect(s).toMatchObject({ barBad: 1, barWarn: 1, barError: 1 });
    expect(badCount(s)).toBe(1);
    expect(panelStatus(panel, l)).toBe("bad");
    expect(chipList(s).map((c) => c.text)).toEqual(["1 behind pace", "1 at risk", "1 Jira link failing"]);
  });
  it("is all clear for an empty wall, and uses the server's date for late actions", () => {
    expect(chipList(signals([], live()))).toEqual([{ text: "All clear", status: "good" }]);
    expect(isLate({ id: "a", text: "", owner: "", due: "2026-11-09", done: false }, "2026-11-10")).toBe(true);
    expect(isLate({ id: "a", text: "", owner: "", due: "2026-11-10", done: false }, "2026-11-10")).toBe(false);
    expect(isLate({ id: "a", text: "", owner: "", due: "2026-11-01", done: true }, "2026-11-10")).toBe(false);
  });
  it("matches the prototype's totals for the example room", () => {
    const room = seed("program");
    const s = signals(room.walls.flatMap((w) => w.panels), live({ jiraConfigured: false, periods: periods({ today: todayISO() }) }));
    expect(s).toMatchObject({ kpiBad: 4, off: 1, risk: 1, blocked: 1, openHigh: 1, late: 1, barBad: 0 });
  });
});

describe("PI calendar", () => {
  const pis = [
    { name: "PI 26.3", start: "2026-07-27", end: "2026-10-04" },
    { name: "PI 26.4", start: "2026-10-05", end: "2026-12-13" },
  ];
  it("bumps the last number in a name", () => {
    expect(bumpName("PI 26.4")).toBe("PI 26.5");
    expect(bumpName("PI-09")).toBe("PI-10");
    expect(bumpName("2026 PI4")).toBe("2026 PI5");
    expect(bumpName("Planning")).toBe("Planning 2");
    expect(bumpName("")).toBe("PI 1");
  });
  it("continues the cadence from the latest PI", () => {
    expect(nextPi(pis, "2026-11-10")).toEqual({ name: "PI 26.5", start: "2026-12-14", end: "2027-02-21" });
    expect(nextPi([pis[1]!, pis[0]!], "2026-11-10").start).toBe("2026-12-14");
  });
  it("starts a calendar from today", () => {
    expect(nextPi([], "2026-11-10")).toEqual({ name: "PI 1", start: "2026-11-10", end: "2027-01-18" });
  });
  it("finds the PI that covers a day", () => {
    expect(piContaining(pis, "2026-10-05")?.name).toBe("PI 26.4");
    expect(piContaining(pis, "2026-10-04")?.name).toBe("PI 26.3");
    expect(piContaining(pis, "2027-01-01")).toBeNull();
  });
  it("validates a calendar", () => {
    expect(calendarError(pis)).toBeNull();
    expect(calendarError([{ name: " ", start: "2026-01-01", end: "2026-02-01" }])).toContain("name");
    expect(calendarError([{ name: "A", start: "", end: "2026-02-01" }])).toContain("start");
    expect(calendarError([{ name: "A", start: "2026-03-01", end: "2026-02-01" }])).toContain("before");
    expect(calendarError([pis[0]!, { ...pis[1]!, name: "pi 26.3" }])).toContain("same name");
  });
  it("warns when the calendar is missing or has run out", () => {
    expect(calendarNotice(periods({ pi: null }), false)).toBeNull();
    expect(calendarNotice(periods({ pi: null }), true)).toContain("no PI calendar");
    expect(calendarNotice(periods(), true)).toBeNull();
    expect(calendarNotice(periods({ today: "2026-12-20" }), true)).toContain("ended on");
    expect(calendarNotice(periods({ today: "2026-12-20", nextPi: { name: "PI 27.1", start: "2027-01-04", end: "2027-03-14" } }), true)).toBeNull();
  });
  it("knows when a room depends on the calendar", () => {
    expect(roomUsesPi(seed("program"))).toBe(true);
    expect(roomUsesPi(seed("leadership"))).toBe(false);
  });
  it("describes where the PI and sprint are", () => {
    expect(periodLine(periods())).toBe("PI 26.4 · day 37 of 70 · Sprint 14 · 5 days left");
    expect(periodLine(periods({ sprint: null, today: "2026-12-13" }))).toBe("PI 26.4 · day 70 of 70");
    expect(periodLine(periods({ pi: null, today: "2026-11-15" }))).toBe("Sprint 14 · ends today");
    expect(periodLine(periods({ pi: null, sprint: null }))).toBe("");
  });
});

describe("normalizeRoom", () => {
  it("rejects anything that is not room data", () => {
    for (const bad of [null, 5, "x", [], {}, { walls: "no" }, { walls: [{ id: "a" }] }, { walls: [5] }]) {
      expect(normalizeRoom(bad)).toBeNull();
      expect(looksLikeRoom(bad)).toBe(false);
    }
  });
  it("upgrades a v1 prototype backup", () => {
    const v1 = {
      v: 1,
      roomName: "Old room",
      theme: "auto",
      tvTheme: "dark",
      accent: "teal",
      density: "compact",
      rotate: 30,
      example: false,
      updated: "2026-01-01T00:00:00Z",
      walls: [
        {
          id: "w1",
          name: "Direction",
          subtitle: "Why",
          panels: [
            { id: "p1", type: "portfolio", title: "Portfolio", span: 3, data: { items: [{ id: "i1", name: "A", owner: "O", health: "risk", progress: 45, horizon: "Q4", note: "" }] } },
            { id: "p2", type: "kanban", title: "Flow", span: 3, data: { columns: [{ id: "c1", name: "To do", wip: 0 }], cards: [{ id: "k1", title: "Card", col: "gone", owner: "", tag: "", blocked: true }] } },
            { id: "p3", type: "kpi", title: "KPIs", span: 2, data: { items: [{ id: "k", name: "Lead time", unit: "days", target: 5, actual: "", dir: "down", history: [3, "4", "x"] }] } },
            { id: "p4", type: "mystery", title: "?", span: 1, data: {} },
          ],
        },
      ],
    };
    const room = normalizeRoom(v1) as Room;
    expect(room.v).toBe(2);
    expect(room).toMatchObject({ roomName: "Old room", accent: "teal", density: "compact", rotate: 30, example: false });
    expect("updated" in room).toBe(false);
    const panels = room.walls[0]!.panels;
    expect(panels.map((p) => p.type)).toEqual(["portfolio", "kanban", "kpi"]);
    const [portfolio, kanban, kpi] = panels;
    expect(portfolio!.type === "portfolio" && portfolio.data.items[0]!.source).toBeNull();
    expect(kanban!.type === "kanban" && kanban.data.cards[0]!.col).toBe("c1");
    expect(kpi!.type === "kpi" && kpi.data.items[0]).toMatchObject({ actual: "", target: 5, history: [3, 4] });
  });
  it("fills in what a progress panel is missing and tidies Jira keys", () => {
    const room = normalizeRoom({
      walls: [
        {
          id: "w",
          panels: [
            {
              type: "progress",
              title: "Bars",
              data: {
                items: [
                  { id: "a", source: { kind: "issue", key: "https://jira.example/browse/plat-7" } },
                  { id: "b", label: "Manual", source: { kind: "manual", done: "3", total: 9 }, pace: { kind: "dates", start: "2026-01-01", end: "2026-02-01" }, color: "purple" },
                  { id: "c", source: { kind: "jql", jql: "  " } },
                ],
                auto: { jql: "issuetype = Epic", limit: 500 },
              },
            },
          ],
        },
      ],
    }) as Room;
    const p = room.walls[0]!.panels[0] as ProgressPanel;
    expect(room.roomName).toBe("Obeya Room");
    expect(p.span).toBe(1);
    expect(p.data.sort).toBe("manual");
    expect(p.data.showKeys).toBe(true);
    expect(p.data.auto).toEqual({ jql: "issuetype = Epic", limit: 100, measure: "count", includeSubtasks: false, doneStatuses: [] });
    expect(p.data.items[0]!.source).toEqual({ kind: "issue", key: "PLAT-7", measure: "count", includeSubtasks: false, doneStatuses: [] });
    expect(p.data.items[1]).toMatchObject({ color: "status", valueFormat: "both", pace: { kind: "dates", start: "2026-01-01", end: "2026-02-01" }, source: { kind: "manual", done: 3, total: 9, unit: "" } });
    expect(p.data.items[2]!.source.kind).toBe("manual");
  });
  it("leaves a freshly seeded room unchanged", () => {
    const room = seed("program");
    expect(normalizeRoom(JSON.parse(JSON.stringify(room)))).toEqual(room);
  });
});

describe("TV row layout", () => {
  it("places panels in rows like the wall grid", () => {
    const delivery = seed("program").walls[2]!;
    expect(gridRows(delivery.panels).map((r) => r.map((p) => p.type))).toEqual([["statement", "kpi"], ["progress"], ["kanban"]]);
    const spans = (n: (1 | 2 | 3)[]) => n.map((span, i) => ({ id: String(i), type: "statement" as const, title: "", span, data: { text: "", meta: "" } }));
    expect(gridRows(spans([2, 2, 1, 1, 1, 3, 1])).map((r) => r.length)).toEqual([1, 2, 2, 1, 1]);
    expect(gridRows([])).toEqual([]);
  });
  it("gives rows with more content more height", () => {
    const delivery = seed("program").walls[2]!;
    const auto: AutoResult = { ok: true, truncated: false, fetchedAt: "", bars: Array.from({ length: 11 }, (_, i) => result({ key: `PLAT-${i + 10}` })) };
    const few = tvRowWeights(delivery.panels, live());
    const many = tvRowWeights(delivery.panels, live({ auto: { [delivery.panels[2]!.id]: auto } }));
    expect(few).toHaveLength(3);
    expect(many[1]!).toBeGreaterThan(few[1]!);
    expect(many[0]).toBe(few[0]);
    // 12 bars in two columns need six rows of height, not twelve.
    expect(many[1]).toBe(80 + 6 * 56);
  });
});
