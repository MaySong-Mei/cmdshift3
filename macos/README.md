# CmdShift3 for macOS

Menu bar client: press **⌃⇧⌘2** anywhere → select a region (or press Space to pick a window, same as ⌘⇧4) → annotate → write what changed → Draft fields → **Commit ⌘↩**. The server turns it into a real Git commit; teammates see it in the menu bar, the app window, and the web dashboard.

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
4. In the composer:
   - Left: Box / Arrow / Text / Highlight tools, 5 colors, ⌘Z to undo. For text, type the label first, then click the image.
   - Right: write what changed → **Draft fields** (⌘D). With no AI configured on the server, the badge says *Manual — no AI connected* and you fill SHIPPED / DECISION / WHY / BLOCKER / NEXT yourself.
   - On a SHIPPED item, **Resolves…** explicitly closes an open blocker / next item.
   - **Commit ⌘↩**. The result shows the Git SHA and whether origin is synced. Esc cancels.
5. Panel: unseen count, Catch me up, last 5 commits. **Open CmdShift3** opens the full window (Catch me up / Feed with screenshot, annotations, and discussion / Project state). **Web** opens the dashboard.

## Headless acceptance test

Checks session → draft → commit → idempotent retry → feed → evidence → state → catch-up → comment against a running server. It needs no screen permission.

```bash
build/CmdShift3.app/Contents/MacOS/CmdShift3 --selftest --endpoint http://127.0.0.1:4317 --code may-demo
# optional: --project proj_cmdshift3 --image some.png
```

Prints `PASS` and exits 0 on success. Note that it writes a real Work Commit to the chosen project.

## Notes

- The demo login token is kept in UserDefaults, not Keychain, because the ad-hoc signature changes on every rebuild and Keychain would prompt each time.
- Captures above 7.5 MB are downscaled to fit the API's 8 MiB PNG limit.
- The panel and window poll every 10 s; SSE is not used by the macOS client yet.
