/* Add or edit one progress bar: what it is linked to, and how it is drawn. */
import { useState } from "react";
import { defaultDisplay } from "../../logic/progress";
import { uid } from "../../logic/util";
import { store } from "../../store";
import type { BarDisplay, ProgressBarItem, ProgressPanel, Source } from "../../types";
import { findPanel } from "../../ui";
import { Dialog, Segmented, TextField } from "../Dialog";
import { CheckLink, DisplayFields, LinkFields, displayError, linkDraft, linkSource, type LinkDraft } from "./JiraFields";

type Kind = Source["kind"];
const KINDS: readonly (readonly [Kind, string])[] = [
  ["issue", "Jira issue"],
  ["jql", "Jira query"],
  ["manual", "Manual"],
];

export function BarDialog({ panel, itemId, onClose }: { panel: ProgressPanel; itemId?: string; onClose: () => void }) {
  const [item] = useState<ProgressBarItem | undefined>(() => (itemId ? panel.data.items.find((b) => b.id === itemId) : undefined));
  const src = item?.source;
  const [kind, setKind] = useState<Kind>(src?.kind ?? "issue");
  const [link, setLink] = useState<LinkDraft>(() => linkDraft(src && src.kind !== "manual" ? src : null));
  const [manual, setManual] = useState(() => ({
    done: src?.kind === "manual" ? String(src.done) : "0",
    total: src?.kind === "manual" ? String(src.total) : "10",
    unit: src?.kind === "manual" ? src.unit : "",
  }));
  const [label, setLabel] = useState(item?.label ?? "");
  const [owner, setOwner] = useState(item?.owner ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [display, setDisplay] = useState<BarDisplay>(() =>
    item ? { color: item.color, valueFormat: item.valueFormat, showInProgress: item.showInProgress, pace: item.pace } : defaultDisplay(),
  );

  const draftLink: LinkDraft = { ...link, kind: kind === "jql" ? "jql" : "issue" };

  const buildSource = (): Source | string => {
    if (kind !== "manual") return linkSource(draftLink);
    const done = parseFloat(manual.done), total = parseFloat(manual.total);
    if (!isFinite(done) || !isFinite(total) || done < 0 || total < 0) return "Enter the done and total amounts as numbers.";
    if (done > total) return "Done cannot be more than the total.";
    return { kind: "manual", done, total, unit: manual.unit.trim() };
  };

  const save = (): string | void => {
    const source = buildSource();
    if (typeof source === "string") return source;
    const name = label.trim();
    if (!name && source.kind !== "issue") return "Give the bar a label.";
    const problem = displayError(display);
    if (problem) return problem;
    const bar: ProgressBarItem = { id: item?.id ?? uid(), label: name, owner: owner.trim(), note: note.trim(), source, ...display };
    store.commit((room) => {
      const p = findPanel(room, panel.id)?.panel;
      if (p?.type !== "progress") return;
      const i = p.data.items.findIndex((b) => b.id === bar.id);
      if (i >= 0) p.data.items[i] = bar;
      else p.data.items.push(bar);
    });
  };

  const removeBar = (): void =>
    store.commit((room) => {
      const p = findPanel(room, panel.id)?.panel;
      if (p?.type === "progress") p.data.items = p.data.items.filter((b) => b.id !== itemId);
    });

  return (
    <Dialog
      title={item ? "Edit bar" : "Add bar"}
      submitLabel={item ? "Save" : "Add bar"}
      onClose={onClose}
      onSubmit={save}
      wide
      danger={item ? { label: "Delete bar", onConfirm: removeBar } : undefined}
    >
      <Segmented legend="Progress comes from" value={kind} onChange={setKind} options={KINDS} />
      {kind === "manual" ? (
        <div className="three">
          <TextField label="Done" type="number" min={0} value={manual.done} onChange={(done) => setManual({ ...manual, done })} />
          <TextField label="Total" type="number" min={0} value={manual.total} onChange={(total) => setManual({ ...manual, total })} />
          <TextField label="Unit" value={manual.unit} onChange={(unit) => setManual({ ...manual, unit })} placeholder="sites, teams, %" />
        </div>
      ) : (
        <>
          <LinkFields value={draftLink} onChange={setLink} />
          <CheckLink
            build={() => {
              const s = linkSource(draftLink);
              return typeof s === "string" ? s : { source: s };
            }}
          />
        </>
      )}
      <div className="dlg-section">
        <h4>Label</h4>
        <TextField
          label="Label"
          value={label}
          onChange={setLabel}
          placeholder={kind === "issue" ? "Leave empty to use the title from Jira" : "For example: Sprint scope"}
          hint={kind === "issue" ? "Shown instead of the Jira title when filled in." : undefined}
        />
        <div className="two">
          <TextField label="Owner" value={owner} onChange={setOwner} />
          <TextField label="Note" value={note} onChange={setNote} />
        </div>
      </div>
      <div className="dlg-section">
        <h4>Display</h4>
        <DisplayFields value={display} onChange={setDisplay} />
      </div>
    </Dialog>
  );
}
