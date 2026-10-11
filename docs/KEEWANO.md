# Keewano integration

CmdShift3 uses Keewano to retrieve indexed project activity for Catch-up. Git remains the source of confirmed deliverables, evidence and current project state. A verified query adds an indexed-activity section to the existing summary; recent Git records remain available while indexing catches up.

After a Work Commit succeeds, the server queues seven typed events outside the Git transaction:

| Event | Type | Value |
|---|---|---|
| `Cmd3ActorId` | string | Authenticated author's ID |
| `Cmd3CommitSha` | string | Confirmed Git SHA |
| `Cmd3CaptureApp` | string | Source application name, limited to 256 characters |
| `Cmd3BlockersRecorded` | uint | Number of blocker items in this commit |
| `Cmd3ItemsResolved` | uint | Number of explicit `shipped.resolves` references |
| `Cmd3NextRecorded` | uint | Number of next items in this commit |
| `Cmd3WorkCommitted` | none | Marker delimiting the work record |

The integration sends no screenshot pixels, annotations, comments or project-context text. A deterministic project entity UUID scopes its events; the commit UUID identifies the ingress session. Ingress failures do not roll back Git. An accepted write does not establish query visibility.

Catch-up authenticates the viewer and checks project membership before retrieval. One MCP client per application instance reuses its session and permits only `list_event_types` and `run_script_query`. The server verifies the owned event schema, then runs fixed Lua with the project's entity filter and a maximum of 40 records. User and model input cannot supply query code.

Returned rows are candidates until their SHA, actor ID, creation timestamp in whole Unix seconds, and all three field counts match confirmed Git records in the requested project and captured sequence window. Foreign or mismatched rows produce no citation. Activity and retrieval evidence include only the viewer's current unread window. Contributor counts describe distinct recorded authors; blocker, resolution-reference and next counts describe recorded events. Current blockers and task completion continue to come from Git fields and explicit resolution relationships.

Query results are cached and coalesced per project for 30 seconds, separately from the base AI summary. No configuration or an empty unread window causes no sponsor request. Missing event types, indexing delay and query failures preserve the normal summary, Git evidence and project state. `retrieval.status` distinguishes `disabled`, `schema_pending`, `not_indexed`, `unavailable` and verified `completed` results. Reading Catch-up never advances seen or writes Git.

To configure the server:

1. Select a Keewano project and obtain an **SDK-type write key** for ingress. Store it as `KEEWANO_API_KEY`.
2. Obtain a personal access token with access to that project. Store it as `KEEWANO_PAT`, and its project UUID as `KEEWANO_PROJECT_ID`. The PAT is used for MCP reads; it does not replace the SDK write key.
3. Set these variables in the ignored local `.env` or the hosting service's runtime secrets, then restart the server. Keep credentials out of Git, browser bundles and URLs.
4. Submit a real Work Commit, allow indexing time, and open Catch-up. Verify that matching Git-backed rows appear in retrieval evidence and change the indexed-activity section. Configuration and write acknowledgements alone are insufficient evidence of a working history query.

This implementation does not deploy or invoke a hosted Keewano agent. It combines typed ingress, read-only history queries, Git verification and the application's separately configured summary model.

Implementation: [ingress](../server/lib/keewano.mjs), [MCP transport](../server/lib/keewano-mcp.mjs), [fixed history query](../server/lib/keewano-history.mjs), [Catch-up API](API.md).
