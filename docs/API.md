# CmdShift3 API v1

Base URL: `http://127.0.0.1:4317`. UTF-8 JSON. Require `Authorization: Bearer <token>` except health, session and static dashboard. `GET /api/health` reports providers without secrets. Production hosting and OAuth are not part of demo login.

## Sessions and projects

- `POST /api/session` with `{ "code": "may-demo" }` or `{ "code": "gary-demo" }` returns `{token,user,projects}`. May and Gary are separate demo users. Client stores token per session/tab. Server assigns author; never trust submitted author.
- `GET /api/me` returns `{user,projects}`.
- `GET /api/projects` returns `{projects:[{id,name,description}]}`. IDs: `proj_cmdshift3` (May + Gary), `proj_research` (May only). All project, image, commit and comment operations enforce membership.
- `POST /api/session/logout` revokes the bearer token.

## Draft

`POST /api/draft`: `{project_id,comment,source,image_base64?}`. source is `{app_name,window_title,capture_kind}`; kind is `region|window|fullscreen|upload`. image_base64 is plain base64 PNG or a PNG data URL.

Returns `{summary,fields,organizer:{provider,status},warnings:[]}`. Field names: shipped, decision, why, blocker, next; each is an array of `{id,text,resolves?:[]}`. Stable ids use `it_<uuid>`; draft ids persist into submit. Only shipped items can explicitly resolve earlier blocker/next IDs from this project. A missing field is an empty array. No inferred absence closes a blocker. Provider `manual` indicates a manual result: `not_configured` means no AI is configured, while `ai_unavailable` preserves input after a provider failure. Provider `deepseek` or `openai` with `completed` indicates validated model output, still reviewed before Commit. Plain comment is preserved, never represented as verified completion.

## Commit

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

- `GET /api/projects/:id/catchup`: `{since_sequence,through_sequence,commits,summary,state,analyzer:{provider,status},evidence:[{commit_id,git_sha}]}`. AI optional; manual provider returns a factual readable summary from confirmed fields. Keewano disabled until configured; no claim of sponsor success.

Configured empty catch-up windows return the configured provider with status `no_changes` and a factual empty-window message; no model request is made. A failed analysis returns `manual/ai_unavailable`. Successful DeepSeek/OpenAI summaries keep the same commit window and source evidence; repeat requests reuse a bounded 10-minute cache per user/project/window/provider.
- `POST /api/projects/:id/seen` `{through_sequence}`: `{seen_sequence}`. Cursor monotonically advances, bounded by current project sequence. Scope is user and project. GET never advances it. Mark only up to the sequence actually viewed, preserving newer arrivals.
- `GET /api/projects/:id/events`: SSE with bearer header. `event: ready` then `event: update` and JSON `{type:"commit|comment",project_id,commit_id,sequence}`. Heartbeat; reconnect client fetches current feed. Browser uses fetch stream with Authorization rather than leaking token in query string.

Errors: `{error:{code,message}}`; 400 malformed/invalid input, 401 missing/expired token, 403 nonmember, 404 missing, 409 conflicting reuse/reference, 413 too large. Escape all user text when rendering. Keep data, captures, tokens and secrets out of the development repo.
