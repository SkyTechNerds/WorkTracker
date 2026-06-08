// generate_icon.swift — erzeugt AppIcon.png (1024x1024): abgerundetes Quadrat
// mit Farbverlauf und weisser Aktentasche. Aufruf: `swift generate_icon.swift`
import AppKit

let S: CGFloat = 1024

// Weisses Symbol vorab rendern (sourceAtop-Tinting).
func whiteSymbol(_ name: String, pointSize: CGFloat) -> NSImage {
    let cfg = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
    let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)!
        .withSymbolConfiguration(cfg)!
    let out = NSImage(size: base.size)
    out.lockFocus()
    base.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
    NSColor.white.set()
    NSRect(origin: .zero, size: base.size).fill(using: .sourceAtop)
    out.unlockFocus()
    return out
}

let glyph = whiteSymbol("briefcase.fill", pointSize: 470)

let image = NSImage(size: NSSize(width: S, height: S))
image.lockFocus()

// Abgerundetes Quadrat mit Rand (macOS-Icon-Grid).
let margin: CGFloat = 96
let rect = NSRect(x: margin, y: margin, width: S - 2*margin, height: S - 2*margin)
let radius = rect.width * 0.2237
let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

// Farbverlauf (oben hell -> unten dunkelblau).
let top = NSColor(srgbRed: 0.32, green: 0.58, blue: 0.99, alpha: 1)
let bottom = NSColor(srgbRed: 0.13, green: 0.27, blue: 0.62, alpha: 1)
NSGradient(colors: [top, bottom])!.draw(in: path, angle: -90)

// Aktentasche mittig.
let gw = glyph.size.width, gh = glyph.size.height
let target = S * 0.46
let scale = target / gw
let dw = gw * scale, dh = gh * scale
glyph.draw(in: NSRect(x: (S - dw)/2, y: (S - dh)/2, width: dw, height: dh))

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    fputs("Fehler beim Rendern\n", stderr); exit(1)
}
let url = URL(fileURLWithPath: "AppIcon.png")
try! png.write(to: url)
print("✓ AppIcon.png erzeugt (\(Int(S))x\(Int(S)))")
