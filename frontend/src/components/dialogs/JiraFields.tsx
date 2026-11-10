/* Form parts shared by every editor that links something to Jira. */
import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { JQL_HINT, JQL_PRESETS, parseIssueKey, parseStatusList } from "../../logic/jira";
import { defaultJiraOptions } from "../../logic/progress";
import { dayNumber, fmtNum } from "../../logic/util";
import type { AutoResult, BarColor, BarDisplay, JiraSource, JiraSourceOptions, Measure, PreviewRequest, ProgressResult, ValueFormat } from "../../types";
import { CheckField, SelectField, TextArea, TextField } from "../Dialog";

/* ---------- Draft of a Jira link, as typed into the form ---------- */

export interface OptionsDraft {
  measure: Measure;
  includeSubtasks: boolean;
  /** Comma separated, as typed. */
  doneStatuses: string;
}

export interface LinkDraft extends OptionsDraft {
  kind: "issue" | "jql";
  /** A key or a pasted Jira URL. */
  keyInput: string;
  jql: string;
}

export function optionsDraft(o?: JiraSourceOptions | null): OptionsDraft {
  const v = o ?? defaultJiraOptions();
  return { measure: v.measure, includeSubtasks: v.includeSubtasks, doneStatuses: v.doneStatuses.join(", ") };
}

export function optionsOf(d: OptionsDraft): JiraSourceOptions {
  return { measure: d.measure, includeSubtasks: d.includeSubtasks, doneStatuses: parseStatusList(d.doneStatuses) };
}

export function linkDraft(src?: JiraSource | null): LinkDraft {
  return {
    kind: src?.kind ?? "issue",
    keyInput: src?.kind === "issue" ? src.key : "",
    jql: src?.kind === "jql" ? src.jql : "",
    ...optionsDraft(src),
  };
}

/** The source a draft describes, or a message saying what is missing. */
export function linkSource(d: LinkDraft): JiraSource | string {
  if (d.kind === "issue") {
    const key = parseIssueKey(d.keyInput);
    if (!key) return d.keyInput.trim() ? "That does not look like a Jira key or link. A key looks like PLAT-123." : "Enter a Jira key or paste a link to the issue.";
    return { kind: "issue", key, ...optionsOf(d) };
  }
  const jql = d.jql.trim();
  if (!jql) return "Enter a Jira query.";
  return { kind: "jql", jql, ...optionsOf(d) };
}

/* ---------- Fields ---------- */

export function JqlInput({ value, onChange, label = "Jira query (JQL)" }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <>
      <TextArea label={label} value={value} onChange={onChange} rows={2} code hint={JQL_HINT} placeholder='project = PLAT AND issuetype = Epic AND {PI_FIELD} = "{PI}"' />
      <div className="btn-row">
        <span className="hint">Start from:</span>
        {JQL_PRESETS.map((p) => (
          <button key={p.label} type="button" className="btn small" onClick={() => onChange(p.jql)}>
            {p.label}
          </button>
        ))}
      </div>
    </>
  );
}

const MEASURES: readonly (readonly [Measure, string])[] = [
  ["count", "Issues"],
  ["points", "Story points"],
];

export function OptionsFields<T extends OptionsDraft>({ value, onChange }: { value: T; onChange: (v: T) => void }) {
  return (
    <>
      <div className="two">
        <SelectField label="Measure by" value={value.measure} onChange={(measure) => onChange({ ...value, measure })} options={MEASURES} />
        <TextField
          label="Statuses that count as done"
          value={value.doneStatuses}
          onChange={(doneStatuses) => onChange({ ...value, doneStatuses })}
          placeholder="Leave empty to use Jira's done category"
          hint="Comma separated, for example: Done, Released"
        />
      </div>
      <CheckField label="Count sub-tasks instead of their parent stories" checked={value.includeSubtasks} onChange={(includeSubtasks) => onChange({ ...value, includeSubtasks })} />
    </>
  );
}

/** The key or query input for a link, plus its options. The kind is chosen by the caller. */
export function LinkFields({ value, onChange }: { value: LinkDraft; onChange: (v: LinkDraft) => void }) {
  const parsed = value.kind === "issue" ? parseIssueKey(value.keyInput) : null;
  return (
    <>
      {value.kind === "issue" ? (
        <TextField
          label="Jira key or link"
          value={value.keyInput}
          onChange={(keyInput) => onChange({ ...value, keyInput })}
          placeholder="PLAT-123 or a pasted Jira link"
          hint={
            parsed && parsed !== value.keyInput.trim()
              ? `Will link to ${parsed}. Progress is worked out from everything under it.`
              : "An epic, initiative or any issue with children. Progress is worked out from everything under it."
          }
        />
      ) : (
        <JqlInput value={value.jql} onChange={(jql) => onChange({ ...value, jql })} />
      )}
      <OptionsFields value={value} onChange={onChange} />
    </>
  );
}

/* ---------- Check link ---------- */

const UNITS: Record<ProgressResult["unit"], string> = { issues: "issues", points: "points" };

function describe(r: ProgressResult): string {
  const head = [r.title || r.key || "Query", r.issueType, r.status].filter(Boolean).join(" · ");
  if (r.total <= 0) return `${head}: ${r.unit === "points" ? `no estimates yet (${r.issues} ${r.issues === 1 ? "issue" : "issues"})` : "no issues yet"}.`;
  const extra = r.unit === "points" && r.unestimated > 0 ? `, ${r.unestimated} unestimated` : "";
  return `${head}: ${fmtNum(r.done)} of ${fmtNum(r.total)} ${UNITS[r.unit] ?? "issues"} done${extra}.`;
}

function describeAuto(r: AutoResult): string {
  const n = r.bars.length;
  if (!n) return "The query matches nothing right now, so it would add no bars.";
  const names = r.bars.slice(0, 4).map((b) => b.key || b.title || "").filter(Boolean).join(", ");
  return `It would add ${n} ${n === 1 ? "bar" : "bars"}${r.truncated ? " (more issues match than the limit allows)" : ""}${names ? `: ${names}${n > 4 ? "…" : ""}` : "."}`;
}

/** "Check link": asks the server what the link resolves to right now and shows the answer inline. */
export function CheckLink({ build, label = "Check link" }: { build: () => PreviewRequest | string; label?: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const built = build();
  const signature = typeof built === "string" ? built : JSON.stringify(built);
  useEffect(() => setResult(null), [signature]);

  const check = async (): Promise<void> => {
    if (typeof built === "string") return setResult({ ok: false, text: built });
    setBusy(true);
    try {
      const r = await api.preview(built);
      if (!r.ok) setResult({ ok: false, text: r.error || "Jira could not read this link." });
      else setResult({ ok: true, text: "bars" in r ? describeAuto(r) : describe(r) });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="btn-row">
        <button type="button" className="btn small" onClick={() => void check()} disabled={busy}>
          {busy ? "Checking…" : label}
        </button>
        <span className="hint">Asks Jira now, without saving anything.</span>
      </div>
      {result ? (
        <p className={`check-result st-${result.ok ? "good" : "warn"}`} role="status">
          {result.text}
        </p>
      ) : null}
    </>
  );
}

/* ---------- How a bar is drawn ---------- */

const COLORS: readonly (readonly [BarColor, string])[] = [
  ["status", "By status (green, amber, red)"],
  ["accent", "Room accent"],
  ["good", "Green"],
  ["warn", "Amber"],
  ["bad", "Red"],
  ["neutral", "Grey"],
];
const FORMATS: readonly (readonly [ValueFormat, string])[] = [
  ["both", "Percent and count"],
  ["percent", "Percent only"],
  ["fraction", "Count only"],
];
type PaceKind = BarDisplay["pace"]["kind"];
const PACES: readonly (readonly [PaceKind, string])[] = [
  ["none", "No pace check"],
  ["sprint", "Current sprint"],
  ["pi", "Current PI"],
  ["dates", "Custom dates"],
];

export function DisplayFields({ value, onChange }: { value: BarDisplay; onChange: (v: BarDisplay) => void }) {
  const pace = value.pace;
  const setPace = (kind: PaceKind): void => {
    if (kind === "dates") onChange({ ...value, pace: { kind, start: pace.kind === "dates" ? pace.start : "", end: pace.kind === "dates" ? pace.end : "" } });
    else onChange({ ...value, pace: { kind } });
  };
  return (
    <>
      <div className="two">
        <SelectField label="Colour" value={value.color} onChange={(color) => onChange({ ...value, color })} options={COLORS} />
        <SelectField label="Value shown" value={value.valueFormat} onChange={(valueFormat) => onChange({ ...value, valueFormat })} options={FORMATS} />
      </div>
      <SelectField
        label="Pace against"
        value={pace.kind}
        onChange={setPace}
        options={PACES}
        hint="Draws a marker where the bar should be today and flags the bar when it falls behind. Sprint and PI dates follow Jira and the PI calendar, so nothing needs changing when they roll over."
      />
      {pace.kind === "dates" ? (
        <div className="two">
          <TextField label="Start" type="date" value={pace.start} onChange={(start) => onChange({ ...value, pace: { ...pace, start } })} />
          <TextField label="End" type="date" value={pace.end} onChange={(end) => onChange({ ...value, pace: { ...pace, end } })} />
        </div>
      ) : null}
      <CheckField label="Show work in progress as a lighter segment" checked={value.showInProgress} onChange={(showInProgress) => onChange({ ...value, showInProgress })} />
    </>
  );
}

/** What is wrong with a bar's display settings, or "". */
export function displayError(d: BarDisplay): string {
  if (d.pace.kind !== "dates") return "";
  if (dayNumber(d.pace.start) === null || dayNumber(d.pace.end) === null) return "Give the custom pace a start and an end date.";
  if (d.pace.end < d.pace.start) return "The custom pace ends before it starts.";
  return "";
}
