# CmdShift3

**Commit your work. Everyone stays caught up.**

A Mac menu bar app turns a screenshot, annotations and a short comment into a project Work Commit. Each confirmed update creates a real Git commit. Teammates share a live dashboard, discuss the evidence and catch up from their own last checkpoint.

## Run the core demo

Requires macOS **15+** for the capture app, Node **22.19+**, Git, and Xcode for building the Mac app. The server and dashboard have no npm dependencies.

```sh
npm start
```

Open **http://127.0.0.1:4317** in two browser tabs. Sign in with `may-demo` and `gary-demo`; each tab keeps its own session. Both users belong to CmdShift3, while only May belongs to Research. These are intentionally labeled demo accounts.

Build and launch the native app using the instructions in [macos/README.md](macos/README.md). It connects to the same service. The browser also has an upload-and-annotate composer for testing the complete workflow.

Data persists in `.data/`, outside the application source. Each project has an independent working Git repository and local bare origin. A commit tracks `capture.png`, `annotations.json` and `deliverable.json`; the API returns its actual SHA. Retrying the same submission ID and payload returns the same commit.

```sh
npm test
git -C .data/projects/proj_cmdshift3/repo log --oneline
git --git-dir=.data/projects/proj_cmdshift3/origin.git log --oneline
```

See the [three-minute demo walkthrough](docs/DEMO.md), [real collaboration case](docs/REAL_CASE_DEMO.md), and [API contract](docs/API.md).

## Public early access

Open **[CmdShift3](https://cmdshift3-web-production.up.railway.app/)** to create your account. Download the **[Mac app](https://cmdshift3-web-production.up.railway.app/downloads/CmdShift3.zip)** from the same service.

The public deployment uses independent username/password accounts and private projects. Create a project, save its background in the Project Context Card, invite teammates, and generate a personal access code to connect the existing Mac app. Each confirmed Work Commit still creates a real Git commit. Public mode uses separate persistent cloud data and rejects the published local demo codes.

See [deployment and onboarding](docs/DEPLOYMENT.md) for hosting, Mac setup, access controls and release checks. Vercel and Supabase are not required for this initial single-server release. The first release has no password recovery; keep your account password.

## Optional configuration

Copy `.env.example` to `.env` and fill in only the services you want. Never commit credentials.

- `CMD3_AI_PROVIDER=deepseek`, `CMD3_AI_API_KEY`, `CMD3_AI_MODEL=deepseek-flash`, and `CMD3_AI_BASE_URL=https://api.deepseek.com/v1`: enable screenshot/text deliverable drafts and project catch-up through DeepSeek Chat Completions. The server gathers project context, requests structured JSON, validates it, and returns an editable draft; a human confirms before Git commit. Catch-up uses confirmed work and links to its source commits. Keep the key in the ignored local `.env`, never in the browser or source repository. Restart the service after configuration changes.
- `CMD3_AI_PROVIDER=openai` keeps the existing Responses adapter; use an OpenAI model and `CMD3_AI_BASE_URL=https://api.openai.com/v1`. Anthropic is not integrated yet. Without a valid provider/key/model configuration, the UI uses clearly labeled manual review. Labels such as `shipped:`, `blocker:` and `next:` can populate editable fields; plain prose is preserved without guessing completion. Failed or malformed model output preserves the original comment and capture for manual review. Empty catch-up windows skip model requests; repeated summaries reuse the existing bounded cache.
- `CMD3_HOST=0.0.0.0`: expose the demo server to a second device on your network. Use the server machine's address in the native client. Demo codes are public and this is not a production authentication system.
- `CMD3_PORT` and `CMD3_DATA_DIR`: change the port or data directory.
- `CMD3_REMOTE_PROJ_CMDSHIFT3` / `CMD3_REMOTE_PROJ_RESEARCH`: configure a dedicated empty Git remote for a project's work history. Credentials must already be available to Git. A failed push preserves the local commit and reports `remote_synced: false`; resending the identical submission retries synchronization. The default bare origin runs on the same machine and is not cloud deployment.
- `KEEWANO_API_KEY`: optional typed event ingress adapter. `KEEWANO_PAT` is reserved for the separate query integration. No live Keewano write/query or managed-agent execution has been verified, and query-driven summaries are not implemented. The core demo does not claim sponsor integration.

Current state uses explicit `shipped.resolves` references to close earlier blocker/next items. Omitting a blocker from a later update never resolves it. Viewing catch-up does not mark it read; the user confirms the checkpoint explicitly.

DeepSeek protocol and current screenshot support are documented in its [Chat API](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/), [JSON output guide](https://api-docs.deepseek.com/guides/json_mode/), and [vision guide](https://api-docs.deepseek.com/zh-cn/guides/vision/). The organizer uses the non-thinking mode with strict local validation. A complete DeepSeek response that fails JSON or deliverable validation gets at most one repair request within the same 25-second deadline; HTTP errors and interrupted responses fall back directly. Model text does not execute tools or change confirmed project history. Web drafts retain existing edits when AI organization fails.

## Collaboration

Codex is lead; Claude Code owns the Mac client. Both agents read [COLLAB.md](COLLAB.md), the canonical handoff and task board, before working.
