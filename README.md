# Obeya

A configurable digital Obeya room for leadership and program management. Each wall of the room runs full screen on its own TV. Editing happens from a laptop, and the screens are display-only.

## Status

**Working build, not yet deployed.** The app runs locally as a React frontend and a small Python server that keeps its data in a SQLite file (Postgres is an option). Progress bars can be linked to Jira epics, initiatives and queries. It has been tested against a built-in fake Jira, not against a real one; see `docs/architecture.md` for what that leaves unchecked. The next step, connecting it to the real Jira, is written up step by step in `AGENTS.md`.

`prototype/index.html` is the original single-file prototype (browser storage only, no Jira). It is kept for reference.

## What it does

- **Overview:** totals of everything that needs attention across the room, plus a room plan showing which wall runs on which screen.
- **Walls:** each wall is a grid of panels you can add, resize (one third, two thirds or full width), reorder and edit.
- **Panel types:**
  - Statement: true north, a goal or a focus statement
  - KPI tracker: actual against target, with a trend sparkline; the value can come from Jira
  - Portfolio: initiatives with health, progress and horizon; progress can come from Jira
  - Progress bars: Jira-linked or manual bars, with an optional pace marker and a trend showing how each bar moved over the last week
  - Burn-up chart: done against scope, day by day, across a PI, a sprint or chosen dates, with a forecast
  - Dependencies: which issues are waiting on which, read from Jira's issue links, with work that is held up right now listed first
  - Risks: a risk register with owner, impact and ROAM status (open, owned, accepted, mitigated, resolved)
  - Problem solving: problems moving through Define, Analyze, Countermeasure, Verify and Closed
  - Action tracker: owner, due date and done, with late actions flagged
  - Flow board: columns with WIP limits and drag-and-drop cards, or a live read-only view of a Jira board
- **Display mode** (`#screen-N`): a dark theme that scales to fill the screen, with a clock, the current PI and sprint, and an "updated" stamp. Controls and the mouse cursor hide when the mouse is idle. The arrow keys switch walls and Escape exits. Screens can be set to rotate when there are fewer TVs than walls.
- **Status encoding:** colored stripes and labels for KPIs off target, initiatives at risk, blocked work, work waiting on a dependency, high risks nobody owns, columns over their WIP limit, high-severity problems, late actions, bars and burn-up charts behind pace, and stale work (in-progress Jira cards nobody has updated, and started bars with no progress, each for a number of days you set per panel).
- **Customize:** room name, accent color, separate themes for laptops and TVs, density, three room templates (Program, Leadership, Team delivery) and a JSON backup and import.

## Jira-linked progress

A progress bar can be linked three ways, all from the editor:

- **A Jira issue.** Paste a key or a Jira URL. Progress is measured across everything beneath it, so an initiative is measured by the stories under its epics.
- **A Jira query (JQL).** Progress is measured across the issues the query matches, for example `sprint in openSprints()`. Tick "Count the work under each match" and it measures what sits beneath them instead, so a query for the epics in the current PI is measured by their stories.
- **Auto-fill.** A progress panel can take a query, and every issue it matches becomes its own bar, for example every epic in the current PI.

Each bar chooses issue count or story points, which statuses count as done, its label, color, value format and pace marker.

The server keeps one snapshot of every link per day. Bars use it to show a small trend line and the change over the last week ("+4 in 7d"), which can be switched off per panel.

A **burn-up chart** panel is linked the same way, to an issue or a query, and covers the current PI, the current sprint or dates you choose. It draws scope and done for each day, an even-pace line, and a forecast from the pace of the last two weeks. The days from before the chart was added are worked out once from Jira's issue histories, so the chart is filled in from the start.

## Dependencies and risks

The **Dependencies & risks** wall (in the Program room template, or under **+ Wall**) holds two panels:

- **Dependencies** takes a Jira query and lists the dependencies of the issues it finds, from their issue links: "is blocked by", "depends on" and links worded like them. Each row reads "A waits on B". It is marked **Waiting now** when A is already in progress and B is not done, **Open** when A has not started, and **Settled** when B is done. Dependencies between two projects are tagged "Across teams". If your Jira uses its own link types, name them in the panel settings. The panel is read-only: links are made in Jira.
- **Risks** is entered by hand, because a risk needs a person's judgement. A high-impact risk that nobody has taken turns the panel red; anything still open or owned keeps it amber.

## Jira flow boards and KPIs

- **Flow boards.** Point a flow board at a Jira board and it shows that board's own columns, WIP limits and cards. A scrum board shows the active sprint, so it rolls over when the sprint does.
- **KPIs.** A KPI can be worked out from Jira: cycle time, lead time, throughput, blocked days, scope done, work in progress, blocked items and unplanned work. You still set the target.
- **Blocked.** What counts as blocked (the flag, a status, a label, an "is blocked by" link) is set once under **Jira** and used everywhere.
- **Stale.** A card on a Jira board is flagged "Stale 9d" when it is in progress and nobody has updated the issue for 7 days; a Jira-linked bar says "No progress 16d" when it has started, is not finished and nothing more has been done for 14 days. Both numbers are set in the panel settings, and 0 switches the flag off.

To keep sprint and PI changes hands-off:

- Sprint queries use Jira's `openSprints()`, so they follow the active sprint.
- PI queries use `{PI}` and `{PI_FIELD}`, filled in from a PI calendar entered once under **Jira** in the app. When the date passes into the next PI, the bars follow.
- Links, the PI field, the board and the calendar are all set in the app. None of them need a code or config change.

## Locking edits and setting up TVs

- **Edit passcode.** Under **Customize** you can set a passcode. After that, TVs and visitors can look but not change anything, and editing needs the passcode once per browser. If it is forgotten, `python -m obeya reset-passcode` on the server removes it.
- **Earlier versions.** The server keeps the last 100 saves of the room. **Customize** > **Earlier versions** lists them with what each one changed, and restores any of them. A restore is saved as a new version, so it can be undone the same way.
- **Screen addresses.** Each TV opens `/#screen-1`, `/#screen-2` and so on. A TV follows its screen number, so reordering walls or loading a template changes what it shows without touching it.
- **Jira connection check.** **Jira** > **Check the connection** tests the real Jira against everything the app relies on and says what to fix. `python -m obeya check` does the same from the server.

## Running it locally

Requirements: Python 3.10+ and Node 20+. The backend needs no packages installed.

```bash
cd frontend && npm install && npm run build && cd ..
cd backend && python scripts/dev.py
```

Open http://127.0.0.1:8787. `scripts/dev.py` starts the server together with the fake Jira (sample keys: `PLAT-1`, `DATA-1`) and fills in matching Jira settings on the first run.

To try a TV, open a second tab on `#screen-1`, or use **Open display** on any wall. Everything in the starter room is example data.

For frontend work, run `npm run dev` in `frontend/` alongside the server; it proxies `/api` to port 8787.

To run against real Jira, set `JIRA_BASE_URL` and `JIRA_TOKEN` (see `backend/.env.example`) and start `python -m obeya` instead of the dev script.

Data is stored in `backend/data/obeya.db`. To back it up or move it, copy that file while the server is stopped. To use Postgres instead, set `DATABASE_URL` to a `postgresql://` URL and install the driver (`pip install "psycopg[binary]"`, or `uv sync --extra postgres`).

## Tests

```bash
cd backend && python -m unittest discover -s tests -t .
cd frontend && npm test
```

## Layout

| Path | Contents |
|---|---|
| `frontend/` | React app |
| `backend/obeya/` | API server, Jira client, sync job |
| `backend/fake_jira/` | Stand-in Jira for development and tests |
| `AGENTS.md` | Step-by-step brief for connecting Obeya to the real Jira, written for a coding agent |
| `docs/architecture.md` | API, data model, configuration, deployment and security notes |
| `docs/jira-integration.md` | Jira discovery items and what is still to build |
| `prototype/` | The original single-file prototype |

## Roadmap

1. Deploy to the VM and check the Jira calls against the real instance.
2. GitLab metrics.
3. Per-user sign-in, if the passcode or the existing proxy is not enough.
4. Keep strategy, problems and actions as manual entries, since those need human judgment.

## License

Apache 2.0
