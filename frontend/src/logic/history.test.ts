import { describe, expect, it } from "vitest";
import type { RoomHistory, RoomVersionInfo } from "../types";
import { changeLines, countsText, restoredText, versionRows } from "./history";

const info = (over: Partial<RoomVersionInfo> = {}): RoomVersionInfo => ({
  version: 3,
  savedAt: "2026-11-10T15:04:00+00:00",
  roomName: "Program Obeya",
  walls: 4,
  panels: 12,
  changes: ["Added panel PI burn-up to Delivery"],
  more: 0,
  ...over,
});

describe("earlier versions", () => {
  it("counts walls and panels in plain words", () => {
    expect(countsText({ walls: 4, panels: 12 })).toBe("4 walls · 12 panels");
    expect(countsText({ walls: 1, panels: 1 })).toBe("1 wall · 1 panel");
    expect(countsText({ walls: 0, panels: 0 })).toBe("0 walls · 0 panels");
  });

  it("lists what a save changed, and says when there is more than fits", () => {
    expect(changeLines(info())).toEqual(["Added panel PI burn-up to Delivery"]);
    expect(changeLines(info({ changes: ["A", "B"], more: 3 }))).toEqual(["A", "B", "and 3 more changes"]);
    expect(changeLines(info({ changes: ["A"], more: 1 }))).toEqual(["A", "and 1 more change"]);
  });

  it("never leaves a row without an explanation", () => {
    expect(changeLines(info({ changes: [], more: 0 }))).toEqual(["Saved with no changes to the room"]);
    expect(changeLines(info({ changes: ["", "  "], more: 0 }))).toEqual(["Saved with no changes to the room"]);
    // An answer that is missing fields (an older or a broken server) still reads sensibly.
    expect(changeLines({} as RoomVersionInfo)).toEqual(["Saved with no changes to the room"]);
    expect(changeLines({ changes: ["A"], more: -2 } as RoomVersionInfo)).toEqual(["A"]);
  });

  it("marks the live version and puts the newest first", () => {
    const history: RoomHistory = { current: 3, versions: [info({ version: 2, changes: ["Room settings changed"] }), info({ version: 3 }), info({ version: 1, walls: 1, panels: 0, changes: ["Room created"] })] };
    const rows = versionRows(history);
    expect(rows.map((r) => [r.version, r.current])).toEqual([
      [3, true],
      [2, false],
      [1, false],
    ]);
    expect(rows[0]!.label).toBe("Version 3 · 4 walls · 12 panels");
    expect(rows[2]!).toMatchObject({ label: "Version 1 · 1 wall · 0 panels", lines: ["Room created"], savedAt: "2026-11-10T15:04:00+00:00" });
  });

  it("marks nothing as live when the live version is no longer in the list", () => {
    expect(versionRows({ current: 9, versions: [info({ version: 3 })] }).map((r) => r.current)).toEqual([false]);
  });

  it("copes with an empty or malformed answer", () => {
    expect(versionRows({ current: 0, versions: [] })).toEqual([]);
    expect(versionRows(null)).toEqual([]);
    expect(versionRows({ current: 1 } as RoomHistory)).toEqual([]);
    const odd = { current: 2, versions: [info({ version: 2 }), { version: "x" }, null, info({ version: 0 })] } as unknown as RoomHistory;
    expect(versionRows(odd).map((r) => r.version)).toEqual([2]);
  });

  it("says what a restore did", () => {
    expect(restoredText("Nov 10, 3:04 PM")).toBe("Restored the room as it was on Nov 10, 3:04 PM. The version you replaced is still in the list.");
    expect(restoredText("")).toBe("Restored the room as it was. The version you replaced is still in the list.");
  });
});
