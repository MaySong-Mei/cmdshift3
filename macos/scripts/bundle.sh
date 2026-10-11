#!/usr/bin/env bash
# Builds macos/build/CmdShift3.app (menu bar app, ad-hoc signed).
set -euo pipefail
cd "$(dirname "$0")/.."

# SwiftUI macros need the full Xcode toolchain, not just Command Line Tools.
if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

# -Onone on purpose: Swift 6.4 -O miscompiled local state mutated across an
# await in this target (fields silently dropped). Speed does not matter here.
FLAGS=(-c release -Xswiftc -Onone)
swift build "${FLAGS[@]}"
BIN="$(swift build "${FLAGS[@]}" --show-bin-path)/CmdShift3"
APP=build/CmdShift3.app

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/CmdShift3"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.cmdshift3.app</string>
  <key>CFBundleName</key><string>CmdShift3</string>
  <key>CFBundleDisplayName</key><string>CmdShift3</string>
  <key>CFBundleExecutable</key><string>CmdShift3</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>15.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <!-- Demo server runs over plain HTTP on localhost / LAN. -->
    <key>NSAllowsArbitraryLoads</key><true/>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP" >/dev/null
echo "Built $(pwd)/$APP"
