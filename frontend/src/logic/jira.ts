/* Jira keys and the JQL presets offered in the editor. */

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
