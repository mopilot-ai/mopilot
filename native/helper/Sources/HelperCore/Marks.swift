import CoreGraphics
import Foundation

// Marks on a window screenshot whose accessibility list is sparse (Electron or canvas apps, #3571 G7): which OCR text
// lines get a number (not those an accessibility element already covers), in reading order, and where each number's
// label goes on the image.

/// One numbered mark: the element_index main gives it, the text OCR read, its frame in global points.
public struct Mark: Equatable {
    public let n: Int
    public let text: String
    public let frame: CGRect

    public init(n: Int, text: String, frame: CGRect) {
        self.n = n
        self.text = text
        self.frame = frame
    }

    public var json: [String: Any] {
        ["n": n, "text": text, "frame": ["x": Double(frame.minX), "y": Double(frame.minY), "w": Double(frame.width), "h": Double(frame.height)]]
    }
}

/// The most marks one screenshot carries.
public let maxMarks = 80

/// The OCR lines to number, from `start`: lines with text whose center no `taken` frame (the accessibility elements
/// main already listed) holds, inside `window`, in reading order (top to bottom by line, then left to right), at most
/// `limit`.
public func chooseMarks(ocr: [UIElement], taken: [CGRect], window: CGRect, start: Int, limit: Int = maxMarks) -> [Mark] {
    let lines = ocr.filter { e in
        let c = CGPoint(x: e.frame.midX, y: e.frame.midY)
        return !e.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && window.contains(c) && !taken.contains { $0.contains(c) }
    }
    // the same line: centers within half the shorter line's height
    let sorted = lines.sorted { a, b in
        if abs(a.frame.midY - b.frame.midY) > min(a.frame.height, b.frame.height) / 2 { return a.frame.midY < b.frame.midY }
        return a.frame.minX < b.frame.minX
    }
    return sorted.prefix(max(0, min(limit, maxMarks))).enumerated().map { i, e in
        Mark(n: start + i, text: String(e.text.prefix(200)), frame: e.frame)
    }
}

/// A frame in global points as image pixels: `origin` is the window's top-left in points, `ppp` the image's pixels per
/// point.
public func pixelRect(_ r: CGRect, origin: CGPoint, ppp: Double) -> CGRect {
    CGRect(x: (r.minX - origin.x) * ppp, y: (r.minY - origin.y) * ppp, width: r.width * ppp, height: r.height * ppp)
}

/// Where a mark's number label goes (top-left image pixels): just above the box's top-left corner, or inside it when
/// there is no room above, kept inside the image.
public func labelRect(box: CGRect, size: CGSize, image: CGSize) -> CGRect {
    var x = box.minX
    var y = box.minY - size.height
    if y < 0 { y = box.minY }
    x = min(max(0, x), max(0, image.width - size.width))
    y = min(max(0, y), max(0, image.height - size.height))
    return CGRect(origin: CGPoint(x: x, y: y), size: size)
}

/// What fixes a window capture's pixels: the window and how app.screenshot sized the frame (`maxSide`, `maxPixels`,
/// `scale`).
public struct ShotKey: Equatable {
    public let windowId: Int
    public let maxSide: Int
    public let maxPixels: Int?
    public let scale: Double

    public init(windowId: Int, maxSide: Int, maxPixels: Int?, scale: Double) {
        self.windowId = windowId
        self.maxSide = maxSide
        self.maxPixels = maxPixels
        self.scale = scale
    }
}

/// How long app.marks may reuse the capture of the app.screenshot before it (#3939): that request follows at once, so a
/// longer gap means the screenshot's answer was held up, and the window is captured again.
public let reuseShotMs = 8000.0

/// Whether the capture remembered under `held` (taken at `heldAtMs`) is the one `want` asks for at `nowMs`: the same
/// window sized the same way, not older than `reuseShotMs`. The marks then sit on the very pixels the accessibility
/// list was read next to, with no second capture.
public func canReuseShot(held: ShotKey?, heldAtMs: Double, want: ShotKey, nowMs: Double) -> Bool {
    guard let held, held == want else { return false }
    let age = nowMs - heldAtMs
    return age >= 0 && age <= reuseShotMs
}
