# Mapping a shared Jira project onto the room

Read this before step 4 of `AGENTS.md` when the Jira project is shared: several teams, a portfolio layer and support work all living under one project key. The example room assumes one tidy project per team. A shared project breaks that assumption in a few predictable ways, and each one produces numbers that look fine and are wrong.

All names here are made up (`PLAT`, "Cancelled"). The real values never go in this repository; see the last section.

## 1. Slice by team, never by project

A project-wide board, velocity or cycle time mixes teams that plan differently. Give each team its own Delivery wall and scope every link on it to that team.

- **Flow board:** use the team's own Jira board id. Its saved filter already selects the team.
- **KPIs:** set the same board id, or a query that names the team (`project = PLAT AND Team = 12`).
- **Bars and burn-ups:** these take an issue or a query, not a board id, so use the query that names the team.
- **Leadership walls:** show the portfolio level (initiatives and epics) and counts per team side by side. Do not add team numbers together unless they use the same unit.

Find out how much work has no team at all (`Team is EMPTY`). On a shared project it can be most of it. If the walls only show team slices, that work disappears from the room, so give it a place of its own.

## 2. Say what "done" means, once

By default a link counts an issue as done when its status is in Jira's Done category. Shared projects often keep a cancelled or no-longer-needed status in that category. Left alone, cancelled work is counted as delivered in every bar, KPI and burn-up.

- **Name the cancelled status under "Never counted" in Jira settings.** Work in it is then left out of every bar, burn-up and KPI, including the work found under a linked epic or initiative. It is one setting for the whole room.
- The connection check line "Statuses never counted" lists every status in the Done category. Read it: anything there that does not mean delivered needs handling.
- If the Done category holds other statuses that are not delivered either (a release or waiting status, say), list the ones that are under **Statuses that count as done** on each link (`doneStatuses` in the room document). A Done-category status left off that list counts as in progress, not as removed, so use "Never counted" for work that should not count at all.
- **Do not use the resolution field** to tell delivered from cancelled until you have counted it. Workflows often set the same resolution on both.
- **Do not trust a board's last column** as the definition of done. Columns are a team's display choice and can hold release or waiting statuses. Check each board's column mapping (`/rest/agile/1.0/board/{id}/configuration`) against the statuses that mean delivered.
- **Flow boards are not affected by "Never counted".** They show what the Jira board shows. A board whose filter hides the cancelled status will show different totals from a KPI on the same board that does not. To leave cancelled cards off a wall, add `status != Cancelled` as the board's extra query.

## 3. Blocked

If the teams move work to a "Blocked" status instead of flagging it, name that status under **Blocked means** in Jira settings. Blocked days are then replayed from status history, which works without the Flagged field.

## 4. Estimates differ by team

The story points field is one setting for the whole room. On a shared project one team may estimate in points, another in hours, and a third not at all.

- Use **points** only on walls whose team fills in the room's points field consistently. Check the share of stories with no estimate first; the result shows it as "unestimated".
- Use **count** everywhere else.
- Never sum points and hours on a leadership wall.

## 5. Portfolio levels

Themes and initiatives usually run on their own workflow with their own statuses. Link portfolio bars to the initiative or epic keys and let the hierarchy walk count the stories underneath. A portfolio kanban board can go on a wall as a flow board; hide any column that has no status mapped to it.

## 6. What to collect, and where it goes

Collect these with read-only calls and keep the answers in a private note, not in the repository.

| Collect | From | Goes in |
|---|---|---|
| Jira address and deployment type | the Jira administrator | `backend/.env` (`JIRA_BASE_URL`, `JIRA_AUTH`) |
| Jira version | `python -m obeya check`, "Jira can be reached" | The report in `architecture.md` |
| Story points field id, PI field id | `GET /api/jira/fields` | Jira settings |
| Each team's board id and type | `GET /api/jira/boards` | Flow boards and KPIs on that team's wall |
| Each board's filter query | the board's settings in Jira, or its owner. The server never reads saved filters, so the service account may not be able to. | Check that it selects the team, and whether it hides cancelled work |
| Each board's columns and the statuses in them | board configuration | Check against the done list; hidden columns |
| Statuses that mean delivered, and the one that means cancelled | the connection check lists the Done category; the teams say which ones mean what | "Never counted" in Jira settings; "Statuses that count as done" on a link only where needed |
| How blocked work is marked | ask the teams | "Blocked means" in Jira settings |
| Which estimate each team uses | board configuration (`estimation`, scrum boards only), or ask the team | Points or count, per wall |
| The team field and how much work leaves it empty | one search | Queries; a place for unassigned work |
| PI names exactly as Jira spells them, with dates | `GET /api/jira/pi-values`, the calendar owner | PI calendar |
| Initiative and epic keys leadership wants to watch | ask leadership | Portfolio bars |

## 7. What the app cannot express yet

These came out of mapping a real shared project. Each has a workaround today and is listed under "Not built yet" in `architecture.md`.

| Gap | Workaround today |
|---|---|
| Flow boards take their last column from the Jira board, whatever statuses it holds. | Fix the column mapping in Jira, or hide the column on the wall. |
| No KPI that simply counts the issues matching a query, which is what a data-quality wall and an "unassigned work" figure need. | A bar linked to the query shows done against total, not a count of gaps. |
| One estimate field for the whole room. A team that estimates in another field cannot use points. | Use count on that team's wall. |
| WIP limits are per column, as Jira boards define them. A per-person limit cannot be checked. | None. |

## 8. Keeping real values out of the repository

Board ids, field ids, team names, status names, queries and the Jira address are all read from the real Jira, so the rule in `AGENTS.md` applies to them: they are entered in the app and stored in its database, and they are never committed. Keep the filled-in version of the table above in a private note. Before every commit, run `git status` and `git diff --staged` and look for anything that came from Jira.
