# Instructions for coding agents

Obeya is a digital Obeya room: walls of panels shown on TVs, edited from a laptop, with progress bars, boards, KPIs, burn-up charts and dependencies read from Jira. This file is the brief for the next piece of work. `README.md` describes the product and `docs/architecture.md` is the technical reference; read both before changing anything.

## The task

**Get Obeya showing real work from the real Jira.** Everything in this repository was built and tested against the fake Jira in `backend/fake_jira/`. Your job is to run it against the real one, load the setup file a person gives you, and fix the places where the real Jira answers differently from the fake.

Most of the work is running four commands in order and reading what they print. You change code only when a command shows that the real Jira answered in a shape the code did not expect.

Done means all of these:

1. `python -m obeya check` reports no failures, and every warning is either fixed or explained in your report.
2. `python -m obeya verify` exits 0: no link in the room fails. Every line it marks `EMPTY` is explained in your report.
3. Each item under "What has never been checked" is confirmed or fixed.
4. Both test suites pass, and every code fix has a test.
5. `docs/architecture.md` says what was confirmed against the real Jira (and its version) and what is still open.

## Rules

- **This repository is public.** Never commit the Jira address, the token, the setup file, or anything read from the real Jira: issue keys, summaries, people's names, project names, team names, field ids, board ids, queries, screenshots, logs, command output. Tests and docs use the fake data only (`PLAT-1`, `DATA-1`). The token lives in `backend/.env`, which git ignores. Keep the setup file outside the repository. Run `git status` and `git diff --staged` before every commit.
- **Jira is read-only.** The client sends GET requests and the search POST, nothing else. Do not add a call that writes to Jira.
- **The backend uses the Python standard library only.** Do not add packages. (`psycopg` is the one optional extra, for Postgres.)
- **Settings a person might change belong in the app, not in files.** The setup file is a one-time load into the database; the server never reads it. Only secrets and deployment values go in the environment.
- **Every new or changed Jira call needs three things:** the fake Jira answers it the way the real one does, a test covers it, and the connection check (`backend/obeya/diagnostics.py`) reports on it if a Jira could lack it.
- **When the real Jira differs from the fake, fix the fake first.** Make the fake return the real shape (with made-up data), watch a test fail, then fix the code. Do not special-case around the fake.
- **Keep `docs/architecture.md` current** in the same commit as the change it describes.
- **Work on a branch,** one commit per fix, and say in the commit message what the real Jira did that the code did not expect. Do not rewrite history on `main`.
- **Do not invent room content.** Statements, risks, problems, actions and targets are for the team to enter.

## Do not

These are the ways this task has gone wrong before.

- Do not edit the room by hand, in the app or through `PUT /api/room`, to point it at real work. The setup file does that. If the file cannot express something, stop and say so.
- Do not change a query, board id, team id or field id yourself to make a line pass. Those values belong to the person who wrote the setup file. Report the line and ask.
- Do not change code because a link is `EMPTY` or because a number looks wrong. First find out whether the setup file or the code is at fault (step 5).
- Do not change code without a failing test that shows the problem first.
- Do not skip a step, reorder steps, or carry on past a step that failed.
- Do not use `scripts/dev.py` or its database for the real Jira.
- Do not refactor, rename, tidy or add features. Fix what a command shows to be broken and nothing else.

## Stop and ask a person when

- A test fails in step 1, before you have changed anything.
- `check` cannot reach Jira or the token is rejected, and the address, token, CA bundle and proxy are as you were given them.
- `setup` exits 2 and the message points at a value in the file (an unknown board, a malformed entry).
- A link fails or is empty and the cause is the value in the setup file, not the code.
- You have made three code fixes and `verify` still fails. Report what you found instead of making a fourth.
- Anything would require writing to Jira, adding a package, or committing something read from Jira.

## What you need from a person first

Stop if you cannot get the first three.

- The Jira base URL, and whether it is Data Center or Cloud.
- A token for a **read-only** service account that can browse the projects and view the boards to be shown. Data Center: a personal access token. Cloud: an API token and the account's email.
- The setup file. It names the Jira settings, the teams with their boards and queries, the portfolio items, the dependencies query and the counts. `backend/setup.example.json` shows the format; `docs/architecture.md`, "Loading a setup file and verifying the room", explains every key.
- A CA bundle file if Jira uses an internal certificate authority, and proxy settings if the server reaches Jira through one.

## Steps

Run every command from `backend/` unless the step says otherwise.

### 0. Start clean

If you have worked in this checkout before: commit every code change you made on a branch and push it, so nothing is lost, and say in your report which of those commits are fixes with a test. Do not carry uncommitted changes forward (`git stash` keeps them recoverable). Then `git pull` on `main` and start a new branch from it. What you entered in the app earlier stays in the database; the setup file in step 4 replaces or keeps it as the file says.

### 1. Prove the checkout works, with the fake Jira

```
cd frontend
npm ci
npm run build
npm test
cd ../backend
python -m unittest discover -s tests -t .
```

Requirements are Python 3.10+ and Node 20+. Expect 173 frontend and 213 backend tests to pass. If any fail, stop and report; do not continue.

To see what a working room looks like, run `python scripts/dev.py`, open http://127.0.0.1:8787, then stop it. It serves the app against the fake Jira on port 8790. It is for the demo only: it overrides the Jira address and token with the fake's.

### 2. Connect

Copy `backend/.env.example` to `backend/.env` and fill in:

```
JIRA_BASE_URL=https://jira.example.com
JIRA_TOKEN=...
JIRA_AUTH=bearer        # "basic" plus JIRA_EMAIL for Cloud
JIRA_CA_BUNDLE=         # path to a CA file, if needed
```

`HTTPS_PROXY` and `NO_PROXY` are honoured. Use a fresh database: delete `backend/data/obeya.db*` if `scripts/dev.py` ever wrote to it, or set `DATABASE_URL` to another file. Then:

```
python -m obeya check
```

It runs sixteen checks in order and prints a fix beside each warning or failure. It exits 1 if anything failed. If Jira cannot be reached or rejects the token, the rest are skipped, so fix from the top. Before the setup file is loaded, the PI field, PI calendar and board checks warn that nothing is chosen; that is expected.

| If this fails | Look at |
|---|---|
| Jira can be reached | `JIRA_BASE_URL`, TLS (`JIRA_CA_BUNDLE`), proxy. Code: `JiraClient._request` in `backend/obeya/jira_client.py`. |
| Token accepted | `JIRA_AUTH` (bearer or basic), the token itself. |
| Issues are visible | The service account's Browse Projects permission. |
| Anything else | The check's own code in `backend/obeya/diagnostics.py` shows the exact request it made. |

Read the line "Statuses never counted". It lists every status in Jira's Done category. Put that list in your report: a person has to confirm that each one means delivered.

### 3. Try the setup file, writing nothing

```
python -m obeya setup /path/outside/the/repo/setup.json --dry-run
```

This asks Jira about every link the file describes and prints one line each. Nothing is saved.

- **Exit 2, "Nothing was changed":** the file cannot be used. The message names the place. Stop and ask the person who wrote the file, unless it is a plain typo in a key name.
- **Lines marked `FAIL` or `EMPTY`:** go to step 5 before loading anything.
- **Lines starting `Note:`** say what was left out and why. Copy them into your report.

### 4. Load it

```
python -m obeya setup /path/outside/the/repo/setup.json
python -m obeya check
python -m obeya verify
```

`setup` saves the settings and the walls, runs a sync and prints the same report. It can be run again after the file changes: it updates the walls it created and loses no history. `check` now has a PI field and boards to test. `verify` prints the report for the room as it stands and exits 1 if any link fails; it is the test for "done".

Then start the server (`python -m obeya`) and open the app to see the walls.

### 5. When a line fails, is empty, or shows a wrong number

Work out which of two things is wrong before touching anything.

**The value in the setup file is wrong.** Signs: Jira's error names something that does not exist (a field, a board, a status, an issue key); a query returns nothing; a figure is a clean multiple or subset of the right one. Paste the query from the file into Jira's own issue search and compare. If Jira agrees with Obeya, the file is at fault. Do not fix it yourself: report the line, what Jira's search returned, and what you think the value should be.

**The real Jira answered in a shape the code did not expect.** Signs: an error that mentions an unexpected answer, a Python exception in the server log, a figure that disagrees with Jira's own search for the same query. Then, in this order:

1. Find the call in `backend/obeya/jira_client.py` and look at what Jira returned.
2. Make the fake Jira return the same shape, with made-up data.
3. Write a test that fails.
4. Fix the code until the test passes and both suites are green.
5. Add a connection check line if another Jira could differ in the same way.
6. Commit that one fix with its test and its line in `docs/architecture.md`.

To try one link without saving anything, use `POST /api/jira/preview` on the running server. The body is one of `{"source": ...}`, `{"auto": ...}`, `{"board": ...}`, `{"metric": ...}` or `{"deps": ...}`, holding the same object the room stores (shapes in `frontend/src/types.ts`). Every PUT and POST must be sent as JSON.

Compare at least three figures by hand with Jira's own screens and put the comparison in your report: one team's count of issues in the active sprint, one board column's cards, and one portfolio bar's done and total.

### 6. Check what has never been checked

Each of these is an assumption taken from Jira Data Center's documentation. Confirm it on the real Jira, and if it is wrong, fix it by the six steps above.

| Assumption | How to check | Code |
|---|---|---|
| The token can read the projects and boards involved. | Connection check; `setup` reads every board in the file. | `diagnostics.py` |
| Issues carry `statuscategorychangedate`. Without it cards show no age; nothing else breaks. | Check "Days in status on cards". | `Engine._card` in `sources.py` |
| `updated` moves only when someone really touches the issue. A nightly automation that edits every issue would keep any card from ever looking stale. | Look at `updated` on a few idle in-progress issues. | `Engine._card` in `sources.py` |
| The flag field is a custom field named "Flagged". | Check "Flagged field". | `discovered_fields` in `jira_client.py` |
| Epic Link and Parent Link values can be read. The code accepts a key, an id or an object, and falls back to one query per parent. | Check "Epic and initiative links"; compare a portfolio bar with Jira. | `Engine._descend` and `Engine._children_of` in `sources.py` |
| The PI field accepts `=` in a query. A text field needs `~`. | Check "PI field". | `periods.py` (`field_ref`), the queries in the room |
| Searches with `expand=changelog` return complete histories. Cycle time, lead time, throughput, blocked days and the replayed days of burn-up charts depend on it. | Check "Issue histories"; try a long-lived issue. | `JiraClient.search`, `flow.py` |
| The burn-up replay finishes in reasonable time on a real scope. It is one search with histories per chart for a query, and one per 40 issues for an issue link, run once per chart. | Time the first `setup` or `verify`; watch the server log. | `Engine.daily_history` in `sources.py`, `Syncer._backfill` in `sync.py` |
| Dependency link types are worded so the direction can be read ("is blocked by", "depends on"), and linked issues arrive with summary and status inside the link. | Check "Dependency links"; compare the dependencies panel with a few issues in Jira. If the wording is unusual, the setup file can name the link types. | `deps.py` |
| Board columns, WIP limits, the kanban sub-filter and the active sprint come back in the documented shape. | Compare each team's board panel with the board in Jira. | `board_config`, `board_issues`, `active_sprint` in `jira_client.py` |
| A search asked for no issues (`maxResults` 0) still returns its `total`, on `search` and on a board's issues. The "Issues matching" KPI is that one call. | Check "Issue counts"; compare a count on the walls with the same query in Jira's issue search. | `count`, `board_count` in `jira_client.py` |
| A status name under "Never counted" matches the name Jira returns on issues, whatever its case. | Check "Statuses never counted"; a count of that status in Jira's search should equal what the bars leave out. | `Engine._counted` in `sources.py` |
| A team's own estimate field is a number field that searches return as a number. | A bar or KPI that uses it shows a total above zero and a plausible "unestimated" count. | `issue_view` in `progress.py` |
| Rate limits. When Jira answers 429 (or 502, 503, 504) the client waits, for as long as `Retry-After` says up to 20 seconds, and tries twice more before giving up on that sync. | Watch the server log during a full sync. | `_request`, `_retry_after` in `jira_client.py` |
| Jira Cloud. The client switches to `/rest/api/3/search/jql` and the `parent` field when `serverInfo` says Cloud, but none of it has run. | Only if the real Jira is Cloud: expect more to fix here than anywhere else. | `jira_client.py`, `sources.py` |

The endpoints the server calls, for firewall or permission questions: `/rest/api/2/serverInfo`, `myself`, `field`, `status`, `issueLinkType`, `search` (POST), and `/rest/agile/1.0/board`, `board/{id}/configuration`, `board/{id}/issue`, `board/{id}/sprint`.

### 7. Report

Update the "Tested and not tested" section of `docs/architecture.md`: move what you confirmed out of the "Not tested against real Jira" list, name the Jira type and version it was confirmed on, and leave what is still open. The version is the only thing from the real Jira that goes in the repository.

Then write a short summary for Joe and Devin, outside the repository:

- the output of `check` and `verify`;
- the `Note:` lines from `setup`;
- the statuses in Jira's Done category, for a person to confirm;
- the three figures you compared by hand;
- every `EMPTY` line and what you think explains it;
- what you changed in the code and why, one line per commit;
- what is still open, and anything a person has to decide.

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
| `backend/obeya/roomsetup.py` | The `setup` command: reads the setup file and builds the walls. |
| `backend/obeya/verify.py` | The `verify` command: one line per link. |
| `backend/obeya/server.py` | The HTTP API. |
| `backend/obeya/config.py` | Environment variables. |
| `backend/setup.example.json` | A setup file for the fake Jira. |
| `backend/fake_jira/` | The stand-in Jira used by the demo and the tests. |
| `backend/tests/` | Backend tests; they start the fake Jira and call it over real HTTP. |
| `frontend/src/types.ts` | The shape of the room, every link and every API answer. |
| `frontend/src/logic/` | Frontend logic and its tests. |
| `docs/shared-jira-mapping.md` | How a Jira project shared by several teams maps onto walls. Background for whoever writes the setup file. |

## Things that will waste your time if you do not know them

- Python changes need a server restart. Frontend changes need `npm run build` (the server serves `frontend/dist`), or run `npm run dev` in `frontend/` beside the server.
- Run the commands and the server from `backend/`: that is where `python -m obeya` finds the package. They read `backend/.env`; variables already set in the environment win over the file.
- `setup` and `verify` write to the same database the server uses. The server can stay running; screens pick up the new room on their next refresh.
- A full sync runs every `OBEYA_SYNC_SECONDS` (300 by default). Look-back metrics are recomputed at most every 30 minutes; `verify`, `POST /api/sync` and saving settings recompute them at once.
- A search stops at 2,000 issues, except for the "Issues matching" KPI, which lets Jira count. A bar or board that matches more is too broad for a wall.
- A sprint burn-up has no dates until a board is chosen for the current sprint (`settings.jira.boardId` in the setup file, or **Jira** in the app). `setup` prints a note when it is missing.
- The fake Jira builds its data around today's date. Late in the evening in the Americas, when the UTC date is already tomorrow, a date-sensitive test can fail without anything being wrong; run it again in the morning before changing code.
- If the edit passcode is set, the Jira endpoints answer 401 until the browser (or your HTTP client) has unlocked with `POST /api/unlock`. `python -m obeya reset-passcode` removes a forgotten passcode. The `setup` and `verify` commands do not need the passcode.
