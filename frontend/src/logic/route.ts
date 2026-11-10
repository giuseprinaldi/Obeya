/* Addresses: which view a URL hash asks for, and which wall a numbered screen shows. */

export type Route =
  | { view: "overview" }
  | { view: "wall"; id: string }
  /** Display mode pinned to one wall, wherever it sits in the room. */
  | { view: "tv"; id: string }
  /** Display mode for whichever wall is at position n (1-based) right now. */
  | { view: "screen"; n: number };

export function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, "");
  const screen = /^screen-(\d{1,4})$/.exec(h);
  if (screen) {
    const n = Number(screen[1]);
    return n >= 1 ? { view: "screen", n } : { view: "overview" };
  }
  if (h.startsWith("tv-") && h.length > 3) return { view: "tv", id: h.slice(3) };
  if (h.startsWith("wall-") && h.length > 5) return { view: "wall", id: h.slice(5) };
  return { view: "overview" };
}

export const isDisplay = (r: Route): boolean => r.view === "tv" || r.view === "screen";

/** Index of the wall that screen n shows after `step` rotations, among `count` walls. Rotation starts at the
    screen's own wall and cycles through all of them. Null when nothing is assigned to screen n. */
export function screenWallIndex(n: number, step: number, count: number): number | null {
  if (!Number.isInteger(n) || !Number.isInteger(count) || count < 1 || n < 1 || n > count) return null;
  const k = Number.isInteger(step) && step > 0 ? step : 0;
  return (n - 1 + k) % count;
}

/** The wall screen n shows after `step` rotations, or null. */
export function screenWall<W>(walls: readonly W[], n: number, step = 0): W | null {
  const i = screenWallIndex(n, step, walls.length);
  return i === null ? null : (walls[i] ?? null);
}

/** The screen an arrow key moves to from screen n: one along, wrapping around the room. */
export function neighbourScreen(n: number, dir: 1 | -1, count: number): number {
  if (count < 1) return n;
  if (n < 1 || n > count) return dir === 1 ? 1 : count;
  return ((n - 1 + dir + count) % count) + 1;
}

/** The 1-based screen number of a wall, or 0 when the wall is not in the room. */
export function screenOf(walls: readonly { id: string }[], wallId: string): number {
  return walls.findIndex((w) => w.id === wallId) + 1;
}

export const screenHash = (n: number): string => `#screen-${n}`;

/** The address to open on a TV for screen n, e.g. "http://obeya.example/#screen-2". */
export function screenAddress(origin: string, pathname: string, n: number): string {
  return `${origin}${pathname || "/"}${screenHash(n)}`;
}
