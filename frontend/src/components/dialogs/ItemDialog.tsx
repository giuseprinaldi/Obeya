/* Add or edit one item on a portfolio, problems, actions or flow board panel. KPIs have their own dialog. */
import { useState } from "react";
import { SEVERITIES, STAGES, itemNoun } from "../../logic/seed";
import { clamp, dayOffset, uid } from "../../logic/util";
import { store } from "../../store";
import type { JiraSource, KanbanColumn, Panel, Room, Severity, Stage } from "../../types";
import { findPanel } from "../../ui";
import { CheckField, Dialog, Segmented, SelectField, TextArea, TextField } from "../Dialog";
import { CheckLink, LinkFields, linkDraft, linkSource, type LinkDraft } from "./JiraFields";

type ItemPanel = Exclude<Panel, { type: "statement" } | { type: "progress" } | { type: "kpi" }>;
type Vals = Record<string, string | boolean>;

interface FieldDef {
  k: string;
  l: string;
  t: "text" | "number" | "select" | "textarea" | "date" | "checkbox" | "numlist" | "column";
  half?: boolean;
  ph?: string;
  hint?: string;
  o?: readonly (readonly [string, string])[];
}

const FIELDS: Record<ItemPanel["type"], FieldDef[]> = {
  portfolio: [
    { k: "name", l: "Initiative", t: "text" },
    { k: "owner", l: "Owner", t: "text", half: true },
    { k: "horizon", l: "Horizon", t: "text", ph: "Q1 2027", half: true },
    { k: "health", l: "Health", t: "select", o: [["on", "On track"], ["risk", "At risk"], ["off", "Off track"]], half: true },
    { k: "progress", l: "Progress %", t: "number", half: true, hint: "Used when there is no Jira link, or the link has no result." },
    { k: "note", l: "Note", t: "text" },
  ],
  problems: [
    { k: "title", l: "Problem", t: "text" },
    { k: "owner", l: "Owner", t: "text", half: true },
    { k: "severity", l: "Severity", t: "select", o: SEVERITIES.map((s) => [s, s] as const), half: true },
    { k: "stage", l: "Stage", t: "select", o: STAGES.map((s) => [s, s] as const) },
    { k: "problem", l: "What is happening", t: "textarea" },
    { k: "cause", l: "Root cause", t: "textarea" },
    { k: "countermeasure", l: "Countermeasure", t: "textarea" },
  ],
  actions: [
    { k: "text", l: "Action", t: "text" },
    { k: "owner", l: "Owner", t: "text", half: true },
    { k: "due", l: "Due", t: "date", half: true },
    { k: "done", l: "Done", t: "checkbox" },
  ],
  kanban: [
    { k: "title", l: "Card", t: "text" },
    { k: "owner", l: "Owner", t: "text", half: true },
    { k: "tag", l: "Tag", t: "text", half: true },
    { k: "col", l: "Column", t: "column" },
    { k: "blocked", l: "Blocked", t: "checkbox" },
  ],
};

function defaults(panel: ItemPanel, col?: string): Record<string, unknown> {
  switch (panel.type) {
    case "portfolio":
      return { health: "on", progress: 0 };
    case "problems":
      return { severity: "Medium", stage: "Define" };
    case "actions":
      return { due: dayOffset(7), done: false };
    case "kanban":
      return { col: col || panel.data.columns[0]?.id || "", blocked: false };
  }
}

function existing(panel: ItemPanel, itemId: string): Record<string, unknown> | null {
  const list: { id: string }[] = panel.type === "kanban" ? panel.data.cards : panel.data.items;
  const it = list.find((x) => x.id === itemId);
  return it ? { ...it } : null;
}

function toVals(fields: FieldDef[], item: Record<string, unknown>): Vals {
  const out: Vals = {};
  for (const f of fields) {
    const v = item[f.k];
    if (f.t === "checkbox") out[f.k] = v === true;
    else if (f.t === "numlist") out[f.k] = Array.isArray(v) ? v.join(", ") : "";
    else out[f.k] = v === undefined || v === null ? "" : String(v);
  }
  return out;
}

const text = (v: Vals, k: string): string => String(v[k] ?? "").trim();
const flag = (v: Vals, k: string): boolean => v[k] === true;
const numOrBlank = (v: Vals, k: string): number | "" => {
  const n = parseFloat(String(v[k] ?? ""));
  return isFinite(n) ? n : "";
};
const pick = <T extends string>(v: Vals, k: string, options: readonly T[], d: T): T => {
  const s = text(v, k);
  return (options as readonly string[]).includes(s) ? (s as T) : d;
};

/** Writes the form into the room. Runs inside store.commit, on the draft. */
function apply(room: Room, panelId: string, itemId: string | undefined, v: Vals, source: JiraSource | null): void {
  const f = findPanel(room, panelId);
  if (!f) return;
  const p = f.panel;
  const put = <T extends { id: string }>(list: T[], item: Omit<T, "id">): void => {
    const i = itemId ? list.findIndex((x) => x.id === itemId) : -1;
    if (i >= 0) list[i] = { ...list[i], ...item } as T;
    else list.push({ id: uid(), ...item } as T);
  };
  switch (p.type) {
    case "portfolio":
      put(p.data.items, {
        name: text(v, "name"),
        owner: text(v, "owner"),
        horizon: text(v, "horizon"),
        health: pick(v, "health", ["on", "risk", "off"] as const, "on"),
        progress: clamp(Number(numOrBlank(v, "progress")) || 0, 0, 100),
        note: text(v, "note"),
        source,
      });
      break;
    case "problems":
      put(p.data.items, {
        title: text(v, "title"),
        owner: text(v, "owner"),
        severity: pick<Severity>(v, "severity", SEVERITIES, "Medium"),
        stage: pick<Stage>(v, "stage", STAGES, "Define"),
        problem: text(v, "problem"),
        cause: text(v, "cause"),
        countermeasure: text(v, "countermeasure"),
      });
      break;
    case "actions":
      put(p.data.items, { text: text(v, "text"), owner: text(v, "owner"), due: text(v, "due"), done: flag(v, "done") });
      break;
    case "kanban": {
      const cols = p.data.columns;
      const col = cols.some((c) => c.id === text(v, "col")) ? text(v, "col") : (cols[0]?.id ?? "");
      put(p.data.cards, { title: text(v, "title"), owner: text(v, "owner"), tag: text(v, "tag"), col, blocked: flag(v, "blocked") });
      break;
    }
    case "statement":
    case "progress":
    case "kpi":
      break;
  }
}

function remove(room: Room, panelId: string, itemId: string): void {
  const p = findPanel(room, panelId)?.panel;
  if (!p || p.type === "statement") return;
  if (p.type === "kanban") p.data.cards = p.data.cards.filter((x) => x.id !== itemId);
  else if (p.type === "kpi") p.data.items = p.data.items.filter((x) => x.id !== itemId);
  else if (p.type === "portfolio") p.data.items = p.data.items.filter((x) => x.id !== itemId);
  else if (p.type === "problems") p.data.items = p.data.items.filter((x) => x.id !== itemId);
  else if (p.type === "actions") p.data.items = p.data.items.filter((x) => x.id !== itemId);
  else p.data.items = p.data.items.filter((x) => x.id !== itemId);
}

function FieldInput({ f, value, onChange, columns }: { f: FieldDef; value: string | boolean; onChange: (v: string | boolean) => void; columns: KanbanColumn[] }) {
  const s = typeof value === "string" ? value : "";
  switch (f.t) {
    case "textarea":
      return <TextArea label={f.l} value={s} onChange={onChange} hint={f.hint} />;
    case "select":
      return <SelectField label={f.l} value={s} onChange={onChange} options={f.o ?? []} hint={f.hint} />;
    case "column":
      return <SelectField label={f.l} value={s} onChange={onChange} options={columns.map((c) => [c.id, c.name] as const)} />;
    case "checkbox":
      return <CheckField label={f.l} checked={value === true} onChange={onChange} />;
    case "number":
      return <TextField label={f.l} type="number" value={s} onChange={onChange} hint={f.hint} />;
    case "date":
      return <TextField label={f.l} type="date" value={s} onChange={onChange} />;
    default:
      return <TextField label={f.l} value={s} onChange={onChange} placeholder={f.ph} hint={f.hint} />;
  }
}

type LinkKind = "none" | "issue" | "jql";
const LINK_KINDS: readonly (readonly [LinkKind, string])[] = [
  ["none", "Not linked"],
  ["issue", "Jira issue"],
  ["jql", "Jira query"],
];

export function ItemDialog({ panel, itemId, col, onClose }: { panel: ItemPanel; itemId?: string; col?: string; onClose: () => void }) {
  const fields = FIELDS[panel.type];
  const noun = itemNoun(panel.type);
  const [start] = useState(() => (itemId ? existing(panel, itemId) : null) ?? defaults(panel, col));
  const [vals, setVals] = useState<Vals>(() => toVals(fields, start));
  const startSource = panel.type === "portfolio" && itemId ? (panel.data.items.find((x) => x.id === itemId)?.source ?? null) : null;
  const [linkKind, setLinkKind] = useState<LinkKind>(startSource?.kind ?? "none");
  const [link, setLink] = useState<LinkDraft>(() => linkDraft(startSource));
  const columns = panel.type === "kanban" ? panel.data.columns : [];

  const draftLink: LinkDraft = { ...link, kind: linkKind === "jql" ? "jql" : "issue" };

  const save = (): string | void => {
    const first = fields[0]!.k;
    if (!text(vals, first)) return `Give the ${noun} a name first.`;
    let source: JiraSource | null = null;
    if (panel.type === "portfolio" && linkKind !== "none") {
      const s = linkSource(draftLink);
      if (typeof s === "string") return s;
      source = s;
    }
    store.commit((room) => apply(room, panel.id, itemId, vals, source));
  };

  // Lay half-width fields out in pairs, as the prototype did.
  const rows: FieldDef[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (f.half && last && last.length === 1 && last[0]!.half) last.push(f);
    else rows.push([f]);
  }
  const input = (f: FieldDef) => <FieldInput key={f.k} f={f} value={vals[f.k] ?? ""} onChange={(v) => setVals((old) => ({ ...old, [f.k]: v }))} columns={columns} />;

  return (
    <Dialog
      title={`${itemId ? "Edit" : "Add"} ${noun}`}
      submitLabel={itemId ? "Save" : `Add ${noun}`}
      onClose={onClose}
      onSubmit={save}
      wide={panel.type === "portfolio"}
      danger={itemId ? { label: `Delete ${noun}`, onConfirm: () => store.commit((room) => remove(room, panel.id, itemId)) } : undefined}
    >
      {rows.map((r) =>
        r.length === 2 ? (
          <div className="two" key={r[0]!.k}>
            {r.map(input)}
          </div>
        ) : (
          input(r[0]!)
        ),
      )}
      {panel.type === "portfolio" ? (
        <div className="dlg-section">
          <h4>Jira link</h4>
          <span className="hint">Link the initiative to Jira and its progress is worked out from the linked work instead of typed in.</span>
          <Segmented legend="Progress comes from" value={linkKind} onChange={setLinkKind} options={LINK_KINDS} />
          {linkKind !== "none" ? (
            <>
              <LinkFields value={draftLink} onChange={setLink} />
              <CheckLink
                build={() => {
                  const s = linkSource(draftLink);
                  return typeof s === "string" ? s : { source: s };
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
