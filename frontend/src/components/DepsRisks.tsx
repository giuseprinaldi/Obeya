/* Bodies of the dependencies panel (read from Jira's issue links, read-only) and the risks panel
   (a manual register with ROAM status). */
import { depsView, riskStatus, sortRisks, type DepRow } from "../logic/deps";
import type { LiveData } from "../logic/progress";
import type { DepIssue, DependenciesPanel, RisksPanel } from "../types";
import { useUi } from "../ui";

/* ---------- Dependencies ---------- */

function DepEnd({ issue, tv }: { issue: DepIssue; tv: boolean }) {
  const showTitle = issue.title && issue.title !== issue.key;
  return (
    <div className="dep-end">
      <div className="dep-title">
        {/* In the editor the key opens the issue in Jira. A TV has nobody to click it. */}
        {issue.url && !tv ? (
          <a className="key" href={issue.url} target="_blank" rel="noopener noreferrer">
            {issue.key}
          </a>
        ) : (
          <span className="key">{issue.key}</span>
        )}
        {showTitle ? <span className="rt">{issue.title}</span> : null}
      </div>
      {issue.status ? <div className="rs">{issue.status}</div> : null}
    </div>
  );
}

function DepRowView({ row, tv }: { row: DepRow; tv: boolean }) {
  return (
    <div className={`dep st-${row.status}`}>
      <span className={`pill st-${row.status}`}>{row.label}</span>
      <DepEnd issue={row.waiting} tv={tv} />
      <span className="dep-arrow" title={row.type ? `Jira link type: ${row.type}` : undefined}>
        waits on
      </span>
      <DepEnd issue={row.on} tv={tv} />
      {row.crossTeam ? (
        <span className="tag" title={`${row.waiting.project} is waiting on ${row.on.project}`}>
          Across teams
        </span>
      ) : (
        <span />
      )}
    </div>
  );
}

export function DependenciesBody({ panel, live, tv }: { panel: DependenciesPanel; live: LiveData; tv: boolean }) {
  const ui = useUi();
  const v = depsView(panel, live);
  if (v.state === "unlinked") {
    return (
      <>
        <p className="empty">{v.message}</p>
        {ui.canEdit ? (
          <button type="button" className="add" style={{ marginTop: 10 }} onClick={() => ui.open({ kind: "panel", panelId: panel.id })}>
            Choose what to show
          </button>
        ) : null}
      </>
    );
  }
  if (v.state !== "ok") {
    return (
      <p className={v.state === "error" ? "pbar-note is-error" : "empty"} style={{ margin: 0 }} role={v.state === "error" ? "alert" : undefined}>
        {v.message}
      </p>
    );
  }
  if (!v.rows.length) return <p className="empty">{v.empty}</p>;
  return (
    <>
      <div className="deps">
        {v.rows.map((r) => (
          <DepRowView key={r.id} row={r} tv={tv} />
        ))}
      </div>
      {v.footer ? <p className="board-foot">{v.footer}</p> : null}
    </>
  );
}

/* ---------- Risks ---------- */

export function RisksBody({ panel }: { panel: RisksPanel; live: LiveData; tv: boolean }) {
  const ui = useUi();
  if (!panel.data.items.length) return <p className="empty">No risks yet. Add what could stop the plan, who owns it and where it stands.</p>;
  return (
    <div className="rows risks">
      {sortRisks(panel.data.items).map((r) => {
        const st = riskStatus(r);
        return (
          <div className={`row st-${st}`} key={r.id}>
            <span className="sev" role="img" aria-label={`${r.impact} impact`} />
            <button type="button" className="row-btn" disabled={!ui.canEdit} onClick={() => ui.open({ kind: "item", panelId: panel.id, itemId: r.id })}>
              <div className="rt">{r.title}</div>
              <div className="rs">{[`${r.impact} impact`, r.owner, r.note].filter(Boolean).join(" · ")}</div>
            </button>
            <span className={`pill st-${st}`}>{r.roam}</span>
          </div>
        );
      })}
    </div>
  );
}
