# Jira integration: requirements and discovery

The Jira pull runs on the VM backend, not in the browser. A Python service polls Jira every few minutes, works out the numbers, and writes the results to the database. The TVs read only from the database.

## Status

Built: Jira-linked progress bars (issue, query and auto-fill links), flow boards read from Jira boards, KPIs worked out from Jira, the sync job, the PI calendar and the Jira settings screen. See `architecture.md` for how each works and what is still untested against real Jira.

Most of the discovery table below is now answered inside the app instead of up front:

- Item 3 (boards): picked from a list on each flow board and KPI.
- Item 4 (status to column mapping): read from the Jira board's own configuration.
- Item 5 (field IDs): found automatically, except the PI field, which is picked from a list.
- Item 6 ("blocked"): set under "Blocked means" in Jira settings.
- Item 7 (KPI rules): chosen per KPI; see the metric table in `architecture.md`.
- Item 8 (what may appear on screens): summaries and assignee names can each be switched off.

Items 1 and 2 (Jira type, base URL, token and network path) are still needed to connect at all.

Design constraints:

- Standard library only (plus one Postgres driver if Postgres is used). No Jira SDK, to keep the dependency tree small for security review.
- Read-only API access.
- Links, field IDs and the PI calendar are set in the app and stored in the database, not in code. This replaces the config file planned originally, so that changing them does not need a deploy.

## Information needed before building

| # | Item | Why it matters |
|---|------|----------------|
| 1 | Jira type and version (Cloud or Data Center/Server) | Determines the API version, sign-in method and search endpoint. Data Center uses a Bearer personal access token. |
| 2 | Base URL, token type, and network path from the VM (proxy?) | Confirms the service token works read-only and that the VM can reach Jira. |
| 3 | Board IDs, project keys, Scrum or Kanban, optional JQL filter per wall | Determines which data feeds which wall. |
| 4 | Workflow status to column mapping | Maps statuses to Backlog, Ready, In progress, Review and Done. Usually available from the board configuration. |
| 5 | Custom field IDs: story points, sprint, epic link or parent, Flagged | These IDs are different on every Jira instance. |
| 6 | Team definition of "blocked" (Flagged, a status, a label or an "is blocked by" link) | The blocked counts are only useful if they match how the team actually works. |
| 7 | KPI rules: which issue types count, and what "unplanned" means | Cycle time and lead time need the issue change history. Scope done, throughput, blocked days and unplanned work each need a clear rule. |
| 8 | Field allowlist per board | Keeps sensitive summaries off screens in a shared room. |

## Discovery commands

Run these from the VM. Scrub names and issue summaries from the output before sharing it.

```bash
export JIRA=https://your-jira-host
export TOKEN=...   # service token

curl -H "Authorization: Bearer $TOKEN" "$JIRA/rest/api/2/serverInfo"
curl -H "Authorization: Bearer $TOKEN" "$JIRA/rest/api/2/field"
curl -H "Authorization: Bearer $TOKEN" "$JIRA/rest/agile/1.0/board/BOARD_ID/configuration"
curl -H "Authorization: Bearer $TOKEN" "$JIRA/rest/api/2/search?jql=project=KEY&maxResults=3&expand=changelog"
```

These answer items 1, 4 and 5, show the real data shapes, and confirm that the VM can reach Jira.

For progress bars, the field IDs in item 5 no longer need looking up by hand: the server finds Epic Link, Parent Link and Story Points from `/rest/api/2/field`, and the PI field is picked from a list in Jira settings.

## Deliverables

Done:

- `backend/obeya/`: Jira client, sync job, progress calculation as pure functions, HTTP API
- `backend/fake_jira/`: a stand-in Jira for development and tests
- Tables for the room, settings, link results, daily history and sync runs (SQLite by default, Postgres optional)
- `docs/architecture.md`: API, data model, configuration and deployment notes for the VM build

- Flow boards from Jira boards, and KPIs from issue histories (`backend/obeya/flow.py`)

Still to do:

- Check all of the above against the real Jira instance from the VM
- GitLab metrics
