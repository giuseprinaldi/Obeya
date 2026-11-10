/* Jira keys, the JQL presets offered in the editor, and defaults for the Jira settings. */
import type { Settings } from "../types";

const KEY = "[A-Za-z][A-Za-z0-9_]*-\\d+";
const BARE = new RegExp(`^${KEY}$`);
const IN_URL = [
  new RegExp(`/browse/(${KEY})(?![A-Za-z0-9_-])`),
  new RegExp(`[?&]selectedIssue=(${KEY})(?![A-Za-z0-9_-])`),
  new RegExp(`/issues/(${KEY})(?![A-Za-z0-9_-])`),
];

/** Accepts a bare key ("plat-12") or a pasted Jira URL and returns the key in upper case, or null. */
export function parseIssueKey(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (BARE.test(s)) return s.toUpperCase();
  for (const re of IN_URL) {
    const m = re.exec(s);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return null;
}

export const JQL_PRESETS: { label: string; jql: string }[] = [
  { label: "Epics in the current PI", jql: 'issuetype = Epic AND {PI_FIELD} = "{PI}"' },
  { label: "Current sprint", jql: "sprint in openSprints()" },
  { label: "Everything in the current PI", jql: '{PI_FIELD} = "{PI}"' },
];

export const JQL_HINT =
  "{PI} is the current PI from the PI calendar, {NEXT_PI} and {PREV_PI} are the ones around it, and {PI_FIELD} is the PI field chosen in Jira settings. They update on their own when the PI changes.";

/** "Done, Closed , " -> ["Done", "Closed"] */
export function parseStatusList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type Loose<T> = { [K in keyof T]?: T[K] | null };

/** Settings as the page uses them. A server from before a setting existed leaves it out, so the
    defaults are filled in here: flagged issues count as blocked, and assignee names are shown. */
export function withSettingsDefaults(raw: { jira?: Loose<Settings["jira"]> | null; pis?: Settings["pis"] | null } | null | undefined): Settings {
  const j = raw?.jira ?? {};
  const b: Loose<Settings["jira"]["blocked"]> = j.blocked ?? {};
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.map((v) => String(v).trim()).filter(Boolean) : []);
  return {
    jira: {
      piField: j.piField ?? "",
      storyPointsField: j.storyPointsField ?? "",
      boardId: typeof j.boardId === "number" ? j.boardId : null,
      showSummaries: j.showSummaries ?? true,
      showAssignees: j.showAssignees ?? true,
      blocked: {
        flagged: b.flagged ?? true,
        statuses: list(b.statuses),
        labels: list(b.labels),
        links: b.links ?? false,
      },
    },
    pis: Array.isArray(raw?.pis) ? raw.pis : [],
  };
}
