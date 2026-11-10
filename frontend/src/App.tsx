/* The app shell: hash routing, room preferences, polling, the edit lock, and which dialog is open. */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ControlBar, Overview, WallView } from "./components/Editor";
import { PinnedDisplay, ScreenDisplay } from "./components/TvView";
import { UnlockDialog } from "./components/dialogs/AccessDialogs";
import { BarDialog } from "./components/dialogs/BarDialog";
import { ItemDialog } from "./components/dialogs/ItemDialog";
import { JiraSettingsDialog } from "./components/dialogs/JiraSettingsDialog";
import { KpiDialog } from "./components/dialogs/KpiDialog";
import { AddPanelDialog, PanelSettingsDialog } from "./components/dialogs/PanelDialogs";
import { AddWallDialog, CustomizeDialog, WallSettingsDialog } from "./components/dialogs/RoomDialogs";
import { isDisplay, parseRoute } from "./logic/route";
import { ACCENTS } from "./logic/seed";
import { liveOf, store, useStore } from "./store";
import type { Room } from "./types";
import { UiContext, findPanel, wallById, type DialogSpec, type Ui } from "./ui";

const EDITOR_POLL_MS = 10_000;
const TV_POLL_MS = 30_000;

const subscribeHash = (cb: () => void): (() => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
const useHash = (): string => useSyncExternalStore(subscribeHash, () => window.location.hash);

/** The dialogs that edit the room. A dialog whose target has gone (deleted elsewhere) simply does not open. */
function RoomDialog({ spec, room, close }: { spec: Exclude<DialogSpec, { kind: "unlock" }>; room: Room; close: () => void }) {
  switch (spec.kind) {
    case "item": {
      const p = findPanel(room, spec.panelId)?.panel;
      if (!p || p.type === "statement" || p.type === "progress") return null;
      if (p.type === "kpi") return <KpiDialog panel={p} itemId={spec.itemId} onClose={close} />;
      return <ItemDialog panel={p} itemId={spec.itemId} col={spec.col} onClose={close} />;
    }
    case "bar": {
      const p = findPanel(room, spec.panelId)?.panel;
      return p?.type === "progress" ? <BarDialog panel={p} itemId={spec.itemId} onClose={close} /> : null;
    }
    case "panel": {
      const p = findPanel(room, spec.panelId)?.panel;
      return p ? <PanelSettingsDialog panel={p} onClose={close} /> : null;
    }
    case "addPanel": {
      const w = wallById(room, spec.wallId);
      return w ? <AddPanelDialog wall={w} onClose={close} /> : null;
    }
    case "wall": {
      const w = wallById(room, spec.wallId);
      return w ? <WallSettingsDialog room={room} wall={w} onClose={close} /> : null;
    }
    case "addWall":
      return <AddWallDialog onClose={close} />;
    case "customize":
      return <CustomizeDialog room={room} onClose={close} />;
    case "jira":
      return <JiraSettingsDialog onClose={close} />;
  }
}

export function App() {
  const s = useStore();
  const route = parseRoute(useHash());
  const isTv = isDisplay(route);
  const canEdit = s.access.canEdit;
  const [dialog, setDialog] = useState<{ spec: DialogSpec; n: number } | null>(null);
  // The one place the edit lock is applied to the editor: components read ui.canEdit, and while it is
  // false no dialog opens except the one that unlocks.
  const ui = useMemo<Ui>(
    () => ({
      open: (spec) => {
        if (canEdit || spec.kind === "unlock") setDialog((old) => ({ spec, n: (old?.n ?? 0) + 1 }));
      },
      close: () => setDialog(null),
      canEdit,
    }),
    [canEdit],
  );
  const live = useMemo(() => liveOf(s), [s.progress, s.auto, s.boards, s.metrics, s.periods, s.sync.jiraConfigured]);
  const room = s.room;

  useEffect(() => {
    if (!window.location.hash) window.history.replaceState(null, "", "#overview");
  }, []);

  useEffect(() => {
    store.start(isTv ? TV_POLL_MS : EDITOR_POLL_MS);
    return () => store.stop();
  }, [isTv]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void store.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  // Room preferences: accent, theme (separate for TVs), density.
  const accent = room?.accent, theme = room ? (isTv ? room.tvTheme : room.theme) : "auto", density = room?.density;
  useEffect(() => {
    const a = ACCENTS[accent ?? "cobalt"] ?? ACCENTS.cobalt;
    const root = document.documentElement.style;
    root.setProperty("--accent-l", a.l);
    root.setProperty("--accent-d", a.d);
    const b = document.body.classList;
    b.toggle("force-light", theme === "light");
    b.toggle("force-dark", theme === "dark");
    b.toggle("compact", density === "compact");
    b.toggle("tv", isTv);
  }, [accent, theme, density, isTv]);

  useEffect(() => {
    document.title = room?.roomName ? `${room.roomName} · Obeya` : "Obeya Room";
  }, [room?.roomName]);

  // Display mode has no editing, so entering it closes any open dialog. So does losing the right to edit
  // (locked from this browser, or the session ended). The unlock dialog closes once editing is unlocked.
  const dialogKind = dialog?.spec.kind;
  useEffect(() => {
    if (!dialogKind) return;
    if (isTv || (!canEdit && dialogKind !== "unlock") || (canEdit && dialogKind === "unlock")) setDialog(null);
  }, [isTv, canEdit, dialogKind]);

  // A display pinned to a wall that no longer exists moves to the first wall.
  const pinnedId = route.view === "tv" ? route.id : "";
  const pinned = room && route.view === "tv" ? (wallById(room, pinnedId) ?? room.walls[0]) : undefined;
  const pinnedWallId = pinned?.id;
  const hasRoom = !!room;
  useEffect(() => {
    if (!hasRoom || !pinnedId) return;
    if (!pinnedWallId) window.location.hash = "#overview";
    else if (pinnedWallId !== pinnedId) window.history.replaceState(null, "", `#tv-${pinnedWallId}`);
  }, [hasRoom, pinnedId, pinnedWallId]);

  const unlockDialog = dialog?.spec.kind === "unlock" && !isTv ? <UnlockDialog key={dialog.n} onClose={ui.close} /> : null;

  if (!room) {
    // No room yet. A browser that may edit sets one up by itself; a view-only one waits, or unlocks.
    const waiting = s.loaded && !canEdit;
    return (
      <UiContext.Provider value={ui}>
        <div className="splash" role="status">
          <div>
            <strong>Obeya</strong>
            {s.loadError ? (
              `${s.loadError} Trying again every few seconds.`
            ) : waiting ? (
              <>
                <p>This room has not been set up yet. {isTv ? "" : "Unlock editing to set it up."}</p>
                {isTv ? null : (
                  <button type="button" className="btn primary" onClick={() => ui.open({ kind: "unlock" })}>
                    Unlock editing
                  </button>
                )}
              </>
            ) : s.loaded ? (
              "Setting up the room…"
            ) : (
              "Loading the room…"
            )}
          </div>
        </div>
        {unlockDialog}
      </UiContext.Provider>
    );
  }

  const wall = route.view === "wall" ? wallById(room, route.id) : undefined;

  return (
    <UiContext.Provider value={ui}>
      {route.view === "screen" ? (
        <ScreenDisplay key={route.n} room={room} n={route.n} live={live} s={s} />
      ) : route.view === "tv" ? (
        pinned ? <PinnedDisplay room={room} wall={pinned} live={live} s={s} /> : null
      ) : (
        <>
          <ControlBar room={room} route={wall ? route : { view: "overview" }} live={live} s={s} />
          <main>{wall ? <WallView room={room} wall={wall} live={live} /> : <Overview room={room} live={live} s={s} />}</main>
        </>
      )}
      {unlockDialog}
      {dialog && dialog.spec.kind !== "unlock" && !isTv && canEdit ? <RoomDialog key={dialog.n} spec={dialog.spec} room={room} close={ui.close} /> : null}
      {s.toast ? (
        <div className="toast" role="alert">
          <span>{s.toast}</span>
          <button type="button" onClick={() => store.dismissToast()}>
            Dismiss
          </button>
        </div>
      ) : null}
    </UiContext.Provider>
  );
}
