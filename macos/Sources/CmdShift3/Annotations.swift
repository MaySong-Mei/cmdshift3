import SwiftUI

extension Color {
    init(hex: String) {
        let s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let v = UInt64(s, radix: 16) ?? 0xF97066
        self.init(red: Double((v >> 16) & 0xFF) / 255,
                  green: Double((v >> 8) & 0xFF) / 255,
                  blue: Double(v & 0xFF) / 255)
    }
}

let annotationColors = ["#F97066", "#FDB022", "#32D583", "#2E90FA", "#7A5AF8"]

/// Draws relative (0–1) annotations over a view of the given size.
struct AnnotationLayer: View {
    let annotations: [Annotation]

    var body: some View {
        Canvas { ctx, size in
            for a in annotations { draw(a, in: &ctx, size: size) }
        }
        .allowsHitTesting(false)
    }

    private func draw(_ a: Annotation, in ctx: inout GraphicsContext, size: CGSize) {
        let color = Color(hex: a.color)
        let x = a.x * size.width, y = a.y * size.height
        let w = a.w * size.width, h = a.h * size.height
        switch a.type {
        case .rect:
            ctx.stroke(Path(CGRect(x: x, y: y, width: w, height: h)), with: .color(color), lineWidth: 3)
        case .highlight:
            ctx.fill(Path(CGRect(x: x, y: y, width: w, height: h)), with: .color(color.opacity(0.3)))
        case .arrow:
            let start = CGPoint(x: x, y: y), end = CGPoint(x: x + w, y: y + h)
            var line = Path()
            line.move(to: start); line.addLine(to: end)
            ctx.stroke(line, with: .color(color), style: StrokeStyle(lineWidth: 3, lineCap: .round))
            let angle = atan2(end.y - start.y, end.x - start.x)
            let len: CGFloat = 14
            var head = Path()
            head.move(to: end)
            head.addLine(to: CGPoint(x: end.x - len * cos(angle - .pi / 7), y: end.y - len * sin(angle - .pi / 7)))
            head.move(to: end)
            head.addLine(to: CGPoint(x: end.x - len * cos(angle + .pi / 7), y: end.y - len * sin(angle + .pi / 7)))
            ctx.stroke(head, with: .color(color), style: StrokeStyle(lineWidth: 3, lineCap: .round))
        case .text:
            let text = Text(a.text ?? "").font(.system(size: 16, weight: .bold)).foregroundColor(color)
            let resolved = ctx.resolve(text)
            let textSize = resolved.measure(in: size)
            let bg = CGRect(x: x - 4, y: y - 2, width: textSize.width + 8, height: textSize.height + 4)
            ctx.fill(Path(roundedRect: bg, cornerRadius: 4), with: .color(.black.opacity(0.55)))
            ctx.draw(resolved, at: CGPoint(x: x, y: y), anchor: .topLeading)
        }
    }
}

/// Screenshot with an interactive annotation overlay.
struct AnnotationCanvas: View {
    let image: NSImage
    @Binding var annotations: [Annotation]
    let tool: AnnotationType
    let color: String
    let text: String

    @State private var start: CGPoint?
    @State private var current: CGPoint?

    var body: some View {
        Image(nsImage: image)
            .resizable()
            .aspectRatio(contentMode: .fit)
            .overlay(
                GeometryReader { geo in
                    AnnotationLayer(annotations: annotations + (pending(size: geo.size).map { [$0] } ?? []))
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { v in
                                    if start == nil { start = v.startLocation }
                                    current = v.location
                                }
                                .onEnded { _ in
                                    if let a = pending(size: geo.size) { annotations.append(a) }
                                    start = nil; current = nil
                                }
                        )
                        .allowsHitTesting(true)
                }
            )
    }

    private func clamp(_ v: Double) -> Double { min(max(v, 0), 1) }

    private func pending(size: CGSize) -> Annotation? {
        guard let s = start, let c = current, size.width > 0, size.height > 0 else { return nil }
        let x0 = clamp(s.x / size.width), y0 = clamp(s.y / size.height)
        let x1 = clamp(c.x / size.width), y1 = clamp(c.y / size.height)
        switch tool {
        case .rect, .highlight:
            let w = abs(x1 - x0), h = abs(y1 - y0)
            guard w > 0.005, h > 0.005 else { return nil }
            return Annotation(type: tool, x: min(x0, x1), y: min(y0, y1), w: w, h: h, text: nil, color: color)
        case .arrow:
            guard abs(x1 - x0) + abs(y1 - y0) > 0.01 else { return nil }
            return Annotation(type: .arrow, x: x0, y: y0, w: x1 - x0, h: y1 - y0, text: nil, color: color)
        case .text:
            let t = text.trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty else { return nil }
            return Annotation(type: .text, x: x1, y: y1, w: 0, h: 0, text: t, color: color)
        }
    }
}
