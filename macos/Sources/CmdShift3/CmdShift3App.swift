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
            Image(systemName: "camera.viewfinder")
            if app.unseenCount > 0 { Text("\(app.unseenCount)") }
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
        hotKey = HotKey { AppState.shared.startCapture() }
    }
}
