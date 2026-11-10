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
  | { kind: "jira" };

export interface Ui {
  open(d: DialogSpec): void;
  close(): void;
}

export const UiContext = createContext<Ui>({ open: () => undefined, close: () => undefined });
export const useUi = (): Ui => useContext(UiContext);

export const wallById = (room: Room, id: string): Wall | undefined => room.walls.find((w) => w.id === id);

export function findPanel(room: Room, panelId: string): { wall: Wall; panel: Panel } | null {
  for (const wall of room.walls) {
    const panel = wall.panels.find((p) => p.id === panelId);
    if (panel) return { wall, panel };
  }
  return null;
}

export type Route = { view: "overview" } | { view: "wall"; id: string } | { view: "tv"; id: string };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  if (h.startsWith("tv-")) return { view: "tv", id: h.slice(3) };
  if (h.startsWith("wall-")) return { view: "wall", id: h.slice(5) };
  return { view: "overview" };
}

export function go(hash: string): void {
  window.location.hash = hash;
}
