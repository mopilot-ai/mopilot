// Renders macOS's resolved helper icon alongside its canonical resource and the generic app icon.
import AppKit
import UniformTypeIdentifiers

let bundlePath = CommandLine.arguments[1]
let sourcePath = CommandLine.arguments[2]
let output = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
guard let reference = NSImage(contentsOfFile: sourcePath) else {
    fatalError("Could not load the canonical MoPilot icon")
}

func render(_ image: NSImage, name: String) throws -> [UInt8] {
    let side = 128
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: side * 4, bitsPerPixel: 32
    )!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    image.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
    return Array(UnsafeBufferPointer(start: bitmap.bitmapData!, count: side * side * 4))
}

func difference(_ a: [UInt8], _ b: [UInt8]) -> Double {
    Double(zip(a, b).reduce(0) { $0 + abs(Int($1.0) - Int($1.1)) }) / Double(a.count)
}

let expected = try render(reference, name: "canonical-mopilot-icon.png")
let actual = try render(NSWorkspace.shared.icon(forFile: bundlePath), name: "resolved-helper-icon.png")
let generic = try render(NSWorkspace.shared.icon(for: .applicationBundle), name: "generic-app-icon.png")
let info = Bundle(path: bundlePath)!.infoDictionary!
let result: [String: Any] = [
    "bundleId": info["CFBundleIdentifier"]!,
    "iconFile": info["CFBundleIconFile"] ?? NSNull(),
    "meanAbsoluteError": difference(actual, expected),
    "genericMeanAbsoluteError": difference(generic, expected)
]
print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
