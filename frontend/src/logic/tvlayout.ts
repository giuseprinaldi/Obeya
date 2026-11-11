/* Display mode: how much height each row of panels needs, so a TV shares its height by content
   instead of giving every row the same amount. Estimates are in stage pixels and only need to be roughly right. */
import type { Panel } from "../types";
import { boardHeight, boardView } from "./board";
import { depsView } from "./deps";
import { resolveBars, type LiveData } from "./progress";

const FRAME = 80; // panel title bar plus body padding
/** Wide progress panels switch to two columns of bars on a TV above this many bars (see styles.css). */
export const TV_TWO_COLUMN_BARS = 4;

/** Splits panels into grid rows the way the 3-column wall grid places them. */
export function gridRows(panels: Panel[]): Panel[][] {
  const rows: Panel[][] = [];
  let col = 0;
  for (const p of panels) {
    const span = p.span === 2 || p.span === 3 ? p.span : 1;
    if (!rows.length || col + span > 3) {
      rows.push([]);
      col = 0;
    }
    rows[rows.length - 1]!.push(p);
    col += span;
  }
  return rows;
}

function need(p: Panel, live: LiveData): number {
  switch (p.type) {
    case "statement":
      return FRAME + 130;
    case "kpi": {
      const perRow = p.span === 3 ? 6 : p.span === 2 ? 4 : 2;
      return FRAME + Math.max(1, Math.ceil(p.data.items.length / perRow)) * 150;
    }
    case "portfolio":
    case "actions":
      return FRAME + Math.max(1, p.data.items.length) * 50;
    case "problems":
      return FRAME + Math.max(1, p.data.items.length) * 68;
    case "progress": {
      const n = Math.max(1, resolveBars(p, live).bars.length);
      if (p.span === 3) return FRAME + (n > TV_TWO_COLUMN_BARS ? Math.ceil(n / 2) : n) * 56;
      return FRAME + n * (p.span === 2 ? 56 : 78);
    }
    case "risks":
      return FRAME + Math.max(1, p.data.items.length) * 58;
    case "dependencies":
      // One row per dependency shown, and a line of totals under them.
      return FRAME + 30 + Math.max(1, depsView(p, live).rows.length) * 54;
    case "burnup":
      // The numbers and legend above a plot that is worth at least a third of a screen's height.
      return FRAME + 300;
    case "kanban": {
      const board = boardView(p, live);
      // A Jira board has a line under it; its cards measure about 60px with their gap.
      if (board) return FRAME + 50 + 24 + Math.max(1, boardHeight(board)) * 60;
      const tallest = Math.max(0, ...p.data.columns.map((c) => p.data.cards.filter((x) => x.col === c.id).length));
      return FRAME + 50 + Math.max(1, tallest) * 64;
    }
  }
}

/** One weight per grid row: the height its tallest panel needs. */
export function tvRowWeights(panels: Panel[], live: LiveData): number[] {
  return gridRows(panels).map((row) => Math.max(...row.map((p) => need(p, live))));
}
