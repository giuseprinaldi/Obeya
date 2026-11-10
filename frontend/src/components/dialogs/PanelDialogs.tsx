/* Panel settings (title, width, and what each panel type adds) and the add-panel picker. */
import { useId, useState } from "react";
import { MAX_CARDS_MAX, MAX_CARDS_MIN, defaultBoardSource, hideableColumns } from "../../logic/board";
import { defaultDisplay } from "../../logic/progress";
import { PANEL_TYPES, SPANS, newPanel } from "../../logic/seed";
import { clamp, uid } from "../../logic/util";
import { store } from "../../store";
import type { AutoSource, BarDisplay, BoardResult, BoardSource, JiraBoard, Panel, PanelType, ProgressSort, Span, Wall } from "../../types";
import { findPanel, wallById } from "../../ui";
import { CheckField, Dialog, Segmented, SelectField, TextArea, TextField } from "../Dialog";
import { BoardPicker, CheckLink, DisplayFields, JqlInput, OptionsFields, displayError, optionsDraft, optionsOf, useBoards, type OptionsDraft } from "./JiraFields";

const SPAN_OPTIONS = SPANS.map(([n, l]) => [String(n), l] as const);
const toSpan = (s: string): Span => (s === "2" ? 2 : s === "3" ? 3 : 1);

const SORTS: readonly (readonly [ProgressSort, string])[] = [
  ["manual", "As arranged"],
  ["status", "Furthest behind first"],
  ["pct-asc", "Least complete first"],
  ["pct-desc", "Most complete first"],
];

interface ColumnDraft {
  id: string;
  name: string;
  wip: string;
}

function ColumnsEditor({ value, onChange }: { value: ColumnDraft[]; onChange: (v: ColumnDraft[]) => void }) {
  const set = (i: number, patch: Partial<ColumnDraft>): void => onChange(value.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const move = (i: number, dir: number): void => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = value.slice();
    const [c] = next.splice(i, 1);
    if (c) next.splice(j, 0, c);
    onChange(next);
  };
  return (
    <div className="field">
      <span className="legend">Columns</span>
      <div className="edit-rows">
        <div className="edit-row cols head" aria-hidden="true">
          <span>Name</span>
          <span>WIP limit</span>
        </div>
        {value.map((c, i) => (
          <div className="edit-row cols" key={c.id}>
            <input type="text" value={c.name} aria-label={`Column ${i + 1} name`} onChange={(e) => set(i, { name: e.target.value })} />
            <input type="number" min={0} step={1} value={c.wip} placeholder="None" aria-label={`Column ${i + 1} WIP limit`} onChange={(e) => set(i, { wip: e.target.value })} />
            <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${c.name || "column"} earlier`}>
              ↑
            </button>
            <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === value.length - 1} aria-label={`Move ${c.name || "column"} later`}>
              ↓
            </button>
            <button type="button" className="icon-btn" onClick={() => onChange(value.filter((_, n) => n !== i))} disabled={value.length === 1} aria-label={`Remove ${c.name || "column"}`}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="btn-row">
        <button type="button" className="btn small" onClick={() => onChange([...value, { id: uid(), name: "", wip: "" }])}>
          + Add column
        </button>
      </div>
      <span className="hint">Listed left to right. Leave the WIP limit empty for no limit. Cards in a removed column move to the first column.</span>
    </div>
  );
}

/* ---------- Flow board fed by a Jira board ---------- */

type BoardMode = "manual" | "jira";
const BOARD_MODES: readonly (readonly [BoardMode, string])[] = [
  ["manual", "Manual"],
  ["jira", "Jira board"],
];
const SPRINT_SCOPES: readonly (readonly [BoardSource["sprint"], string])[] = [
  ["active", "The active sprint"],
  ["all", "Everything on the board"],
];
const BOARD_PRESETS = [
  { label: "Current PI", jql: '{PI_FIELD} = "{PI}"' },
  // Kanban boards in Jira list epics as cards; this leaves only the work items.
  { label: "Without epics", jql: "issuetype != Epic" },
];

/** The Jira source as typed into the form: no board chosen yet is allowed, and numbers are still text. */
interface BoardDraft {
  boardId: number | null;
  jql: string;
  sprint: BoardSource["sprint"];
  hidden: string[];
  maxCards: string;
  doneDays: string;
}

function boardDraft(src: BoardSource | null | undefined): BoardDraft {
  const s = src ?? defaultBoardSource(0);
  return { boardId: src ? s.boardId : null, jql: s.jql, sprint: s.sprint, hidden: s.hiddenColumns, maxCards: String(s.maxCards), doneDays: String(s.doneDays) };
}

/** The source a draft describes, or a message saying what is missing. */
function boardOf(d: BoardDraft): BoardSource | string {
  if (d.boardId === null) return "Choose the Jira board this panel shows.";
  const maxCards = Math.round(Number(d.maxCards));
  if (!Number.isFinite(maxCards) || maxCards < MAX_CARDS_MIN || maxCards > MAX_CARDS_MAX) return `Cards per column must be between ${MAX_CARDS_MIN} and ${MAX_CARDS_MAX}.`;
  const doneDays = d.doneDays.trim() === "" ? 0 : Math.round(Number(d.doneDays));
  if (!Number.isFinite(doneDays) || doneDays < 0) return "The number of days for the done column must be 0 or more.";
  return { boardId: d.boardId, jql: d.jql.trim(), sprint: d.sprint, hiddenColumns: d.hidden, maxCards, doneDays };
}

interface BoardFieldsProps {
  value: BoardDraft;
  onChange: (v: BoardDraft) => void;
  boards: JiraBoard[];
  boardsError: string;
  /** What Jira last returned for this panel, and what the Check button just returned. */
  last: BoardResult | undefined;
  checked: BoardResult | null;
  onChecked: (r: BoardResult) => void;
}

function BoardFields({ value, onChange, boards, boardsError, last, checked, onChecked }: BoardFieldsProps) {
  const type = boards.find((b) => b.id === value.boardId)?.type ?? (checked?.ok ? checked.boardType : last?.ok ? last.boardType : "");
  const names = hideableColumns(value.hidden, checked, last);
  const hidden = new Set(value.hidden.map((n) => n.toLowerCase()));
  const toggle = (name: string, hide: boolean): void =>
    onChange({ ...value, hidden: hide ? [...value.hidden, name] : value.hidden.filter((n) => n.toLowerCase() !== name.toLowerCase()) });
  return (
    <>
      <BoardPicker
        label="Jira board"
        value={value.boardId}
        onChange={(boardId) => onChange({ ...value, boardId, hidden: boardId === value.boardId ? value.hidden : [] })}
        boards={boards}
        emptyLabel="Choose a board"
        hint={boardsError ? `The list of boards could not be read: ${boardsError}` : "Columns, WIP limits and cards all come from this board, and the panel becomes read-only."}
      />
      {type !== "kanban" ? <SelectField label="Show" value={value.sprint} onChange={(sprint) => onChange({ ...value, sprint })} options={SPRINT_SCOPES} /> : null}
      <JqlInput value={value.jql} onChange={(jql) => onChange({ ...value, jql })} label="Extra filter (JQL), optional" presets={BOARD_PRESETS} placeholder='labels = platform AND {PI_FIELD} = "{PI}"' />
      <div className="two">
        <TextField label="Cards per column" type="number" min={MAX_CARDS_MIN} max={MAX_CARDS_MAX} step={1} value={value.maxCards} onChange={(maxCards) => onChange({ ...value, maxCards })} hint="The rest are counted as “+N more”." />
        <TextField label="Done column shows the last (days)" type="number" min={0} step={1} value={value.doneDays} onChange={(doneDays) => onChange({ ...value, doneDays })} hint="0 shows everything that is done." />
      </div>
      <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="legend" style={{ padding: 0, marginBottom: 5 }}>
          Columns to hide
        </legend>
        {names.length ? (
          <div className="seg">
            {names.map((n) => (
              <label key={n}>
                <input type="checkbox" checked={hidden.has(n.toLowerCase())} onChange={(e) => toggle(n, e.target.checked)} />
                {n}
              </label>
            ))}
          </div>
        ) : (
          <span className="hint">Press Check to list the board's columns.</span>
        )}
      </fieldset>
      <CheckLink
        label="Check"
        build={() => {
          const b = boardOf(value);
          return typeof b === "string" ? b : { board: b };
        }}
        onResult={(r) => {
          if ("columns" in r) onChecked(r);
        }}
      />
    </>
  );
}

interface AutoDraft extends OptionsDraft {
  on: boolean;
  jql: string;
  limit: string;
}

function autoOf(d: AutoDraft): AutoSource | string | null {
  if (!d.on) return null;
  const jql = d.jql.trim();
  if (!jql) return "Enter the Jira query that fills this panel, or turn auto-fill off.";
  const limit = clamp(Math.round(Number(d.limit) || 12), 1, 100);
  return { jql, limit, ...optionsOf(d) };
}

export function PanelSettingsDialog({ panel, onClose }: { panel: Panel; onClose: () => void }) {
  const [title, setTitle] = useState(panel.title);
  const [span, setSpan] = useState(String(panel.span || 1));
  const [text, setText] = useState(panel.type === "statement" ? panel.data.text : "");
  const [meta, setMeta] = useState(panel.type === "statement" ? panel.data.meta : "");
  const [columns, setColumns] = useState<ColumnDraft[]>(() =>
    panel.type === "kanban" ? panel.data.columns.map((c) => ({ id: c.id, name: c.name, wip: Number(c.wip) > 0 ? String(c.wip) : "" })) : [],
  );
  const jiraSource = panel.type === "kanban" ? panel.data.jira : null;
  const [boardMode, setBoardMode] = useState<BoardMode>(jiraSource ? "jira" : "manual");
  const [board, setBoard] = useState<BoardDraft>(() => boardDraft(jiraSource));
  const [checked, setChecked] = useState<BoardResult | null>(null);
  const [lastBoard] = useState<BoardResult | undefined>(() => store.getState().boards[panel.id]);
  const { boards, error: boardsError } = useBoards();
  const pd = panel.type === "progress" ? panel.data : null;
  const [sort, setSort] = useState<ProgressSort>(pd?.sort ?? "manual");
  const [showKeys, setShowKeys] = useState(pd?.showKeys ?? true);
  const [auto, setAuto] = useState<AutoDraft>(() => ({ on: !!pd?.auto, jql: pd?.auto?.jql ?? "", limit: String(pd?.auto?.limit ?? 12), ...optionsDraft(pd?.auto) }));
  const [autoDisplay, setAutoDisplay] = useState<BarDisplay>(() => pd?.autoDisplay ?? defaultDisplay());

  const save = (): string | void => {
    const name = title.trim();
    if (!name) return "Give the panel a title.";
    let cols: { id: string; name: string; wip: number }[] = [];
    let boardSource: BoardSource | null = null;
    if (panel.type === "kanban" && boardMode === "jira") {
      const b = boardOf(board);
      if (typeof b === "string") return b;
      boardSource = b;
    } else if (panel.type === "kanban") {
      cols = columns.map((c) => ({ id: c.id, name: c.name.trim(), wip: Math.max(0, parseInt(c.wip, 10) || 0) }));
      if (!cols.length) return "A flow board needs at least one column.";
      if (cols.some((c) => !c.name)) return "Give every column a name, or remove the empty ones.";
    }
    let autoSource: AutoSource | null = null;
    if (panel.type === "progress") {
      const a = autoOf(auto);
      if (typeof a === "string") return a;
      autoSource = a;
      if (a) {
        const problem = displayError(autoDisplay);
        if (problem) return problem;
      }
    }
    store.commit((room) => {
      const p = findPanel(room, panel.id)?.panel;
      if (!p) return;
      p.title = name;
      p.span = toSpan(span);
      if (p.type === "statement") p.data = { text: text.trim(), meta: meta.trim() };
      if (p.type === "kanban" && boardSource) {
        // The manual columns and cards are left exactly as they were, for when the board goes back to Manual.
        p.data.jira = boardSource;
      } else if (p.type === "kanban") {
        p.data.jira = null;
        const ids = new Set(cols.map((c) => c.id));
        const first = cols[0]!.id;
        for (const card of p.data.cards) if (!ids.has(card.col)) card.col = first;
        p.data.columns = cols;
      }
      if (p.type === "progress") {
        p.data.sort = sort;
        p.data.showKeys = showKeys;
        p.data.auto = autoSource;
        p.data.autoDisplay = autoDisplay;
      }
    });
  };

  const removePanel = (): void =>
    store.commit((room) => {
      const f = findPanel(room, panel.id);
      if (f) f.wall.panels.splice(f.wall.panels.indexOf(f.panel), 1);
    });

  return (
    <Dialog title="Edit panel" onClose={onClose} onSubmit={save} wide={panel.type === "progress" || panel.type === "kanban"} danger={{ label: "Delete panel", onConfirm: removePanel }}>
      <div className="two">
        <TextField label="Panel title" value={title} onChange={setTitle} />
        <SelectField label="Width on the wall" value={span} onChange={setSpan} options={SPAN_OPTIONS} />
      </div>
      {panel.type === "statement" ? (
        <>
          <TextArea label="Statement" value={text} onChange={setText} />
          <TextField label="Supporting line" value={meta} onChange={setMeta} placeholder="Owner, cadence or date" />
        </>
      ) : null}
      {panel.type === "kanban" ? (
        <>
          <Segmented legend="Source" value={boardMode} onChange={setBoardMode} options={BOARD_MODES} />
          {boardMode === "manual" ? (
            <ColumnsEditor value={columns} onChange={setColumns} />
          ) : (
            <>
              <BoardFields value={board} onChange={setBoard} boards={boards} boardsError={boardsError} last={lastBoard} checked={checked} onChecked={setChecked} />
              <span className="hint">The columns and cards entered by hand are kept, and come back if you switch to Manual.</span>
            </>
          )}
        </>
      ) : null}
      {panel.type === "progress" ? (
        <>
          <div className="two">
            <SelectField label="Order of the bars" value={sort} onChange={setSort} options={SORTS} />
            <CheckField label="Show the Jira key next to each bar" checked={showKeys} onChange={setShowKeys} />
          </div>
          <div className="dlg-section">
            <h4>Auto-fill from Jira</h4>
            <CheckField
              label="Add a bar for every issue a Jira query finds"
              checked={auto.on}
              onChange={(on) => setAuto({ ...auto, on })}
              hint="The bars follow the query, so the panel fills itself with the right epics each sprint or PI. Bars you add by hand stay, and are listed first."
            />
            {auto.on ? (
              <>
                <JqlInput value={auto.jql} onChange={(jql) => setAuto({ ...auto, jql })} label="Query: each match becomes a bar" />
                <TextField label="Most bars to show" type="number" min={1} max={100} step={1} value={auto.limit} onChange={(limit) => setAuto({ ...auto, limit })} />
                <OptionsFields value={auto} onChange={setAuto} />
                <CheckLink
                  label="Check query"
                  build={() => {
                    const a = autoOf(auto);
                    return typeof a === "string" ? a : a ? { auto: a } : "Auto-fill is off.";
                  }}
                />
                <DisplayFields value={autoDisplay} onChange={setAutoDisplay} />
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </Dialog>
  );
}

export function AddPanelDialog({ wall, onClose }: { wall: Wall; onClose: () => void }) {
  const [type, setType] = useState<PanelType>("statement");
  const [title, setTitle] = useState("");
  const [span, setSpan] = useState("1");
  const name = useId();
  const types = Object.entries(PANEL_TYPES) as [PanelType, (typeof PANEL_TYPES)[PanelType]][];

  const save = (): void => {
    const panel = newPanel(type, title.trim() || PANEL_TYPES[type].label, toSpan(span));
    store.commit((room) => {
      wallById(room, wall.id)?.panels.push(panel);
    });
  };

  return (
    <Dialog title="Add panel" submitLabel="Add panel" onClose={onClose} onSubmit={save}>
      <fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className="legend" style={{ padding: 0, marginBottom: 5 }}>
          Panel type
        </legend>
        <div className="type-pick">
          {types.map(([k, T]) => (
            <label key={k}>
              <input type="radio" name={name} value={k} checked={type === k} onChange={() => setType(k)} />
              {T.label}
              <small>{T.desc}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="two">
        <TextField label="Panel title" value={title} onChange={setTitle} placeholder="For example: Customer KPIs" />
        <SelectField label="Width on the wall" value={span} onChange={setSpan} options={SPAN_OPTIONS} />
      </div>
    </Dialog>
  );
}
