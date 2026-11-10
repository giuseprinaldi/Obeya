/* Screen addresses, the edit lock and the Jira connection check. */
import { describe, expect, it } from "vitest";
import type { DiagnosticCheck } from "../types";
import { OPEN_ACCESS, accessOf, checkWord, diagnosticsSummary, lockControl, passcodeError } from "./access";
import { isDisplay, neighbourScreen, parseRoute, screenAddress, screenHash, screenOf, screenWall, screenWallIndex } from "./route";
import { seed } from "./seed";

describe("parseRoute", () => {
  it("reads the editor routes", () => {
    expect(parseRoute("")).toEqual({ view: "overview" });
    expect(parseRoute("#overview")).toEqual({ view: "overview" });
    expect(parseRoute("#wall-delivery-ab12")).toEqual({ view: "wall", id: "delivery-ab12" });
    expect(parseRoute("wall-x")).toEqual({ view: "wall", id: "x" });
  });
  it("reads a display pinned to a wall", () => {
    expect(parseRoute("#tv-delivery-ab12")).toEqual({ view: "tv", id: "delivery-ab12" });
    expect(isDisplay(parseRoute("#tv-x"))).toBe(true);
  });
  it("reads a numbered screen", () => {
    expect(parseRoute("#screen-1")).toEqual({ view: "screen", n: 1 });
    expect(parseRoute("#screen-12")).toEqual({ view: "screen", n: 12 });
    expect(parseRoute("#screen-007")).toEqual({ view: "screen", n: 7 });
    expect(isDisplay(parseRoute("#screen-2"))).toBe(true);
  });
  it("falls back to the overview for anything else", () => {
    for (const bad of ["#screen-0", "#screen-", "#screen-x", "#screen--1", "#screen-1.5", "#screen-2/extra", "#screen-99999", "#tv-", "#wall-", "#nonsense", "#screens-2"]) {
      expect(parseRoute(bad)).toEqual({ view: "overview" });
    }
    expect(isDisplay(parseRoute("#overview"))).toBe(false);
    expect(isDisplay(parseRoute("#wall-x"))).toBe(false);
  });
  it("does not mistake a wall whose id starts with 'screen' for a screen", () => {
    expect(parseRoute("#wall-screen-2")).toEqual({ view: "wall", id: "screen-2" });
    expect(parseRoute("#tv-screen-2")).toEqual({ view: "tv", id: "screen-2" });
  });
});

describe("which wall a screen shows", () => {
  const walls = ["a", "b", "c", "d"];
  it("shows the wall at that position", () => {
    expect(screenWall(walls, 1)).toBe("a");
    expect(screenWall(walls, 4)).toBe("d");
    expect(screenWallIndex(2, 0, 4)).toBe(1);
  });
  it("has nothing for a screen beyond the walls, or before the first", () => {
    expect(screenWall(walls, 5)).toBeNull();
    expect(screenWall(walls, 0)).toBeNull();
    expect(screenWall(walls, -1)).toBeNull();
    expect(screenWall(walls, 1.5)).toBeNull();
    expect(screenWall(walls, NaN)).toBeNull();
    // Rotation does not conjure a wall for a screen that has none.
    expect(screenWall(walls, 5, 3)).toBeNull();
  });
  it("has nothing in an empty room", () => {
    expect(screenWall([], 1)).toBeNull();
    expect(screenWall([], 1, 2)).toBeNull();
    expect(screenWallIndex(1, 0, 0)).toBeNull();
  });
  it("rotates through every wall starting from its own, and comes back", () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => screenWall(walls, 3, k))).toEqual(["c", "d", "a", "b", "c", "d"]);
    expect([0, 1, 2].map((k) => screenWall(walls, 1, k))).toEqual(["a", "b", "c"]);
    expect(screenWall(walls, 2, 4000001)).toBe("c");
  });
  it("ignores a rotation step that makes no sense", () => {
    expect(screenWall(walls, 2, -1)).toBe("b");
    expect(screenWall(walls, 2, 0.5)).toBe("b");
    expect(screenWall(walls, 2, NaN)).toBe("b");
  });
  it("follows the room as walls are reordered, removed or replaced", () => {
    expect(screenWall(["b", "a", "c"], 1)).toBe("b");
    expect(screenWall(["a"], 2)).toBeNull();
    const room = seed("program");
    const team = seed("team");
    expect(screenWall(room.walls, 3)?.name).toBe("Delivery");
    expect(screenWall(team.walls, 3)?.name).toBe("Problems & actions");
    expect(screenWall(team.walls, 4)).toBeNull();
  });
});

describe("moving between screens", () => {
  it("steps one along and wraps around", () => {
    expect(neighbourScreen(1, 1, 4)).toBe(2);
    expect(neighbourScreen(4, 1, 4)).toBe(1);
    expect(neighbourScreen(1, -1, 4)).toBe(4);
    expect(neighbourScreen(3, -1, 4)).toBe(2);
    expect(neighbourScreen(1, 1, 1)).toBe(1);
  });
  it("comes back into range from a screen that has no wall", () => {
    expect(neighbourScreen(9, 1, 4)).toBe(1);
    expect(neighbourScreen(9, -1, 4)).toBe(4);
  });
  it("stays put in an empty room", () => {
    expect(neighbourScreen(2, 1, 0)).toBe(2);
    expect(neighbourScreen(2, -1, 0)).toBe(2);
  });
  it("numbers a wall by its position", () => {
    const walls = [{ id: "x" }, { id: "y" }];
    expect(screenOf(walls, "x")).toBe(1);
    expect(screenOf(walls, "y")).toBe(2);
    expect(screenOf(walls, "gone")).toBe(0);
    expect(screenOf([], "x")).toBe(0);
  });
  it("builds the address to open on a TV", () => {
    expect(screenHash(2)).toBe("#screen-2");
    expect(screenAddress("http://obeya.example", "/", 2)).toBe("http://obeya.example/#screen-2");
    expect(screenAddress("https://tools.example", "/obeya/", 11)).toBe("https://tools.example/obeya/#screen-11");
    expect(screenAddress("http://localhost:8787", "", 1)).toBe("http://localhost:8787/#screen-1");
    expect(parseRoute(new URL(screenAddress("http://obeya.example", "/", 3)).hash)).toEqual({ view: "screen", n: 3 });
  });
});

describe("access", () => {
  it("treats a server that sends no access as open", () => {
    expect(accessOf(undefined)).toEqual(OPEN_ACCESS);
    expect(accessOf(null)).toEqual(OPEN_ACCESS);
    expect(accessOf("locked")).toEqual(OPEN_ACCESS);
    expect(OPEN_ACCESS).toEqual({ locked: false, canEdit: true, passcodeSet: false, user: null });
  });
  it("reads a locked, view-only browser", () => {
    expect(accessOf({ locked: true, canEdit: false, passcodeSet: true, user: null })).toEqual({ locked: true, canEdit: false, passcodeSet: true, user: null });
  });
  it("reads a locked room this browser has unlocked, and the signed-in name", () => {
    expect(accessOf({ locked: true, canEdit: true, passcodeSet: true, user: " Dana Lee " })).toEqual({ locked: true, canEdit: true, passcodeSet: true, user: "Dana Lee" });
  });
  it("fails closed when a locked answer is incomplete, and open rooms can always be edited", () => {
    expect(accessOf({ locked: true }).canEdit).toBe(false);
    expect(accessOf({ locked: true, canEdit: "yes" }).canEdit).toBe(false);
    expect(accessOf({ locked: false, canEdit: false }).canEdit).toBe(true);
    expect(accessOf({}).canEdit).toBe(true);
    expect(accessOf({ user: "" }).user).toBeNull();
    expect(accessOf({ user: 5 }).user).toBeNull();
  });
  it("offers unlock, lock or nothing", () => {
    expect(lockControl(OPEN_ACCESS)).toBe("none");
    expect(lockControl({ locked: true, canEdit: false, passcodeSet: true, user: null })).toBe("unlock");
    expect(lockControl({ locked: true, canEdit: true, passcodeSet: true, user: null })).toBe("lock");
  });
  it("wants six characters in a passcode", () => {
    expect(passcodeError("12345")).toContain("at least 6");
    expect(passcodeError("")).toContain("at least 6");
    expect(passcodeError("123456")).toBe("");
    expect(passcodeError("obeya-test")).toBe("");
  });
});

describe("Jira connection check", () => {
  const check = (status: DiagnosticCheck["status"], id: string = status): DiagnosticCheck => ({ id, label: id, status, detail: "", fix: "" });
  it("puts failures first, then warnings", () => {
    expect(diagnosticsSummary({ checks: [check("pass"), check("pass", "p2")] })).toEqual({ text: "Everything passed", status: "good" });
    expect(diagnosticsSummary({ checks: [check("pass"), check("warn")] })).toEqual({ text: "1 warning", status: "warn" });
    expect(diagnosticsSummary({ checks: [check("warn"), check("warn", "w2"), check("pass")] })).toEqual({ text: "2 warnings", status: "warn" });
    expect(diagnosticsSummary({ checks: [check("warn"), check("fail"), check("skip")] })).toEqual({ text: "1 check failed", status: "bad" });
    expect(diagnosticsSummary({ checks: [check("fail"), check("fail", "f2"), check("fail", "f3")] })).toEqual({ text: "3 checks failed", status: "bad" });
  });
  it("does not call skipped checks a pass on their own, and copes with no checks", () => {
    expect(diagnosticsSummary({ checks: [check("pass"), check("skip")] })).toEqual({ text: "Everything passed", status: "good" });
    expect(diagnosticsSummary({ checks: [check("skip"), check("skip", "s2")] })).toEqual({ text: "Nothing was checked", status: "none" });
    expect(diagnosticsSummary({ checks: [] })).toEqual({ text: "Nothing was checked", status: "none" });
  });
  it("names each status with a word and a colour", () => {
    expect(checkWord("pass")).toEqual({ word: "Pass", status: "good" });
    expect(checkWord("warn")).toEqual({ word: "Warning", status: "warn" });
    expect(checkWord("fail")).toEqual({ word: "Failed", status: "bad" });
    expect(checkWord("skip")).toEqual({ word: "Skipped", status: "none" });
    expect(checkWord("something new")).toEqual({ word: "Skipped", status: "none" });
  });
});
