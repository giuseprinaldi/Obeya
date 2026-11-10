// Dev-only stand-in for the Python API, so the UI can be exercised without the backend.
// Not part of the build. Usage: node dev/mock-server.mjs [port] [locked]   (default port 8799)
// Edit lock: start with the word "locked" as an argument, or OBEYA_LOCKED=1, and the room needs the
// passcode "obeya-test" before it can be edited. Without it the room is open until a passcode is set
// in Customize. Five wrong passcodes in a row answer 429 for 30 seconds.
// Then: OBEYA_API=http://localhost:8799 npm run dev
// State lives in memory. Jira answers are invented from the issue key.
// Invented on purpose, so every state can be seen: board 1 has a blocked card, a column over its WIP limit and a
// column with "+N more"; a cycle_time KPI has nothing to measure; an unplanned KPI fails; board 404 fails.
import { createServer } from "node:http";

const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a))) || 8799;
let passcode = args.includes("locked") || process.env.OBEYA_LOCKED === "1" ? "obeya-test" : "";
const sessions = new Set();
let wrong = 0, blockedUntil = 0;
const COOKIE = "obeya_mock_edit";
const OPEN_WHEN_LOCKED = new Set(["GET /api/state", "GET /api/health", "POST /api/unlock", "POST /api/lock"]);
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => iso(new Date(Date.now() + n * 86400000));

let room = null, version = 0, updatedAt = null;
let settings = {
  jira: { piField: "customfield_10500", storyPointsField: "", boardId: 1, showSummaries: true, showAssignees: true, blocked: { flagged: true, statuses: [], labels: [], links: false } },
  pis: [{ name: "PI 26.4", start: day(-36), end: day(33) }],
};
const TITLES = ["Feature proposal pipeline", "Data platform modernization", "Sign-in and access", "Audit trail", "Review workflow", "Template library"];

function hash(s) {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function fake(key, measure, title) {
  if (/-404$/.test(key)) return { ok: false, error: `${key} was not found in Jira.`, unit: "issues", total: 0, done: 0, inProgress: 0, todo: 0, issues: 0, unestimated: 0, byStatus: {}, history: [], fetchedAt: new Date().toISOString() };
  const h = hash(key);
  const issues = 12 + (h % 30);
  const scale = measure === "points" ? 3 : 1;
  const total = issues * scale;
  const done = Math.round(total * (((h >>> 3) % 90) / 100));
  const inProgress = Math.min(total - done, Math.round(total * 0.12));
  return {
    ok: true, key, title: title ?? TITLES[h % TITLES.length], url: `https://jira.example/browse/${key}`, issueType: "Epic", status: "In Progress",
    unit: measure === "points" ? "points" : "issues", total, done, inProgress, todo: total - done - inProgress, issues,
    unestimated: measure === "points" ? h % 4 : 0, byStatus: {}, history: [], fetchedAt: new Date().toISOString(),
  };
}

const forSource = (s) => (s.kind === "issue" ? fake(s.key, s.measure) : { ...fake("JQL-" + hash(s.jql), s.measure), key: undefined, title: undefined, url: undefined, issueType: undefined, status: undefined });
const forAuto = (a) => {
  if (/syntax error/i.test(a.jql)) return { ok: false, error: "Jira rejected the query: syntax error.", bars: [], truncated: false, fetchedAt: new Date().toISOString() };
  const n = Math.min(a.limit, 6);
  return { ok: true, bars: Array.from({ length: n }, (_, i) => fake(`PLAT-${10 + i}`, a.measure, TITLES[i % TITLES.length])), truncated: a.limit < 6, fetchedAt: new Date().toISOString() };
};

const BOARDS = [{ id: 1, name: "Platform board", type: "scrum" }, { id: 2, name: "Data kanban", type: "kanban" }];
const PEOPLE = ["Priya", "Marcus", "Dana", "Joe", "Tom", ""];
const WORK = ["Proposal upload form", "Review result view", "Template reformatter", "AI review prompt v2", "Proposal schema", "Sign-in spike", "Audit log", "Upload error states", "Approval gate UI", "Jira epic preview", "Repo scaffold", "CI pipeline", "Retry queue", "Access review"];

function card(n, over = {}) {
  const key = `PLAT-${100 + n}`;
  return {
    key, title: settings.jira.showSummaries ? WORK[n % WORK.length] : key, url: `https://jira.example/browse/${key}`, type: n % 5 === 0 ? "Bug" : "Story",
    assignee: settings.jira.showAssignees ? PEOPLE[n % PEOPLE.length] : "", status: "", points: n % 4 === 3 ? null : [1, 2, 3, 5, 8][n % 5],
    blocked: false, blockedReason: "", ageDays: n % 7, ...over,
  };
}

function forBoard(b) {
  const fetchedAt = new Date().toISOString();
  const board = BOARDS.find((x) => x.id === b.boardId);
  if (!board) return { ok: false, error: `Board ${b.boardId} was not found in Jira.`, boardName: "", boardType: "", sprint: null, columns: [], blocked: 0, total: 0, fetchedAt };
  if (/syntax error/i.test(b.jql)) return { ok: false, error: "Jira rejected the extra filter: syntax error.", boardName: board.name, boardType: board.type, sprint: null, columns: [], blocked: 0, total: 0, fetchedAt };
  const cards = (from, n, over) => Array.from({ length: n }, (_, i) => card(from + i, over?.(i) ?? {}));
  const all = [
    { name: "Backlog", wip: 0, total: 22, cards: cards(0, 12) },
    { name: "To do", wip: 0, total: 4, cards: cards(20, 4) },
    { name: "In progress", wip: 3, total: 5, cards: cards(30, 5, (i) => (i === 1 ? { blocked: true, blockedReason: "Flagged", ageDays: 9 } : i === 3 ? { blocked: true, blockedReason: "Blocked by PLAT-9", ageDays: 4 } : {})) },
    { name: "Review", wip: 2, total: 2, cards: cards(40, 2, () => ({ ageDays: null })) },
    { name: "Done", wip: 0, total: b.doneDays ? 14 : 40, cards: cards(50, 12) },
  ];
  const hidden = new Set(b.hiddenColumns.map((n) => n.toLowerCase()));
  const columns = all.filter((c) => !hidden.has(c.name.toLowerCase()));
  const sprint = board.type === "scrum" && b.sprint === "active" ? { name: "Sprint 14", start: day(-8), end: day(5) } : null;
  return { ok: true, boardName: board.name, boardType: board.type, sprint, columns, blocked: columns.some((c) => c.name === "In progress") ? 2 : 0, total: columns.reduce((n, c) => n + c.total, 0), fetchedAt };
}

function forMetric(m) {
  const fetchedAt = new Date().toISOString();
  const fail = (error) => ({ ok: false, error, value: null, unit: "", n: 0, detail: "", history: [], fetchedAt });
  if (m.boardId !== null && !BOARDS.some((b) => b.id === m.boardId)) return fail(`Board ${m.boardId} was not found in Jira.`);
  if (/syntax error/i.test(m.jql)) return fail("Jira rejected the query: syntax error.");
  if (m.kind === "unplanned" && m.unplanned.rule === "added_after_start") return fail("The board's sprint report could not be read, so work added after the start is unknown.");
  if (m.kind === "cycle_time") return { ok: true, value: null, unit: "days", n: 0, detail: `No work was finished in the last ${m.windowDays} days`, history: [], fetchedAt };
  const series = { lead_time: [12, 11, 9.5, 9, 8, 6.5], throughput: [3, 4, 4, 5, 6, 7], blocked_days: [0, 1, 1, 2, 3, 3], scope_done: [8, 20, 31, 44, 52, 61], wip: [4, 5, 7, 6, 5, 5], blocked_now: [0, 1, 1, 2, 2, 2], unplanned: [5, 8, 9, 12, 12, 13] }[m.kind];
  const unit = { lead_time: "days", throughput: "/ week", blocked_days: "days", scope_done: "%", wip: m.measure === "points" ? "pts" : "items", blocked_now: "items", unplanned: "%" }[m.kind];
  const detail = { lead_time: `${m.stat} of 23 items finished in the last ${m.windowDays} days`, throughput: `23 items finished in the last ${m.windowDays} days`, blocked_days: `3 items were blocked in the last ${m.windowDays} days`, scope_done: "37 of 61 points done", wip: "5 items in progress", blocked_now: "2 of 18 open items are blocked", unplanned: "4 of 31 items are unplanned" }[m.kind];
  return { ok: true, value: series.at(-1), unit, n: 23, detail, history: series.map((value, i) => ({ d: day((i - series.length + 1) * 7), value })), fetchedAt };
}

function state() {
  const progress = {}, auto = {}, boards = {}, metrics = {};
  for (const w of room?.walls ?? []) {
    for (const p of w.panels) {
      if (p.type === "portfolio") for (const it of p.data.items) if (it.source) progress[it.id] = forSource(it.source);
      if (p.type === "kpi") for (const it of p.data.items) if (it.metric) metrics[it.id] = forMetric(it.metric);
      if (p.type === "kanban" && p.data.jira) boards[p.id] = forBoard(p.data.jira);
      if (p.type === "progress") {
        for (const it of p.data.items) if (it.source.kind !== "manual") progress[it.id] = forSource(it.source);
        if (p.data.auto) auto[p.id] = forAuto(p.data.auto);
      }
    }
  }
  const today = iso(new Date());
  const pis = settings.pis.slice().sort((a, b) => a.start.localeCompare(b.start));
  const pi = pis.find((p) => p.start <= today && today <= p.end) ?? pis.filter((p) => p.start <= today).pop() ?? null;
  return {
    room, version, updatedAt, progress, auto, boards, metrics,
    periods: { today, pi, nextPi: pi ? (pis.find((p) => p.start > pi.end) ?? null) : null, sprint: settings.jira.boardId ? { name: "Sprint 14", start: day(-8), end: day(5) } : null },
    sync: { jiraConfigured: true, running: false, lastRunAt: new Date().toISOString(), lastOk: true, lastError: null, intervalSeconds: 300 },
  };
}

const sessionOf = (req) => (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === COOKIE)?.[1] ?? "";
const unlocked = (req) => sessions.has(sessionOf(req));
const accessFor = (canEdit) => ({ locked: passcode !== "", canEdit: passcode === "" || canEdit, passcodeSet: passcode !== "", user: null });

// One check of each kind, so every row style can be seen.
const diagnostics = () => ({
  ok: false,
  ranAt: new Date().toISOString(),
  checks: [
    { id: "reach", label: "Jira can be reached", status: "pass", detail: "https://jira.example answered in 180 ms.", fix: "" },
    { id: "token", label: "Token accepted", status: "pass", detail: "Signed in as svc-obeya.", fix: "" },
    { id: "version", label: "Jira version", status: "warn", detail: "Jira Server 8.5 is older than the versions this was tested on.", fix: "It should still work. Tell whoever looks after Jira if boards come back empty." },
    { id: "pi-field", label: "PI field", status: "fail", detail: "The field customfield_10500 does not exist in this Jira.", fix: "Pick the PI field again in the Fields section below." },
    { id: "pi-values", label: "PI field has values", status: "skip", detail: "Not run because the PI field check failed.", fix: "" },
  ],
});

const read = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b ? JSON.parse(b) : null)); });

createServer(async (req, res) => {
  const send = (code, body, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const route = `${req.method} ${req.url.split("?")[0]}`;
  try {
    // The real server only takes JSON on PUT and POST, and answers 401 to everything but these four while locked.
    if (req.method !== "GET" && !/^application\/json\b/.test(req.headers["content-type"] ?? "")) return send(415, { error: "Send JSON: Content-Type must be application/json." });
    const canEdit = passcode === "" || unlocked(req);
    if (!canEdit && !OPEN_WHEN_LOCKED.has(route)) return send(401, { error: "Editing is locked." });
    switch (route) {
      case "GET /api/state": return send(200, { ...state(), access: accessFor(canEdit) });
      case "GET /api/health": return send(200, { ok: true });
      case "POST /api/unlock": {
        const body = await read(req);
        if (Date.now() < blockedUntil) return send(429, { error: "Too many wrong passcodes. Wait half a minute and try again." });
        if (passcode !== "" && body?.passcode !== passcode) {
          if (++wrong >= 5) { wrong = 0; blockedUntil = Date.now() + 30000; }
          return send(403, { error: "That passcode is not right." });
        }
        wrong = 0;
        const id = Math.random().toString(36).slice(2);
        sessions.add(id);
        return send(200, accessFor(true), { "Set-Cookie": `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      case "POST /api/lock":
        sessions.delete(sessionOf(req));
        return send(200, accessFor(false), { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      case "PUT /api/passcode": {
        const body = await read(req);
        if ((body?.current ?? "") !== passcode) return send(403, { error: "The current passcode is not right." });
        const next = String(body?.next ?? "");
        if (next !== "" && next.length < 6) return send(400, { error: "A passcode needs at least 6 characters." });
        passcode = next;
        if (next === "") { sessions.clear(); return send(200, accessFor(true)); }
        // Whoever set the passcode stays unlocked; everyone else has to unlock.
        const id = Math.random().toString(36).slice(2);
        sessions.clear();
        sessions.add(id);
        return send(200, accessFor(true), { "Set-Cookie": `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax` });
      }
      case "GET /api/jira/diagnostics":
        await new Promise((ok) => setTimeout(ok, 1200));
        return send(200, diagnostics());
      case "PUT /api/room": {
        const body = await read(req);
        if (body.baseVersion !== version) return send(409, { error: "conflict", version, room });
        room = body.room; version++; updatedAt = new Date().toISOString();
        return send(200, { version, updatedAt });
      }
      case "GET /api/settings": return send(200, settings);
      case "PUT /api/settings": settings = await read(req); return send(200, settings);
      case "GET /api/jira/status": return send(200, { configured: true, ok: true, baseUrl: "https://jira.example", deployment: "Server", version: "9.12.4", error: null });
      case "GET /api/jira/fields": return send(200, [
        { id: "customfield_10500", name: "Program Increment", custom: true }, { id: "customfield_10106", name: "Story Points", custom: true },
        { id: "customfield_10101", name: "Epic Link", custom: true }, { id: "customfield_10104", name: "Sprint", custom: true }, { id: "summary", name: "Summary", custom: false },
      ]);
      case "GET /api/jira/boards": return send(200, BOARDS);
      case "GET /api/jira/pi-values": return send(200, ["PI 26.3", "PI 26.4", "PI 26.5"]);
      case "POST /api/jira/preview": {
        const body = await read(req);
        return send(200, body.board ? forBoard(body.board) : body.metric ? forMetric(body.metric) : body.auto ? forAuto(body.auto) : forSource(body.source));
      }
      case "POST /api/sync": return send(200, { ok: true, error: null, sources: 9, durationMs: 840 });
      default: return send(404, { error: "Not found" });
    }
  } catch (e) {
    send(500, { error: String(e) });
  }
}).listen(port, () => console.log(`Mock Obeya API on http://localhost:${port}${passcode ? ' (locked, passcode "obeya-test")' : ""}`));
