# CmdShift3 for macOS

Menu bar client: press **⌃⇧⌘2** anywhere → select a region (or press Space to pick a window, same as ⌘⇧4) → a light capture card opens and **the AI writes the Work Commit** → you review it (optionally add context, marks or edits) → **Commit ⌘↩**. Only Commit creates the real Git commit; teammates see it in the menu bar, the app window, and the web dashboard.

## v0.3 AI-first capture card (T14)

- **Capture → AI draft → review → Commit.** When the capture arrives, the screenshot is sent once for an AI draft (empty context is fine). The draft is never committed on its own: nothing reaches Git until you press **Commit**.
- **Light card by default** (~700 px): highlighted thumbnail (steady soft accent outline + glow, one short pulse on arrival; Reduce Motion keeps the static highlight), project pill, AI status, the AI-written summary and only the non-empty items, an optional *context for the AI* box (Return adds a new line), and one primary action.
- **Editing is optional.** *Edit screenshot* / *Edit draft* expand the same window into the canvas + draft editor; *Done editing* returns to the card. Marks, context and draft edits are kept. Marks are saved with the commit; the AI drafts from the screenshot and your context, not from marks.
- **Context or project changed → Update draft.** Editing the context does not call the AI on every keystroke; the primary button becomes *Update draft*, which only re-drafts and returns you to review. Switching project re-drafts for that project and drops old *resolves* links. Your own edits to the summary/items are kept across updates.
- **Honest AI states.** *Writing…*, *Written by ‹provider›*, *Context changed*, *No AI connected*, *AI couldn't finish*, and explicit messages for rate limits (HTTP 429), network errors and expired sessions. The capture and context are always kept. Without a usable AI draft, Commit stays off until you choose **Retry AI** or **Continue manually** (manual review).
- **Retry is exact.** After the first Commit attempt the payload and id are frozen: *Retry commit* resends the same request and never asks the AI again. *Edit as new commit* unlocks editing under new work/item ids.
- Only the latest draft request applies, and only if the input revision is unchanged since it was sent and the commit isn't frozen. Every actual project/context change bumps the revision, so A→B→A (even back to identical values) drops a pending result or failure and requires *Update draft* before Commit; this also covers edits mid-request and overlapping requests.
- Closing an uncommitted capture always asks **Keep Editing / Discard**. The capture and its AI draft count as unsent work.
- **Preview** (`--preview-capture`) shows a static draft labeled **SAMPLE · not written by AI**; AI and Commit are off.

## Build & run

```bash
cd macos
./scripts/bundle.sh          # → macos/build/CmdShift3.app
open build/CmdShift3.app
```

- Needs macOS 15+ and **Xcode installed** (SwiftUI macros are not in Command Line Tools). The script uses `/Applications/Xcode.app` automatically; set `DEVELOPER_DIR` to override.
- Built with `-Onone` on purpose: the Swift 6.4 optimizer silently dropped work-commit fields in this target.
- The app is ad-hoc signed, so macOS asks for **Screen Recording** again after every rebuild: System Settings → Privacy & Security → Screen Recording → enable CmdShift3, then relaunch it. Without it, screenshots contain only the wallpaper.

## Use

1. Start the server from the repo root: `npm start` (default `http://127.0.0.1:4317`).
2. Click the camera icon in the menu bar → enter the server URL and a demo login code (`may-demo` or `gary-demo`) → Sign in.
3. **⌃⇧⌘2** (or "New Work Commit" in the panel) → select a region.
4. In the capture card (see v0.3 below):
   - The AI draft appears on its own. Read it, optionally add context (then **Update draft**), and press **Commit ⌘↩**.
   - **Edit screenshot** opens the canvas: Box / Arrow / Highlight / Text, 5 colors, Undo / Clear. For text, type the label first, then click the image. **Edit draft** edits the summary and items; on a Shipped item the seal menu explicitly resolves an open blocker / next item.
   - With no AI on the server, choose **Continue manually** and write the items yourself.
   - After Commit the card shows the Git SHA and whether origin is synced. Esc cancels.
5. Panel: unseen count, Catch me up, last 5 commits. **Open CmdShift3** opens the full window (Catch me up / Feed with screenshot, annotations, and discussion / Project state). **Web** opens the dashboard.

## v0.2 capture workbench (historical — superseded by v0.3)

> Kept for reference only. v0.3 replaced the manual **Draft with AI** / folded *Review details* flow with the AI-first card above; the bullets below describe the old 0.2.0 build, not current behavior.

- After capture the screenshot fades/scales in (~250 ms) with one accent border pulse. Reduce Motion turns both off. The effect is view-only; the evidence PNG is untouched.
- Header: “Captured · Add a mark or tell your team what changed.” and the target project, always visible.
- Tools: Box / Arrow / Highlight / Text, 5 colors, Undo, Clear (all with accessibility labels and help). The comment box is focused on open. Return adds a new line. **Draft with AI** sends the screenshot and comment for a draft only; **Commit** publishes your update.
- AI fields stay folded under **Review details** until you Draft. AI states are labeled honestly: *no AI connected*, *AI unavailable — review by hand*, or the provider name.
- Closing with unsaved marks/comment asks **Keep Editing / Discard**. Cancel and close are disabled while a commit is in flight. A failed commit keeps everything for an exact retry.
- The hotkey while a composer is open (even minimized) brings that same draft back.
- New installs default to `https://cmdshift3-web-production.up.railway.app` and ask for your personal Mac code (web → **Connect Mac app**). A saved endpoint, e.g. the local `http://127.0.0.1:4317`, keeps being used; local demo codes are only hinted there.

### Layout preview (no permissions, no network)

```bash
build/CmdShift3.app/Contents/MacOS/CmdShift3 --preview-capture fixtures/preview-capture.png
```

Opens the same editor on a neutral fixture with a visible *Preview* badge. The app runs on an in-memory state: it does not read the saved account or endpoint, makes no network requests, writes nothing to UserDefaults, and registers no hotkey (a running real app keeps ⌃⇧⌘2). Draft, Commit and sign-in are disabled. A missing path or unreadable file exits with code 2. This is for layout review only. It is not a real capture.

## v0.5 Commit inbox (durable pre-commit captures)

- Every CmdShift3 capture (⌃⇧⌘2, **New capture**, or **Import Screenshot…**) is saved immediately to `~/Library/Application Support/CmdShift3/Drafts/<hash(server|account)>/<draft>/` as `capture.png` + versioned `draft.json`, and every edit autosaves. No bearer token, Mac code or password is stored.
- The **Commit** tab (first in the main window, also offered from the menu bar panel) lists this project's waiting captures: thumbnail, status, project, source and time; **Open** resumes the same capture, marks, note and draft. Other accounts/servers never see them.
- Closing the editor (**Save for later** / Esc / ✕) keeps the capture in the inbox. **Discard…** deletes it and asks first. Only a successful Commit removes it.
- Resuming never sends a new AI request by itself: a draft written for the same note is review-ready again; a changed note shows **Update draft**. A frozen (already submitted) capture can only be **retried** with the same commit id and content, so retries can't create duplicate Git records.
- macOS's own ⌘⇧3 / ⌘⇧4 screenshots don't go to CmdShift3. Use **Import Screenshot…** to bring one in (explicit file choice; nothing is scanned automatically).
- Selftest/preview launches never open the real Drafts folder (`--selftest --offline` checks this with a temporary directory).

## Headless acceptance test

Checks session → draft → commit → idempotent retry → feed → evidence → state → catch-up → comment against a running server. It needs no screen permission.

```bash
build/CmdShift3.app/Contents/MacOS/CmdShift3 --selftest --endpoint http://127.0.0.1:4317 --code may-demo
# optional: --project proj_cmdshift3 --image some.png
```

It also runs the v0.3 composer flow through the real `ComposerModel`: arrival draft with empty context, no Git write before review, the latest context is what commits, a frozen retry returns the same SHA with no new AI request, and an unreachable AI keeps the material.

Prints `PASS` and exits 0 on success. Note that it writes real Work Commits to the chosen project, so use a scratch server. Without `--endpoint` it targets the local `127.0.0.1:4317`, never the public service. `--selftest --offline` runs only the network-free model checks (including the composer window-identity and close guards); selftest launches never restore the saved session.

## Notes

- The demo login token is kept in UserDefaults, not Keychain, because the ad-hoc signature changes on every rebuild and Keychain would prompt each time.
- Captures above 7.5 MB are downscaled to fit the API's 8 MiB PNG limit.
- The panel and window poll every 10 s; SSE is not used by the macOS client yet.
