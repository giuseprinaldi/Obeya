# Obeya

A configurable digital Obeya room for leadership and program management. Each wall of the room runs full screen on its own TV. Editing happens from a laptop, and the screens are display-only.

## Status

**Prototype.** `prototype/index.html` is a single self-contained page that runs in any modern browser with no build step and no dependencies. Data is stored in the browser's localStorage. Display tabs open in the same browser update live while you edit.

The production version will run on an internal VM. It will use a Python backend and Postgres, and it will pull live data from Jira (see `docs/jira-integration.md`).

## What the prototype does

- **Overview:** totals of everything that needs attention across the room, plus a room plan showing which wall runs on which screen.
- **Walls:** each wall is a grid of panels you can add, resize (one third, two thirds or full width), reorder and edit.
- **Panel types:**
  - Statement: true north, a goal or a focus statement
  - KPI tracker: actual against target, with a trend sparkline
  - Portfolio: initiatives with health, progress and horizon
  - Problem solving: problems moving through Define, Analyze, Countermeasure, Verify and Closed
  - Action tracker: owner, due date and done, with late actions flagged
  - Flow board: columns with WIP limits and drag-and-drop cards
- **Display mode** (`#tv-<wall-id>`): a dark theme that scales to fill the screen, with a clock and an "updated" stamp. Controls and the mouse cursor hide when the mouse is idle. The arrow keys switch walls and Escape exits. Screens can be set to rotate when there are fewer TVs than walls.
- **Status encoding:** colored stripes and labels for KPIs off target, initiatives at risk, blocked work, columns over their WIP limit, high-severity problems and late actions.
- **Customize:** room name, accent color, separate themes for laptops and TVs, density, three room templates (Program, Leadership, Team delivery) and a JSON backup and import.

## Running it

Open `prototype/index.html` in a browser. To try a TV, open a second tab on `#tv-<wall-id>`, or use **Open display** on any wall.

Everything in the starter room is example data.

## Roadmap

1. Port to the VM stack: a Python API, Postgres as the system of record, and the React frontend.
2. Have the screens poll the API, roughly every 30 seconds, instead of reading localStorage.
3. Pull the flow boards and flow KPIs from Jira. GitLab metrics come after that.
4. Keep strategy, problems and actions as manual entries, since those need human judgment.

## License

Apache 2.0
