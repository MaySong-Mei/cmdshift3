import AppKit
import SwiftUI

extension NSColor {
    /// Warm off-white / soft charcoal window surface for the capture card.
    static let cmd3Surface = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedRed: 0.118, green: 0.118, blue: 0.122, alpha: 1)
            : NSColor(calibratedRed: 0.980, green: 0.976, blue: 0.965, alpha: 1)
    }

    /// Slightly raised panels on top of the surface.
    static let cmd3Raised = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(calibratedRed: 0.160, green: 0.160, blue: 0.165, alpha: 1)
            : NSColor.white
    }
}

enum Theme {
    static let surface = Color(nsColor: .cmd3Surface)
    static let raised = Color(nsColor: .cmd3Raised)
    static let hairline = Color.primary.opacity(0.09)
    static let subtle = Color.primary.opacity(0.06)
    static let selected = Color.primary.opacity(0.09)
}

/// Quiet raised panel: thin border, no heavy shadow.
struct Panel: ViewModifier {
    var radius: CGFloat = 12
    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.raised))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Theme.hairline))
    }
}

extension View {
    func panel(radius: CGFloat = 12) -> some View { modifier(Panel(radius: radius)) }
}

/// The one primary action: solid single-color pill (inverts in dark mode).
struct PrimaryPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        PrimaryPill(configuration: configuration)
    }

    private struct PrimaryPill: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled

        var body: some View {
            configuration.label
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .foregroundStyle(Color(nsColor: .cmd3Surface))
                .background(Capsule().fill(Color.primary.opacity(configuration.isPressed ? 0.7 : 0.92)))
                .opacity(isEnabled ? 1 : 0.3)
                .contentShape(Capsule())
        }
    }
}

/// Secondary actions: text with a faint pill, no color.
struct QuietPillStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        QuietPill(configuration: configuration)
    }

    private struct QuietPill: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.callout)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .foregroundStyle(.primary.opacity(isEnabled ? 0.8 : 0.3))
                .background(Capsule().fill(Color.primary.opacity(configuration.isPressed ? 0.12 : (hovering ? 0.08 : 0.05))))
                .contentShape(Capsule())
                .onHover { hovering = $0 }
        }
    }
}

/// The captured screenshot's highlight: a steady soft accent outline + glow
/// (always visible), and one short pulse when the capture first arrives.
/// View-only — never burned into the evidence PNG. Reduce Motion keeps the
/// static highlight and skips the pulse and fade.
struct CaptureHighlight: ViewModifier {
    var radius: CGFloat = 12
    /// Animate the arrival (only the first time this composer shows the capture).
    let animateArrival: Bool
    let onArrived: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var pulse = 0.0

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return content
            .clipShape(shape)
            .background(shape.fill(Color.accentColor.opacity(0.22)).blur(radius: 14).allowsHitTesting(false))
            .overlay(shape.strokeBorder(Color.accentColor.opacity(0.55), lineWidth: 1.5).allowsHitTesting(false))
            .overlay(
                RoundedRectangle(cornerRadius: radius + 5, style: .continuous)
                    .stroke(Color.accentColor.opacity(pulse), lineWidth: 3)
                    .padding(-5)
                    .allowsHitTesting(false)
            )
            .opacity(appeared || !animateArrival || reduceMotion ? 1 : 0)
            .scaleEffect(appeared || !animateArrival || reduceMotion ? 1 : 0.97)
            .onAppear {
                guard animateArrival, !reduceMotion else {
                    appeared = true
                    onArrived()
                    return
                }
                onArrived()
                withAnimation(.easeOut(duration: 0.25)) { appeared = true }
                pulse = 0.9
                withAnimation(.easeOut(duration: 0.9).delay(0.15)) { pulse = 0 }
            }
    }
}

/// Small rounded label used for the project, AI provider and sample markers.
struct Pill: View {
    let text: String
    var systemImage: String?
    var tint: Color = .primary

    var body: some View {
        HStack(spacing: 4) {
            if let systemImage { Image(systemName: systemImage).imageScale(.small) }
            Text(text).lineLimit(1)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tint.opacity(0.85))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(tint.opacity(0.08)))
    }
}
