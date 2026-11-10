/* Jira settings: connection status, which fields mean what, and the PI calendar. */
import { useEffect, useId, useMemo, useState } from "react";
import { api, errorText } from "../../api";
import { parseStatusList, withSettingsDefaults } from "../../logic/jira";
import { calendarError, nextPi, piContaining } from "../../logic/periods";
import { fmtDateTime } from "../../logic/util";
import { store, useStore } from "../../store";
import type { JiraBoard, JiraField, JiraStatus, Period, Settings } from "../../types";
import { CheckField, Dialog, SelectField, TextField } from "../Dialog";
import { ConnectionCheck } from "./ConnectionCheck";

interface PiRow extends Period {
  /** Stable key for the row while it is edited. */
  rid: number;
}

let nextRid = 1;
const row = (p: Period): PiRow => ({ rid: nextRid++, name: p.name, start: p.start, end: p.end });

/** A select with a filter box above it, for long lists such as Jira's custom fields. */
function FieldPicker({ label, value, onChange, fields, emptyLabel, hint }: { label: string; value: string; onChange: (v: string) => void; fields: JiraField[]; emptyLabel: string; hint?: string }) {
  const [filter, setFilter] = useState("");
  const id = useId();
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = fields.filter((f) => f.id === value || !q || f.name.toLowerCase().includes(q) || f.id.toLowerCase().includes(q));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [fields, filter, value]);
  const known = !value || fields.some((f) => f.id === value);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type to filter the list" aria-label={`Filter ${label}`} />
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {known ? null : <option value={value}>{value}</option>}
        {shown.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name} ({f.id})
          </option>
        ))}
      </select>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

function PiCalendar({ rows, onChange, today, suggestions }: { rows: PiRow[]; onChange: (r: PiRow[]) => void; today: string; suggestions: string[] }) {
  const listId = useId();
  const current = piContaining(rows, today);
  const set = (rid: number, patch: Partial<Period>): void => onChange(rows.map((r) => (r.rid === rid ? { ...r, ...patch } : r)));
  const sorted = rows.slice().sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999") || a.rid - b.rid);
  return (
    <>
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      {rows.length ? (
        <div className="edit-rows">
          <div className="edit-row pis head" aria-hidden="true">
            <span>Name, exactly as in Jira</span>
            <span>Start</span>
            <span>End</span>
          </div>
          {sorted.map((r, i) => (
            <div className="edit-row pis" key={r.rid}>
              <input type="text" list={listId} value={r.name} aria-label={`PI ${i + 1} name`} onChange={(e) => set(r.rid, { name: e.target.value })} />
              <input type="date" value={r.start} aria-label={`${r.name || "PI"} start`} onChange={(e) => set(r.rid, { start: e.target.value })} />
              <input type="date" value={r.end} aria-label={`${r.name || "PI"} end`} onChange={(e) => set(r.rid, { end: e.target.value })} />
              <button type="button" className="icon-btn" onClick={() => onChange(rows.filter((x) => x.rid !== r.rid))} aria-label={`Remove ${r.name || "PI"}`}>
                ✕
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="empty">No PIs yet. Add the current one, then use "Add next PI" to carry the cadence forward.</p>
      )}
      <div className="btn-row">
        <button type="button" className="btn small" onClick={() => onChange([...rows, row(nextPi(rows, today))])}>
          {rows.length ? "+ Add next PI" : "+ Add a PI"}
        </button>
        {rows.length ? (
          <button type="button" className="btn small" onClick={() => onChange([...rows, row({ name: "", start: "", end: "" })])}>
            + Add empty row
          </button>
        ) : null}
        {current ? (
          <span className="current-tag">Current: {current.name}</span>
        ) : rows.length ? (
          <span className="hint">No PI covers today.</span>
        ) : null}
      </div>
      <span className="hint">
        Bars that use {"{PI}"} or pace against the current PI switch over by themselves on each start date. "Add next PI" continues the same length and numbering; check the name matches Jira.
      </span>
    </>
  );
}

export function JiraSettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rows, setRows] = useState<PiRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [fields, setFields] = useState<JiraField[]>([]);
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [piValues, setPiValues] = useState<string[]>([]);
  // The two "blocked" lists are kept as typed and split into names on save.
  const [blockedStatuses, setBlockedStatuses] = useState("");
  const [blockedLabels, setBlockedLabels] = useState("");
  const [checking, setChecking] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let live = true;
    api.getSettings().then(
      (v) => {
        if (!live) return;
        const full = withSettingsDefaults(v);
        setSettings(full);
        setBlockedStatuses(full.jira.blocked.statuses.join(", "));
        setBlockedLabels(full.jira.blocked.labels.join(", "));
        setRows((v.pis ?? []).map(row));
      },
      (e: unknown) => live && setLoadError(errorText(e)),
    );
    api.jiraStatus().then((v) => live && setStatus(v), () => undefined);
    api.jiraFields().then((v) => live && setFields(Array.isArray(v) ? v : []), () => undefined);
    api.jiraBoards().then((v) => live && setBoards(Array.isArray(v) ? v : []), () => undefined);
    api.piValues().then((v) => live && setPiValues(Array.isArray(v) ? v : []), () => undefined);
    return () => {
      live = false;
    };
  }, []);

  const save = async (): Promise<string | void> => {
    if (!settings) return loadError || "The settings have not loaded yet.";
    const pis: Period[] = rows.map((r) => ({ name: r.name.trim(), start: r.start, end: r.end }));
    const problem = calendarError(pis);
    if (problem) return problem;
    try {
      const blocked = { ...settings.jira.blocked, statuses: parseStatusList(blockedStatuses), labels: parseStatusList(blockedLabels) };
      await api.saveSettings({ jira: { ...settings.jira, blocked }, pis });
    } catch (e) {
      return errorText(e);
    }
    store.refreshSoon();
  };

  const syncNow = async (): Promise<void> => {
    setSyncing(true);
    setSyncMsg("");
    try {
      const r = await api.sync();
      setSyncMsg(r.ok ? `Synced ${r.sources} ${r.sources === 1 ? "link" : "links"} in ${(r.durationMs / 1000).toFixed(1)} s.` : r.error || "The sync failed.");
    } catch (e) {
      setSyncMsg(errorText(e));
    } finally {
      setSyncing(false);
      void store.refresh();
    }
  };

  const jira = settings?.jira;
  const setJira = (patch: Partial<Settings["jira"]>): void => setSettings((old) => (old ? { ...old, jira: { ...old.jira, ...patch } } : old));
  const setBlocked = (patch: Partial<Settings["jira"]["blocked"]>): void =>
    setSettings((old) => (old ? { ...old, jira: { ...old.jira, blocked: { ...old.jira.blocked, ...patch } } } : old));
  const custom = useMemo(() => fields.filter((f) => f.custom), [fields]);

  const connection = !status
    ? { st: "none", text: "Checking the connection…" }
    : !status.configured
      ? { st: "none", text: "Jira is not connected. The server needs a Jira address and token; until then, linked bars stay empty and manual bars work as usual." }
      : status.ok
        ? { st: "good", text: `Connected to ${status.baseUrl ?? "Jira"}${status.deployment ? ` (${[status.deployment, status.version].filter(Boolean).join(" ")})` : ""}.` }
        : { st: "bad", text: `Cannot reach Jira${status.baseUrl ? ` at ${status.baseUrl}` : ""}: ${status.error ?? "unknown error"}` };

  const lastSync = s.sync.lastRunAt
    ? `Last sync ${fmtDateTime(s.sync.lastRunAt)}${s.sync.lastOk === false ? `, failed: ${s.sync.lastError ?? "unknown error"}` : ""}. Runs every ${Math.round(s.sync.intervalSeconds / 60) || 1} min.`
    : "No sync has run yet.";

  return (
    <Dialog title="Jira settings" onClose={onClose} onSubmit={save} wide>
      <div className="status-line">
        <span className={`dot st-${connection.st}`} aria-hidden="true" />
        <span>{connection.text}</span>
      </div>
      <div className="btn-row">
        <button type="button" className="btn small" onClick={() => void syncNow()} disabled={syncing || !s.sync.jiraConfigured}>
          {syncing ? "Syncing…" : "Sync now"}
        </button>
        <button type="button" className="btn small" onClick={() => setChecking(true)} disabled={checking}>
          Check the connection
        </button>
        <span className="hint" role="status">
          {syncMsg || lastSync}
        </span>
      </div>
      {checking ? <ConnectionCheck onClose={() => setChecking(false)} /> : null}

      {!settings ? (
        <p className="empty">{loadError || "Loading settings…"}</p>
      ) : (
        <>
          <div className="dlg-section">
            <h4>Fields</h4>
            <FieldPicker
              label="PI field"
              value={jira?.piField ?? ""}
              onChange={(piField) => setJira({ piField })}
              fields={custom}
              emptyLabel="Not set"
              hint="The Jira field that says which PI an epic or story belongs to. It is what {PI_FIELD} stands for in queries."
            />
            <div className="two">
              <FieldPicker label="Story points field" value={jira?.storyPointsField ?? ""} onChange={(storyPointsField) => setJira({ storyPointsField })} fields={custom} emptyLabel="Detect automatically" />
              <SelectField
                label="Board for the current sprint"
                value={jira?.boardId == null ? "" : String(jira.boardId)}
                onChange={(v) => setJira({ boardId: v === "" ? null : Number(v) })}
                options={[
                  ["", "None"] as const,
                  ...(jira?.boardId != null && !boards.some((b) => b.id === jira.boardId) ? [[String(jira.boardId), `Board ${jira.boardId}`] as const] : []),
                  ...boards.map((b) => [String(b.id), `${b.name} (${b.type})`] as const),
                ]}
                hint="Its active sprint sets the dates for bars that pace against the current sprint."
              />
            </div>
            <div className="two">
              <CheckField
                label="Show Jira summaries on screens"
                checked={jira?.showSummaries ?? true}
                onChange={(showSummaries) => setJira({ showSummaries })}
                hint="Turn off to keep ticket titles out of a shared room. Bars and cards then show the key, or the label you give them."
              />
              <CheckField
                label="Show assignee names on screens"
                checked={jira?.showAssignees ?? true}
                onChange={(showAssignees) => setJira({ showAssignees })}
                hint="Turn off to keep names off the flow boards."
              />
            </div>
          </div>
          <div className="dlg-section">
            <h4>Blocked means</h4>
            <span className="hint">Used for the Blocked marker on flow board cards and for the blocked KPIs. Any one of these is enough.</span>
            <CheckField label="Flagged in Jira" checked={jira?.blocked.flagged ?? true} onChange={(flagged) => setBlocked({ flagged })} />
            <div className="two">
              <TextField label="In one of these statuses" value={blockedStatuses} onChange={setBlockedStatuses} placeholder="Blocked, On hold" hint="Comma separated." />
              <TextField label="Has one of these labels" value={blockedLabels} onChange={setBlockedLabels} placeholder="blocked, waiting" hint="Comma separated." />
            </div>
            <CheckField label="Has an unresolved “is blocked by” link" checked={jira?.blocked.links ?? false} onChange={(links) => setBlocked({ links })} />
          </div>
          <div className="dlg-section">
            <h4>PI calendar</h4>
            <PiCalendar rows={rows} onChange={setRows} today={s.periods.today} suggestions={piValues} />
          </div>
        </>
      )}
    </Dialog>
  );
}
