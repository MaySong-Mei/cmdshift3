# Core demo walkthrough

Target: a three-minute demonstration of capture → real Git history → teammate discussion → personal catch-up.

## Prepare

1. Run `npm start` from the repository. Keep the service running.
2. Open `http://127.0.0.1:4317` in two tabs. Sign in as May (`may-demo`) and Gary (`gary-demo`), both in CmdShift3. Separate tabs use separate sessions.
3. Launch the Mac app, use the same service address and May's demo login code. If already signed in, click the menu bar camera icon and **Open CmdShift3** to open the full window. Authorize screen capture when macOS asks.
4. For the AI demo, configure DeepSeek in the ignored local `.env` using `.env.example`, then restart the service. The organizer and catch-up show `deepseek` after successful analysis. Without a key/model, the demo remains in explicit manual review; a temporary provider failure shows a preserved manual fallback. Never claim a fallback is model output.

## Show the loop

1. **Capture work.** From the menu bar or `⌃⇧⌘2`, select part of a screen. Draw a rectangle, arrow, text or highlight. Write `shipped: Menu bar capture is ready` and `blocker: Need teammate approval`. Click **Draft fields**, then review the summary and editable fields before Commit. Without this step, the comment is preserved but its labels do not populate the project state.
2. **Show real history.** The dashboard receives the update. Open it: screenshot, annotations, author and Git SHA travel together. The project state includes the blocker. Optionally show the actual Git log in `.data/projects/proj_cmdshift3/repo` and its local bare origin.
3. **Collaborate.** In Gary's tab open that update and comment `Reviewed — the capture is clear.` May sees the discussion update. Each account's checkpoint is independent.
4. **Resolve explicitly.** Gary submits another capture (native app or browser upload), records a shipped outcome and selects the earlier blocker as resolved. The state now removes that blocker. A later update without this explicit link would leave it open.
5. **Catch up.** May opens Catch me up. It shows changes since May's checkpoint, current blockers/next steps, and links to the source commits. Click the read confirmation; a second catch-up has no new commits. Gary's checkpoint remains independent.

## State the current boundaries

The demo uses real Git commits and a real server-hosted bare origin. It has demo accounts, not production identity. AI is not connected without a configured key/model. Keewano's optional ingress adapter is not a verified query-driven sponsor integration. The native client requires a reachable service; an offline submission queue is outside this first demo.

Never describe the local bare origin as a cloud deployment or a deterministic manual summary as model output.
