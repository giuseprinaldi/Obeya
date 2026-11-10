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

## How Jira flow boards work

A flow board panel can be switched from manual cards to a Jira board. Nothing is mapped by hand:

- **Columns and WIP limits** come from the board's own configuration in Jira (`/rest/agile/1.0/board/{id}/configuration`), so a column added or a limit changed in Jira shows up on the next sync.
- **Cards** are the issues on that board. A scrum board shows its active sprint (or everything, by choice); a kanban board applies its sub-filter. An optional extra query narrows either. Sub-tasks are left out.
- **The last column** only shows work finished in the last N days (14 by default), so it does not grow forever.
- **Each card** carries key, summary, type, assignee, points, days in its current status category and whether it is blocked. Screens get at most 30 cards per column plus the true column total.

The board is read-only in Obeya; Jira stays the place where work moves.

## How Jira KPIs work

A KPI can take its value from Jira instead of being typed in. Target and direction stay manual. The scope is a board, a query, or both. Sub-tasks are never counted.

| Metric | What it measures | Needs issue history |
|---|---|---|
| Cycle time | Days from the first "in progress" status to done, for work finished in the window. Median, average or 85th percentile. Work that went straight from to-do to done has no cycle time and is left out. | Yes |
| Lead time | Days from created to done, for work finished in the window. | Yes |
| Throughput | Items finished per week, averaged over the window. | Yes |
| Blocked days | Total days items spent blocked in the window, counting the flag and blocked statuses. Overlaps are counted once. | Yes |
| Scope done | Percent of the scope that is done now, by issues or points. | No |
| Work in progress | Items (or points) in progress now. | No |
| Blocked items | Items blocked now. | No |
| Unplanned work | Percent of the scope that is unplanned: added to the active sprint after the day it started, or carrying a chosen label, or of a chosen issue type. | Only for "added after start" |

- **Done** means Jira's "Done" status category, or the status names given on the KPI. Reopened work is not done until it is finished again.
- **On a scrum board**, the right-now metrics look at the active sprint and the look-back metrics look at the whole board.
- **Trend.** Look-back metrics come with eight weekly points worked out from history, so the sparkline is filled in from the first sync. Right-now metrics are snapshotted once a day and build their trend over time.
- **Load on Jira.** Look-back metrics read issue histories, which is the heaviest call, so they are recomputed at most every 30 minutes. "Sync now" and saving Jira settings recompute them at once.

**Blocked** is defined once, under "Blocked means" in Jira settings, and used by cards and metrics alike: the Flagged field, named statuses, named labels, an unresolved "is blocked by" link, or any combination. Blocked days can only replay the flag and statuses, because labels and links leave no usable history.

## Who can edit

Reading the room is always open, so TVs need no sign-in. Editing works in one of three ways:

- **Open (the default).** Until a passcode is set, anyone who can reach the server can edit.
- **Passcode.** Set under Customize in the app. From then on a browser is view-only until someone enters the passcode, which unlocks that browser for 12 hours (`OBEYA_EDIT_SESSION_HOURS`). Changing or removing the passcode needs the current one and ends every other unlocked session. If it is forgotten, run `python -m obeya reset-passcode` on the server.
- **Sign-in proxy.** If a reverse proxy signs people in, set `OBEYA_AUTH_HEADER` to the header it passes the user name in and `OBEYA_EDITORS` to the names allowed to edit (`*` for anyone it lets in). This can be combined with a passcode. Only use it when the server cannot be reached except through the proxy, because the server believes whatever that header says.

While locked, a view-only browser can call only `GET /api/state`, `GET /api/health`, `POST /api/unlock` and `POST /api/lock`. Everything else answers 401, including the Jira endpoints, so a visitor cannot run Jira queries through the service account.

How it is built:

- The passcode is stored only as a salted PBKDF2-SHA256 hash (200,000 rounds).
- An unlocked browser holds a signed, expiring cookie (`HttpOnly`, `SameSite=Strict`, and `Secure` when the proxy reports https). The signing key is generated on first use and kept in the database.
- Wrong guesses are limited to 8 in 5 minutes across all browsers.
- Every PUT and POST must be JSON. Together with the cookie settings, that stops another website from acting through an unlocked browser.

## Screen addresses

A TV opens `/#screen-N`. It shows whichever wall is at position N and follows it when walls are reordered, replaced or loaded from a template, so nobody has to touch the TV. `/#tv-<wall-id>` still pins one specific wall.

## Checking a real Jira

`GET /api/jira/diagnostics`, the "Check the connection" button in Jira settings, and `python -m obeya check` on the server all run the same list of checks and say what to do about each warning or failure:

| Check | What it tells you |
|---|---|
| Jira address and token | The server has been given both. |
| Jira can be reached | Network path, TLS and proxy work; reports the Jira type and version. |
| Token accepted | The account the token belongs to. |
| Issues are visible | The account can read at least one issue. |
| Epic Link and Story Points fields | Found automatically, or the field picked in settings exists. |
| Flagged field | The flag rule for "blocked" can work. |
| Epic and initiative links | Whether Parent Link exists and whether its values can be read. |
| PI field | It exists, has values, accepts `=` in a query, and the calendar's current PI name matches a value Jira uses. |
| PI calendar | There is a current PI and it is not about to run out. |
| Boards and sprints | The chosen board can be read and has an active sprint. |
| Status categories | Needed to tell when work started and finished. |
| Issue histories | Searches return complete histories, which the look-back metrics need. |
| Days in status on cards | Whether this Jira reports it. |

The command exits with status 1 if any check failed, so it can be used in a deployment script. It reads from Jira and writes nothing.

## API

All JSON, same origin. Errors are `{"error": "..."}` with a non-2xx status. Types are in `frontend/src/types.ts`.

| Method and path | Purpose |
|---|---|
| `GET /api/state` | Room, version, Jira results (`progress`, `auto`, `boards`, `metrics`), `periods`, `sync` status, and `access` (whether this browser may edit). Sends an ETag. |
| `PUT /api/room` | Body `{room, baseVersion}`. `200 {version, updatedAt}`, or `409 {error: "conflict", version, room}` if someone saved first. `baseVersion` 0 creates the room. |
| `GET /api/settings`, `PUT /api/settings` | PI field, story points field, board, summaries and assignee names on or off, the blocked rule, PI calendar. Saving triggers a full sync. |
| `POST /api/sync` | Run a full sync now and wait for it. |
| `POST /api/unlock`, `POST /api/lock` | Enter the passcode for this browser (sets the session cookie), or go back to view-only. |
| `PUT /api/passcode` | Body `{current, next}`. Set, change or remove (`next` empty) the edit passcode. |
| `GET /api/jira/diagnostics` | Run the Jira connection check. |
| `GET /api/jira/status` | Whether Jira is configured and reachable with the token. |
| `GET /api/jira/fields`, `GET /api/jira/boards` | For the pickers in Jira settings. |
| `GET /api/jira/pi-values` | Distinct values recently used in the PI field, as name suggestions. |
| `POST /api/jira/preview` | Body `{source}`, `{auto}`, `{board}` or `{metric}`. Computes a link without saving it ("Check"). |
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
| `OBEYA_AUTH_HEADER`, `OBEYA_EDITORS` | empty | Trust a sign-in proxy's user header; see "Who can edit". |
| `OBEYA_EDIT_SESSION_HOURS` | `12` | How long a browser stays unlocked. |

## Deploying on the VM

1. `cd frontend && npm ci && npm run build`
2. Nothing to install for the backend, unless Postgres is used (`pip install "psycopg[binary]"`).
3. Set the environment (Jira URL and a read-only token; `DATABASE_URL` only to move the SQLite file or use Postgres) and run `python -m obeya` from `backend/` under the service manager. Make sure the service account can write to the data directory.
4. Run `python -m obeya check` and read what it says about this Jira.
5. Open the app, go to **Jira**, and pick the PI field, the board and enter the PI calendar. This replaces the planned `config/boards.yaml`: it is done once in the UI and can be changed there later. Run the check again from that screen.
6. Set an edit passcode under **Customize**.
7. On each TV, open `/#screen-1`, `/#screen-2` and so on.

## Security notes

- **Editing is open until it is locked.** Set a passcode under Customize, or put the server behind a sign-in proxy; see "Who can edit". Reading the room stays open to anyone who can reach the port, so keep it on the internal network. There are no per-user accounts and no record of who changed what.
- **Use https in front of it.** The server speaks plain http. Without TLS at a proxy, the passcode and the session cookie cross the network unencrypted.
- **Read-only Jira.** The client only sends GET requests and the search POST. Use a read-only service account anyway.
- **Token handling.** The token is read from the environment, sent only to `JIRA_BASE_URL`, never stored in the database and never sent to a browser. Redirects to another host are refused.
- **Summaries and names.** "Show Jira summaries on screens" and "Show assignee names on screens" can each be switched off in Jira settings. Bars and cards then show keys only, and the summaries or names never leave the server.
- **Dependencies.** Backend: none with SQLite; `psycopg` with Postgres. Frontend runtime: `react`, `react-dom` and three font packages.

## Tested and not tested

- **Tested:** 137 backend tests (`python -m unittest discover -s tests -t .` in `backend/`), covering the PI calendar, JQL variables, progress and flow maths on hand-built histories, the Jira client, hierarchy walk, boards and metrics over real HTTP against the fake Jira, and the API against a real SQLite database. Setting `OBEYA_TEST_DATABASE_URL` to a `postgresql://` URL runs the API tests a second time on Postgres (160 tests in total). The edit lock is covered there: forged, edited and expired cookies, the guess limit, and every endpoint refusing a locked-out browser.
- **Frontend:** 105 unit tests on the status, pace, link-parsing, calendar, board, KPI, access and screen-address logic (`npm test` in `frontend/`). The built app was also run in Chrome against this server and the fake Jira: first-run seeding, linking a bar from a pasted Jira URL, Check link (good and bad keys), auto-fill bars, adding a Jira KPI, switching a flow board between Jira boards, the "Blocked means" and assignee settings taking effect, Jira settings, display mode at 1366x768 and 1920x1080, arrow keys and Escape, and the "changed on another device" conflict path. Also run there: the edit lock (set, change and remove the passcode, lock, unlock, a wrong passcode, too many wrong guesses, view-only mode, a session ending mid-edit, and the server-side reset command against the running server); screen addresses (a TV following a reorder within its 30-second refresh, rotation without the address changing, wrap-around, and a screen with no wall); and the connection check section.
- **Frontend, not tested:** Firefox and Safari (the bar layout uses CSS subgrid, `:has()` and container queries, so use a current browser on the TVs), the wall rotation timer over a long run, and the copy-to-clipboard button.
- **Display mode has a density limit.** A wall is scaled to fit the screen, and text shrinks as a wall gets denser, down to a floor. Past that floor panels are cut off at the bottom rather than scrolled. The example Delivery wall (four panels, three KPIs, eight bars and a four-column Jira board at six cards per column) fits a 16:9 screen with a little shrinking; much more than that should be split across two walls, or the board given fewer cards per column.
- **Not tested against real Jira.** The fake follows Data Center's documented shapes, but these need checking on the VM:
  - that the service token can read the projects and boards involved;
  - that this Jira version reports `statuscategorychangedate` (it drives the age shown on cards; without it cards simply show no age);
  - that the flag field is called "Flagged", which is how the server finds it;
  - that searches with `expand=changelog` return complete histories for long-lived issues (the look-back metrics depend on it);
  - how this instance returns the Parent Link field (the code handles a key, an id or an object, and falls back to one query per parent if it cannot read it);
  - that the PI field accepts `cf[NNNNN] = "name"` (a text field would need `~` in the query instead of `=`).
- **Jira Cloud is untested.** The client switches to Cloud's search endpoint and `parent` hierarchy when `serverInfo` reports Cloud, but nothing has exercised it.

## Not built yet

- GitLab metrics.
- Moving cards from Obeya. Jira boards are read-only here by design.
- Per-user sign-in and a record of who changed what.
