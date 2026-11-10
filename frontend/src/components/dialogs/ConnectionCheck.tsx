/* Jira connection check: runs the server's diagnostics and lists each check with what to do about it. */
import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { checkWord, diagnosticsSummary } from "../../logic/access";
import { fmtTime } from "../../logic/util";
import type { Diagnostics } from "../../types";

type State = { phase: "checking" } | { phase: "done"; result: Diagnostics } | { phase: "failed"; error: string };

/** Shown inside the Jira settings dialog, so nothing typed there is lost while the check runs. */
export function ConnectionCheck({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<State>({ phase: "checking" });
  const [run, setRun] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ phase: "checking" });
    api.diagnostics().then(
      (result) => live && setState({ phase: "done", result: { ...result, checks: Array.isArray(result?.checks) ? result.checks : [] } }),
      (e: unknown) => live && setState({ phase: "failed", error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [run]);

  const summary = state.phase === "done" ? diagnosticsSummary(state.result) : null;

  return (
    <div className="dlg-section" aria-live="polite">
      <h4>Jira connection check</h4>
      {state.phase === "checking" ? <p className="empty">Checking… This can take a few seconds.</p> : null}
      {state.phase === "failed" ? (
        <p className="check-result st-bad" role="alert">
          The check could not be run: {state.error}
        </p>
      ) : null}
      {state.phase === "done" && summary ? (
        <>
          <p className={`check-result st-${summary.status}`} role="status">
            <b>{summary.text}</b>
            {state.result.ranAt ? ` · checked ${fmtTime(state.result.ranAt)}` : ""}
          </p>
          <ul className="checks">
            {state.result.checks.map((c) => {
              const w = checkWord(c.status);
              return (
                <li key={c.id} className="check-row">
                  <span className={`pill st-${w.status}`}>{w.word}</span>
                  <div>
                    <div className="rt">{c.label}</div>
                    {c.detail ? <div className="rs">{c.detail}</div> : null}
                    {c.fix ? <div className="fix">What to do: {c.fix}</div> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      <div className="btn-row">
        <button type="button" className="btn small" onClick={() => setRun((n) => n + 1)} disabled={state.phase === "checking"}>
          Run again
        </button>
        <button type="button" className="btn small ghost" onClick={onClose}>
          Hide the check
        </button>
      </div>
    </div>
  );
}
