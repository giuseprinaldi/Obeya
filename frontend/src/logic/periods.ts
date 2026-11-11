/* PI calendar helpers. The server decides which PI is current; these cover the editor and the labels. */
import type { Period, Periods, Room } from "../types";
import { addDays, dayNumber, daysBetween, fmtDate } from "./util";

const DEFAULT_PI_DAYS = 70;

/** Raises the last number in a name: "PI 26.4" -> "PI 26.5", "PI-09" -> "PI-10". */
export function bumpName(name: string): string {
  const m = /^(.*?)(\d+)(\D*)$/.exec(name);
  if (!m) return name ? `${name} 2` : "PI 1";
  const digits = m[2] ?? "";
  const next = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${m[1] ?? ""}${next}${m[3] ?? ""}`;
}

/** The PI that follows the latest one: starts the day after it ends, same length, bumped name. */
export function nextPi(pis: Period[], today: string): Period {
  const dated = pis.filter((p) => dayNumber(p.start) !== null && dayNumber(p.end) !== null);
  if (!dated.length) return { name: "PI 1", start: today, end: addDays(today, DEFAULT_PI_DAYS - 1) };
  const last = dated.reduce((a, b) => (b.end > a.end ? b : a));
  const length = Math.max(1, (daysBetween(last.start, last.end) ?? DEFAULT_PI_DAYS - 1) + 1);
  const start = addDays(last.end, 1);
  return { name: bumpName(last.name), start, end: addDays(start, length - 1) };
}

/** The PI that contains today, if any. */
export function piContaining(pis: Period[], today: string): Period | null {
  return pis.find((p) => !!p.start && !!p.end && p.start <= today && today <= p.end) ?? null;
}

/** The problem that stops a calendar from being saved, or null. */
export function calendarError(pis: Period[]): string | null {
  for (const p of pis) {
    if (!p.name.trim()) return "Give every PI a name.";
    if (dayNumber(p.start) === null || dayNumber(p.end) === null) return `Give ${p.name} a start and an end date.`;
    if (p.end < p.start) return `${p.name} ends before it starts.`;
  }
  const names = pis.map((p) => p.name.trim().toLowerCase());
  if (new Set(names).size !== names.length) return "Two PIs have the same name.";
  return null;
}

const usesPiVar = (jql: string | undefined): boolean => !!jql && /\{(PI|NEXT_PI|PREV_PI)\}/.test(jql);

/** True when any bar or burn-up chart in the room depends on the PI calendar. */
export function roomUsesPi(room: Room): boolean {
  for (const w of room.walls) {
    for (const p of w.panels) {
      if (p.type === "portfolio") {
        if (p.data.items.some((x) => x.source?.kind === "jql" && usesPiVar(x.source.jql))) return true;
      }
      if (p.type === "dependencies" && usesPiVar(p.data.source?.jql)) return true;
      if (p.type === "burnup" && p.data.source) {
        if (p.data.period.kind === "pi" || (p.data.source.kind === "jql" && usesPiVar(p.data.source.jql))) return true;
      }
      if (p.type === "progress") {
        if (p.data.auto && (usesPiVar(p.data.auto.jql) || p.data.autoDisplay.pace.kind === "pi")) return true;
        for (const b of p.data.items) {
          if (b.pace.kind === "pi") return true;
          if (b.source.kind === "jql" && usesPiVar(b.source.jql)) return true;
        }
      }
    }
  }
  return false;
}

/** A line for the overview when the PI calendar needs attention, or null. */
export function calendarNotice(periods: Periods, usesPi: boolean): string | null {
  if (!periods.pi) {
    return usesPi
      ? "There is no PI calendar yet, so bars that follow the current PI have nothing to follow. Add one in Jira settings."
      : null;
  }
  if (periods.pi.end < periods.today && !periods.nextPi) {
    return `The PI calendar ended on ${fmtDate(periods.pi.end)}. Add the next PI in Jira settings.`;
  }
  return null;
}

function piText(p: Period, today: string): string {
  const total = (daysBetween(p.start, p.end) ?? 0) + 1;
  const day = (daysBetween(p.start, today) ?? 0) + 1;
  if (day < 1) return `${p.name} · starts ${fmtDate(p.start)}`;
  if (day > total) return `${p.name} · ended ${fmtDate(p.end)}`;
  return `${p.name} · day ${day} of ${total}`;
}

function sprintText(p: Period, today: string): string {
  const left = daysBetween(today, p.end);
  if (left === null) return p.name;
  if (left < 0) return `${p.name} · ended ${fmtDate(p.end)}`;
  if (left === 0) return `${p.name} · ends today`;
  return `${p.name} · ${left} ${left === 1 ? "day" : "days"} left`;
}

/** "PI 26.4 · day 37 of 70 · Sprint 14 · 4 days left", or "" when neither is known. */
export function periodLine(periods: Periods): string {
  const parts: string[] = [];
  if (periods.pi) parts.push(piText(periods.pi, periods.today));
  if (periods.sprint) parts.push(sprintText(periods.sprint, periods.today));
  return parts.join(" · ");
}
