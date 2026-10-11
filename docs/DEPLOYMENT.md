# CmdShift3 public deployment

The public release lets each person create an account, create a private project, invite teammates, and submit screenshot Work Commits. The web dashboard and Mac client connect to the same HTTPS service. Project context records retain who changed the background and when; confirmed screenshot deliverables continue to create real Git commits.

Public service: **[cmdshift3-web-production.up.railway.app](https://cmdshift3-web-production.up.railway.app/)**. [Download the Mac app](https://cmdshift3-web-production.up.railway.app/downloads/CmdShift3.zip).

The initial deployment is pinned to tested source commit `ec7aea29fc42202668cbd8e17ee759b6366189fa`. Later source pushes do not automatically replace it; deploy a newly verified commit explicitly.

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

Use **Connect Mac** to generate a personal access code. Download the Mac app, open it, and enter the deployed service URL and personal code. The current app requires Apple Silicon and macOS 15+. It is ad-hoc signed; macOS may require explicit approval in Privacy & Security. Grant Screen Recording when prompted. Use Control–Shift–Command–2 to capture, annotate, add context, prepare a draft and confirm the Commit. The web composer also supports screenshot upload for people without the Mac app.

Keep personal Mac codes and project invitations private. A Mac code logs in as its account owner; a project invitation only joins a private project after the recipient signs in.

## Validate the release

Check that the health endpoint reports `mode: public`, demo codes fail, two newly registered accounts can collaborate through an invitation, and a third account cannot access their project or image. Submit a PNG, confirm a real Git SHA, and retry the identical request to confirm the SHA remains unchanged. Test discussion, explicit blocker resolution, individual catch-up checkpoints and context version conflicts. Restart the cloud service and confirm the project, context, comments and Git-backed capture remain available.

The first release has bounded signup, writes, storage and AI usage. The initial limits are 1,000 accounts, 100 projects, five owned projects per account, 20 MiB of Git-backed storage per project and 300 MiB across the service. AI allows 25 provider calls per person per UTC day and 200 across the service; one schema-repair attempt also counts. Project context retains up to 100 versions and discussion allows 500 comments per project. Reaching a limit returns an actionable error without deleting previous work or duplicating a frozen Commit retry. This is an early-access deployment with a 500 MB volume.

Context history and comments are application records. Both AI stages receive the confirmed project background as context; project goals and phase never prove completed progress. Catch-up summarizes confirmed Work Commits and preserves their source SHAs. Keewano and Anthropic remain unconnected.

Hosting references: [Railway persistent volumes](https://docs.railway.com/volumes), [Dockerfiles](https://docs.railway.com/builds/dockerfiles), and [deployment configuration](https://docs.railway.com/config-as-code/reference).
