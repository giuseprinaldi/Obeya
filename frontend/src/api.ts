/* HTTP client for the Obeya API. Same origin; every error body is {error}. */
import type {
  Access,
  AutoResult,
  BoardResult,
  DepsResult,
  Diagnostics,
  JiraBoard,
  JiraField,
  JiraStatus,
  MetricResult,
  PasscodeRequest,
  PreviewRequest,
  ProgressResult,
  RoomHistory,
  RoomVersion,
  SaveRoomConflict,
  SaveRoomRequest,
  SaveRoomResponse,
  ServerState,
  Settings,
  SyncResponse,
  UnlockRequest,
} from "./types";

/** A response the server sent with a non-2xx status. Network failures throw a plain TypeError instead. */
export class ApiFailure extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.body = body;
  }
}

/** True for failures worth retrying: no connection, or the server itself failing. */
export function isTransient(e: unknown): boolean {
  return !(e instanceof ApiFailure) || e.status >= 500;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiFailure) return e.message;
  return "The Obeya server cannot be reached.";
}

/** True when the server said this browser may not edit (401). */
export const isLocked = (e: unknown): boolean => e instanceof ApiFailure && e.status === 401;

let onLocked: (() => void) | null = null;
/** The store registers here to hear about every 401, whichever call it came from. */
export function setLockedHandler(fn: () => void): void {
  onLocked = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // The server only accepts JSON on PUT and POST, so every one of them sends a JSON body, even when it is empty.
  const sends = method !== "GET";
  const res = await fetch(path, {
    method,
    headers: sends ? { Accept: "application/json", "Content-Type": "application/json" } : { Accept: "application/json" },
    body: sends ? JSON.stringify(body ?? {}) : undefined,
    cache: "no-store",
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && "error" in data && typeof (data as { error: unknown }).error === "string"
        ? (data as { error: string }).error
        : `The server answered ${res.status}.`;
    if (res.status === 401) onLocked?.();
    throw new ApiFailure(res.status, msg, data);
  }
  return data as T;
}

/** On a conflict the server sends back its own room, which is null if it holds none. */
export type SaveOutcome = { kind: "saved"; version: number; updatedAt: string } | { kind: "conflict"; version: number; room: unknown };

/** The answer to a preview: which one depends on what was asked. */
export type PreviewResult = ProgressResult | AutoResult | BoardResult | MetricResult | DepsResult;

export const api = {
  getState: (): Promise<ServerState> => request<ServerState>("GET", "/api/state"),

  async saveRoom(req: SaveRoomRequest): Promise<SaveOutcome> {
    try {
      const r = await request<SaveRoomResponse>("PUT", "/api/room", req);
      return { kind: "saved", version: r.version, updatedAt: r.updatedAt };
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 409 && typeof e.body === "object" && e.body !== null && "room" in e.body) {
        const c = e.body as SaveRoomConflict;
        return { kind: "conflict", version: c.version, room: c.room };
      }
      throw e;
    }
  },

  /** The saved versions the server still keeps, newest first. */
  roomHistory: (): Promise<RoomHistory> => request<RoomHistory>("GET", "/api/room/history"),
  /** One saved version, to restore it. 404 when it is no longer kept. */
  roomVersion: (version: number): Promise<RoomVersion> => request<RoomVersion>("GET", `/api/room/history?version=${encodeURIComponent(version)}`),

  getSettings: (): Promise<Settings> => request<Settings>("GET", "/api/settings"),
  saveSettings: (s: Settings): Promise<Settings> => request<Settings>("PUT", "/api/settings", s),
  jiraStatus: (): Promise<JiraStatus> => request<JiraStatus>("GET", "/api/jira/status"),
  jiraFields: (): Promise<JiraField[]> => request<JiraField[]>("GET", "/api/jira/fields"),
  jiraBoards: (): Promise<JiraBoard[]> => request<JiraBoard[]>("GET", "/api/jira/boards"),
  piValues: (): Promise<string[]> => request<string[]>("GET", "/api/jira/pi-values"),
  preview: (req: PreviewRequest): Promise<PreviewResult> => request<PreviewResult>("POST", "/api/jira/preview", req),
  sync: (): Promise<SyncResponse> => request<SyncResponse>("POST", "/api/sync"),

  /** 403 = wrong passcode, 429 = too many attempts; both carry the text to show. */
  unlock: (req: UnlockRequest): Promise<Access> => request<Access>("POST", "/api/unlock", req),
  lock: (): Promise<Access> => request<Access>("POST", "/api/lock"),
  setPasscode: (req: PasscodeRequest): Promise<Access> => request<Access>("PUT", "/api/passcode", req),
  /** Runs the Jira connection checks. Can take several seconds. */
  diagnostics: (): Promise<Diagnostics> => request<Diagnostics>("GET", "/api/jira/diagnostics"),
};
