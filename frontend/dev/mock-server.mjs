// Dev-only stand-in for the Python API, so the UI can be exercised without the backend.
// Not part of the build. Usage: node dev/mock-server.mjs [port]   (default 8799)
// Then: OBEYA_API=http://localhost:8799 npm run dev
// State lives in memory. Jira answers are invented from the issue key.
import { createServer } from "node:http";

const port = Number(process.argv[2]) || 8799;
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => iso(new Date(Date.now() + n * 86400000));

let room = null, version = 0, updatedAt = null;
let settings = {
  jira: { piField: "customfield_10500", storyPointsField: "", boardId: 7, showSummaries: true },
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

function state() {
  const progress = {}, auto = {};
  for (const w of room?.walls ?? []) {
    for (const p of w.panels) {
      if (p.type === "portfolio") for (const it of p.data.items) if (it.source) progress[it.id] = forSource(it.source);
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
    room, version, updatedAt, progress, auto,
    periods: { today, pi, nextPi: pi ? (pis.find((p) => p.start > pi.end) ?? null) : null, sprint: settings.jira.boardId ? { name: "Sprint 14", start: day(-8), end: day(5) } : null },
    sync: { jiraConfigured: true, running: false, lastRunAt: new Date().toISOString(), lastOk: true, lastError: null, intervalSeconds: 300 },
  };
}

const read = (req) => new Promise((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => ok(b ? JSON.parse(b) : null)); });

createServer(async (req, res) => {
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const route = `${req.method} ${req.url.split("?")[0]}`;
  try {
    switch (route) {
      case "GET /api/state": return send(200, state());
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
      case "GET /api/jira/boards": return send(200, [{ id: 7, name: "Platform board", type: "scrum" }, { id: 9, name: "Data kanban", type: "kanban" }]);
      case "GET /api/jira/pi-values": return send(200, ["PI 26.3", "PI 26.4", "PI 26.5"]);
      case "POST /api/jira/preview": {
        const body = await read(req);
        return send(200, body.auto ? forAuto(body.auto) : forSource(body.source));
      }
      case "POST /api/sync": return send(200, { ok: true, error: null, sources: 9, durationMs: 840 });
      default: return send(404, { error: "Not found" });
    }
  } catch (e) {
    send(500, { error: String(e) });
  }
}).listen(port, () => console.log(`Mock Obeya API on http://localhost:${port}`));
