import AppKit
import SwiftUI

@main
struct CmdShift3App: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var app = AppState.shared

    var body: some Scene {
        MenuBarExtra {
            MenuPanel().environmentObject(app)
        } label: {
            MenuBarLabel().environmentObject(app)
        }
        .menuBarExtraStyle(.window)

        Window("CmdShift3", id: "main") {
            MainView()
                .environmentObject(app)
                .frame(minWidth: 900, minHeight: 560)
        }
        .defaultLaunchBehavior(.suppressed)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var hotKey: HotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if CommandLine.arguments.contains("--selftest") {
            Task { await SelfTest.run() }
            return
        }
        if AppState.previewRequested {
            // Layout review only: no hotkey, so a running real app keeps ⌃⇧⌘2.
            guard let path = AppState.previewCapturePath else {
                print("usage: CmdShift3 --preview-capture <path-to-png>")
                exit(2)
            }
            AppState.shared.openPreview(path: path)
            return
        }
        hotKey = HotKey { AppState.shared.startCapture() }
    }
}

/// The menu bar label is rendered at launch, so it is where we can reach
/// openWindow: with no saved session, open the main window for sign-in.
struct MenuBarLabel: View {
    @EnvironmentObject var app: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "camera.viewfinder")
            if app.unseenCount > 0 { Text("\(app.unseenCount)") }
        }
        .onAppear {
            guard !CommandLine.arguments.contains("--selftest"), !app.isPreview, !app.hasSavedSession else { return }
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: .cmd3NeedsSignIn)) { _ in
            openWindow(id: "main")
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}
