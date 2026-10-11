# CmdShift3 public deployment

The public release lets each person create an account, create a private project, invite teammates, and submit screenshot Work Commits. The web dashboard and Mac client connect to the same HTTPS service. Project context records retain who changed the background and when; confirmed screenshot deliverables continue to create real Git commits.

Public service: **[cmdshift3-web-production.up.railway.app](https://cmdshift3-web-production.up.railway.app/)**. [Download the Mac app](https://cmdshift3-web-production.up.railway.app/downloads/CmdShift3.zip).

The initial deployment used tested source commit `ec7aea29fc42202668cbd8e17ee759b6366189fa`. Releases are pinned to verified source commits; later source pushes do not automatically deploy. The v0.2.0 capture-workbench release was pinned to `57e3cc66ec563519a828760a7bf5708884de5b5f`; downloaded ZIP bytes match the verified archive (SHA256 `5ad0d2efcaaffe3ad7711762bbf1d6f18795020e951085ae831f6eac27d7f5aa`). Existing project context, members, evidence, discussion and original Git SHA were rechecked after this deployment and preserved.

The current v0.3.0 AI-first capture release is pinned to `b02252c63a49929ebf8fd0bc53abc44f384ac063` (Railway deployment `361e214c-a3bd-4dd1-90d2-8f3f5eda98ed`, SUCCESS). The public archive matches the frozen signed package: 985403 bytes, SHA256 `c0c271b047703a5f90bb4a7813a50e48faa2a1f2cea93759034f491fbd4de3e2`. Existing project context, members, capture, discussion and original Git SHA were preserved. A real public DeepSeek draft from an empty-comment checkout screenshot summarized visible evidence without claiming shipped work, resolving items or creating a Git commit.

## Hosting layout

Run one Node 22.19+ process with Git installed. Mount persistent storage at `/data`, and set `CMD3_DATA_DIR=/data`. That volume contains SQLite, discussion, memberships, context versions, screenshot files, per-project Git working repositories and bare origins. Keep one replica and avoid overlapping writers during deployments. The bundled Dockerfile installs Git and uses the Node 22 runtime; Railway detects it at the repository root.

Use a separate empty cloud volume. Do not upload the local `.data`, Research project, saved sessions or `.env`. The Docker build copies only application files and the frozen Mac download; `.dockerignore` excludes runtime data and secrets.

## Railway setup

1. Create a service from `MaySong-Mei/cmdshift3`, using the root Dockerfile.
2. Attach a persistent volume at `/data` before the first deployment. The initial trial deployment uses 500 MB.
3. Set `CMD3_MODE=public`, `CMD3_HOST=0.0.0.0`, `CMD3_DATA_DIR=/data`, `PORT=4317` and `NODE_ENV=production`.
4. Configure `/api/health` as the health check, one replica, zero deployment overlap and a 45-second drain window. Keep the service awake during the demo.
5. Generate an HTTPS Railway domain routed to port 4317.
6. Optional AI configuration belongs in runtime variables: `CMD3_AI_PROVIDER=deepseek`, `CMD3_AI_MODEL=deepseek-flash`, `CMD3_AI_BASE_URL=https://api.deepseek.com/v1`, and secret `CMD3_AI_API_KEY`. The browser never receives the provider key. Without a key, the app clearly uses manual review.

The default Git origin is on the cloud volume, so the hosted service retains genuine project Git history. It does not automatically push Work Commits into the application source repository or a GitHub project repository. An additional remote and backup policy can be configured separately.

## Try it

Create an account with a username, display name and password of at least 12 characters. Store the password: this first public release has no password recovery. Create a project and fill in its background, phase and deadline. Generate a project invitation and share it with a teammate, who creates their own account and joins using that code.

Use **Connect Mac** to generate a personal access code. Download the Mac app, open it, and enter the deployed service URL and personal code. The current app requires Apple Silicon and macOS 15+. It is ad-hoc signed; macOS may require explicit approval in Privacy & Security. Grant Screen Recording when prompted. Quit an earlier CmdShift3 version before opening v0.3.0. A new ad-hoc signature may require fresh Screen Recording approval; quit and reopen after granting it. Use Control–Shift–Command–2 to capture. A highlighted thumbnail appears in a compact card, and AI automatically writes the draft from the screenshot and project context. Review the result, optionally use Edit screenshot / Edit draft, and choose Commit (⌘↩) to publish. Context is optional; Return adds a line. Changed context requires Update draft (⌘D), then another review before Commit. If AI is unavailable, Retry AI or explicitly Continue manually; the capture stays available. Closing unsaved work asks Keep Editing / Discard. Failed submissions retain all material for retry. The web composer also supports screenshot upload for people without the Mac app.

Keep personal Mac codes and project invitations private. A Mac code logs in as its account owner; a project invitation only joins a private project after the recipient signs in.

## Validate the release

Check that the health endpoint reports `mode: public`, demo codes fail, two newly registered accounts can collaborate through an invitation, and a third account cannot access their project or image. Submit a PNG, confirm a real Git SHA, and retry the identical request to confirm the SHA remains unchanged. Test discussion, explicit blocker resolution, individual catch-up checkpoints and context version conflicts. Restart the cloud service and confirm the project, context, comments and Git-backed capture remain available.

The first release has bounded signup, writes, storage and AI usage. The initial limits are 1,000 accounts, 100 projects, five owned projects per account, 20 MiB of Git-backed storage per project and 300 MiB across the service. AI allows 25 provider calls per person per UTC day and 200 across the service; one schema-repair attempt also counts. Project context retains up to 100 versions and discussion allows 500 comments per project. Reaching a limit returns an actionable error without deleting previous work or duplicating a frozen Commit retry. This is an early-access deployment with a 500 MB volume.

Context history and comments are application records. Both AI stages receive the confirmed project background as context; project goals and phase never prove completed progress. Catch-up summarizes confirmed Work Commits and preserves their source SHAs. Keewano and Anthropic remain unconnected.

Hosting references: [Railway persistent volumes](https://docs.railway.com/volumes), [Dockerfiles](https://docs.railway.com/builds/dockerfiles), and [deployment configuration](https://docs.railway.com/config-as-code/reference).

## Native v0.2 acceptance

The captured workbench was checked on a neutral fixture: all four mark tools, multiline comments, annotation alignment when the toolbar changes, persistent editing, and Keep Editing after close/Esc passed. The production app passed offline model/window/session guards, archive integrity and strict signature checks; Claude also passed isolated scratch-server integration. A fixture preview is not a new physical screenshot acceptance. The earlier frozen package passed a real local hotkey → capture → mark → DeepSeek → Git Commit flow. The final v0.2 bundle is frozen after verification; do not rebuild it while a user is granting Screen Recording.

## Native v0.3 acceptance

The frozen AI-first bundle was checked on a controlled checkout fixture. Box, Arrow, Highlight and Text marks, multiline context, human summary edits, compact/editor round trips and close/Keep Editing all passed; preview labels the sample draft and disables AI/Commit. Network-denied offline checks cover input revisions, overlapping requests, explicit review, failure retention, frozen retries and existing window/session protections. Isolated final-bundle integration confirmed that drafting writes no Git, latest context reaches the confirmed commit, and an identical retry keeps one SHA without another AI request. Real DeepSeek screenshot-only validation produced a useful visible-evidence summary with no unreported shipped work or inferred resolution. Archive integrity, extraction, executable identity and strict signatures passed.

The v0.3 GUI check uses a fixture preview, not a new physical capture. The older frozen package's physical capture PASS remains separate. Keep this final bundle unchanged while a user grants Screen Recording.
