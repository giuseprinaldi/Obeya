import { describe, expect, it } from "vitest";
import type { BurnupPanel, HistoryPoint, Periods, ProgressPanel, ProgressResult } from "../types";
import { axisTicks, burnPill, burnSummary, burnUnestimated, burnupView, idealAt, nearestPoint } from "./burnup";
import { normalizeRoom } from "./normalize";
import { roomUsesPi } from "./periods";
import { defaultDisplay, defaultJiraOptions, itemBar, paceDates, resolveBars, type LiveData } from "./progress";
import { newPanel, seed } from "./seed";
import { chipList, panelStatus, signals } from "./status";
import { barTrend, signed, sparkPath, trendText, trendTitle } from "./trend";
import { tvRowWeights } from "./tvlayout";
import { addDays } from "./util";

const TODAY = "2026-11-10";
const PI = { name: "PI 26.4", start: "2026-10-01", end: "2026-12-09" }; // 70 days; today is day 40

const periods = (over: Partial<Periods> = {}): Periods => ({
  today: TODAY,
  pi: PI,
  nextPi: null,
  sprint: { name: "Sprint 14", start: "2026-11-02", end: "2026-11-15" },
  ...over,
});

const live = (over: Partial<LiveData> = {}): LiveData => ({ progress: {}, auto: {}, boards: {}, metrics: {}, burnups: {}, deps: {}, periods: periods(), jiraConfigured: true, ...over });

const result = (over: Partial<ProgressResult> = {}): ProgressResult => ({
  ok: true,
  key: "PLAT-1",
  title: "Feature proposal pipeline",
  url: "https://jira.example/browse/PLAT-1",
  issueType: "Initiative",
  status: "In Progress",
  unit: "points",
  total: 100,
  done: 40,
  inProgress: 10,
  todo: 50,
  issues: 30,
  unestimated: 0,
  byStatus: {},
  history: [],
  fetchedAt: "2026-11-10T09:00:00Z",
  ...over,
});

/** A history point `ago` days before today. */
const h = (ago: number, done: number, total = 100): HistoryPoint => ({ d: addDays(TODAY, -ago), done, total });

/** One point a day from `from` days ago to yesterday, done rising by `perDay` and ending just under `done`. */
const steady = (from: number, done: number, perDay: number, total = 100): HistoryPoint[] =>
  Array.from({ length: from }, (_, i) => h(from - i, done - perDay * (from - i), total));

const burnup = (data: Partial<BurnupPanel["data"]> = {}): BurnupPanel => ({
  id: "u1",
  type: "burnup",
  title: "PI burn-up",
  span: 2,
  data: { source: { kind: "issue", key: "PLAT-1", ...defaultJiraOptions(), measure: "points" }, period: { kind: "pi" }, ...data },
});

describe("bar trend", () => {
  it("compares today with a week ago", () => {
    const t = barTrend([h(10, 20, 90), h(7, 28, 95), h(3, 35), h(1, 38)], { done: 40, total: 100 }, TODAY)!;
    expect([t.delta, t.scopeDelta, t.days]).toEqual([12, 5, 7]);
    expect(trendText(t)).toBe("+12 in 7d");
    expect(trendTitle(t, "pts")).toBe("12 pts more done than 7 days ago; the scope grew by 5.");
  });
  it("uses the oldest day while the history is shorter than a week, and says how far back that is", () => {
    const t = barTrend([h(2, 38), h(1, 38)], { done: 40, total: 100 }, TODAY)!;
    expect([t.delta, t.days]).toEqual([2, 2]);
    expect(trendText(t)).toBe("+2 in 2d");
    expect(trendText(barTrend([h(1, 39)], { done: 40, total: 100 }, TODAY)!)).toBe("+1 in 1d");
    expect(trendTitle(barTrend([h(1, 39)], { done: 40, total: 100 }, TODAY)!, "issues")).toBe("1 issue more done than 1 day ago.");
  });
  it("reaches further back when the server missed some days", () => {
    const t = barTrend([h(12, 30), h(2, 39)], { done: 40, total: 100 }, TODAY)!;
    expect([t.delta, t.days]).toEqual([10, 12]);
  });
  it("shows a stall and a step back plainly", () => {
    const stalled = barTrend([h(7, 40)], { done: 40, total: 100 }, TODAY)!;
    expect(trendText(stalled)).toBe("0 in 7d");
    expect(trendTitle(stalled, "pts")).toBe("Nothing more done than 7 days ago.");
    const back = barTrend([h(7, 43, 110)], { done: 40, total: 100 }, TODAY)!;
    expect(trendText(back)).toBe("−3 in 7d");
    expect(trendTitle(back, "pts")).toBe("3 pts fewer done than 7 days ago; the scope shrank by 10.");
    expect([signed(4), signed(0), signed(-2.5)]).toEqual(["+4", "0", "−2.5"]);
  });
  it("has nothing to say without an earlier day", () => {
    expect(barTrend([], { done: 40, total: 100 }, TODAY)).toBeNull();
    expect(barTrend(undefined, { done: 40, total: 100 }, TODAY)).toBeNull();
    expect(barTrend([h(0, 40)], { done: 40, total: 100 }, TODAY)).toBeNull(); // today's own snapshot is not a comparison
    expect(barTrend([{ d: "junk", done: 1, total: 2 }], { done: 40, total: 100 }, TODAY)).toBeNull();
    expect(barTrend([h(3, 10)], { done: 40, total: 100 }, "not a date")).toBeNull();
  });
  it("draws the last 30 days of percent done, ending today", () => {
    const t = barTrend([h(45, 0), h(30, 10), h(15, 25), h(0, 99)], { done: 40, total: 100 }, TODAY)!;
    expect(t.points).toEqual([
      { x: 0, pct: 10 },
      { x: 0.5, pct: 25 },
      { x: 1, pct: 40 },
    ]);
    expect(sparkPath(t.points, 56, 18)).toBe("2.0,16.0 28.0,9.0 54.0,2.0");
    // A flat history is a level line through the middle, and one point is no line at all.
    expect(sparkPath([{ x: 0, pct: 40 }, { x: 1, pct: 40 }], 56, 18)).toBe("2.0,9.0 54.0,9.0");
    expect(sparkPath([{ x: 1, pct: 40 }], 56, 18)).toBe("");
  });
  it("reaches the bars: linked bars carry a trend, manual and failing ones do not", () => {
    const linked = { id: "b1", label: "", owner: "", note: "", source: { kind: "issue" as const, key: "PLAT-1", ...defaultJiraOptions() }, ...defaultDisplay() };
    const manual = { ...linked, id: "b2", label: "Manual", source: { kind: "manual" as const, done: 3, total: 10, unit: "sites" } };
    const progress = { b1: result({ history: [h(7, 30), h(0, 40)] }) };
    expect(itemBar(linked, live({ progress })).trend).toMatchObject({ delta: 10, days: 7 });
    expect(itemBar(manual, live({ progress })).trend).toBeNull();
    expect(itemBar(linked, live({ progress: { b1: result({ ok: false, error: "gone" }) } })).trend).toBeNull();
    expect(itemBar(linked, live({ progress: { b1: result({ total: 0, done: 0, history: [h(7, 0, 0)] }) } })).trend).toBeNull();
    const panel: ProgressPanel = { id: "p1", type: "progress", title: "Bars", span: 3, data: { items: [], auto: { jql: "x", limit: 5, ...defaultJiraOptions() }, autoDisplay: defaultDisplay(), sort: "manual", showKeys: true, showTrend: true, staleDays: 14 } };
    const auto = { p1: { ok: true, bars: [result({ key: "PLAT-2", history: [h(3, 35)] })], truncated: false, fetchedAt: "" } };
    expect(resolveBars(panel, live({ auto })).bars[0]!.trend).toMatchObject({ delta: 5, days: 3 });
  });
});

describe("burn-up chart", () => {
  it("says what is missing before there is anything to draw", () => {
    expect(burnupView(burnup({ source: null }), live())).toMatchObject({ state: "unlinked", status: "none" });
    expect(burnupView(burnup(), live())).toMatchObject({ state: "loading", message: "Loading from Jira…", keyText: "PLAT-1" });
    expect(burnupView(burnup(), live({ jiraConfigured: false }))).toMatchObject({ state: "disconnected" });
    const failed = burnupView(burnup(), live({ burnups: { u1: result({ ok: false, error: "PLAT-1 was not found in Jira." }) } }));
    expect(failed).toMatchObject({ state: "error", message: "PLAT-1 was not found in Jira.", status: "warn" });
    const burnups = { u1: result() };
    expect(burnupView(burnup(), live({ burnups, periods: periods({ pi: null }) }))).toMatchObject({ state: "noperiod", message: expect.stringContaining("PI calendar") });
    expect(burnupView(burnup({ period: { kind: "sprint" } }), live({ burnups, periods: periods({ sprint: null }) })).message).toContain("active sprint");
    expect(burnupView(burnup({ period: { kind: "dates", start: "", end: "" } }), live({ burnups })).message).toContain("start and an end date");
    expect(burnupView(burnup({ period: { kind: "dates", start: "2026-12-01", end: "2026-11-01" } }), live({ burnups })).state).toBe("noperiod");
  });

  it("places each day across the period and ends on today's live numbers", () => {
    const history = [h(60, 0, 50), h(40, 0, 80), h(20, 20, 90), h(1, 38, 100), h(0, 1, 1)];
    const v = burnupView(burnup(), live({ burnups: { u1: result({ history }) } }));
    expect(v.state).toBe("ok");
    // 60 days ago is before the PI began, so it is left out; today's stored row gives way to the live result.
    expect(v.points.map((p) => [p.d, Number(p.x.toFixed(3)), p.done, p.total])).toEqual([
      ["2026-10-01", 0, 0, 80],
      ["2026-10-21", 0.29, 20, 90],
      ["2026-11-09", 0.565, 38, 100],
      ["2026-11-10", 0.58, 40, 100],
    ]);
    expect([v.periodName, v.start, v.end, v.unit]).toEqual(["PI 26.4", "2026-10-01", "2026-12-09", "pts"]);
    expect([v.done, v.total, v.pct]).toEqual([40, 100, 40]);
    expect(v.todayX).toBeCloseTo(40 / 69);
    expect([v.keyText, v.url]).toEqual(["PLAT-1", "https://jira.example/browse/PLAT-1"]);
  });

  it("judges pace the way bars do: against a straight line from nothing to everything", () => {
    const at = (done: number): ReturnType<typeof burnupView> => burnupView(burnup(), live({ burnups: { u1: result({ done }) } }));
    // Day 40 of 70: 58% should be done.
    expect(at(40).expected).toBeCloseTo(57.97, 1);
    expect([at(56).status, at(45).status, at(30).status, at(100).status]).toEqual(["good", "warn", "bad", "good"]);
    expect(burnPill(at(56))).toEqual({ text: "On pace", status: "good" });
    expect(burnPill(at(45))).toEqual({ text: "At risk", status: "warn" });
    expect(burnPill(at(30))).toEqual({ text: "Behind", status: "bad" });
    expect(burnPill(at(100))).toEqual({ text: "Done", status: "good" });
    expect(burnSummary(at(30))).toBe("30% done, 58% expected by today");
    expect(burnSummary(at(100))).toBe("100% done");
    expect(idealAt(at(30), 0.5)).toBe(50);
    // A chart in points says how many issues it cannot count; one in issues has nothing to add.
    const view = (over: Partial<ProgressResult>): ReturnType<typeof burnupView> => burnupView(burnup(), live({ burnups: { u1: result(over) } }));
    expect(burnUnestimated(view({ unestimated: 4 }))).toBe("4 unestimated");
    expect(burnUnestimated(view({ unestimated: 0 }))).toBe("");
    expect(burnUnestimated(view({ unit: "issues", unestimated: 4 }))).toBe("");
  });

  it("follows chosen dates and a sprint the same way", () => {
    const burnups = { u1: result({ history: [h(5, 30)] }) };
    const dates = burnupView(burnup({ period: { kind: "dates", start: addDays(TODAY, -10), end: addDays(TODAY, 10) } }), live({ burnups }));
    expect([dates.periodName, dates.todayX, dates.points.length, dates.status]).toEqual(["", 0.5, 2, "warn"]);
    const sprint = burnupView(burnup({ period: { kind: "sprint" } }), live({ burnups }));
    expect([sprint.periodName, sprint.start, sprint.points.map((p) => p.d)]).toEqual(["Sprint 14", "2026-11-02", ["2026-11-05", TODAY]]);
    expect(paceDates({ kind: "none" }, periods())).toBeNull();
  });

  it("forecasts from the pace of the last two weeks", () => {
    // 1.5 points a day: 60 left takes 40 days, but only 29 are left in the PI.
    const short = burnupView(burnup(), live({ burnups: { u1: result({ history: steady(30, 40, 1.5) }) } }));
    expect(short.forecast).toMatchObject({ x: 1, text: "At this pace: 84 of 100 pts by Dec 9" });
    expect(short.forecast!.value).toBeCloseTo(83.5);
    expect(short.note).toBe(short.forecast!.text);
    // 4 points a day: 60 left takes 15 days, so it finishes on Nov 25.
    const fast = burnupView(burnup(), live({ burnups: { u1: result({ history: steady(30, 40, 4) }) } }));
    expect(fast.forecast).toMatchObject({ value: 100, text: "At this pace: done by Nov 25" });
    expect(fast.forecast!.x).toBeCloseTo(55 / 69);
    // The pace is the recent one, not the average since the start.
    const slowed = burnupView(burnup(), live({ burnups: { u1: result({ history: [h(30, 0), h(14, 39), h(1, 40)] }) } }));
    expect(slowed.forecast!.text).toBe("At this pace: 42 of 100 pts by Dec 9");
  });

  it("gives no forecast it cannot stand behind", () => {
    const view = (over: Partial<ProgressResult>, p: Partial<Periods> = {}): ReturnType<typeof burnupView> => burnupView(burnup(), live({ burnups: { u1: result(over) }, periods: periods(p) }));
    expect(view({ history: [h(2, 30)] })).toMatchObject({ forecast: null, note: "" }); // two days is too little to go on
    expect(view({ history: [h(10, 40)] })).toMatchObject({ forecast: null, note: "Nothing has been finished in the last 10 days." });
    expect(view({ done: 100, history: steady(10, 100, 2) })).toMatchObject({ forecast: null, note: "Everything in scope is done." });
    expect(view({ total: 0, done: 0, history: [] })).toMatchObject({ forecast: null, status: "none", note: "Nothing in scope has an estimate yet." });
    expect(view({ unit: "issues", total: 0, done: 0 }).note).toBe("Nothing in scope yet.");
    expect(burnPill(view({ total: 0, done: 0 }))).toBeNull();
    // Before the period starts there is nothing to judge yet.
    const early = view({}, { today: "2026-09-20" });
    expect([early.points, early.todayX, early.status, early.note]).toEqual([[], null, "none", "PI 26.4 starts on Oct 1."]);
  });

  it("stands as it ended once the period is over", () => {
    const history = [{ d: "2026-12-01", done: 80, total: 100 }, { d: "2026-12-09", done: 90, total: 100 }, { d: "2026-12-20", done: 99, total: 120 }];
    const v = burnupView(burnup(), live({ burnups: { u1: result({ done: 99, total: 120, history }) }, periods: periods({ today: "2026-12-20" }) }));
    expect([v.done, v.total, v.todayX, v.forecast]).toEqual([90, 100, null, null]);
    expect(v.points.map((p) => p.d)).toEqual(["2026-12-01", "2026-12-09"]);
    expect([v.status, burnPill(v)?.text]).toEqual(["warn", "At risk"]); // it ended 10 points short, judged like a bar
  });

  it("picks round axis values that reach the top", () => {
    expect(axisTicks(100)).toEqual([0, 50, 100]);
    expect(axisTicks(110)).toEqual([0, 50, 100, 150]);
    expect(axisTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(axisTicks(8)).toEqual([0, 2, 4, 6, 8]);
    expect(axisTicks(3)).toEqual([0, 1, 2, 3]);
    expect(axisTicks(1240)).toEqual([0, 500, 1000, 1500]);
    expect(axisTicks(0)).toEqual([0, 1]);
    // The axis makes room for a scope that used to be larger and for the forecast.
    const shrunk = burnupView(burnup(), live({ burnups: { u1: result({ history: [h(20, 10, 180)] }) } }));
    expect([shrunk.max, shrunk.ticks]).toEqual([200, [0, 50, 100, 150, 200]]);
  });

  it("finds the day nearest the pointer", () => {
    const v = burnupView(burnup(), live({ burnups: { u1: result({ history: [h(40, 0), h(20, 20)] }) } }));
    expect(nearestPoint(v.points, 0.05)?.d).toBe("2026-10-01");
    expect(nearestPoint(v.points, 0.33)?.d).toBe("2026-10-21");
    expect(nearestPoint(v.points, 2)?.d).toBe(TODAY);
    expect(nearestPoint([], 0.5)).toBeNull();
  });
});

describe("burn-up charts in the room", () => {
  it("count like a bar in the wall's signals", () => {
    const behind = live({ burnups: { u1: result({ done: 30 }) } });
    expect(signals([burnup()], behind)).toMatchObject({ barBad: 1, barWarn: 0, items: 1, jiraFailing: 0 });
    expect(panelStatus(burnup(), behind)).toBe("bad");
    expect(chipList(signals([burnup()], behind))).toEqual([{ text: "1 behind pace", status: "bad" }]);
    expect(panelStatus(burnup(), live({ burnups: { u1: result({ done: 45 }) } }))).toBe("warn");
    expect(panelStatus(burnup(), live({ burnups: { u1: result({ done: 60 }) } }))).toBe("good");
    expect(signals([burnup()], live({ burnups: { u1: result({ ok: false, error: "x" }) } }))).toMatchObject({ jiraFailing: 1, items: 0 });
    expect(panelStatus(burnup({ source: null }), live())).toBe("none");
    expect(panelStatus(burnup(), live())).toBe("none"); // still loading
  });

  it("are kept, repaired or dropped when a room is read", () => {
    const read = (data: unknown): unknown => normalizeRoom({ walls: [{ id: "w", panels: [{ id: "u1", type: "burnup", title: "Burn", span: 2, data }] }] })!.walls[0]!.panels[0];
    expect(read({ source: { kind: "jql", jql: " project = PLAT ", measure: "points" }, period: { kind: "sprint" } })).toEqual({
      id: "u1",
      type: "burnup",
      title: "Burn",
      span: 2,
      data: { source: { kind: "jql", jql: "project = PLAT", descend: false, measure: "points", includeSubtasks: false, doneStatuses: [] }, period: { kind: "sprint" } },
    });
    expect(read({ source: { kind: "manual", done: 1, total: 2 }, period: { kind: "none" } })).toMatchObject({ data: { source: null, period: { kind: "pi" } } });
    expect(read({ period: { kind: "dates", start: "2026-11-01", end: "2026-11-30" } })).toMatchObject({ data: { source: null, period: { kind: "dates", start: "2026-11-01", end: "2026-11-30" } } });
    expect(read(undefined)).toMatchObject({ data: { source: null, period: { kind: "pi" } } });
    // "Count the work under each match" is kept only when it is plainly switched on.
    const descend = (value: unknown): unknown => (read({ source: { kind: "jql", jql: "issuetype = Epic", descend: value } }) as BurnupPanel).data.source;
    expect(descend(true)).toMatchObject({ kind: "jql", descend: true });
    expect(descend("yes")).toMatchObject({ descend: false });
    expect(read({ source: { kind: "issue", key: "PLAT-1", descend: true } })).not.toHaveProperty("data.source.descend");
  });

  it("keep the trend switch on bars, on by default for rooms saved before it existed", () => {
    const read = (data: unknown): ProgressPanel => normalizeRoom({ walls: [{ id: "w", panels: [{ id: "p1", type: "progress", data }] }] })!.walls[0]!.panels[0] as ProgressPanel;
    expect(read({ items: [] }).data.showTrend).toBe(true);
    expect(read({ items: [], showTrend: false }).data.showTrend).toBe(false);
    expect((newPanel("progress", "Bars", 3) as ProgressPanel).data.showTrend).toBe(true);
  });

  it("start unlinked on the current PI, and the example room carries two", () => {
    expect(newPanel("burnup", "Burn-up chart", 2)).toMatchObject({ type: "burnup", data: { source: null, period: { kind: "pi" } } });
    const charts = seed("program").walls[1]!.panels.filter((p): p is BurnupPanel => p.type === "burnup");
    expect(charts.map((p) => [p.title, p.span, p.data.source?.kind, p.data.source?.measure, p.data.period.kind])).toEqual([
      ["PI burn-up", 2, "jql", "points", "pi"],
      ["Sprint burn-up", 1, "jql", "points", "sprint"],
    ]);
    // The PI chart finds the PI's epics and measures the stories under them; the sprint chart counts its matches.
    expect(charts.map((p) => (p.data.source?.kind === "jql" ? [p.data.source.jql, p.data.source.descend] : null))).toEqual([
      ['issuetype = Epic AND {PI_FIELD} = "{PI}"', true],
      ["sprint in openSprints()", false],
    ]);
    // An example room survives a round trip through the server unchanged.
    const room = seed("program");
    expect(normalizeRoom(JSON.parse(JSON.stringify(room)))).toEqual(room);
  });

  it("make the room depend on the PI calendar only when they follow it", () => {
    const room = (p: BurnupPanel): Parameters<typeof roomUsesPi>[0] => ({ ...seed("program"), walls: [{ id: "w", name: "W", subtitle: "", panels: [p] }] });
    expect(roomUsesPi(room(burnup()))).toBe(true);
    expect(roomUsesPi(room(burnup({ period: { kind: "sprint" } })))).toBe(false);
    expect(roomUsesPi(room(burnup({ period: { kind: "sprint" }, source: { kind: "jql", jql: '{PI_FIELD} = "{PI}"', descend: false, ...defaultJiraOptions() } })))).toBe(true);
    expect(roomUsesPi(room(burnup({ source: null })))).toBe(false);
  });

  it("get a fixed share of a TV's height", () => {
    const [chart] = tvRowWeights([burnup()], live());
    const [statement] = tvRowWeights([newPanel("statement", "S", 1)], live());
    expect(chart!).toBeGreaterThan(statement!);
  });
});
