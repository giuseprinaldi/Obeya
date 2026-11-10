/* Small shared helpers: ids, dates and number formatting. */

export const uid = (): string => Math.random().toString(36).slice(2, 9);

const pad2 = (n: number): string => String(n).padStart(2, "0");
export const iso = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const todayISO = (): string => iso(new Date());
export const dayOffset = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

/** Days since the epoch for an ISO date (YYYY-MM-DD...), or null when it is not a date. */
export function dayNumber(s: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / 86400000);
}

export function addDays(s: string, n: number): string {
  const d = dayNumber(s);
  if (d === null) return s;
  return new Date((d + n) * 86400000).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a), or null when either is not a date. */
export function daysBetween(a: string, b: string): number | null {
  const x = dayNumber(a), y = dayNumber(b);
  return x === null || y === null ? null : y - x;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s.slice(0, 10) + "T00:00:00");
  return isNaN(d.getTime()) ? s : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime())
    ? ""
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function fmtTime(s: string | Date | null | undefined): string {
  if (!s) return "";
  const d = typeof s === "string" ? new Date(s) : s;
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function fmtNum(v: number | string | null | undefined): string {
  if (v === "" || v === null || v === undefined) return "–";
  const n = Number(v);
  if (!isFinite(n)) return "–";
  return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
