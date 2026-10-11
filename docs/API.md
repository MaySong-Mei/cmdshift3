# CmdShift3 API v1

Local base URL: `http://127.0.0.1:4317`; hosted clients use the deployed HTTPS origin. UTF-8 JSON. Require `Authorization: Bearer <token>` except health, account registration, session and static dashboard. `GET /api/health` reports providers, mode and public registration availability without secrets. `CMD3_MODE=public` enables independent accounts and private projects; the default local demo retains its labeled demo accounts.

## Sessions and projects

- `POST /api/session` with `{ "code": "may-demo" }` or `{ "code": "gary-demo" }` returns `{token,user,projects}`. May and Gary are separate demo users. Client stores token per session/tab. Server assigns author; never trust submitted author.
- `GET /api/me` returns `{user,projects}`.
- `GET /api/projects` returns `{projects:[{id,name,description}]}`. IDs: `proj_cmdshift3` (May + Gary), `proj_research` (May only). All project, image, commit and comment operations enforce membership.
- `POST /api/session/logout` revokes the bearer token.

### Public accounts and private projects

These additions preserve the Work Commit contract and the native client's `{code}` sign-in.

- `POST /api/accounts` `{username,name,password}` creates a public account and returns `201 {token,user,projects}`. Username is 3–32 lowercase letters, digits, `_` or `-`; name is 1–80 characters; password is 12–128 characters. Passwords are salted and hashed. New accounts have no default project membership. This first release uses usernames; it has no email verification or password recovery.
- `POST /api/session` `{username,password}` signs into an existing account. Public mode rejects the published demo codes. Sessions expire after 30 days and are explicitly revocable by logout.
- `POST /api/me/access-code` returns `{code}` for signing into the existing Mac client. The code is personal, random, and stored as a hash. Generating a replacement invalidates the previous code; existing signed-in sessions remain until expiry or logout. Never put the code or bearer token in a URL.
- `POST /api/projects` `{name,description,context,phase,deadline}` creates a private project and returns `201 {project}`. Optional text fields default to empty; deadline is an empty string or a `YYYY-MM-DD` date. The creator is the owner. Public project fields add `owner_id,context,phase,deadline,version,updated_at,member_count` to `id,name,description`.
- `POST /api/projects/:id/invite` is owner-only and returns `{invite_code,expires_at}`. The random code is valid for seven days; a replacement invalidates the previous invitation. Project invitations add membership to a signed-in account; they do not sign someone in as the owner.
- `POST /api/projects/join` `{code}` joins an invited project and returns `{project}`. Invalid or expired invitations reveal no project contents.
- `GET /api/projects/:id/context` is member-only and returns `{project,members:[{id,name}],history:[{version,name,description,context,phase,deadline,updated_at,updated_by:{id,name}}]}`.
- `POST /api/projects/:id/context` is owner-only. Send `{name,description,context,phase,deadline,expected_version}` and receive `{project}`. A stale version returns 409; clients retain their edits and refresh before retrying. Context versions preserve author and time separately from screenshot Work Commits. AI does not silently change goals or deadlines.

Project lists, evidence, comments, summaries and event streams enforce membership for both dynamic public projects and the local demo. Public signup, authentication, writes, active streams, storage and model usage are bounded; a quota error preserves existing data and frozen submission IDs. Public mode must use a separate data directory rather than opening an existing demo-seeded directory.

## Draft

`POST /api/draft`: `{project_id,comment,source,image_base64?}`. source is `{app_name,window_title,capture_kind}`; kind is `region|window|fullscreen|upload`. image_base64 is plain base64 PNG or a PNG data URL.

Returns `{summary,fields,organizer:{provider,status},warnings:[]}`. Field names: shipped, decision, why, blocker, next; each is an array of `{id,text,resolves?:[]}`. Stable ids use `it_<uuid>`; draft ids persist into submit. Only shipped items can explicitly resolve earlier blocker/next IDs from this project. A missing field is an empty array. No inferred absence closes a blocker. Provider `manual` indicates a manual result: `not_configured` means no AI is configured, while `ai_unavailable` preserves input after a provider failure. Provider `deepseek` or `openai` with `completed` indicates validated model output, still reviewed before Commit. Plain comment is preserved, never represented as verified completion.

## Commit

The Mac capture flow calls draft once automatically, including a PNG with an empty comment. Draft generation writes no Git history. With a blank comment, the organizer summarizes visible screenshot evidence without inferring completed work or resolved blockers. AI reads the original PNG, comment and project context; annotation metadata is saved only at Commit. The client requires a current-input review before explicit submission, and changed context updates the draft before another review. Unavailable AI requires an explicit manual-review choice. Frozen Commit retries resend the original payload without another AI request.

`POST /api/commits`: `{id,project_id,source,image_base64,annotations,comment,summary,fields}`. id is a fresh `wc_<uuid>` generated before submitting and reused for retries. Annotations are relative 0–1 `{type:"rect|arrow|text|highlight",x,y,w,h,text?,color:"#RRGGBB"}`. Rectangle/highlight sizes nonnegative; arrow w/h can be signed with endpoints within image. Request limit 12 MiB; decoded PNG limit 8 MiB. PNG required.

Successful response `201 {commit}`; retry with same id and same input returns `200 {commit}`. Different input with same id returns 409. WorkCommit has id, project_id, source, comment, summary, fields, author `{id,name}`, created_at ISO UTC, per-project sequence, evidence `{image_url,annotations}`, git `{sha,parent_sha,branch:"main",remote_synced}`. `GET /api/evidence/:id` is membership-protected PNG. API exposes image URL path, not base64.

Every Work Commit creates a real Git commit containing `deliverables/<id>/capture.png`, `annotations.json`, and `deliverable.json`. This record must not contain its own Git SHA (self-reference is impossible); SHA is returned in the API/index. Server's bare origin sync is real Git protocol on the host, not a claim of cloud deployment. Serialize writes by project, preserve both concurrent submissions. Recover/index manifests from Git if interrupted after Git succeeds. No remote event is announced before commit succeeds. If origin push fails, retain committed record and report `remote_synced:false` for repair/retry.

## Feed, state and discussion

- `GET /api/projects/:id/commits?since_sequence=0`: `{commits:[...newest first],through_sequence}`.
- `GET /api/commits/:id`: `{commit}`.
- `GET /api/projects/:id/state`: `{state:{shipped,decisions,blockers,next},through_sequence}`. State items include id,text,commit_id,author,created_at,git_sha. Resolved blocker/next omitted from active lists; history retained.
- `GET /api/commits/:id/comments`: `{comments}`.
- `POST /api/commits/:id/comments` `{body}`: `201 {comment}`. Server assigns author/time/id. Body 1–4000 chars.

## Catch up and seen

- `POST /api/projects/:id/conversation` `{question,history?}` answers a project question from confirmed Work Commits and project context. Question is 1–2000 trimmed visible characters. Optional history is at most 6 `{role:"user"|"assistant",content}` messages, each <=2000 characters, combined <=6000; body <=16 KiB. Clients reset history when project or account changes. Response is `{answer,analyzer:{provider,status},evidence:[{commit_id,git_sha}],through_sequence,context_version,coverage:{total_commits,included_commits,from_sequence,truncated}}`. The bounded evidence window includes recent history and current unresolved state. Citation IDs are validated and SHAs supplied by the server. History is dialogue context, not confirmed evidence. This endpoint does not write Git, comments, context, seen or stored chat. Empty/unavailable AI returns an explicit factual/manual result; normal membership, model concurrency/daily bounds and a public per-user question rate limit apply.

- `GET /api/projects/:id/catchup`: `{since_sequence,through_sequence,commits,summary,state,analyzer:{provider,status},evidence:[{commit_id,git_sha}],retrieval?}`. AI optional; manual provider returns a factual readable summary from confirmed fields. Optional Keewano retrieval is `{provider:"keewano",status:"disabled"|"schema_pending"|"not_indexed"|"unavailable"|"completed",indexed_commits,recent_git_commits,evidence:[{commit_id,git_sha}],activity:{contributors,blockers_recorded,items_resolved,next_recorded},queried_at?}`. Only query rows matched to this authenticated project's confirmed Git SHA, actor, time and field counts are included. Activity counts refer to recorded events, not current blocker totals or inferred completion. Recent unindexed Git records remain included. Query results are cached/coalesced per project for 30 seconds separately from the AI summary; failures retain normal Catch-up. No configuration means no sponsor calls or success claim. Catch-up never mutates Git or seen.

`recent_git_commits` counts unread Git records outside this query's verified coverage. A bounded or cached query cannot prove that unmatched records have never been indexed. They remain in the summary and evidence.

Configured empty catch-up windows return the configured provider with status `no_changes` and a factual empty-window message; no model request is made. A failed analysis returns `manual/ai_unavailable`. Successful DeepSeek/OpenAI summaries keep the same commit window and source evidence; repeat requests reuse a bounded 10-minute cache per user/project/window/provider/context version.
- `POST /api/projects/:id/seen` `{through_sequence}`: `{seen_sequence}`. Cursor monotonically advances, bounded by current project sequence. Scope is user and project. GET never advances it. Mark only up to the sequence actually viewed, preserving newer arrivals.
- `GET /api/projects/:id/events`: SSE with bearer header. `event: ready` then `event: update` and JSON `{type:"commit|comment",project_id,commit_id,sequence}`. Heartbeat; reconnect client fetches current feed. Browser uses fetch stream with Authorization rather than leaking token in query string.

Errors: `{error:{code,message}}`; 400 malformed/invalid input, 401 missing/expired token, 403 nonmember, 404 missing, 409 conflicting reuse/reference, 413 too large, 429 rate/concurrency/model allowance, 507 storage or project-history allowance. Escape all user text when rendering. Keep data, captures, tokens and secrets out of the development repo.
