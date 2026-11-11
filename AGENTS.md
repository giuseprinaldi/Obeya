# Instructions for coding agents

Obeya is a digital Obeya room: walls of panels shown on TVs, edited from a laptop, with progress bars, boards, KPIs, burn-up charts and dependencies read from Jira. This file is the brief for the next piece of work. `README.md` describes the product and `docs/architecture.md` is the technical reference; read both before changing anything.

## The task

**Get Obeya working against the real Jira.** Everything in this repository was built and tested against the fake Jira in `backend/fake_jira/`. Nothing has ever talked to a real one. The work is to connect it, find where the real Jira behaves differently from the fake, fix those places, and point the room at real projects.

Done means all of these:

1. `python -m obeya check` (run in `backend/`) reports no failures against the real Jira, and every warning is either fixed or explained in your report.
2. Every Jira-linked panel in the room shows real data: after a sync, no result in `GET /api/state` has `"ok": false`.
3. Each item under "What has never been checked" below is confirmed or fixed.
4. Both test suites still pass, and every fix has a test.
5. `docs/architecture.md` says what was confirmed against the real Jira (and its version) and what is still open.

## Rules

- **This repository is public.** Never commit the Jira address, the token, or anything read from the real Jira: issue keys, summaries, people's names, project names, field values, screenshots, logs. Tests and docs use the fake data only (`PLAT-1`, `DATA-1`). The token lives in `backend/.env`, which git ignores; check `git status` before every commit.
- **Jira is read-only.** The client sends GET requests and the search POST, nothing else. Do not add a call that writes to Jira.
- **The backend uses the Python standard library only.** Do not add packages. (`psycopg` is the one optional extra, for Postgres.)
- **Settings a person might change belong in the app, not in files.** Field ids, board ids, queries, thresholds and the PI calendar are set in the UI and stored in the database. Only secrets and deployment values go in the environment.
- **Every new or changed Jira call needs three things:** the fake Jira (`backend/fake_jira/`) answers it the way the real one does, a test covers it, and the connection check (`backend/obeya/diagnostics.py`) reports on it if a Jira could lack it.
- **When the real Jira differs from the fake, fix the fake first.** Make the fake return the real shape (with made-up data), watch a test fail, then fix the code. Do not special-case around the fake.
- **Keep `docs/architecture.md` current** in the same commit as the change it describes.
- **Work on a branch,** one commit per fix, and say in the commit message what the real Jira did that the code did not expect. Do not rewrite history on `main`.
- **Do not invent room content.** Statements, risks, problems, actions and hand-typed KPIs are for the team to enter. Your job is the Jira links.

## What you need from a person first

Ask for these before starting, and stop if you cannot get the first two:

- The Jira base URL, and whether it is Data Center or Cloud.
- A token for a **read-only** service account that can browse the projects and view the boards to be shown. Data Center: a personal access token. Cloud: an API token and the account's email.
- A CA bundle file if Jira uses an internal certificate authority, and proxy settings if the server reaches Jira through one.
- Which projects and boards go on the walls, and which board's sprint sets the sprint pace.
- The name of the custom field that holds the PI (program increment), and the PI calendar: each PI's name exactly as Jira spells it, with start and end dates.
- How the teams mark work as blocked (the flag, a status, a label, an "is blocked by" link) and which link types they use for dependencies.

## Steps

### 1. Prove the checkout works, with the fake Jira

```
cd frontend
npm ci
npm run build
npm test
cd ../backend
python -m unittest discover -s tests -t .
python scripts/dev.py
```

Requirements are Python 3.10+ and Node 20+. Expect 165 frontend and 184 backend tests to pass. `scripts/dev.py` serves the app on http://127.0.0.1:8787 against the fake Jira on port 8790. Open it once so you know what a working room looks like, then stop it.

`scripts/dev.py` is for the demo only. It overrides the Jira address and token with the fake's and, on a new database, saves Jira settings that match the fake. **Do not use it for the real Jira, and do not reuse its database:** start step 2 with a fresh one (delete `backend/data/obeya.db*`, or set `DATABASE_URL` to another file).

### 2. Connect

Copy `backend/.env.example` to `backend/.env` and fill in:

```
JIRA_BASE_URL=https://jira.example.com
JIRA_TOKEN=...
JIRA_AUTH=bearer        # "basic" plus JIRA_EMAIL for Cloud
JIRA_CA_BUNDLE=         # path to a CA file, if needed
```

`HTTPS_PROXY` and `NO_PROXY` are honoured. Then, in `backend/`:

```
python -m obeya check
```

It runs fourteen checks in order and prints a fix beside each warning or failure. It exits 1 if anything failed. If Jira cannot be reached or rejects the token, the rest are skipped, so fix from the top. At this point the PI and board checks will warn that nothing is chosen yet; that is step 3.

| If this fails | Look at |
|---|---|
| Jira can be reached | `JIRA_BASE_URL`, TLS (`JIRA_CA_BUNDLE`), proxy. Code: `JiraClient._request` in `backend/obeya/jira_client.py`. |
| Token accepted | `JIRA_AUTH` (bearer or basic), the token itself. |
| Issues are visible | The service account's Browse Projects permission. |
| Anything else | The check's own code in `backend/obeya/diagnostics.py` shows the exact request it made. |

### 3. Start the server and enter the Jira settings

```
cd backend
python -m obeya
```

The settings are entered once, under **Jira** in the app, or through the API. To do it through the API:

- `GET /api/jira/fields` lists every field with its id. Find the PI field and the story points field.
- `GET /api/jira/boards` lists the boards with their ids.
- `GET /api/jira/pi-values` lists the values recently used in the PI field, once the PI field is saved. The calendar's PI names must match these exactly.
- `PUT /api/settings` saves them and starts a full sync:

```json
{
  "jira": {
    "piField": "customfield_NNNNN",
    "storyPointsField": "",
    "boardId": 123,
    "showSummaries": true,
    "showAssignees": true,
    "blocked": { "flagged": true, "statuses": [], "labels": [], "links": false }
  },
  "pis": [
    { "name": "PI name as in Jira", "start": "2026-10-01", "end": "2026-12-31" }
  ]
}
```

`storyPointsField` empty means "find it automatically". Every PUT and POST must be sent as JSON. Run `python -m obeya check` again afterwards: the PI field, PI calendar and board checks now have something to test.

### 4. Point the room at real work

The room is one JSON document. It does not exist until a browser opens the app for the first time, which creates the example room; a headless browser is enough. That room is linked to things that only exist in the fake Jira, so these need changing:

| Wall | Panel | In the room document | Example value to replace |
|---|---|---|---|
| Direction | Strategic portfolio | `data.items[].source.key` | `PLAT-1`, `DATA-1` |
| Performance | Delivery and flow (KPIs) | `data.items[].metric.jql` | `project = PLAT` |
| Performance | Sprint burn-up | `data.source.jql` | `sprint in openSprints()` |
| Delivery | Sprint health (KPIs) | `data.items[].metric.boardId` | `1` |
| Delivery | PI objectives, first bar | `data.items[].source.jql` | `sprint in openSprints()` |
| Delivery | Program flow (board) | `data.jira.boardId` | `1` |
| Dependencies & risks | Dependencies | `data.source.jql` | `project in (PLAT, DATA)` |

`sprint in openSprints()` is valid on a real Jira but matches every open sprint the account can see, so narrow it to the right projects. The queries that use `{PI_FIELD} = "{PI}"` (PI burn-up, and the auto-fill bars on PI objectives) need no change: the server fills them in from the settings and the calendar.

Two ways to change the links:

- **In the app:** open the wall, then the panel's or the item's settings. Each link has a **Check** button.
- **Through the API:** `GET /api/state` returns `room` and `version`. Edit the room and send it back with `PUT /api/room` as `{"room": ..., "baseVersion": <version>}`. A 409 means someone saved first; fetch again. The shapes are in `frontend/src/types.ts`, and the existing example links already have the right shape, so change values, not structure.

Test a link before saving it with `POST /api/jira/preview`. The body is one of `{"source": ...}`, `{"auto": ...}`, `{"board": ...}`, `{"metric": ...}` or `{"deps": ...}`, holding the same object the room would store. The answer is the computed result, with `ok` and, when it failed, `error`.

Then `POST /api/sync` (it waits for the sync to finish) and read `GET /api/state`. Results are in `progress`, `auto`, `boards`, `metrics`, `burnups` and `deps`, keyed by the id of the panel or item that owns the link. Every one must have `"ok": true`. Compare a few numbers by hand against Jira's own screens: an epic's story count, a board column's cards, a sprint's points.

### 5. Check what has never been checked

Each of these is an assumption taken from Jira Data Center's documentation. Confirm it on the real Jira, and if it is wrong, fix it by the rule above (fake first, then a test, then the code).

| Assumption | How to check | Code |
|---|---|---|
| The token can read the projects and boards involved. | Connection check; the board list is not empty. | `diagnostics.py` |
| Issues carry `statuscategorychangedate`. Without it cards show no age; nothing else breaks. | Check "Days in status on cards". | `Engine._card` in `sources.py` |
| `updated` moves only when someone really touches the issue. A nightly automation that edits every issue would keep any card from ever looking stale. | Look at `updated` on a few idle in-progress issues. | `Engine._card` in `sources.py` |
| The flag field is a custom field named "Flagged". | Check "Flagged field". | `discovered_fields` in `jira_client.py` |
| Epic Link and Parent Link values can be read. The code accepts a key, an id or an object, and falls back to one query per parent. | Check "Epic and initiative links"; compare an initiative's bar with Jira. | `Engine._descend` and `Engine._children_of` in `sources.py` |
| The PI field accepts `=` in a query. A text field needs `~`. | Check "PI field". | `periods.py` (`field_ref`), the queries in the room |
| Searches with `expand=changelog` return complete histories. Cycle time, lead time, throughput, blocked days and the replayed days of burn-up charts depend on it. | Check "Issue histories"; try a long-lived issue. | `JiraClient.search`, `flow.py` |
| The burn-up replay finishes in reasonable time on a real scope. It is one search with histories per chart for a query, and one per 40 issues for an issue link, run once per chart. | Add a PI burn-up and time the first sync; watch the server log. | `Engine.daily_history` in `sources.py`, `Syncer._backfill` in `sync.py` |
| Dependency link types are worded so the direction can be read ("is blocked by", "depends on"), and linked issues arrive with summary and status inside the link. | Check "Dependency links"; compare the dependencies panel with a few issues in Jira. If the wording is unusual, name the link types in the panel settings. | `deps.py` |
| Board columns, WIP limits, the kanban sub-filter and the active sprint come back in the documented shape. | Compare the Program flow panel with the board in Jira. | `board_config`, `board_issues`, `active_sprint` in `jira_client.py` |
| Rate limits. When Jira answers 429 (or 502, 503, 504) the client waits, for as long as `Retry-After` says up to 20 seconds, and tries twice more before giving up on that sync. | Watch the server log during a full sync. | `_request`, `_retry_after` in `jira_client.py` |
| Jira Cloud. The client switches to `/rest/api/3/search/jql` and the `parent` field when `serverInfo` says Cloud, but none of it has run. | Only if the real Jira is Cloud: expect more to fix here than anywhere else. | `jira_client.py`, `sources.py` |

The endpoints the server calls, for firewall or permission questions: `/rest/api/2/serverInfo`, `myself`, `field`, `status`, `issueLinkType`, `search` (POST), and `/rest/agile/1.0/board`, `board/{id}/configuration`, `board/{id}/issue`, `board/{id}/sprint`.

### 6. Report

Finish by updating the "Tested and not tested" section of `docs/architecture.md`: move what you confirmed out of the "Not tested against real Jira" list, name the Jira type and version it was confirmed on, and leave what is still open. Then write a short summary for Joe and Devin: what worked untouched, what you changed and why, what is still open, and anything a person has to decide.

## Deploying

`docs/architecture.md`, "Deploying on the VM", has the steps. In short: build the frontend, set the environment, run `python -m obeya` from `backend/` under the service manager with `OBEYA_HOST=0.0.0.0` behind a reverse proxy that provides https, set an edit passcode under **Customize**, and open `/#screen-1`, `/#screen-2` and so on on the TVs.

## Where things are

| Path | What it holds |
|---|---|
| `backend/obeya/jira_client.py` | Every HTTP call to Jira. Start here when a request or a response shape is wrong. |
| `backend/obeya/sources.py` | Turns a link (issue, query, board, metric, dependencies) into a result: the hierarchy walk, boards, burn-up replay. |
| `backend/obeya/flow.py` | Cycle time, lead time, throughput, blocked days, burn-up maths. No Jira calls. |
| `backend/obeya/deps.py` | Reads dependencies from issue links. |
| `backend/obeya/periods.py` | PI calendar and the `{PI}` variables in queries. |
| `backend/obeya/sync.py` | The sync thread: collects links from the room, computes them, stores results and daily snapshots. |
| `backend/obeya/diagnostics.py` | The connection check. |
| `backend/obeya/server.py` | The HTTP API. |
| `backend/obeya/config.py` | Environment variables. |
| `backend/fake_jira/` | The stand-in Jira used by the demo and the tests. |
| `backend/tests/` | Backend tests; they start the fake Jira and call it over real HTTP. |
| `frontend/src/types.ts` | The shape of the room, every link and every API answer. |
| `frontend/src/logic/` | Frontend logic and its tests. |

## Things that will waste your time if you do not know them

- Python changes need a server restart. Frontend changes need `npm run build` (the server serves `frontend/dist`), or run `npm run dev` in `frontend/` beside the server.
- The server reads `backend/.env` only when started from `backend/` as `python -m obeya`. Variables already set in the environment win over the file.
- A full sync runs every `OBEYA_SYNC_SECONDS` (300 by default). Look-back metrics are recomputed at most every 30 minutes; `POST /api/sync` and saving settings recompute them at once.
- A search stops at 2,000 issues. A link that matches more is too broad for a wall; narrow the query.
- The fake Jira builds its data around today's date. Late in the evening in the Americas, when the UTC date is already tomorrow, a date-sensitive test can fail without anything being wrong; run it again in the morning before changing code.
- If the edit passcode is set, the Jira endpoints answer 401 until the browser (or your HTTP client) has unlocked with `POST /api/unlock`. `python -m obeya reset-passcode` removes a forgotten passcode.
