/* The room that "python -m obeya setup" builds, as the app reads it.
   The fixture is written by backend/tests/test_setup.py from backend/setup.example.json, and that
   test fails when the two drift apart. The command writes the room straight to the database, so
   nothing else checks that its panels have the shape this app expects. */
import { describe, expect, it } from "vitest";
import built from "../../../backend/tests/fixtures/setup-room.json";
import type { BurnupPanel, DependenciesPanel, KanbanPanel, KpiPanel, Panel, ProgressPanel, Room } from "../types";
import { normalizeRoom } from "./normalize";

const room = normalizeRoom(built) as Room;
const panels = (r: { walls: { panels: unknown[] }[] }): unknown[] => r.walls.flatMap((w) => w.panels);
const ofType = <T extends Panel>(type: T["type"]): T[] => room.walls.flatMap((w) => w.panels).filter((p): p is T => p.type === type);

describe("a room built by the setup command", () => {
  it("is already in the form the app saves, so opening it changes nothing", () => {
    expect(room).not.toBeNull();
    expect(room).toEqual(built);
  });
  it("loses no panel", () => {
    expect(panels(room)).toHaveLength(panels(built).length);
    expect(room.walls.map((w) => w.id)).toEqual(["setup-team-platform", "setup-team-data", "setup-portfolio", "setup-dependencies"]);
  });
  it("keeps every Jira link", () => {
    const kpis = ofType<KpiPanel>("kpi").flatMap((p) => p.data.items);
    expect(kpis.length).toBeGreaterThan(10);
    expect(kpis.every((k) => k.metric !== null && k.metric !== undefined)).toBe(true);
    expect(kpis.filter((k) => k.metric?.kind === "count").map((k) => k.name)).toEqual(["Cancelled work", "Stories with no estimate"]);
    expect(ofType<KanbanPanel>("kanban").map((p) => p.data.jira?.boardId)).toEqual([1, 2]);
    expect(ofType<BurnupPanel>("burnup").map((p) => p.data.source?.kind)).toEqual(["jql"]);
    expect(ofType<DependenciesPanel>("dependencies").map((p) => p.data.source?.jql)).toEqual(["project in (PLAT, DATA)"]);
    const bars = ofType<ProgressPanel>("progress").flatMap((p) => p.data.items);
    expect(bars.map((b) => (b.source.kind === "issue" ? b.source.key : ""))).toEqual(["PLAT-1", "DATA-1"]);
  });
  it("keeps a team's own estimate field and unit", () => {
    const data = room.walls.find((w) => w.id === "setup-team-data")!;
    const wip = (data.panels[0] as KpiPanel).data.items.find((k) => k.metric?.kind === "wip")!;
    expect(wip.unit).toBe("hrs");
    expect(wip.metric?.estimateField).toBe("customfield_10108");
  });
});
