// app.marks (#3571 G7): a window whose accessibility list is sparse (Electron or canvas apps) captured again as
// app.screenshot sized it, its text found by Vision OCR, and the lines no listed element covers drawn as numbered
// boxes, numbered from where main's element list ends, so element_index reaches them. The choice and placement are
// HelperCore/Marks.swift.
import AppKit
import CoreText
import Foundation
import HelperCore
import ScreenCaptureKit

private func bridge<T>(_ body: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var result: Result<T, Error>?
    Task.detached {
        do { result = .success(try await body()) } catch { result = .failure(error) }
        done.signal()
    }
    done.wait()
    return try result!.get()
}

private func rect(_ v: Any?) -> CGRect? {
    guard let a = v as? [Double], a.count == 4 else { return nil }
    return CGRect(x: a[0], y: a[1], width: a[2], height: a[3])
}

/// The last full-window capture app.screenshot made (#3939): app.marks follows it at once for a sparse window, and
/// draws on these pixels instead of capturing the window again.
private var heldShot: (key: ShotKey, atMs: Double, image: CGImage, frame: WindowFrame)?
private let heldShotLock = NSLock()

/// Remembers the capture app.screenshot just made (one slot: the newest).
func holdShot(_ key: ShotKey, image: CGImage, frame: WindowFrame) {
    heldShotLock.lock()
    heldShot = (key, nowMs(), image, frame)
    heldShotLock.unlock()
}

/// The held capture when it is the one `key` asks for and still fresh.
private func heldShot(for key: ShotKey) -> (CGImage, WindowFrame)? {
    heldShotLock.lock()
    defer { heldShotLock.unlock() }
    guard let h = heldShot, canReuseShot(held: h.key, heldAtMs: h.atMs, want: key, nowMs: nowMs()) else { return nil }
    return (h.image, h.frame)
}

/// The window, captured at the frame app.screenshot used (`maxSide`, `maxPixels`, `scale`).
private func captureForMarks(_ id: CGWindowID, maxSide: Int, maxPixels: Int?, imageScale: Double) throws -> (CGImage, WindowFrame) {
    try bridge {
        try await retryingCapture {
            let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            guard let w = content.windows.first(where: { $0.windowID == id }) else { throw NoWindowsToCapture() }
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let frame = WindowFrame.forWindow(bounds: w.frame, scale: Double(filter.pointPixelScale), maxSide: maxSide, maxPixels: maxPixels)
            let cfg = SCStreamConfiguration()
            cfg.showsCursor = false
            cfg.ignoreShadowsSingleWindow = true
            let k = max(0.1, min(imageScale, 1))
            cfg.width = max(1, Int((Double(frame.width) * k).rounded()))
            cfg.height = max(1, Int((Double(frame.height) * k).rounded()))
            return (try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg), frame)
        }
    }
}

/// `image` with each mark's box and number drawn on it.
private func drawMarks(_ marks: [Mark], on image: CGImage, origin: CGPoint, ppp: Double) -> CGImage? {
    let w = image.width, h = image.height
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    // CoreGraphics draws bottom-up; the marks are top-down
    ctx.translateBy(x: 0, y: CGFloat(h))
    ctx.scaleBy(x: 1, y: -1)
    let red = CGColor(red: 0.9, green: 0.1, blue: 0.2, alpha: 1)
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, max(11, CGFloat(ppp) * 7), nil)
    for m in marks {
        let box = pixelRect(m.frame, origin: origin, ppp: ppp)
        ctx.setStrokeColor(red)
        ctx.setLineWidth(max(1, CGFloat(ppp)))
        ctx.stroke(box)
        let text = NSAttributedString(string: "\(m.n)", attributes: [.font: font, .foregroundColor: NSColor.white])
        let line = CTLineCreateWithAttributedString(text)
        let b = CTLineGetBoundsWithOptions(line, .useOpticalBounds)
        let label = labelRect(box: box, size: CGSize(width: b.width + 6, height: b.height + 4), image: CGSize(width: w, height: h))
        ctx.setFillColor(red)
        ctx.fill(label)
        ctx.saveGState()
        // text draws upright: flip back around the label
        ctx.translateBy(x: label.minX + 3, y: label.maxY - 2)
        ctx.scaleBy(x: 1, y: -1)
        ctx.textPosition = CGPoint(x: -b.minX, y: -b.minY)
        CTLineDraw(line, ctx)
        ctx.restoreGState()
    }
    return ctx.makeImage()
}

/// app.marks: {windowId, start, taken: [[x, y, w, h]] (global points), maxSide, maxPixels, scale, quality, reuse}.
func markWindow(_ params: [String: Any]) throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else { throw HelperError.permission(.screenRecording) }
    guard let id = params["windowId"] as? Int, id > 0 else { throw HelperError.invalidParams("windowId") }
    let start = max(1, params["start"] as? Int ?? 1)
    let taken = (params["taken"] as? [Any] ?? []).compactMap(rect)
    let maxSide = cappedSide(params["maxSide"] as? Int, fallback: 1568)
    let maxPixels = params["maxPixels"] as? Int
    let imageScale = params["scale"] as? Double ?? 1
    let key = ShotKey(windowId: id, maxSide: maxSide, maxPixels: maxPixels, scale: imageScale)
    // `reuse`: main asks for the pixels of the app.screenshot it just made, the ones its element list was read beside
    let held = params["reuse"] as? Bool == true ? heldShot(for: key) : nil
    let (image, frame) = try held ?? captureForMarks(CGWindowID(id), maxSide: maxSide, maxPixels: maxPixels, imageScale: imageScale)
    let ppp = Double(image.width) / max(Double(frame.bounds.width), 1)
    let shot = AppShot(image: image, display: 0, frame: frame.bounds)
    let marks = chooseMarks(ocr: try recognizeText(in: shot), taken: taken, window: frame.bounds, start: start,
                            limit: params["limit"] as? Int ?? maxMarks)
    let drawn = marks.isEmpty ? image : (drawMarks(marks, on: image, origin: frame.bounds.origin, ppp: ppp) ?? image)
    let data = try encodeImage(drawn, jpeg: true, quality: params["quality"] as? Double ?? 0.8)
    return [
        "jpeg": data.base64EncodedString(), "mimeType": "image/jpeg", "width": drawn.width, "height": drawn.height,
        "frame": ["width": frame.width, "height": frame.height], "marks": marks.map(\.json),
    ]
}
