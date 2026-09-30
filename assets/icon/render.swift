// Renders the flat TDP Daily Deals icon (dark tile + ticket + marks) as PNGs: swift render.swift <out dir>
import AppKit
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let ticket = NSImage(contentsOf: here.appendingPathComponent("ticket.svg"))!
let marks = NSImage(contentsOf: here.appendingPathComponent("marks.svg"))!
func render(_ px: Int, tile: Bool) -> Data {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let w = CGFloat(px)
    var art = NSRect(x: 0, y: 0, width: w, height: w)
    if tile {
        let inset = w * 0.08
        let r = NSRect(x: inset, y: inset, width: w - 2 * inset, height: w - 2 * inset)
        let path = NSBezierPath(roundedRect: r, xRadius: r.width * 0.22, yRadius: r.width * 0.22)
        NSGradient(colors: [NSColor(srgbRed: 0.20, green: 0.11, blue: 0.32, alpha: 1), NSColor(srgbRed: 0.055, green: 0.043, blue: 0.078, alpha: 1)])!
            .draw(in: path, angle: -90)
        art = r
    }
    ticket.draw(in: art); marks.draw(in: art)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])!
}
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
for px in [16, 32, 48, 64, 128, 256, 512, 1024] {
    try! render(px, tile: true).write(to: dir.appendingPathComponent("icon-\(px).png"))
}
try! render(512, tile: false).write(to: dir.appendingPathComponent("ticket-512.png"))
print("ok")
