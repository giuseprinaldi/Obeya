/* The editing views: control bar with wall tabs, the room overview, and one wall. */
import { calendarNotice, roomUsesPi } from "../logic/periods";
import type { LiveData } from "../logic/progress";
import { badCount, chipList, signals, wallStatus } from "../logic/status";
import { fmtDateTime, fmtTime } from "../logic/util";
import type { StoreState } from "../store";
import type { Room, Status, Wall } from "../types";
import { go, useUi, type Route } from "../ui";
import { PanelView } from "./PanelView";

function jiraDot(s: StoreState): { st: Status; title: string } {
  if (!s.sync.jiraConfigured) return { st: "none", title: "Jira is not connected" };
  if (s.sync.lastOk === false) return { st: "bad", title: `The last Jira sync failed: ${s.sync.lastError ?? "unknown error"}` };
  if (s.sync.lastOk) return { st: "good", title: `Jira synced ${fmtTime(s.sync.lastRunAt)}` };
  return { st: "none", title: "Waiting for the first Jira sync" };
}

export function ControlBar({ room, route, live, s }: { room: Room; route: Route; live: LiveData; s: StoreState }) {
  const ui = useUi();
  const active = route.view === "wall" ? route.id : "overview";
  const dot = jiraDot(s);
  const displayId = route.view === "wall" ? route.id : room.walls[0]?.id;
  return (
    <header className="bar">
      <div className="brand">
        <div className="mark" aria-hidden="true">
          大
        </div>
        <div className="brand-text">
          <div className="eyebrow">Obeya</div>
          <h1>{room.roomName || "Obeya Room"}</h1>
        </div>
        {room.example ? <span className="chip-example">Example data</span> : null}
      </div>
      <nav className="tabs" aria-label="Walls">
        <a className="tab" href="#overview" aria-current={active === "overview" ? "page" : undefined}>
          Overview
        </a>
        {room.walls.map((w, i) => {
          const n = badCount(signals(w.panels, live));
          return (
            <a className="tab" key={w.id} href={`#wall-${w.id}`} aria-current={active === w.id ? "page" : undefined}>
              <span className="scr">{i + 1}</span>
              {w.name}
              {n ? (
                <span className="flag" aria-label={`${n} items need attention`}>
                  {n}
                </span>
              ) : null}
            </a>
          );
        })}
        <button type="button" className="tab" onClick={() => ui.open({ kind: "addWall" })} aria-label="Add a wall">
          + Wall
        </button>
      </nav>
      <div className="bar-actions">
        {s.saveState === "retrying" ? (
          <span className="save-state is-retrying" role="status">
            Not saved, retrying
          </span>
        ) : s.saveState === "saving" ? (
          <span className="save-state" role="status">
            Saving…
          </span>
        ) : null}
        <button type="button" className="btn" onClick={() => ui.open({ kind: "jira" })} title={dot.title}>
          <span className={`dot st-${dot.st}`} aria-hidden="true" />
          Jira
          <span className="sr-only">: {dot.title}</span>
        </button>
        <button type="button" className="btn" onClick={() => ui.open({ kind: "customize" })}>
          Customize
        </button>
        <button type="button" className="btn primary" onClick={() => displayId && go(`#tv-${displayId}`)} disabled={!displayId}>
          Display mode
        </button>
      </div>
    </header>
  );
}

function Stat({ n, label, status }: { n: number; label: string; status: Status }) {
  return (
    <div className={`stat st-${n ? status : "good"}`}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export function Overview({ room, live, s }: { room: Room; live: LiveData; s: StoreState }) {
  const ui = useUi();
  const all = signals(
    room.walls.flatMap((w) => w.panels),
    live,
  );
  const notice = calendarNotice(live.periods, roomUsesPi(room));
  const first = room.walls[0]?.id;
  const jiraLine = !s.sync.jiraConfigured
    ? " Jira is not connected, so linked bars are empty."
    : s.sync.lastRunAt
      ? ` Jira was last read ${fmtDateTime(s.sync.lastRunAt)} and is read again every ${Math.round(s.sync.intervalSeconds / 60) || 1} minutes.`
      : "";
  return (
    <>
      <div className="wall-head">
        <div>
          <div className="screen-tag">Room overview</div>
          <h2>{room.roomName}</h2>
          <p>
            {room.walls.length} {room.walls.length === 1 ? "wall" : "walls"}
            {s.updatedAt ? ` · updated ${fmtDateTime(s.updatedAt)}` : ""}
          </p>
        </div>
        <div className="wall-actions">
          <button type="button" className="btn" onClick={() => ui.open({ kind: "addWall" })}>
            + Add wall
          </button>
          <button type="button" className="btn primary" onClick={() => first && go(`#tv-${first}`)} disabled={!first}>
            Start display
          </button>
        </div>
      </div>
      {notice ? (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" className="btn small" onClick={() => ui.open({ kind: "jira" })}>
            Open Jira settings
          </button>
        </div>
      ) : null}
      <div className="summary">
        <Stat n={all.kpiBad} label="KPIs off target" status="bad" />
        <Stat n={all.off + all.risk} label="Initiatives off track or at risk" status={all.off ? "bad" : "warn"} />
        <Stat n={all.barBad} label="Progress bars behind pace" status="bad" />
        <Stat n={all.blocked} label="Blocked work items" status="bad" />
        <Stat n={all.openHigh} label="High-severity problems open" status="bad" />
        <Stat n={all.late} label="Late actions" status="bad" />
      </div>
      <div className="section-h">
        <h3>Room plan</h3>
        <p>Each wall runs on its own screen. Open a display on the TV it belongs to.</p>
      </div>
      <div className="plan">
        {room.walls.length ? (
          room.walls.map((w, i) => {
            const sig = signals(w.panels, live);
            return (
              <div key={w.id}>
                <div className="screen">
                  <div className={`screen-inner st-${wallStatus(sig)}`}>
                    <div className="screen-label">
                      Screen {i + 1} · {w.panels.length} {w.panels.length === 1 ? "panel" : "panels"}
                    </div>
                    <div className="screen-name">{w.name}</div>
                    <div className="chips">
                      {chipList(sig).map((c) => (
                        <span key={c.text} className={`pill st-${c.status}`}>
                          {c.text}
                        </span>
                      ))}
                    </div>
                    <div className="screen-links">
                      <a className="btn small" href={`#wall-${w.id}`}>
                        Edit wall
                      </a>
                      <a className="btn small primary" href={`#tv-${w.id}`}>
                        Open display
                      </a>
                    </div>
                  </div>
                </div>
                <div className="screen-stand">
                  <span />
                </div>
              </div>
            );
          })
        ) : (
          <p className="empty">No walls yet. Add one, or load a room template from Customize.</p>
        )}
      </div>
      <p className="footnote">Changes are saved to the Obeya server as you make them, and every screen picks them up within about 30 seconds.{jiraLine} Customize has a JSON backup of the whole room.</p>
    </>
  );
}

export function WallView({ room, wall, live }: { room: Room; wall: Wall; live: LiveData }) {
  const ui = useUi();
  const i = room.walls.indexOf(wall);
  return (
    <>
      <div className="wall-head">
        <div>
          <div className="screen-tag">
            Screen {i + 1} of {room.walls.length}
          </div>
          <h2>{wall.name}</h2>
          {wall.subtitle ? <p>{wall.subtitle}</p> : null}
        </div>
        <div className="wall-actions">
          <button type="button" className="btn" onClick={() => ui.open({ kind: "addPanel", wallId: wall.id })}>
            + Add panel
          </button>
          <button type="button" className="btn" onClick={() => ui.open({ kind: "wall", wallId: wall.id })}>
            Wall settings
          </button>
          <a className="btn primary" href={`#tv-${wall.id}`}>
            Open display
          </a>
        </div>
      </div>
      <div className="grid">
        {wall.panels.length ? wall.panels.map((p) => <PanelView key={p.id} panel={p} wall={wall} live={live} tv={false} />) : <p className="empty">This wall is empty. Add a panel to start.</p>}
      </div>
    </>
  );
}
