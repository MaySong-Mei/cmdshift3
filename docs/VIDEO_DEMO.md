# CmdShift3 v0.3 video demo

Owner: the existing Claude Code recording session. Codex coordinates acceptance and publishing. Target: a 90–180 second English video using the actual Mac app. For the next take, use the dedicated public demo actors and private project prepared by lead at `https://cmdshift3-web-production.up.railway.app/`. Complete sign-in and Mac connection off-camera so the video starts with the project already open.

The approved local **Real case 2** take at `http://127.0.0.1:4317/` remains valid. If it is already recording, finish it before switching environments; never switch the service or actor in the middle of a captured draft. State which environment the delivered take uses.

The story is **capture → AI writes → human reviews → Commit → teammate catches up**. Spend most of the video on fast capture and review; the dashboard shows what the team needs to know afterward.

## Recording handoff

1. Read the latest `COLLAB.md`, R28 and the public-account handoff. Use the frozen production bundle `/private/tmp/cmdshift3-ai-review/CmdShift3.app`, v0.3.0. Native source: `7614a7efc7cb6c873648b967ed5b40c2beb6f387`. Binary SHA256: `a07fbfed12e64d7f6c1c0ee1cdc6462e6faba5741ee18513c7c7a4d3677587c2`. **Do not rebuild, re-sign, or replace it.**
2. Check the final app's Screen Recording permission and the recording host's permission through May's approved workflow. If permission is missing or an action is denied, report the exact requirement; do not silently change OS permissions or work around a denial.
3. Following lead's R28 approval, quit the old v0.1 app through its normal UI to free the capture shortcut, then launch the frozen v0.3 app. Preserve unsent material and local history; do not force-kill apps, reset saved defaults, restart the local service or change cloud configuration. For the local take, reuse the existing local connection. For a public take, use the normal sign-in/Connect Mac workflow off-camera with the lead-prepared accounts; never display or log connection secrets. Change environments only between takes with no unsent draft.
4. Before taking the mouse and keyboard, append **video running** to `COLLAB.md`, with the expected recording window, and check for a lead `hold`. Lead has released its preview GUI. After recording, append **video done** with paths and verification, or **video paused** with a concrete blocker; release the GUI.
5. Prepare two independent sessions for the delivery and review demo actors in the same project. Public credentials are provided only through the lead's ignored `work/video-demo-accounts.json`; do not copy them into this guide, shared messages, screenshots or the video. The public service requires these dedicated accounts, not the local demo codes. Use fresh case titles and preserve older case/T8 records. Keep private chats, unrelated code, credentials and permission pages outside the frame. Reserve about ten minutes of exclusive GUI time for setup and one take.

Use a non-sensitive artifact: the local first take can keep its actual passing test output. A public product-focused take can capture the readable checkout fixture at `/Users/maymaymei/Documents/Codex/2026-10-11/new-chat/work/ai-review-demo.png`, after displaying it on screen and completing the stated visual checks. Only this neutral evidence belongs in the public demo project; do not migrate local history. Do not use `--preview-capture`, its sample AI card, uploaded evidence, or a selftest as a substitute for the filmed physical Mac capture.

## Shot list and narration

Aim for about two minutes; the timings below allow up to three minutes when showing the second review commit. Remove idle waits and setup rather than rushing the human-review pause. This single script works for either environment.

| Time | On-screen action | English narration |
|---|---|---|
| 0:00–0:15 | Start already signed in, on project context and team state. Then show the neutral work artifact. Keep any actual test-result proof under ten seconds. | “CmdShift3 makes a work update as quick as taking a screenshot. Here is our project and the evidence ready for teammate review.” |
| 0:15–0:35 | Press **Control–Shift–Command–2**, select the artifact region and release. Show the captured thumbnail's highlight, compact card and automatic AI-writing state. Leave context empty for this first draft. | “I capture the evidence, and AI starts organizing it immediately. The screenshot stays available while I review the draft.” |
| 0:35–1:00 | Read the actual AI result. Choose **Edit screenshot**, add one box or arrow, and add a short truthful work note. Choose **Done editing**, then **Update draft**. | “I can add a mark and a short note when context matters. Updating the draft prepares a new review; it doesn't publish anything.” |
| 1:00–1:20 | Inspect the updated summary and nonempty fields. Keep a new-case review blocker and video task. Correct unsupported claims if necessary. Pause visibly on the reviewed draft, then explicitly press **Commit**. Show the real success state, SHA and sync result. | “AI writes the update, but I decide what goes into the project. Only after I review and commit does this become a real Git record with its evidence.” |
| 1:20–1:45 | Switch to the review actor's separate dashboard session. Open the new delivery record; show its author, captured evidence, annotation and SHA. Add a short review comment. | “My teammate sees the update and its evidence together. They can review the detail and leave feedback without asking me to reconstruct what happened.” |
| 1:45–2:20 | As the review actor, attach an actual review screenshot in the web composer. Prepare and inspect the AI draft. Explicitly select **only this new case's review blocker**, then commit the review. Show its own SHA and the case blocker disappearing from current state. | “The review becomes another confirmed work record. We explicitly resolve this case's blocker, while the original evidence and discussion remain available.” |
| 2:20–2:50 | Return to the delivery actor and open **Catch me up**. Show the actual delivery/review summary, source records and current state or context card. | “When I return, I can see what changed, who reviewed it, and what still needs doing. Each update leads back to its evidence.” |
| 2:50–3:00 | End on the captured work record or project progress view. Add the public app URL as an end caption. | “Commit your work. Everyone stays caught up.” |

For the approved local test-output take, retain the following notes. Replace the case title and reviewer label when using the dedicated public actors.

```text
Real case 2: I ran the project tests and the captured result shows they passed. The delivery evidence is ready for Gary's demo review. Blocker: Gary's review of this case is pending. Next: record and review the demo video.
```

Gary's comment:

```text
Real case 2 demo review: I inspected the captured passing test result and the reviewed work draft. This case is ready for approval.
```

Gary's review Work Commit note, after actually inspecting the evidence:

```text
Real case 2: I completed the demo review of the delivery evidence and passing project test result. This case's review is approved. Resolve only the pending Gary review blocker created for Real case 2. The demo video still needs final review.
```

For a public checkout take, the delivery note can instead say: “I checked the primary button contrast and postal-code validation message in this checkout demo. The evidence is ready for teammate review. Blocker: teammate sign-off is pending.” The reviewer must actually inspect those details before reporting approval. Adapt every note to the actual result; never insert a prepared test count or claim tests passed when using only a design fixture. The actors are demo roles operated by us. A screenshot alone does not establish shipped work or approval. Comments stay in discussion; current AI catch-up summarizes confirmed Work Commits. Approval and resolution require a separately reviewed, explicit review Commit.

## Acceptance and delivery

- Confirm this recording uses **real physical v0.3 capture**, a real AI response and explicitly reviewed delivery and review commits. Keep the first capture and AI return free of automatic Git writes.
- Verify both new records' full Git SHAs, actors and project; verify the delivery's captured PNG, annotation, latest context and `remote_synced` result. Verify the review references only this new case's blocker. These are real project work-history Git commits synchronized to a service-owned Git origin. For the local take the origin is local; for the public take it is stored on the cloud service's persistent volume. Do not describe either as GitHub synchronization.
- Verify the second actor's independent session can read the delivery's evidence and SHA, its comment is stored, and the delivery actor's Catch me up has actual source records for this case. Leave unrelated history and blockers unchanged.
- Deliver `CmdShift3-v0.3-demo.mp4`, a representative poster image, and a small secret-free verification report under `/Users/maymaymei/Documents/Codex/2026-10-11/new-chat/outputs/`. Include duration, dimensions, recording time, local/public environment, final bundle hash, both full work SHAs, actors and acceptance results. Keep secrets out of reports and filenames. Keep the video local for May's review; do not upload or submit it.
- Play the exported video once; inspect text readability, cursor/selection visibility, highlight, review pause, final success and audio/captions. Cuts may remove waiting time, but must preserve the action order. Label accelerated waits if used; never replace actual AI output with a prepared draft.

If v0.3 capture or recording permission is blocked, report the blocker and retain the prepared script. Do not call fixture-preview acceptance or the older v0.1 capture a completed v0.3 recording. Public availability can be stated separately: `https://cmdshift3-web-production.up.railway.app/`.
