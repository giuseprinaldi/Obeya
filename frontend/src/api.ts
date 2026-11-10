/* HTTP client for the Obeya API. Same origin; every error body is {error}. */
import type {
  AutoResult,
  JiraBoard,
  JiraField,
  JiraStatus,
  PreviewRequest,
  ProgressResult,
  SaveRoomConflict,
  SaveRoomRequest,
  SaveRoomResponse,
  ServerState,
  Settings,
  SyncResponse,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
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
    throw new ApiFailure(res.status, msg, data);
  }
  return data as T;
}

/** On a conflict the server sends back its own room, which is null if it holds none. */
export type SaveOutcome = { kind: "saved"; version: number; updatedAt: string } | { kind: "conflict"; version: number; room: unknown };

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

  getSettings: (): Promise<Settings> => request<Settings>("GET", "/api/settings"),
  saveSettings: (s: Settings): Promise<Settings> => request<Settings>("PUT", "/api/settings", s),
  jiraStatus: (): Promise<JiraStatus> => request<JiraStatus>("GET", "/api/jira/status"),
  jiraFields: (): Promise<JiraField[]> => request<JiraField[]>("GET", "/api/jira/fields"),
  jiraBoards: (): Promise<JiraBoard[]> => request<JiraBoard[]>("GET", "/api/jira/boards"),
  piValues: (): Promise<string[]> => request<string[]>("GET", "/api/jira/pi-values"),
  preview: (req: PreviewRequest): Promise<ProgressResult | AutoResult> => request<ProgressResult | AutoResult>("POST", "/api/jira/preview", req),
  sync: (): Promise<SyncResponse> => request<SyncResponse>("POST", "/api/sync"),
};
