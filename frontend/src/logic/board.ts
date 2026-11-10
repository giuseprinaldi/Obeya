/* Jira-fed flow boards: turning the server's board result into the columns and cards that get drawn. */
import type { BoardCard, BoardResult, BoardSource, KanbanPanel } from "../types";
import { missingReason, type LiveData } from "./progress";
import { clamp, fmtTime } from "./util";

export const MAX_CARDS_MIN = 1;
export const MAX_CARDS_MAX = 30;

export const defaultBoardSource = (boardId: number): BoardSource => ({
  boardId,
  jql: "",
  sprint: "active",
  hiddenColumns: [],
  maxCards: 6,
  doneDays: 14,
});

export interface BoardCardView extends BoardCard {
  /** "5d" for cards in the middle columns whose age is known, else "". */
  age: string;
  /** "3 pts" or "1 pt", or "" without an estimate. */
  pointsText: string;
}

export interface BoardColumnView {
  name: string;
  wip: number;
  total: number;
  over: boolean;
  /** "7", "7 / 5" or "7 / 5 over". */
  countText: string;
  cards: BoardCardView[];
  /** Issues in the column that are not shown. */
  more: number;
}

export interface BoardView {
  state: "ok" | "error" | "loading" | "disconnected";
  /** Shown instead of the board when state is not "ok". */
  message: string;
  columns: BoardColumnView[];
  /** "Platform board · Sprint 23 · read 11:34 AM" */
  footer: string;
  blocked: number;
  /** Columns over their WIP limit. */
  overWip: number;
  total: number;
}

const isOver = (c: { wip: number; total: number }): boolean => Number(c.wip) > 0 && Number(c.total) > Number(c.wip);

const lower = (names: string[]): Set<string> => new Set(names.map((n) => n.trim().toLowerCase()));

/** The visible columns of a result: the ones the source hides are left out, whether or not the server already did. */
function visibleColumns(source: BoardSource, r: BoardResult): BoardResult["columns"] {
  const hidden = lower(source.hiddenColumns);
  return (r.columns ?? []).filter((c) => !hidden.has(c.name.trim().toLowerCase()));
}

/** What to draw for a flow board with a Jira source. Null for a manual board. */
export function boardView(panel: KanbanPanel, live: LiveData): BoardView | null {
  const source = panel.data.jira;
  if (!source) return null;
  const empty = { columns: [], footer: "", blocked: 0, overWip: 0, total: 0 };
  const r = live.boards[panel.id];
  if (!r) {
    const m = missingReason(live);
    return { ...empty, state: m.state, message: m.message };
  }
  if (!r.ok) return { ...empty, state: "error", message: r.error || "Jira could not read this board." };

  const cols = visibleColumns(source, r);
  const maxCards = clamp(Math.round(Number(source.maxCards) || 6), MAX_CARDS_MIN, MAX_CARDS_MAX);
  const last = cols.length - 1;
  const columns = cols.map((c, i): BoardColumnView => {
    const shown = (c.cards ?? []).slice(0, maxCards);
    const total = Math.max(Number(c.total) || 0, (c.cards ?? []).length);
    const over = isOver({ wip: c.wip, total });
    const middle = i > 0 && i < last;
    return {
      name: c.name,
      wip: Number(c.wip) || 0,
      total,
      over,
      countText: `${total}${Number(c.wip) > 0 ? ` / ${c.wip}` : ""}${over ? " over" : ""}`,
      cards: shown.map((card) => ({
        ...card,
        age: middle && card.ageDays !== null && card.ageDays !== undefined && isFinite(Number(card.ageDays)) ? `${Math.max(0, Math.round(Number(card.ageDays)))}d` : "",
        pointsText: card.points !== null && card.points !== undefined && isFinite(Number(card.points)) ? `${Number(card.points)} ${Number(card.points) === 1 ? "pt" : "pts"}` : "",
      })),
      more: Math.max(0, total - shown.length),
    };
  });
  return {
    state: "ok",
    message: "",
    columns,
    footer: [r.boardName, r.sprint?.name, r.fetchedAt ? `read ${fmtTime(r.fetchedAt)}` : ""].filter(Boolean).join(" · "),
    blocked: Number(r.blocked) || 0,
    overWip: columns.filter((c) => c.over).length,
    total: Number(r.total) || 0,
  };
}

/** The tallest visible column, in cards, with a "+N more" line counted as part of a card. */
export function boardHeight(view: BoardView): number {
  return Math.max(0, ...view.columns.map((c) => c.cards.length + (c.more > 0 ? 0.4 : 0)));
}

/** "Platform board (scrum), Sprint 23: 4 columns, 37 cards, 2 blocked." for the Check button. */
export function describeBoard(source: BoardSource, r: BoardResult): string {
  const cols = visibleColumns(source, r);
  const cards = cols.reduce((n, c) => n + Math.max(Number(c.total) || 0, (c.cards ?? []).length), 0);
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const head = `${r.boardName || `Board ${source.boardId}`}${r.boardType ? ` (${r.boardType})` : ""}${r.sprint?.name ? `, ${r.sprint.name}` : ""}`;
  return `${head}: ${plural(cols.length, "column", "columns")}, ${plural(cards, "card", "cards")}, ${r.blocked || 0} blocked.`;
}

/** Column names to offer in "columns to hide": what Jira last returned, plus the ones already hidden
    (the server leaves those out of its results). */
export function hideableColumns(hidden: string[], ...results: (BoardResult | null | undefined)[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (n: string): void => {
    const k = n.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      names.push(n.trim());
    }
  };
  // The fullest result goes first, so the list keeps the board's own order as columns get hidden.
  const usable = results.filter((r): r is BoardResult => !!r?.ok).sort((a, b) => (b.columns ?? []).length - (a.columns ?? []).length);
  for (const r of usable) (r.columns ?? []).forEach((c) => add(c.name));
  hidden.forEach(add);
  return names;
}
