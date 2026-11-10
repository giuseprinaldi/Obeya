/* Add or edit one KPI: a hand-entered value, or one worked out from Jira. */
import { useState } from "react";
import { parseStatusList } from "../../logic/jira";
import { METRICS, METRIC_KINDS, WINDOW_MAX, WINDOW_MIN, defaultMetric, metricError, relabel } from "../../logic/kpi";
import { uid } from "../../logic/util";
import { store } from "../../store";
import type { KpiItem, KpiPanel, Measure, Metric, MetricKind, UnplannedRule } from "../../types";
import { findPanel } from "../../ui";
import { Dialog, Segmented, SelectField, TextField } from "../Dialog";
import { BoardPicker, CheckLink, JqlInput, useBoards } from "./JiraFields";

type Source = "manual" | "jira";
const SOURCES: readonly (readonly [Source, string])[] = [
  ["manual", "Manual"],
  ["jira", "Jira"],
];
const DIRS: readonly (readonly ["up" | "down", string])[] = [
  ["up", "Higher"],
  ["down", "Lower"],
];
const KINDS: readonly (readonly [MetricKind, string])[] = METRIC_KINDS.map((k) => [k, METRICS[k].label] as const);
const STATS: readonly (readonly [Metric["stat"], string])[] = [
  ["median", "Median"],
  ["average", "Average"],
  ["p85", "85th percentile"],
];
const MEASURES: readonly (readonly [Measure, string])[] = [
  ["count", "Issues"],
  ["points", "Story points"],
];
type Rule = UnplannedRule["rule"];
const RULES: readonly (readonly [Rule, string])[] = [
  ["added_after_start", "Added after the sprint started"],
  ["labels", "Has one of these labels"],
  ["types", "Is one of these issue types"],
];
const KPI_PRESETS = [
  { label: "Current sprint", jql: "sprint in openSprints()" },
  { label: "Current PI", jql: '{PI_FIELD} = "{PI}"' },
];

/** The metric as typed into the form: numbers and lists are still text. */
interface MetricDraft {
  kind: MetricKind;
  boardId: number | null;
  jql: string;
  windowDays: string;
  stat: Metric["stat"];
  measure: Measure;
  doneStatuses: string;
  rule: Rule;
  ruleValues: string;
}

function draftOf(m: Metric): MetricDraft {
  return {
    kind: m.kind,
    boardId: m.boardId,
    jql: m.jql,
    windowDays: String(m.windowDays),
    stat: m.stat,
    measure: m.measure,
    doneStatuses: m.doneStatuses.join(", "),
    rule: m.unplanned.rule,
    ruleValues: m.unplanned.rule === "added_after_start" ? "" : m.unplanned.values.join(", "),
  };
}

function metricOf(d: MetricDraft): Metric {
  const typed = Math.round(Number(d.windowDays));
  const inRange = Number.isFinite(typed) && typed >= WINDOW_MIN && typed <= WINDOW_MAX;
  return {
    kind: d.kind,
    boardId: d.boardId,
    jql: d.jql.trim(),
    // Kinds that do not look back keep a valid default; for the others metricError reports a bad value.
    windowDays: METRICS[d.kind].window || inRange ? typed : 30,
    stat: d.stat,
    measure: d.measure,
    doneStatuses: parseStatusList(d.doneStatuses),
    unplanned: d.rule === "added_after_start" ? { rule: d.rule } : { rule: d.rule, values: parseStatusList(d.ruleValues) },
  };
}

const numOrBlank = (s: string): number | "" => {
  const n = parseFloat(s);
  return isFinite(n) ? n : "";
};

export function KpiDialog({ panel, itemId, onClose }: { panel: KpiPanel; itemId?: string; onClose: () => void }) {
  const [item] = useState<KpiItem | undefined>(() => (itemId ? panel.data.items.find((k) => k.id === itemId) : undefined));
  const [name, setName] = useState(item?.name ?? "");
  const [unit, setUnit] = useState(item?.unit ?? "");
  const [target, setTarget] = useState(item?.target === undefined || item.target === "" ? "" : String(item.target));
  const [dir, setDir] = useState<"up" | "down">(item?.dir ?? "up");
  const [actual, setActual] = useState(item?.actual === undefined || item.actual === "" ? "" : String(item.actual));
  const [history, setHistory] = useState((item?.history ?? []).join(", "));
  const [source, setSource] = useState<Source>(item?.metric ? "jira" : "manual");
  const [metric, setMetric] = useState<MetricDraft>(() => draftOf(item?.metric ?? defaultMetric()));
  const { boards, error: boardsError } = useBoards();
  const info = METRICS[metric.kind];

  // Picking a metric fills in the name, unit and direction, unless the user has typed their own.
  const relabelFor = (prev: MetricDraft | null, next: MetricDraft): void => {
    const l = relabel({ name, unit, dir }, prev, next);
    setName(l.name);
    setUnit(l.unit);
    setDir(l.dir);
  };
  const changeSource = (next: Source): void => {
    setSource(next);
    if (next === "jira") relabelFor(null, metric);
  };
  const changeMetric = (patch: Partial<MetricDraft>): void => {
    const next = { ...metric, ...patch };
    if (next.kind !== metric.kind || next.measure !== metric.measure) relabelFor(metric, next);
    setMetric(next);
  };

  const save = (): string | void => {
    const n = name.trim();
    if (!n) return "Give the KPI a name first.";
    let jira: Metric | null = null;
    if (source === "jira") {
      jira = metricOf(metric);
      const problem = metricError(jira);
      if (problem) return problem;
    }
    store.commit((room) => {
      const p = findPanel(room, panel.id)?.panel;
      if (p?.type !== "kpi") return;
      const prev = itemId ? p.data.items.find((k) => k.id === itemId) : undefined;
      const base = { name: n, unit: unit.trim(), target: numOrBlank(target), dir };
      let next: KpiItem;
      if (jira) {
        // The hand-entered value and history are kept as they were, in case the KPI goes back to manual.
        next = { id: prev?.id ?? uid(), ...base, actual: prev?.actual ?? "", history: prev?.history ?? [], metric: jira };
      } else {
        const value = numOrBlank(actual);
        const hist = history
          .split(",")
          .map((s) => parseFloat(s))
          .filter((x) => isFinite(x));
        if (value !== "") {
          const changed = !!prev && Number(value) !== Number(prev.actual) && hist[hist.length - 1] !== value;
          if (!hist.length || changed) hist.push(value);
        }
        next = { id: prev?.id ?? uid(), ...base, actual: value, history: hist, metric: null };
      }
      const i = p.data.items.findIndex((k) => k.id === next.id);
      if (i >= 0) p.data.items[i] = next;
      else p.data.items.push(next);
    });
  };

  const remove = (): void =>
    store.commit((room) => {
      const p = findPanel(room, panel.id)?.panel;
      if (p?.type === "kpi") p.data.items = p.data.items.filter((k) => k.id !== itemId);
    });

  return (
    <Dialog
      title={item ? "Edit KPI" : "Add KPI"}
      submitLabel={item ? "Save" : "Add KPI"}
      onClose={onClose}
      onSubmit={save}
      wide={source === "jira"}
      danger={item ? { label: "Delete KPI", onConfirm: remove } : undefined}
    >
      <div className="two">
        <TextField label="KPI name" value={name} onChange={setName} />
        <TextField label="Unit" value={unit} onChange={setUnit} placeholder="%, days, / month" />
      </div>
      <div className="two">
        <TextField label="Target" type="number" value={target} onChange={setTarget} />
        <SelectField label="Better when" value={dir} onChange={setDir} options={DIRS} />
      </div>
      <Segmented legend="Value from" value={source} onChange={changeSource} options={SOURCES} />
      {source === "manual" ? (
        <>
          <TextField label="Current value" type="number" value={actual} onChange={setActual} />
          <TextField label="History, oldest first" value={history} onChange={setHistory} hint="Comma separated. Saving a new current value adds it to the end." />
        </>
      ) : (
        <>
          <SelectField label="Metric" value={metric.kind} onChange={(kind) => changeMetric({ kind })} options={KINDS} hint={info.explain} />
          <div className="dlg-section">
            <h4>Which work</h4>
            <BoardPicker
              label="Board"
              value={metric.boardId}
              onChange={(boardId) => changeMetric({ boardId })}
              boards={boards}
              emptyLabel="No board"
              hint={boardsError ? `The list of boards could not be read: ${boardsError}` : "A scrum board is measured over its active sprint. Add a query to narrow it, or use a query on its own."}
            />
            <JqlInput value={metric.jql} onChange={(jql) => changeMetric({ jql })} label="Jira query (JQL), optional with a board" presets={KPI_PRESETS} placeholder="project = PLAT" />
          </div>
          <div className="dlg-section">
            <h4>How it is measured</h4>
            {info.window || info.stat ? (
              <div className="two">
                {info.window ? (
                  <TextField
                    label="Look back (days)"
                    type="number"
                    min={WINDOW_MIN}
                    max={WINDOW_MAX}
                    step={1}
                    value={metric.windowDays}
                    onChange={(windowDays) => changeMetric({ windowDays })}
                    hint={`Between ${WINDOW_MIN} and ${WINDOW_MAX}.`}
                  />
                ) : null}
                {info.stat ? <SelectField label="Figure to report" value={metric.stat} onChange={(stat) => changeMetric({ stat })} options={STATS} /> : null}
              </div>
            ) : null}
            {info.measure ? <SelectField label="Measure by" value={metric.measure} onChange={(measure) => changeMetric({ measure })} options={MEASURES} /> : null}
            {metric.kind === "unplanned" ? (
              <>
                <SelectField
                  label="Unplanned means"
                  value={metric.rule}
                  onChange={(rule) => changeMetric({ rule })}
                  options={RULES}
                  hint={metric.rule === "added_after_start" ? "Work that joined the active sprint after it began. This rule needs a board." : undefined}
                />
                {metric.rule !== "added_after_start" ? (
                  <TextField
                    label={metric.rule === "labels" ? "Labels" : "Issue types"}
                    value={metric.ruleValues}
                    onChange={(ruleValues) => changeMetric({ ruleValues })}
                    placeholder={metric.rule === "labels" ? "unplanned, expedite" : "Bug, Incident"}
                    hint="Comma separated."
                  />
                ) : null}
              </>
            ) : null}
            <TextField
              label="Statuses that count as done"
              value={metric.doneStatuses}
              onChange={(doneStatuses) => changeMetric({ doneStatuses })}
              placeholder="Leave empty to use Jira's done category"
              hint="Comma separated, for example: Done, Released. Sub-tasks are never counted."
            />
            <CheckLink
              label="Check"
              build={() => {
                const m = metricOf(metric);
                return metricError(m) || { metric: m };
              }}
            />
          </div>
        </>
      )}
    </Dialog>
  );
}
