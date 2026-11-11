import { describe, expect, it } from "vitest";
import type { DepIssue, DependenciesPanel, Dependency, DepsResult, Periods, RiskItem, RisksPanel } from "../types";
import { defaultDepSource, depState, depsView, isCrossTeam, riskLive, riskStatus, sortRisks } from "./deps";
import { normalizeRoom } from "./normalize";
import { roomUsesPi } from "./periods";
import type { LiveData } from "./progress";
import { PANEL_TYPES, TEMPLATES, newPanel, seed } from "./seed";
import { chipList, panelStatus, signals, wallStatus } from "./status";
import { tvRowWeights } from "./tvlayout";

const periods: Periods = { today: "2026-11-10", pi: null, nextPi: null, sprint: null };
const live = (over: Partial<LiveData> = {}): LiveData => ({ progress: {}, auto: {}, boards: {}, metrics: {}, burnups: {}, deps: {}, periods, jiraConfigured: true, ...over });

const CATEGORY: Record<string, string> = { "To Do": "new", "In Progress": "indeterminate", Done: "done" };
const end = (key: string, status = "To Do"): DepIssue => ({ key, title: `Title of ${key}`, url: `https://jira.example/browse/${key}`, status, category: CATEGORY[status] ?? "", project: key.split("-")[0]! });
const dep = (waiting: string, waitingStatus: string, on: string, onStatus: string, type = "Blocks"): Dependency => ({ waiting: end(waiting, waitingStatus), on: end(on, onStatus), type });

const result = (deps: Dependency[], over: Partial<DepsResult> = {}): DepsResult => ({ ok: true, deps, total: deps.length, scope: 40, fetchedAt: "2026-11-10T09:00:00Z", ...over });

const panel = (source: Partial<DependenciesPanel["data"]["source"] & object> | null = {}): DependenciesPanel => ({
  id: "d1",
  type: "dependencies",
  title: "Dependencies",
  span: 2,
  data: { source: source === null ? null : { ...defaultDepSource("project = PLAT"), ...source } },
});

const DEPS = [
  dep("PLAT-4", "In Progress", "DATA-9", "To Do"), // work under way, held up by another team
  dep("PLAT-5", "In Progress", "PLAT-8", "In Progress"), // held up within the team
  dep("PLAT-6", "To Do", "DATA-3", "In Progress", "Dependency"), // not started yet
  dep("PLAT-7", "To Do", "DATA-2", "Done", "Dependency"), // settled
  dep("PLAT-9", "Done", "DATA-1", "To Do"), // the waiting side finished anyway: settled
];

describe("dependencies", () => {
  it("tells waiting now from open from settled", () => {
    expect(DEPS.map(depState)).toEqual(["waiting", "waiting", "open", "done", "done"]);
    expect(DEPS.map(isCrossTeam)).toEqual([true, false, true, true, true]);
  });

  it("lists what is live, counts everything, and says what it leaves out", () => {
    const v = depsView(panel(), live({ deps: { d1: result(DEPS) } }));
    expect(v.state).toBe("ok");
    expect(v.rows.map((r) => [r.waiting.key, r.on.key, r.label, r.status, r.crossTeam])).toEqual([
      ["PLAT-4", "DATA-9", "Waiting now", "bad", true],
      ["PLAT-5", "PLAT-8", "Waiting now", "bad", false],
      ["PLAT-6", "DATA-3", "Open", "none", true],
    ]);
    expect([v.waiting, v.open, v.done, v.crossTeam, v.more]).toEqual([2, 1, 2, 2, 0]);
    expect(v.footer).toBe("3 open dependencies, 2 holding up work under way · 2 across teams · 2 settled, not shown");
  });

  it("shows settled ones when asked, and keeps to the row limit", () => {
    const all = depsView(panel({ showDone: true }), live({ deps: { d1: result(DEPS) } }));
    expect(all.rows.map((r) => r.label)).toEqual(["Waiting now", "Waiting now", "Open", "Settled", "Settled"]);
    expect(all.footer).toBe("3 open dependencies, 2 holding up work under way · 2 across teams");
    const two = depsView(panel({ limit: 2 }), live({ deps: { d1: result(DEPS) } }));
    expect([two.rows.length, two.more]).toEqual([2, 1]);
    expect(two.footer).toContain("1 more not shown");
    // The server sends at most 200 and reports the true total.
    const capped = depsView(panel({ limit: 50 }), live({ deps: { d1: result(DEPS, { total: 260 }) } }));
    expect(capped.more).toBe(255);
  });

  it("says why there is nothing to list", () => {
    expect(depsView(panel(null), live())).toMatchObject({ state: "unlinked", rows: [] });
    expect(depsView(panel(), live())).toMatchObject({ state: "loading", message: "Loading from Jira…" });
    expect(depsView(panel(), live({ jiraConfigured: false }))).toMatchObject({ state: "disconnected" });
    expect(depsView(panel(), live({ deps: { d1: result([], { ok: false, error: "Bad query." }) } }))).toMatchObject({ state: "error", message: "Bad query." });
    const empty = depsView(panel(), live({ deps: { d1: result([]) } }));
    expect([empty.state, empty.rows, empty.footer]).toEqual(["ok", [], ""]);
    expect(empty.empty).toBe("No dependencies between the 40 issues this query finds. They are read from Jira's issue links.");
    const settled = depsView(panel(), live({ deps: { d1: result(DEPS.slice(3)) } }));
    expect(settled.empty).toBe("Nothing is waiting on anything: all 2 dependencies here are settled.");
  });

  it("raises a red flag for work held up, and nothing for dependencies that are merely open", () => {
    const held = live({ deps: { d1: result(DEPS) } });
    expect(signals([panel()], held)).toMatchObject({ waiting: 2, items: 3, jiraFailing: 0 });
    expect(panelStatus(panel(), held)).toBe("bad");
    expect(chipList(signals([panel()], held))).toEqual([{ text: "2 waiting on a dependency", status: "bad" }]);
    const open = live({ deps: { d1: result(DEPS.slice(2)) } });
    expect(panelStatus(panel(), open)).toBe("good");
    expect(wallStatus(signals([panel()], open))).toBe("good");
    expect(signals([panel()], live({ deps: { d1: result([], { ok: false, error: "x" }) } }))).toMatchObject({ jiraFailing: 1, waiting: 0 });
    expect(panelStatus(panel(null), live())).toBe("none");
  });

  it("survives a round trip and repairs what it is given", () => {
    const read = (source: unknown): unknown => (normalizeRoom({ walls: [{ id: "w", panels: [{ id: "d1", type: "dependencies", title: "Deps", data: { source } }] }] })!.walls[0]!.panels[0] as DependenciesPanel).data.source;
    expect(read({ jql: " project = PLAT ", linkTypes: ["Blocks", " ", "Dependency"], showDone: true, limit: 500 })).toEqual({ jql: "project = PLAT", linkTypes: ["Blocks", "Dependency"], showDone: true, limit: 50 });
    expect(read({ jql: "project = PLAT" })).toEqual({ jql: "project = PLAT", linkTypes: [], showDone: false, limit: 12 });
    expect(read({ jql: "  " })).toBeNull();
    expect(read("junk")).toBeNull();
    expect(newPanel("dependencies", "Dependencies", 2)).toMatchObject({ type: "dependencies", data: { source: null } });
    expect(PANEL_TYPES.dependencies.item).toBe(""); // read-only: nothing to add by hand
  });

  it("follows the PI calendar only when its query does", () => {
    const room = (p: DependenciesPanel): Parameters<typeof roomUsesPi>[0] => ({ ...seed("program"), walls: [{ id: "w", name: "W", subtitle: "", panels: [p] }] });
    expect(roomUsesPi(room(panel({ jql: '{PI_FIELD} = "{PI}"' })))).toBe(true);
    expect(roomUsesPi(room(panel()))).toBe(false);
    expect(roomUsesPi(room(panel(null)))).toBe(false);
  });

  it("takes a row of TV height per dependency shown", () => {
    const few = tvRowWeights([panel()], live({ deps: { d1: result(DEPS.slice(0, 1)) } }));
    const many = tvRowWeights([panel()], live({ deps: { d1: result(DEPS) } }));
    expect(many[0]!).toBeGreaterThan(few[0]!);
  });
});

describe("risks", () => {
  const risk = (id: string, impact: RiskItem["impact"], roam: RiskItem["roam"]): RiskItem => ({ id, title: `Risk ${id}`, owner: "", impact, roam, note: "" });
  const risks = (items: RiskItem[]): RisksPanel => ({ id: "r1", type: "risks", title: "Risks", span: 1, data: { items } });

  it("is live while open or owned, and red only when a high one has no owner", () => {
    expect([riskLive(risk("a", "Low", "Open")), riskLive(risk("a", "Low", "Owned")), riskLive(risk("a", "High", "Accepted"))]).toEqual([true, true, false]);
    expect(riskStatus(risk("a", "High", "Open"))).toBe("bad");
    expect(riskStatus(risk("a", "High", "Owned"))).toBe("warn");
    expect(riskStatus(risk("a", "Medium", "Open"))).toBe("warn");
    for (const roam of ["Accepted", "Mitigated", "Resolved"] as const) expect(riskStatus(risk("a", "High", roam))).toBe("good");
  });

  it("puts live risks first, the biggest and least looked-after on top", () => {
    const items = [risk("resolved-high", "High", "Resolved"), risk("owned-high", "High", "Owned"), risk("open-low", "Low", "Open"), risk("open-high", "High", "Open"), risk("accepted-med", "Medium", "Accepted"), risk("open-med", "Medium", "Open")];
    expect(sortRisks(items).map((r) => r.id)).toEqual(["open-high", "owned-high", "open-med", "open-low", "resolved-high", "accepted-med"]);
    expect(items[0]!.id).toBe("resolved-high"); // the room's own order is left alone
  });

  it("rolls up like open problems", () => {
    const none = live();
    expect(panelStatus(risks([]), none)).toBe("none");
    expect(panelStatus(risks([risk("a", "High", "Resolved"), risk("b", "Low", "Accepted")]), none)).toBe("good");
    expect(panelStatus(risks([risk("a", "High", "Owned")]), none)).toBe("warn");
    const red = risks([risk("a", "High", "Open"), risk("b", "Medium", "Open"), risk("c", "Low", "Mitigated")]);
    expect(signals([red], none)).toMatchObject({ items: 3, open: 2, openHigh: 1 });
    expect(panelStatus(red, none)).toBe("bad");
    expect(chipList(signals([red], none))).toEqual([{ text: "1 high severity", status: "bad" }]);
  });

  it("is repaired when a room is read, and added empty", () => {
    const read = (items: unknown): RiskItem[] => (normalizeRoom({ walls: [{ id: "w", panels: [{ id: "r1", type: "risks", data: { items } }] }] })!.walls[0]!.panels[0] as RisksPanel).data.items;
    expect(read([{ id: "a", title: "Hosting slips", owner: "PM", impact: "High", roam: "Owned", note: "Chasing" }])).toEqual([{ id: "a", title: "Hosting slips", owner: "PM", impact: "High", roam: "Owned", note: "Chasing" }]);
    expect(read([{ id: "b", title: "No status", impact: "Huge", roam: "Ignored" }])).toEqual([{ id: "b", title: "No status", owner: "", impact: "Medium", roam: "Open", note: "" }]);
    expect(read("junk")).toEqual([]);
    expect(newPanel("risks", "Risks", 1)).toMatchObject({ type: "risks", data: { items: [] } });
    expect(PANEL_TYPES.risks.item).toBe("Risk");
  });
});

describe("the dependencies and risks wall", () => {
  it("comes with the program room as its last wall, and survives a round trip", () => {
    expect(TEMPLATES.program!.walls).toEqual(["direction", "performance", "delivery", "problems", "dependencies"]);
    const room = seed("program");
    const wall = room.walls[4]!;
    expect([wall.name, wall.panels.map((p) => [p.type, p.span])]).toEqual(["Dependencies & risks", [["dependencies", 2], ["risks", 1]]]);
    const deps = wall.panels[0] as DependenciesPanel;
    expect(deps.data.source).toEqual({ jql: "project in (PLAT, DATA)", linkTypes: [], showDone: false, limit: 12 });
    const register = wall.panels[1] as RisksPanel;
    expect(register.data.items.map((r) => r.roam)).toEqual(["Open", "Owned", "Mitigated", "Accepted", "Resolved"]);
    expect(normalizeRoom(JSON.parse(JSON.stringify(room)))).toEqual(room);
    // The example register has one high risk nobody owns, so the wall starts red, as a real one would.
    expect(wallStatus(signals(wall.panels, live()))).toBe("bad");
  });
});
