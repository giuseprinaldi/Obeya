# Jira integration: requirements and discovery

The Jira pull runs on the VM backend, not in the browser. A Python service polls Jira every few minutes, works out board state and KPIs, and writes the results to Postgres. The TVs read only from Postgres.

Design constraints:

- Standard library plus one Postgres driver. No Jira SDK, to keep the dependency tree small for security review.
- Read-only API access.
- Board mappings, field IDs and KPI rules live in a config file, not in code.

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

## Planned deliverables

- `jira_sync/` Python module: API client, polling job, and mappers from Jira issues to panel data
- `config/boards.yaml`, or JSON to avoid a YAML dependency: board-to-wall mapping, field IDs and status mapping
- KPI calculations as pure functions, with unit tests built from recorded sample responses
- Postgres tables for synced issues, KPI snapshots (the history behind the sparklines) and sync runs
- A spec in the same format as the proposal pipeline spec, for Devin to wire into the VM build
