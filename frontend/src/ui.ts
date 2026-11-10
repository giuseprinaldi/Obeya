/* Which dialog is open, and small helpers for finding things in a room. */
import { createContext, useContext } from "react";
import type { Panel, Room, Wall } from "./types";

export type DialogSpec =
  | { kind: "item"; panelId: string; itemId?: string; col?: string }
  | { kind: "bar"; panelId: string; itemId?: string }
  | { kind: "panel"; panelId: string }
  | { kind: "addPanel"; wallId: string }
  | { kind: "wall"; wallId: string }
  | { kind: "addWall" }
  | { kind: "customize" }
  | { kind: "jira" }
  | { kind: "unlock" };

export interface Ui {
  /** Opens a dialog. While the browser is view-only only the unlock dialog opens. */
  open(d: DialogSpec): void;
  close(): void;
  /** False when the room is locked and this browser has not unlocked it: everything is read-only. */
  canEdit: boolean;
}

export const UiContext = createContext<Ui>({ open: () => undefined, close: () => undefined, canEdit: true });
export const useUi = (): Ui => useContext(UiContext);

export const wallById = (room: Room, id: string): Wall | undefined => room.walls.find((w) => w.id === id);

export function findPanel(room: Room, panelId: string): { wall: Wall; panel: Panel } | null {
  for (const wall of room.walls) {
    const panel = wall.panels.find((p) => p.id === panelId);
    if (panel) return { wall, panel };
  }
  return null;
}

export { parseRoute, type Route } from "./logic/route";

export function go(hash: string): void {
  window.location.hash = hash;
}
