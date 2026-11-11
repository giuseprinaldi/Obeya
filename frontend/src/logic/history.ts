/* Earlier versions of the room: turning the server's list into the rows the dialog shows. */
import type { RoomHistory, RoomVersionInfo } from "../types";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "4 walls · 12 panels" */
export function countsText(v: Pick<RoomVersionInfo, "walls" | "panels">): string {
  return `${plural(v.walls, "wall", "walls")} · ${plural(v.panels, "panel", "panels")}`;
}

/** What a save changed, one line each, ending with "and 3 more changes" when the server cut the list short.
    A save that changed nothing says so, so no row is left without an explanation. */
export function changeLines(v: Pick<RoomVersionInfo, "changes" | "more">): string[] {
  const lines = (Array.isArray(v.changes) ? v.changes : []).filter((l) => typeof l === "string" && l.trim() !== "");
  const more = Number(v.more) > 0 ? Math.round(Number(v.more)) : 0;
  if (!lines.length && !more) return ["Saved with no changes to the room"];
  return more ? [...lines, `and ${plural(more, "more change", "more changes")}`] : lines;
}

export interface VersionRow {
  version: number;
  savedAt: string;
  /** The version that is live now: it is marked, and has no Restore button. */
  current: boolean;
  /** "Version 12 · 4 walls · 12 panels" */
  label: string;
  lines: string[];
}

/** The rows to show, newest first, whatever order the server sent them in. Rows without a usable
    version number are dropped. */
export function versionRows(history: RoomHistory | null | undefined): VersionRow[] {
  const versions = Array.isArray(history?.versions) ? history.versions : [];
  return versions
    .filter((v) => v && Number.isInteger(v.version) && v.version > 0)
    .slice()
    .sort((a, b) => b.version - a.version)
    .map((v) => ({
      version: v.version,
      savedAt: v.savedAt,
      current: v.version === history?.current,
      label: `Version ${v.version} · ${countsText(v)}`,
      lines: changeLines(v),
    }));
}

/** The toast after a restore. `when` is the saved time as shown in the list. */
export function restoredText(when: string): string {
  return `Restored the room as it was${when ? ` on ${when}` : ""}. The version you replaced is still in the list.`;
}
