/* Who may edit, and the Jira connection check: small pure rules behind the lock and the check screen. */
import type { Access, DiagnosticCheck, Diagnostics, Status } from "../types";

export const PASSCODE_MIN = 6;

/** Open access: what a server without the lock feature means. */
export const OPEN_ACCESS: Access = { locked: false, canEdit: true, passcodeSet: false, user: null };

/** The access a state reports. Missing (an older server) means unlocked; an unlocked room can always be edited. */
export function accessOf(raw: unknown): Access {
  if (typeof raw !== "object" || raw === null) return OPEN_ACCESS;
  const a = raw as Partial<Record<keyof Access, unknown>>;
  const locked = a.locked === true;
  return {
    locked,
    canEdit: locked ? a.canEdit === true : true,
    passcodeSet: a.passcodeSet === true,
    user: typeof a.user === "string" && a.user.trim() ? a.user.trim() : null,
  };
}

/** What the control bar offers: nothing when the room is open, otherwise unlock or lock. */
export function lockControl(a: Access): "none" | "unlock" | "lock" {
  if (!a.locked) return "none";
  return a.canEdit ? "lock" : "unlock";
}

/** Why a new passcode cannot be used, or "". */
export function passcodeError(next: string): string {
  if (next.length < PASSCODE_MIN) return `A passcode needs at least ${PASSCODE_MIN} characters.`;
  return "";
}

/* ---------- Jira connection check ---------- */

export const CHECK_WORD: Record<DiagnosticCheck["status"], { word: string; status: Status }> = {
  pass: { word: "Pass", status: "good" },
  warn: { word: "Warning", status: "warn" },
  fail: { word: "Failed", status: "bad" },
  skip: { word: "Skipped", status: "none" },
};

/** The word and colour for one check. An unknown status reads as skipped. */
export function checkWord(status: string): { word: string; status: Status } {
  return (CHECK_WORD as Record<string, { word: string; status: Status }>)[status] ?? CHECK_WORD.skip;
}

/** The line on top of the check: failures first, then warnings, else all clear. */
export function diagnosticsSummary(d: Pick<Diagnostics, "checks">): { text: string; status: Status } {
  const checks = d.checks ?? [];
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  if (failed) return { text: failed === 1 ? "1 check failed" : `${failed} checks failed`, status: "bad" };
  if (warned) return { text: warned === 1 ? "1 warning" : `${warned} warnings`, status: "warn" };
  // Skipped checks did not run, so a list with no pass in it has not shown that anything works.
  if (!checks.some((c) => c.status === "pass")) return { text: "Nothing was checked", status: "none" };
  return { text: "Everything passed", status: "good" };
}
