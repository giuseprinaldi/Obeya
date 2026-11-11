import { describe, expect, it } from "vitest";
import type { BoardCard, BoardColumn, BoardResult, HistoryPoint, KanbanPanel, Periods, ProgressBarItem, ProgressPanel, ProgressResult } from "../types";
import { boardView, defaultBoardSource } from "./board";
import { normalizeRoom } from "./normalize";
import { barPill, defaultDisplay, defaultJiraOptions, itemBar, resolveBars, type LiveData } from "./progress";
import { newPanel } from "./seed";
import { BAR_STALE_DEFAULT, CARD_STALE_DEFAULT, cardStaleDays, isStalled, staleText, staleThreshold, stalledDays } from "./stale";
import { chipList, panelStatus, signals, watchCount } from "./status";
import { addDays } from "./util";

const TODAY = "2026-11-10";

const periods = (over: Partial<Periods> = {}): Periods => ({ today: TODAY, pi: null, nextPi: null, sprint: null, ...over });
const live = (over: Partial<LiveData> = {}): LiveData => ({ progress: {}, auto: {}, boards: {}, metrics: {}, burnups: {}, deps: {}, periods: periods(), jiraConfigured: true, ...over });

/** A history point `ago` days before today. */
const h = (ago: number, done: number, total = 100): HistoryPoint => ({ d: addDays(TODAY, -ago), done, total });

const result = (over: Partial<ProgressResult> = {}): ProgressResult => ({
  ok: true,
  key: "PLAT-1",
  title: "Feature proposal pipeline",
  url: "https://jira.example/browse/PLAT-1",
  issueType: "Epic",
  status: "In Progress",
  unit: "issues",
  total: 100,
  done: 40,
  inProgress: 10,
  todo: 50,
  issues: 100,
  unestimated: 0,
  byStatus: {},
  history: [],
  fetchedAt: "2026-11-10T09:00:00Z",
  ...over,
});

const bar = (id: string, over: Partial<ProgressBarItem> = {}): ProgressBarItem => ({
  id,
  label: id,
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
  data: { items: [], auto: null, autoDisplay: defaultDisplay(), sort: "manual", showKeys: true, showTrend: true, staleDays: 14, ...data },
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
  category: "indeterminate",
  idleDays: 1,
  ...over,
});
const column = (name: string, cards: BoardCard[], over: Partial<BoardColumn> = {}): BoardColumn => ({ name, wip: 0, total: cards.length, cards, ...over });
const boardResult = (columns: BoardColumn[]): BoardResult => ({
  ok: true,
  boardName: "Platform board",
  boardType: "scrum",
  sprint: null,
  columns,
  blocked: 0,
  total: columns.reduce((n, c) => n + c.total, 0),
  fetchedAt: "",
});
const jiraBoard = (over: Partial<NonNullable<KanbanPanel["data"]["jira"]>> = {}): KanbanPanel => ({
  id: "k1",
  type: "kanban",
  title: "Flow",
  span: 3,
  data: { columns: [{ id: "c1", name: "To do", wip: 0 }], cards: [], jira: { ...defaultBoardSource(1), ...over } },
});

describe("how long a bar has stalled", () => {
  it("counts the days since the done amount last went up", () => {
    // 30 until six days ago, then 40 from five days ago on: stalled for five days.
    expect(stalledDays([h(8, 30), h(7, 30), h(6, 30), h(5, 40), h(4, 40), h(3, 40), h(2, 40), h(1, 40)], 40, TODAY)).toBe(5);
    // It went up today.
    expect(stalledDays([h(3, 30), h(2, 35), h(1, 38)], 40, TODAY)).toBe(0);
    // It went up yesterday and not since.
    expect(stalledDays([h(3, 30), h(2, 35), h(1, 40)], 40, TODAY)).toBe(1);
  });
  it("only claims as many days as the history reaches back", () => {
    // Linked two days ago and already at 40: stalled for at least two days, not for fourteen.
    expect(stalledDays([h(2, 40), h(1, 40)], 40, TODAY)).toBe(2);
    expect(stalledDays([h(30, 40), h(1, 40)], 40, TODAY)).toBe(30);
  });
  it("does not take a day the server missed as progress", () => {
    expect(stalledDays([h(20, 30), h(12, 40), h(2, 40)], 40, TODAY)).toBe(12);
    // Nothing between a lower amount twenty days ago and today: it went up at some point, so nothing is claimed.
    expect(stalledDays([h(20, 30)], 40, TODAY)).toBe(0);
  });
  it("treats a done amount that went down as not having gone up", () => {
    expect(stalledDays([h(9, 30), h(8, 45), h(4, 42), h(1, 40)], 40, TODAY)).toBe(8);
  });
  it("ignores today's own snapshot, later days and junk, in any order", () => {
    expect(stalledDays([h(1, 40), h(0, 99), h(-3, 99), { d: "junk", done: 1, total: 2 }, h(4, 40), h(5, 30)], 40, TODAY)).toBe(4);
  });
  it("has nothing to say without an earlier day", () => {
    expect(stalledDays([], 40, TODAY)).toBeNull();
    expect(stalledDays(undefined, 40, TODAY)).toBeNull();
    expect(stalledDays([h(0, 40)], 40, TODAY)).toBeNull();
    expect(stalledDays([h(3, 40)], 40, "not a date")).toBeNull();
  });
  it("needs a bar that has started and is not finished", () => {
    const quiet = { pct: 40, done: 40, wipPct: 0, stalledDays: 20 };
    expect(isStalled(quiet, 14)).toBe(true);
    expect(isStalled(quiet, 21)).toBe(false);
    expect(isStalled(quiet, 0)).toBe(false); // switched off
    expect(isStalled({ ...quiet, pct: 100 }, 14)).toBe(false); // finished
    expect(isStalled({ ...quiet, pct: 0, done: 0 }, 14)).toBe(false); // not started
    expect(isStalled({ ...quiet, pct: 0, done: 0, wipPct: 10 }, 14)).toBe(true); // nothing done, but work is in progress
    expect(isStalled({ ...quiet, stalledDays: null }, 14)).toBe(false);
  });
});

describe("stale bars", () => {
  const flat = (days: number, done = 40): HistoryPoint[] => Array.from({ length: days }, (_, i) => h(days - i, done));
  const panelWith = (history: HistoryPoint[], data: Partial<ProgressPanel["data"]> = {}, over: Partial<ProgressResult> = {}) => {
    const panel = progressPanel({ items: [bar("b1")], ...data });
    return { panel, data: live({ progress: { b1: result({ history, ...over }) } }) };
  };

  it("flags a started bar that has not moved for the panel's threshold", () => {
    const { panel, data } = panelWith(flat(16));
    const [b] = resolveBars(panel, data).bars;
    expect([b!.stalledDays, b!.stale]).toEqual([16, true]);
    expect(barPill(b!)).toEqual({ text: "No progress 16d", status: "warn" });
    expect(signals([panel], data)).toMatchObject({ stale: 1, barBad: 0, barWarn: 0 });
    expect(chipList(signals([panel], data))).toEqual([{ text: "1 stale", status: "warn" }]);
    expect(panelStatus(panel, data)).toBe("warn");
  });
  it("leaves a bar alone until it has been quiet for long enough, and follows the threshold", () => {
    const short = panelWith(flat(10));
    expect(resolveBars(short.panel, short.data).bars[0]).toMatchObject({ stalledDays: 10, stale: false });
    expect(barPill(resolveBars(short.panel, short.data).bars[0]!)).toBeNull();
    expect(signals([short.panel], short.data).stale).toBe(0);
    const lower = panelWith(flat(10), { staleDays: 7 });
    expect(resolveBars(lower.panel, lower.data).bars[0]!.stale).toBe(true);
    const off = panelWith(flat(40), { staleDays: 0 });
    expect(resolveBars(off.panel, off.data).bars[0]).toMatchObject({ stalledDays: 40, stale: false });
    expect(chipList(signals([off.panel], off.data))).toEqual([{ text: "All clear", status: "good" }]);
  });
  it("never flags work that is finished, not started, manual or failing", () => {
    const done = panelWith(flat(30, 100), {}, { done: 100, inProgress: 0, todo: 0 });
    expect(resolveBars(done.panel, done.data).bars[0]!.stale).toBe(false);
    const notStarted = panelWith(flat(30, 0), {}, { done: 0, inProgress: 0, todo: 100 });
    expect(resolveBars(notStarted.panel, notStarted.data).bars[0]!.stale).toBe(false);
    // Nothing done yet, but work is in progress and nothing has landed for a month.
    const underWay = panelWith(flat(30, 0), {}, { done: 0, inProgress: 10, todo: 90 });
    expect(resolveBars(underWay.panel, underWay.data).bars[0]!.stale).toBe(true);
    const manual = progressPanel({ items: [bar("m1", { source: { kind: "manual", done: 3, total: 10, unit: "sites" } })] });
    expect(resolveBars(manual, live()).bars[0]).toMatchObject({ stalledDays: null, stale: false });
    const failing = panelWith(flat(30), {}, { ok: false, error: "gone" });
    expect(resolveBars(failing.panel, failing.data).bars[0]).toMatchObject({ state: "error", stale: false });
    expect(signals([failing.panel], failing.data)).toMatchObject({ stale: 0, jiraFailing: 1 });
  });
  it("keeps the pace pills first and still counts the bar as stale", () => {
    const paced = progressPanel({ items: [bar("b1", { pace: { kind: "dates", start: addDays(TODAY, -90), end: addDays(TODAY, 10) } })] });
    const data = live({ progress: { b1: result({ history: flat(20) }) } });
    const [b] = resolveBars(paced, data).bars;
    expect([b!.status, b!.stale]).toEqual(["bad", true]);
    expect(barPill(b!)).toEqual({ text: "Behind", status: "bad" });
    expect(signals([paced], data)).toMatchObject({ barBad: 1, stale: 1 });
  });
  it("covers the bars a panel's query produces, and a bar worked out on its own is never stale", () => {
    const panel = progressPanel({ auto: { jql: "x", limit: 5, ...defaultJiraOptions() } });
    const auto = { p1: { ok: true, bars: [result({ key: "PLAT-2", history: flat(20) }), result({ key: "PLAT-3", history: flat(3) })], truncated: false, fetchedAt: "" } };
    expect(resolveBars(panel, live({ auto })).bars.map((b) => b.stale)).toEqual([true, false]);
    expect(itemBar(bar("b1"), live({ progress: { b1: result({ history: flat(30) }) } }))).toMatchObject({ stalledDays: 30, stale: false });
  });
});

describe("stale cards", () => {
  it("flags in-progress cards nobody has updated for the board's threshold", () => {
    expect(cardStaleDays(card("A", { idleDays: 9 }), 7)).toBe(9);
    expect(cardStaleDays(card("A", { idleDays: 7 }), 7)).toBe(7);
    expect(cardStaleDays(card("A", { idleDays: 6 }), 7)).toBeNull();
    expect(cardStaleDays(card("A", { idleDays: 40, category: "new" }), 7)).toBeNull(); // waiting, not under way
    expect(cardStaleDays(card("A", { idleDays: 40, category: "done" }), 7)).toBeNull();
    expect(cardStaleDays(card("A", { idleDays: 40 }), 0)).toBeNull(); // switched off
    expect(cardStaleDays(card("A", { idleDays: null }), 7)).toBeNull();
    // An older server sends neither field.
    expect(cardStaleDays({ category: undefined, idleDays: undefined }, 7)).toBeNull();
    expect([staleText(9), staleText(null)]).toEqual(["Stale 9d", ""]);
  });
  it("marks the cards, counts them past the cards-per-column limit, and says so in the footer", () => {
    const columns = [
      column("To do", [card("T-1", { category: "new", idleDays: 30 })]),
      column("In progress", [card("P-1", { idleDays: 9 }), card("P-2", { idleDays: 2 }), card("P-3", { idleDays: 12 }), card("P-4", { idleDays: 8 })]),
      column("Review", [card("R-1", { idleDays: 7 })]),
      // Whatever sits in the last column is finished as far as the board goes.
      column("Done", [card("D-1", { idleDays: 20, category: "done" }), card("D-2", { idleDays: 20 })]),
    ];
    const v = boardView(jiraBoard({ maxCards: 2 }), live({ boards: { k1: boardResult(columns) } }))!;
    expect(v.columns[1]!.cards.map((c) => [c.key, c.staleText])).toEqual([
      ["P-1", "Stale 9d"],
      ["P-2", ""],
    ]);
    expect(v.columns[1]!.cards[0]!.staleTitle).toBe("In progress, and not updated in Jira for 9 days");
    expect(v.columns[0]!.cards[0]!.staleText).toBe("");
    expect(v.columns[3]!.cards.map((c) => c.staleText)).toEqual(["", ""]);
    expect(v.stale).toBe(4); // P-1, P-3, P-4 (two of them beyond the two cards shown) and R-1
    expect(v.footer).toBe("Platform board · 4 stale");
  });
  it("follows the board's threshold, and can be switched off", () => {
    const columns = [column("To do", []), column("In progress", [card("P-1", { idleDays: 9 }), card("P-2", { idleDays: 3 })]), column("Done", [])];
    const data = live({ boards: { k1: boardResult(columns) } });
    expect(boardView(jiraBoard(), data)!.stale).toBe(1); // 7 days by default
    expect(boardView(jiraBoard({ staleDays: 3 }), data)!.stale).toBe(2);
    expect(boardView(jiraBoard({ staleDays: 10 }), data)!.stale).toBe(0);
    const off = boardView(jiraBoard({ staleDays: 0 }), data)!;
    expect([off.stale, off.footer, off.columns[1]!.cards[0]!.staleText]).toEqual([0, "Platform board", ""]);
  });
  it("rolls up into the wall's signals as something to watch", () => {
    const columns = [column("To do", []), column("In progress", [card("P-1", { idleDays: 9 }), card("P-2", { idleDays: 15 })]), column("Done", [])];
    const data = live({ boards: { k1: boardResult(columns) } });
    const s = signals([jiraBoard()], data);
    expect(s).toMatchObject({ stale: 2, blocked: 0, overWip: 0 });
    expect(watchCount(s)).toBe(2);
    expect(chipList(s)).toEqual([{ text: "2 stale", status: "warn" }]);
    expect(panelStatus(jiraBoard(), data)).toBe("warn");
    // A board that is loading, failing or entered by hand has nothing stale.
    expect(signals([jiraBoard()], live()).stale).toBe(0);
    const manual: KanbanPanel = { id: "k2", type: "kanban", title: "Manual", span: 3, data: { columns: [{ id: "c1", name: "Doing", wip: 0 }], cards: [{ id: "x", title: "Old card", owner: "", tag: "", col: "c1", blocked: false }], jira: null } };
    expect(signals([manual], live()).stale).toBe(0);
  });
});

describe("stale thresholds", () => {
  it("are whole days within range, with a default for anything else", () => {
    expect(staleThreshold(9, 7, 90)).toBe(9);
    expect(staleThreshold("12", 7, 90)).toBe(12);
    expect(staleThreshold(4.6, 7, 90)).toBe(5);
    expect(staleThreshold(0, 7, 90)).toBe(0);
    expect(staleThreshold(-3, 7, 90)).toBe(0);
    expect(staleThreshold(500, 7, 90)).toBe(90);
    for (const junk of [undefined, null, "", "soon", NaN, {}]) expect(staleThreshold(junk, 7, 90)).toBe(7);
  });
  it("default to 7 days for boards and 14 for bars, also in rooms saved before they existed", () => {
    expect([CARD_STALE_DEFAULT, BAR_STALE_DEFAULT]).toEqual([7, 14]);
    expect(defaultBoardSource(3).staleDays).toBe(7);
    expect((newPanel("progress", "Bars", 3) as ProgressPanel).data.staleDays).toBe(14);
    const read = (panel: unknown) => normalizeRoom({ walls: [{ id: "w", panels: [panel] }] })!.walls[0]!.panels[0]!;
    const board = (jira: unknown) => (read({ id: "k1", type: "kanban", data: { columns: [], cards: [], jira } }) as KanbanPanel).data.jira!;
    expect(board({ boardId: 7 }).staleDays).toBe(7);
    expect(board({ boardId: 7, staleDays: 0 }).staleDays).toBe(0);
    expect(board({ boardId: 7, staleDays: 200 }).staleDays).toBe(90);
    const bars = (data: unknown) => (read({ id: "p1", type: "progress", data }) as ProgressPanel).data.staleDays;
    expect(bars({ items: [] })).toBe(14);
    expect(bars({ items: [], staleDays: 0 })).toBe(0);
    expect(bars({ items: [], staleDays: 21 })).toBe(21);
    expect(bars({ items: [], staleDays: 99 })).toBe(60);
  });
});
