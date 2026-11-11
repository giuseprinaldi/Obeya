/* Stale items: work that is under way but has gone quiet. A Jira card is stale when it is in progress
   and nobody has updated the issue for a while; a bar when it has started, is not finished, and its
   done amount has not gone up for a while. Both thresholds are set in the panel settings; 0 is off. */
import type { BoardCard, HistoryPoint } from "../types";
import { clamp, dayNumber } from "./util";

/** Days without an update before an in-progress card is flagged. */
export const CARD_STALE_DEFAULT = 7;
export const CARD_STALE_MAX = 90;
/** Days without progress before a started bar is flagged. Bars carry 60 days of history. */
export const BAR_STALE_DEFAULT = 14;
export const BAR_STALE_MAX = 60;

/** A threshold as stored: a whole number of days from 0 (off) to `max`; `fallback` when it is missing or not a number. */
export function staleThreshold(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return isFinite(n) ? clamp(Math.round(n), 0, max) : fallback;
}

/** How many days a card has gone untouched, when that makes it stale; null when it is not stale.
    Only work in progress counts: a card waiting in the backlog or already done is never stale. An older
    server sends neither the category nor the idle days, and then nothing is flagged. */
export function cardStaleDays(card: Pick<BoardCard, "category" | "idleDays">, threshold: number): number | null {
  if (!(threshold > 0) || card.category !== "indeterminate") return null;
  const idle = card.idleDays;
  if (idle === null || idle === undefined || !isFinite(Number(idle))) return null;
  const days = Math.max(0, Math.floor(Number(idle)));
  return days >= threshold ? days : null;
}

/** "Stale 9d", or "" for a card that is not stale. */
export const staleText = (days: number | null): string => (days === null ? "" : `Stale ${days}d`);

/** Whole days for which the done amount has not gone up, as far as the daily history can show.

    It walks back from today for as long as each earlier day already had at least today's amount, and
    stops at the first day that had less: progress was made after that day. When the history never shows
    less, the answer is how far back the history reaches, so it is a lower bound and a bar linked two
    days ago is never "stalled for 14 days". A day the server missed is not taken as progress. A done
    amount that went down counts as not having gone up. Null when there is no earlier day at all. */
export function stalledDays(history: HistoryPoint[] | undefined, done: number, today: string): number | null {
  const t = dayNumber(today);
  if (t === null || !isFinite(done)) return null;
  const past = (history ?? [])
    .map((h) => ({ day: dayNumber(h.d), done: Number(h.done) }))
    .filter((h): h is { day: number; done: number } => h.day !== null && h.day < t && isFinite(h.done))
    .sort((a, b) => b.day - a.day);
  if (!past.length) return null;
  let since = t;
  for (const p of past) {
    if (p.done < done) break;
    since = p.day;
  }
  return t - since;
}

/** True for a bar that has started, is not finished and has not moved for `threshold` days or more. */
export function isStalled(bar: { pct: number; done: number; wipPct: number; stalledDays: number | null }, threshold: number): boolean {
  if (!(threshold > 0) || bar.stalledDays === null) return false;
  const started = bar.done > 0 || bar.wipPct > 0;
  return started && bar.pct < 100 && bar.stalledDays >= threshold;
}
