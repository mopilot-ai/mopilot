import CoreGraphics
import Foundation

// The element list `ocr.elements` returns: the accessibility tree flattened, plus text that only the
// pixels show (found by Vision OCR), all in global screen points so a click can use a frame directly.

public struct UIElement: Equatable {
    public var id: String
    public var text: String
    public var role: String
    /// Global points, top-left origin.
    public var frame: CGRect
    /// "ax" or "ocr".
    public var source: String
    public var confidence: Double?

    public init(id: String, text: String, role: String, frame: CGRect, source: String, confidence: Double? = nil) {
        self.id = id
        self.text = text
        self.role = role
        self.frame = frame
        self.source = source
        self.confidence = confidence
    }

    public var json: [String: Any] {
        var o: [String: Any] = [
            "id": id, "text": text, "role": role, "source": source,
            // Doubles, like the ax.snapshot frames flattenAX reads (CGFloat values don't cast to Double from Any)
            "frame": ["x": Double(frame.minX), "y": Double(frame.minY), "w": Double(frame.width), "h": Double(frame.height)] as [String: Double],
        ]
        if let confidence { o["confidence"] = confidence }
        return o
    }
}

/// Roles a click or keystroke can usefully land on, kept even when they have no text (icon buttons).
let actionableRoles: Set<String> = [
    "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXTextField", "AXTextArea",
    "AXComboBox", "AXSlider", "AXLink", "AXMenuItem", "AXTab", "AXDisclosureTriangle", "AXSwitch", "AXSearchField",
]

/// Flattens an `ax.snapshot` tree into elements with a frame: those with text, and actionable ones.
public func flattenAX(_ root: [String: Any]) -> [UIElement] {
    var out: [UIElement] = []
    func walk(_ node: [String: Any]) {
        let role = node["role"] as? String ?? ""
        let text = [node["title"], node["value"], node["description"], node["help"]]
            .compactMap { $0 as? String }.first { !$0.isEmpty } ?? ""
        if let f = node["frame"] as? [String: Double], let id = node["id"] as? String {
            let rect = CGRect(x: f["x"] ?? 0, y: f["y"] ?? 0, width: f["w"] ?? 0, height: f["h"] ?? 0)
            if rect.width > 0, rect.height > 0, !text.isEmpty || actionableRoles.contains(role) {
                out.append(UIElement(id: "ax:" + id, text: text, role: role, frame: rect, source: "ax"))
            }
        }
        for c in node["children"] as? [[String: Any]] ?? [] { walk(c) }
    }
    walk(root)
    return out
}

/// What a caller saw of an element in its snapshot (`expectElement`: role, and title and description when it
/// had them), checked against the element the same id names now. Ids are child-index paths, so after the UI
/// changes an id can name another control; values change as the user types, so they are not compared.
/// Nil when it is the same element; otherwise what is there now (e.g. `AXButton "Delete"`).
public func elementMismatch(_ expected: [String: Any]?, role: String?, title: String?, description: String?) -> String? {
    guard let expected else { return nil }
    func clip(_ s: String?) -> String { String((s ?? "").prefix(200)) }
    let same = (expected["role"] as? String ?? "") == (role ?? "")
        && clip(expected["title"] as? String) == clip(title)
        && clip(expected["description"] as? String) == clip(description)
    if same { return nil }
    let name = [title, description].compactMap { $0 }.first { !$0.isEmpty }
    return (role ?? "an element") + (name.map { " \"\($0.prefix(80))\"" } ?? "")
}

/// A Vision bounding box (normalized, origin bottom-left) in global points. The image covers the
/// display at `origin`, `pixelsPerPoint` pixels per point.
public func visionRectToPoints(_ n: CGRect, imageWidth: Int, imageHeight: Int, origin: CGPoint, pixelsPerPoint: Double) -> CGRect {
    let k = max(pixelsPerPoint, 0.0001)
    let w = Double(imageWidth), h = Double(imageHeight)
    return CGRect(x: origin.x + n.minX * w / k, y: origin.y + (1 - n.maxY) * h / k, width: n.width * w / k, height: n.height * h / k)
}

private func normalized(_ s: String) -> String {
    s.lowercased().filter { $0.isLetter || $0.isNumber }
}

/// OCR lines the accessibility tree already has (same words, same place) are dropped; the rest are
/// added after the AX elements, top to bottom. At most `limit` elements; `truncated` says if it cut.
public func mergeElements(ax: [UIElement], ocr: [UIElement], limit: Int = 400) -> (elements: [UIElement], truncated: Bool) {
    let known = ax.filter { !$0.text.isEmpty }.map { ($0.frame, normalized($0.text)) }
    var extra: [UIElement] = []
    for o in ocr {
        let t = normalized(o.text)
        if t.isEmpty { continue }
        let area = o.frame.width * o.frame.height
        let covered = known.contains { (frame, text) in
            guard !text.isEmpty, text.contains(t) || t.contains(text) else { return false }
            let i = frame.intersection(o.frame)
            return !i.isNull && area > 0 && (i.width * i.height) / area >= 0.5
        }
        if !covered { extra.append(o) }
    }
    extra.sort { a, b in a.frame.minY == b.frame.minY ? a.frame.minX < b.frame.minX : a.frame.minY < b.frame.minY }
    let all = ax + extra
    let limit = max(limit, 1)
    return (Array(all.prefix(limit)), all.count > limit)
}
