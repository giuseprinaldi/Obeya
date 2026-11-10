# Architecture and handoff notes

This is the reference for wiring Obeya into the VM. It covers what runs where, the API, the data model, configuration, and what has and has not been tested.

## Components

```
Laptop (editor)  ─┐
TV 1 (#tv-...)   ─┼─ HTTP ─►  Obeya server (Python)  ──►  SQLite file (or Postgres)
TV 2 (#tv-...)   ─┘            │  serves the React build and /api
                               └─ sync thread ── read-only HTTPS ──►  Jira
```

- **Frontend** (`frontend/`): React 18, Vite, TypeScript. Built to `frontend/dist` and served by the Python server. No runtime requests to any other host; fonts are bundled.
- **Server** (`backend/obeya/`): Python standard library only. One process: the HTTP API, the static file server and the Jira sync thread.
- **Storage**: a SQLite file by default, or Postgres when `DATABASE_URL` is a `postgresql://` URL (this needs the `psycopg` driver). Seven small tables, created on start. Both are covered by the same tests.
- **Jira**: read by the sync thread only. Browsers never talk to Jira and never see the token.
- **Fake Jira** (`backend/fake_jira/`): a stand-in for Jira Data Center used for development and tests. Not needed on the VM.

## How Jira-linked progress works

1. In the editor, a bar is linked to a Jira issue (key or pasted URL), to a JQL query, or left manual. A progress panel can also have an auto-fill query: every issue it matches becomes a bar.
2. The link is saved inside the room document. Nothing about it lives in code or config files.
3. The sync thread reads the room, collects every distinct link, computes each one against Jira and writes the result to `progress_cache`. A full sync runs every `OBEYA_SYNC_SECONDS`; saving the room triggers a quick run for links that have no result yet.
4. `GET /api/state` returns the room together with the cached results, keyed by the id of the bar that owns each link. Screens poll it.

**What counts.** For a linked issue the server walks down the hierarchy: Parent Link (Advanced Roadmaps), Epic Link, and optionally sub-tasks; on Cloud, `parent`. Anything with children is replaced by its children, so an initiative is measured by the stories under its epics. Anything without children counts as itself, so an epic with no stories shows as one open item. A JQL bar measures exactly the issues the query matches.

**Done.** By default, Jira's "Done" status category. A bar can instead name the statuses that count as done. Progress is by issue count or by story points.

**Sprints and PIs.** Queries can use Jira's own `openSprints()`. For PIs, queries can use `{PI}`, `{NEXT_PI}`, `{PREV_PI}` and `{PI_FIELD}`; the server fills them in from the PI calendar and the PI field chosen in Jira settings. When the date passes into the next PI, every bar that uses `{PI}` follows without anyone editing it. Pace markers use the active sprint of the chosen board and the dates in the PI calendar.

**Jira outages.** If Jira is unreachable or rejects the token, the sync stops and keeps the last good numbers; the error shows in Jira settings. A broken link (unknown key, bad JQL) shows its error on that bar only.

## API

All JSON, same origin. Errors are `{"error": "..."}` with a non-2xx status. Types are in `frontend/src/types.ts`.

| Method and path | Purpose |
|---|---|
| `GET /api/state` | Room, version, Jira results (`progress`, `auto`), `periods`, `sync` status. Sends an ETag. |
| `PUT /api/room` | Body `{room, baseVersion}`. `200 {version, updatedAt}`, or `409 {error: "conflict", version, room}` if someone saved first. `baseVersion` 0 creates the room. |
| `GET /api/settings`, `PUT /api/settings` | PI field, story points field, board, summaries on or off, PI calendar. Saving triggers a full sync. |
| `POST /api/sync` | Run a full sync now and wait for it. |
| `GET /api/jira/status` | Whether Jira is configured and reachable with the token. |
| `GET /api/jira/fields`, `GET /api/jira/boards` | For the pickers in Jira settings. |
| `GET /api/jira/pi-values` | Distinct values recently used in the PI field, as name suggestions. |
| `POST /api/jira/preview` | Body `{source}` or `{auto}`. Computes a link without saving it ("Check link"). |
| `GET /api/health` | `{ok: true}` when the database answers. |

Anything else under `/` is served from `frontend/dist`, with `index.html` as the fallback.

## Data model

| Table | Contents |
|---|---|
| `room` | One row: the room document (JSON) and its version number. |
| `room_history` | The last 100 versions of the room, for recovery. |
| `settings` | One row: Jira field choices and the PI calendar. No secrets. |
| `progress_cache` | Latest result per distinct link. |
| `progress_history` | One snapshot per link per day (180 days kept). |
| `kv` | Small cached values; currently the active sprint. |
| `sync_run` | Outcome of each sync (last 500). |

The schema is `backend/obeya/schema_sqlite.sql` (SQLite) and `backend/obeya/schema.sql` (Postgres). Both are idempotent and applied on every start.

**Choosing between them.** SQLite is enough for this workload: one small document, one writer and a few screens reading. It needs nothing installed, and a backup is a copy of `backend/data/obeya.db` taken while the server is stopped. Choose Postgres if the VM already has managed backups and monitoring for it, or if more than one server process will ever run. There is no migration tool between the two; move a room across with the JSON backup in Customize, and re-enter the Jira settings.

## Configuration

Environment variables, or `backend/.env` (see `backend/.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `OBEYA_HOST`, `OBEYA_PORT` | `127.0.0.1`, `8787` | Use `0.0.0.0` on the VM behind the proxy. |
| `DATABASE_URL` | SQLite file `backend/data/obeya.db` | A file path, `sqlite:///path`, or a `postgresql://` URL. |
| `OBEYA_STATIC_DIR` | `frontend/dist` | Where the built frontend lives. |
| `OBEYA_SYNC_SECONDS` | `300` | Minimum 30. |
| `JIRA_BASE_URL`, `JIRA_TOKEN` | empty | Both empty = run without Jira. |
| `JIRA_AUTH` | `bearer` | `bearer` for a Data Center personal access token; `basic` with `JIRA_EMAIL` for Cloud. |
| `JIRA_CA_BUNDLE` | empty | CA file for an internal certificate authority. |
| `HTTPS_PROXY`, `NO_PROXY` | | Standard variables; honoured for the Jira calls. |

## Deploying on the VM

1. `cd frontend && npm ci && npm run build`
2. Nothing to install for the backend, unless Postgres is used (`pip install "psycopg[binary]"`).
3. Set the environment (Jira URL and a read-only token; `DATABASE_URL` only to move the SQLite file or use Postgres) and run `python -m obeya` from `backend/` under the service manager. Make sure the service account can write to the data directory.
4. Open the app, go to **Jira**, and pick the PI field, the board and enter the PI calendar. This replaces the planned `config/boards.yaml`: it is done once in the UI and can be changed there later.

## Security notes

- **No sign-in.** Anyone who can reach the port can edit the room. Put it behind the reverse proxy or SSO used for the other internal tools, or restrict it to the room's network.
- **Read-only Jira.** The client only sends GET requests and the search POST. Use a read-only service account anyway.
- **Token handling.** The token is read from the environment, sent only to `JIRA_BASE_URL`, never stored in the database and never sent to a browser. Redirects to another host are refused.
- **Summaries.** "Show Jira summaries on screens" can be switched off in Jira settings; bars then show keys or the labels typed in Obeya, and summaries never leave the server.
- **Dependencies.** Backend: none with SQLite; `psycopg` with Postgres. Frontend runtime: `react`, `react-dom` and three font packages.

## Tested and not tested

- **Tested:** 74 backend tests (`python -m unittest discover -s tests -t .` in `backend/`), covering the PI calendar, JQL variables, progress maths, the Jira client and hierarchy walk over real HTTP against the fake Jira, and the API against a real SQLite database. Setting `OBEYA_TEST_DATABASE_URL` to a `postgresql://` URL runs the API tests a second time on Postgres (93 tests in total).
- **Frontend:** 41 unit tests on the status, pace, link-parsing and calendar logic (`npm test` in `frontend/`). The built app was also run in Chrome against this server and the fake Jira: first-run seeding, linking a bar from a pasted Jira URL, Check link (good and bad keys), auto-fill bars, Jira settings, display mode at 1366x768, 1920x1080 and 3840x2160, arrow keys and Escape, and the "changed on another device" conflict path.
- **Frontend, not tested:** Firefox and Safari (the bar layout uses CSS subgrid, `:has()` and container queries, so use a current browser on the TVs), the wall rotation timer over a long run, and the copy-to-clipboard button.
- **Display mode has a density limit.** A wall is scaled to fit the screen, and text shrinks as a wall gets denser, down to a floor. Past that floor panels are cut off at the bottom rather than scrolled. The example Delivery wall (four panels, nine bars, a five-column board) fits a 16:9 screen; much more than that should be split across two walls.
- **Not tested against real Jira.** The fake follows Data Center's documented shapes, but these need checking on the VM:
  - that the service token can read the projects involved;
  - how this instance returns the Parent Link field (the code handles a key, an id or an object, and falls back to one query per parent if it cannot read it);
  - that the PI field accepts `cf[NNNNN] = "name"` (a text field would need `~` in the query instead of `=`).
- **Jira Cloud is untested.** The client switches to Cloud's search endpoint and `parent` hierarchy when `serverInfo` reports Cloud, but nothing has exercised it.

## Not built yet

- Flow boards and flow KPIs fed from Jira (cycle time, throughput, blocked days). The discovery items in `jira-integration.md` about "blocked" and KPI rules still apply to those.
- GitLab metrics.
- Sign-in and per-user permissions.
