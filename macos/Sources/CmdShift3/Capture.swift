import AppKit
import CoreGraphics

enum Capture {
    enum Outcome {
        case captured(Data)
        case cancelled
        case failed(String)
    }

    /// Runs the system's interactive screenshot UI (same as ⌘⇧4: drag a region,
    /// or press Space to pick a window). Esc leaves no file → .cancelled.
    static func interactive() async -> Outcome {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("cmdshift3-\(UUID().uuidString).png")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-i", "-x", "-t", "png", url.path]
        let launchError: String? = await withCheckedContinuation { (cont: CheckedContinuation<String?, Never>) in
            process.terminationHandler = { _ in cont.resume(returning: nil) }
            do { try process.run() } catch { cont.resume(returning: error.localizedDescription) }
        }
        defer { try? FileManager.default.removeItem(at: url) }
        if let launchError { return .failed("Could not start screencapture: \(launchError)") }
        guard FileManager.default.fileExists(atPath: url.path) else {
            return process.terminationStatus == 0 ? .cancelled : .failed("screencapture exited with status \(process.terminationStatus).")
        }
        guard let data = try? Data(contentsOf: url), !data.isEmpty else { return .failed("The screenshot file could not be read.") }
        return .captured(data)
    }

    /// Owner of the topmost normal window that is not ours (fallback when no
    /// other app has been activated since launch).
    static func topmostOtherApp() -> NSRunningApplication? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
            if let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != getpid() {
                return NSRunningApplication(processIdentifier: pid)
            }
        }
        return nil
    }

    /// App name + frontmost window title, used as free context for the draft.
    static func source(for app: NSRunningApplication?) -> Source {
        var title = ""
        if let pid = app?.processIdentifier,
           let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
            for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
                if let name = w[kCGWindowName as String] as? String, !name.isEmpty {
                    title = name
                    break
                }
            }
        }
        return Source(appName: app?.localizedName ?? "Unknown", windowTitle: title, captureKind: "region")
    }

    /// API v1 caps decoded PNG at 8 MiB; Retina full-screen captures can exceed it.
    static func pngWithinLimit(_ data: Data, limit: Int = 7_500_000) -> Data {
        guard data.count > limit, let rep = NSBitmapImageRep(data: data) else { return data }
        var out = data
        var scale = 1.0
        while out.count > limit && scale > 0.2 {
            scale *= 0.75
            let w = Int(Double(rep.pixelsWide) * scale)
            let h = Int(Double(rep.pixelsHigh) * scale)
            guard let small = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
                                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { break }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: small)
            rep.draw(in: NSRect(x: 0, y: 0, width: w, height: h))
            NSGraphicsContext.restoreGraphicsState()
            out = small.representation(using: .png, properties: [:]) ?? out
        }
        return out
    }
}
