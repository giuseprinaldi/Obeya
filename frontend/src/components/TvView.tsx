/* Display mode: one wall drawn on a 1600px stage and scaled to fill the screen. */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { periodLine } from "../logic/periods";
import type { LiveData } from "../logic/progress";
import { chipList, signals } from "../logic/status";
import { tvRowWeights } from "../logic/tvlayout";
import { fmtDateTime, fmtTime } from "../logic/util";
import type { StoreState } from "../store";
import type { Room, Wall } from "../types";
import { go } from "../ui";
import { PanelView } from "./PanelView";

/* The stage is 1600px wide and scaled to the screen. When a wall holds more than fits, the stage is widened
   step by step (so everything gets a little smaller) until nothing is cut off, up to STAGE_MAX. */
const STAGE_WIDTH = 1600;
const STAGE_MAX = 2200;
const STAGE_STEP = 100;
const POINTER_IDLE_MS = 2500;

export function TvView({ room, wall, live, s }: { room: Room; wall: Wall; live: LiveData; s: StoreState }) {
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [now, setNow] = useState(() => new Date());
  const [running, setRunning] = useState(false);
  const [stageW, setStageW] = useState(STAGE_WIDTH);
  const [, setFontsReady] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const index = room.walls.indexOf(wall);
  const wallIds = room.walls.map((w) => w.id).join("|");
  const rotate = Number(room.rotate) > 0 && room.walls.length > 1 ? Number(room.rotate) : 0;

  useEffect(() => {
    const onResize = (): void => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(t);
  }, []);

  // Rotation restarts only when the wall or the rotation setting changes, not on every data refresh.
  useEffect(() => {
    setRunning(false);
    if (!rotate) return;
    const ids = wallIds.split("|");
    const next = ids[(ids.indexOf(wall.id) + 1) % ids.length];
    const frame = requestAnimationFrame(() => setRunning(true));
    const t = setTimeout(() => next && go(`#tv-${next}`), rotate * 1000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(t);
    };
  }, [wall.id, rotate, wallIds]);

  // The exit button and the cursor show only while the mouse is moving.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onMove = (): void => {
      document.body.classList.add("pointer");
      clearTimeout(t);
      t = setTimeout(() => document.body.classList.remove("pointer"), POINTER_IDLE_MS);
    };
    document.addEventListener("mousemove", onMove);
    return () => {
      document.removeEventListener("mousemove", onMove);
      clearTimeout(t);
      document.body.classList.remove("pointer");
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") go(`#wall-${wall.id}`);
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const ids = wallIds.split("|");
        const i = ids.indexOf(wall.id);
        if (i < 0) return;
        const next = ids[(i + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length];
        if (next) go(`#tv-${next}`);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wall.id, wallIds]);

  // Fit: start again from the normal size whenever the wall, the screen or the amount of content changes,
  // then widen the stage while any panel is still cut off. Runs before paint, so the steps are not visible.
  const weights = tvRowWeights(wall.panels, live);
  const fitKey = `${wall.id}|${vp.w}x${vp.h}|${weights.join(",")}`;
  useLayoutEffect(() => setStageW(STAGE_WIDTH), [fitKey]);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || stageW >= STAGE_MAX) return;
    let cut = 0;
    grid.querySelectorAll<HTMLElement>(".panel-body").forEach((b) => {
      cut = Math.max(cut, b.scrollHeight - b.clientHeight);
    });
    if (cut > 2) setStageW((w) => Math.min(STAGE_MAX, w + STAGE_STEP));
  });
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, []);

  const scale = vp.w / stageW;
  const stage: CSSProperties = { width: stageW, height: vp.h / scale, transform: `scale(${scale})` };
  const period = periodLine(live.periods);
  const footRight = [rotate ? `Rotating every ${rotate}s` : "", room.example ? "Example data" : ""].filter(Boolean).join(" · ");

  return (
    <div className="tv-root">
      <div className="tv-stage" style={stage}>
        <div className="tv-head">
          <div>
            <div className="room">
              {room.roomName} · Screen {index + 1}
            </div>
            <h2>{wall.name}</h2>
            {wall.subtitle ? <div className="sub">{wall.subtitle}</div> : null}
            {period ? <div className="period">{period}</div> : null}
          </div>
          <div className="tv-right">
            <div className="chips">
              {chipList(signals(wall.panels, live)).map((c) => (
                <span key={c.text} className={`pill st-${c.status}`}>
                  {c.text}
                </span>
              ))}
            </div>
            <div className="tv-clock">
              <div className="t">{fmtTime(now)}</div>
              <div className="d">{now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</div>
            </div>
          </div>
        </div>
        <div className="grid tv-grid" ref={gridRef} style={{ gridTemplateRows: weights.map((w) => `minmax(0, ${w}fr)`).join(" ") }}>
          {wall.panels.map((p) => (
            <PanelView key={p.id} panel={p} wall={wall} live={live} tv />
          ))}
        </div>
        <div className="tv-foot">
          <span>
            {s.updatedAt ? `Updated ${fmtDateTime(s.updatedAt)}` : ""}
            {s.sync.jiraConfigured && s.sync.lastRunAt ? ` · Jira read ${fmtTime(s.sync.lastRunAt)}` : ""}
          </span>
          <span>
            {s.offlineSince ? <span className="offline">Offline since {fmtTime(s.offlineSince)}</span> : null}
            {s.offlineSince && footRight ? " · " : ""}
            {footRight}
          </span>
        </div>
      </div>
      <button type="button" className="btn tv-exit" onClick={() => go(`#wall-${wall.id}`)}>
        Exit display
      </button>
      <div key={`${wall.id}:${rotate}`} className={`tv-progress${running ? " run" : ""}`} style={{ "--rotate": `${rotate}s` } as CSSProperties} />
    </div>
  );
}
