/* The one store. It holds the room and the live Jira data, saves edits to the server
   (optimistic, with a version check) and polls for changes made elsewhere. */
import { useSyncExternalStore } from "react";
import { api, errorText, isLocked, isTransient, setLockedHandler } from "./api";
import { OPEN_ACCESS, accessOf } from "./logic/access";
import { normalizeRoom } from "./logic/normalize";
import type { LiveData } from "./logic/progress";
import { seed } from "./logic/seed";
import { todayISO } from "./logic/util";
import type { Access, AutoResult, BoardResult, MetricResult, Periods, ProgressResult, Room, ServerState, SyncInfo } from "./types";

export interface StoreState {
  /** False until the first answer from the server. */
  loaded: boolean;
  /** Why the first load is failing, while it is. */
  loadError: string | null;
  room: Room | null;
  version: number;
  updatedAt: string | null;
  progress: Record<string, ProgressResult>;
  auto: Record<string, AutoResult>;
  boards: Record<string, BoardResult>;
  metrics: Record<string, MetricResult>;
  burnups: Record<string, ProgressResult>;
  periods: Periods;
  sync: SyncInfo;
  /** Whether this browser may edit. View-only browsers never save, seed or open editors. */
  access: Access;
  /** "retrying" means an edit has not reached the server yet. */
  saveState: "idle" | "saving" | "retrying";
  /** ISO time of the first failed poll since the last good one. */
  offlineSince: string | null;
  toast: string | null;
}

let state: StoreState = {
  loaded: false,
  loadError: null,
  room: null,
  version: 0,
  updatedAt: null,
  progress: {},
  auto: {},
  boards: {},
  metrics: {},
  burnups: {},
  periods: { today: todayISO(), pi: null, nextPi: null, sprint: null },
  sync: { jiraConfigured: false, running: false, lastRunAt: null, lastOk: null, lastError: null, intervalSeconds: 300 },
  access: OPEN_ACCESS,
  saveState: "idle",
  offlineSince: null,
  toast: null,
};

const listeners = new Set<() => void>();
function set(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

let dirty = false; // local edits not yet accepted by the server
let inFlight = false; // a save request is running
let saveSeq = 0; // bumps whenever a save settles, so stale polls are not applied over it
let dialogs = 0; // open dialogs: the room is never swapped underneath one
let seeding = false;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let followUps: ReturnType<typeof setTimeout>[] = [];
let toastTimer: ReturnType<typeof setTimeout> | undefined;

let lockNoticeAt = 0;

const RETRY_MS = 3000;
const FOLLOW_UP_MS = [2000, 6000];
const LOCKED_TEXT = "Editing is locked. Unlock it to make changes.";

function toast(message: string): void {
  clearTimeout(toastTimer);
  set({ toast: message });
  toastTimer = setTimeout(() => set({ toast: null }), 7000);
}

function applyServer(s: ServerState, seqAtStart: number, force: boolean): void {
  const patch: Partial<StoreState> = {
    loaded: true,
    loadError: null,
    offlineSince: null,
    progress: s.progress ?? {},
    auto: s.auto ?? {},
    // An older server sends none of these.
    boards: s.boards ?? {},
    metrics: s.metrics ?? {},
    burnups: s.burnups ?? {},
    periods: s.periods ?? state.periods,
    sync: s.sync ?? state.sync,
    // An older server sends no access: the room is open.
    access: accessOf(s.access),
  };
  const quiet = !dirty && !inFlight && seqAtStart === saveSeq;
  if (s.room === null) {
    set(patch);
    // A view-only browser never sets the room up; it waits for someone who may edit.
    if (quiet && !seeding && state.access.canEdit) void seedRoom();
    return;
  }
  const newer = state.room === null || s.version > state.version;
  if (force || (quiet && dialogs === 0 && newer)) {
    const room = normalizeRoom(s.room);
    if (room) {
      patch.room = room;
      patch.version = s.version;
      patch.updatedAt = s.updatedAt;
    }
  }
  set(patch);
}

/** The server has no room yet: save the example room (or the one on screen, if the server lost its data).
    If someone beat us to it, take theirs. */
async function seedRoom(): Promise<void> {
  seeding = true;
  try {
    const room = state.room ?? seed("program");
    const r = await api.saveRoom({ room, baseVersion: 0 });
    saveSeq++;
    if (r.kind === "saved") set({ room, version: r.version, updatedAt: r.updatedAt });
    else set({ room: normalizeRoom(r.room) ?? room, version: r.version });
    scheduleFollowUps();
  } catch {
    /* the next poll tries again */
  } finally {
    seeding = false;
  }
}

async function refresh(force = false): Promise<void> {
  const seq = saveSeq;
  try {
    const s = await api.getState();
    applyServer(s, seq, force);
  } catch (e) {
    set({
      offlineSince: state.offlineSince ?? new Date().toISOString(),
      loadError: state.loaded ? null : errorText(e),
    });
  }
}

/** The server answered 401 somewhere: this browser may not edit. Any local edit is dropped and the room
    is read again. Said once, and not at all when the page already knew it was view-only. */
function handleLocked(): void {
  const surprise = state.access.canEdit || dirty || inFlight;
  dirty = false;
  clearTimeout(retryTimer);
  if (state.saveState !== "idle") set({ saveState: "idle" });
  if (!surprise || Date.now() - lockNoticeAt < 3000) return;
  lockNoticeAt = Date.now();
  toast(LOCKED_TEXT);
  void refresh(true);
}
setLockedHandler(handleLocked);

function scheduleFollowUps(): void {
  followUps.forEach(clearTimeout);
  followUps = FOLLOW_UP_MS.map((ms) => setTimeout(() => void refresh(), ms));
}

async function flush(): Promise<void> {
  if (inFlight) return;
  clearTimeout(retryTimer);
  inFlight = true;
  let rebased = false;
  try {
    while (dirty && state.room) {
      dirty = false;
      if (state.saveState === "idle") set({ saveState: "saving" });
      try {
        const r = await api.saveRoom({ room: state.room, baseVersion: state.version });
        saveSeq++;
        if (r.kind === "saved") {
          set({ version: r.version, updatedAt: r.updatedAt, saveState: dirty ? "saving" : "idle" });
        } else {
          const theirs = normalizeRoom(r.room);
          if (theirs) {
            dirty = false;
            set({ room: theirs, version: r.version, saveState: "idle" });
            toast("The room was changed on another device, so your last edit was not saved. You are now looking at the latest version.");
          } else if (!rebased) {
            // The server holds no usable room (its data was reset): ours stands, saved again on its version.
            rebased = true;
            dirty = true;
            set({ version: r.version });
          } else {
            dirty = false;
            set({ saveState: "idle" });
            toast("The server did not accept that change. Reload the page to see what it holds.");
          }
        }
      } catch (e) {
        if (isLocked(e)) {
          // Not a network failure: handleLocked has dropped the edit and is reading the room again.
          saveSeq++;
          dirty = false;
          set({ saveState: "idle" });
          return;
        }
        if (isTransient(e)) {
          dirty = true;
          set({ saveState: "retrying" });
          retryTimer = setTimeout(() => void flush(), RETRY_MS);
          return;
        }
        saveSeq++;
        dirty = false;
        set({ saveState: "idle" });
        toast(`The server did not accept that change: ${errorText(e)}`);
        void refresh(true);
        return;
      }
    }
  } finally {
    inFlight = false;
  }
  scheduleFollowUps();
}

export const store = {
  getState: (): StoreState => state,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /** Loads the room and starts polling. Call again to change the interval. */
  start(pollMs: number): void {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => void refresh(), pollMs);
    if (!state.loaded) void refresh();
  },
  stop(): void {
    clearInterval(pollTimer);
  },
  refresh: (): Promise<void> => refresh(),
  /** Refetch now and again shortly after: Jira results arrive a few seconds behind a change. */
  refreshSoon(): void {
    void refresh();
    scheduleFollowUps();
  },

  /** Applies an edit locally at once and saves it. Any edit ends "example data" unless keepExample is set. */
  commit(mutate: (room: Room) => void, opts?: { keepExample?: boolean }): void {
    if (!state.room || !state.access.canEdit) return;
    const draft = structuredClone(state.room);
    mutate(draft);
    if (!opts?.keepExample) draft.example = false;
    dirty = true;
    set({ room: draft });
    void flush();
  },

  /** Swaps in a whole room (template or imported backup) and saves it. */
  replaceRoom(room: Room): void {
    if (!state.access.canEdit) return;
    dirty = true;
    set({ room });
    void flush();
  },

  /** Unlocks editing in this browser. Returns the reason when the server says no. */
  async unlock(passcode: string): Promise<string | void> {
    try {
      set({ access: accessOf(await api.unlock({ passcode })) });
    } catch (e) {
      return errorText(e);
    }
    await refresh(true);
  },

  /** Puts this browser back to view-only. */
  async lock(): Promise<void> {
    try {
      set({ access: accessOf(await api.lock()) });
    } catch (e) {
      toast(errorText(e));
    }
    await refresh(true);
  },

  /** Sets, changes (both given) or removes (next "") the edit passcode. Returns the reason when it fails. */
  async setPasscode(current: string, next: string): Promise<string | void> {
    try {
      set({ access: accessOf(await api.setPasscode({ current, next })) });
    } catch (e) {
      return errorText(e);
    }
  },

  dialogOpened(): void {
    dialogs++;
  },
  dialogClosed(): void {
    dialogs = Math.max(0, dialogs - 1);
  },

  toast,
  dismissToast(): void {
    clearTimeout(toastTimer);
    set({ toast: null });
  },
};

export function useStore(): StoreState {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** The live Jira data in the shape the status and progress rules take. */
export function liveOf(s: StoreState): LiveData {
  return { progress: s.progress, auto: s.auto, boards: s.boards, metrics: s.metrics, burnups: s.burnups, periods: s.periods, jiraConfigured: s.sync.jiraConfigured };
}
