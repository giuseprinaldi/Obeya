/* Earlier versions: the saved versions of the room the server still keeps, and a way back to any of them. */
import { useEffect, useState } from "react";
import { api, errorText } from "../../api";
import { restoredText, versionRows, type VersionRow } from "../../logic/history";
import { normalizeRoom } from "../../logic/normalize";
import { fmtDateTime } from "../../logic/util";
import { store } from "../../store";
import { go } from "../../ui";
import { Dialog } from "../Dialog";

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; rows: VersionRow[] };

export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<Loaded>({ status: "loading" });
  /** The version whose Restore button has been pressed once and is waiting for the second click. */
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState("");

  useEffect(() => {
    let live = true;
    api.roomHistory().then(
      (h) => live && setList({ status: "ready", rows: versionRows(h) }),
      (e: unknown) => live && setList({ status: "error", message: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, []);

  const restore = async (row: VersionRow): Promise<void> => {
    if (busy !== null) return;
    if (armed !== row.version) {
      setProblem("");
      return setArmed(row.version);
    }
    setBusy(row.version);
    try {
      const saved = await api.roomVersion(row.version);
      const room = normalizeRoom(saved.room);
      if (!room) {
        setProblem(`Version ${row.version} cannot be read as a room, so it was not restored.`);
        return;
      }
      // Saved as a new version, like any other edit: nothing is lost, and the restore can itself be undone.
      store.replaceRoom(room);
      store.toast(restoredText(fmtDateTime(row.savedAt)));
      onClose();
      go("#overview");
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setBusy(null);
      setArmed(null);
    }
  };

  return (
    <Dialog title="Earlier versions" onClose={onClose} wide>
      <span className="hint">
        Every save is kept, up to the last 100. Restoring one saves it again as the newest version, so nothing is lost and a restore can be undone the same way.
      </span>
      {list.status === "loading" ? <p className="empty">Reading the saved versions…</p> : null}
      {list.status === "error" ? (
        <p className="check-result st-warn" role="alert">
          The saved versions could not be read: {list.message}
        </p>
      ) : null}
      {list.status === "ready" && !list.rows.length ? <p className="empty">Nothing has been saved yet.</p> : null}
      {list.status === "ready" && list.rows.length ? (
        <ol className="versions">
          {list.rows.map((row) => (
            <li key={row.version} className={`version${row.current ? " is-current" : ""}`}>
              <div className="version-text">
                <div className="version-when">
                  {fmtDateTime(row.savedAt) || `Version ${row.version}`}
                  {row.current ? <span className="current-tag">Current</span> : null}
                </div>
                <div className="hint">{row.label}</div>
                <ul className="version-changes">
                  {row.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
              {row.current ? null : (
                <button
                  type="button"
                  className={`btn small${armed === row.version ? " danger" : ""}`}
                  data-armed={armed === row.version ? "1" : ""}
                  disabled={busy !== null}
                  onClick={() => void restore(row)}
                  aria-label={armed === row.version ? `Confirm restoring version ${row.version}` : `Restore version ${row.version}`}
                >
                  {busy === row.version ? "Restoring…" : armed === row.version ? "Replace the room? Click again" : "Restore"}
                </button>
              )}
            </li>
          ))}
        </ol>
      ) : null}
      {problem ? (
        <p className="check-result st-warn" role="alert">
          {problem}
        </p>
      ) : null}
    </Dialog>
  );
}
