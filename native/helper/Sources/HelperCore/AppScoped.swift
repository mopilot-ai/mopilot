import CoreGraphics
import Foundation

// The pure parts of app-scoped (background) control, the app.* helper requests: one window of one app is
// captured and acted in without bringing the app to the front or moving the user's pointer. Accessibility
// actions go first; events posted to the app's own process (CGEvent.postToPid) second; anything else is
// refused as unsupported rather than falling back to global input. None of this needs TCC.

// MARK: - Errors

extension HelperError {
    /// The background route can't do this; the caller gets a structured reason ("menu", "canvas", ...).
    public static func unsupported(_ what: String, _ detail: String) -> HelperError {
        HelperError(12, "unsupported", "unsupported(\(what)): \(detail)")
    }
    public static let notRunning = HelperError(11, "not_running", "the app is not running")
    public static let windowGone = HelperError(13, "window_gone", "that window is gone; list the windows again")
    public static func elementGone(_ id: String) -> HelperError { HelperError(14, "element_gone", "element \(id) is gone; take a new app_screenshot") }
    /// The id still names an element, but not the one the caller saw (`expectElement`): the UI changed.
    public static func elementChanged(_ id: String, now: String) -> HelperError {
        HelperError(18, "element_changed", "element \(id) is now \(now), not the element in the screenshot; take a new screenshot")
    }
    /// The menu item a path names exists but the app disables it: told apart from a missing item.
    public static func menuDisabled(_ path: [String]) -> HelperError {
        HelperError(17, "menu_disabled", "\(path.joined(separator: " > ")) is disabled right now")
    }
}

// MARK: - Window coordinate frame

/// One window's coordinate frame: the window's bounds in global points (top-left origin) and the pixel
/// size of its full-resolution screenshot. Coordinates the model passes are pixels of this frame.
public struct WindowFrame: Equatable {
    public let bounds: CGRect
    public let width: Int
    public let height: Int

    public init(bounds: CGRect, width: Int, height: Int) {
        self.bounds = bounds
        self.width = max(1, width)
        self.height = max(1, height)
    }

    /// The frame for a window of `bounds` points on a display of `scale` pixels per point, sized for the model.
    public static func forWindow(bounds: CGRect, scale: Double, maxSide: Int, maxPixels: Int?) -> WindowFrame {
        let s = captureSize(widthPoints: Double(bounds.width), heightPoints: Double(bounds.height), scale: scale, maxSide: maxSide, maxPixels: maxPixels)
        return WindowFrame(bounds: bounds, width: s.width, height: s.height)
    }

    /// Frame pixels per point.
    public var pixelsPerPoint: Double { Double(width) / max(Double(bounds.width), 1) }

    /// A frame pixel as a global point.
    public func toScreen(_ p: CGPoint) -> CGPoint {
        let k = pixelsPerPoint
        return CGPoint(x: bounds.minX + p.x / k, y: bounds.minY + p.y / k)
    }

    /// A global point as a frame pixel.
    public func toPixels(_ p: CGPoint) -> CGPoint {
        let k = pixelsPerPoint
        return CGPoint(x: (p.x - bounds.minX) * k, y: (p.y - bounds.minY) * k)
    }

    public func contains(pixel p: CGPoint) -> Bool {
        p.x >= 0 && p.y >= 0 && p.x < Double(width) && p.y < Double(height)
    }
}

// MARK: - Window state

/// Where a window is relative to the user's current desktop.
public enum WindowState: String, Equatable {
    case visible
    case minimized
    case appHidden = "app_hidden"
    case offSpace = "off_space"
}

/// The app being hidden wins (all its windows are gone), then a minimized window; a window that is
/// neither but isn't on screen is on another Space.
public func windowState(isOnScreen: Bool, isMinimized: Bool, appHidden: Bool) -> WindowState {
    if appHidden { return .appHidden }
    if isMinimized { return .minimized }
    return isOnScreen ? .visible : .offSpace
}

/// Whether events posted to the app's process can reach the window: only one on the current Space.
/// Accessibility actions work in every state.
public func acceptsPostedEvents(_ state: WindowState) -> Bool { state == .visible }

/// A window the window server lists: what `app_list_windows` reports for it.
public struct ListedWindow: Equatable {
    public let id: UInt32
    public let title: String
    public let bounds: CGRect
    public let layer: Int
    public let alpha: Double
    public let onScreen: Bool

    public init(id: UInt32, title: String, bounds: CGRect, layer: Int, alpha: Double, onScreen: Bool) {
        self.id = id
        self.title = title
        self.bounds = bounds
        self.layer = layer
        self.alpha = alpha
        self.onScreen = onScreen
    }
}

/// The windows worth listing: visible ones of a usable size (apps keep tiny or transparent helper
/// windows around), normal-level ones first and then panels, each group in the server's order.
public func listableWindows(_ windows: [ListedWindow], minSide: Double = 40) -> [ListedWindow] {
    let usable = windows.filter { $0.alpha > 0 && $0.bounds.width >= minSide && $0.bounds.height >= minSide && $0.layer >= 0 && $0.layer < 25 }
    return usable.filter { $0.layer == 0 } + usable.filter { $0.layer != 0 }
}

/// Whether a listed window is one the user has: on screen, or matched to an accessibility window (a
/// minimized or off-Space one), or any window of a hidden app. An off-screen window with no
/// accessibility counterpart is one the app ordered out.
public func keepWindow(onScreen: Bool, axMatched: Bool, appHidden: Bool) -> Bool {
    onScreen || axMatched || appHidden
}

/// An accessibility window, for matching to a window-server window.
public struct AXWindowCandidate: Equatable {
    public let frame: CGRect?
    public let title: String?

    public init(frame: CGRect?, title: String?) {
        self.frame = frame
        self.title = title
    }
}

private func near(_ a: CGRect, _ b: CGRect, _ tolerance: Double) -> Bool {
    abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}

/// The accessibility window that is the window-server window of `bounds` and `title` (public APIs have
/// no window id on an AXUIElement): the same frame (and title, when several share it), else the same
/// size and title (a minimized window keeps its size). Nil when nothing matches.
public func matchAXWindow(bounds: CGRect, title: String?, candidates: [AXWindowCandidate]) -> Int? {
    let sameFrame = candidates.indices.filter { candidates[$0].frame.map { near($0, bounds, 2) } ?? false }
    if sameFrame.count == 1 { return sameFrame[0] }
    let t = title ?? ""
    if sameFrame.count > 1 { return sameFrame.first { (candidates[$0].title ?? "") == t } ?? sameFrame[0] }
    guard !t.isEmpty else { return nil }
    return candidates.indices.first { i in
        guard let f = candidates[i].frame, (candidates[i].title ?? "") == t else { return false }
        return abs(f.width - bounds.width) <= 2 && abs(f.height - bounds.height) <= 2
    }
}

// MARK: - Accessibility for Chromium-based apps

/// Chromium-based apps (Electron, CEF, the Chrome family) build their accessibility tree only when an
/// assistive app asks: AXManualAccessibility (Electron) or AXEnhancedUserInterface. Decided by the
/// framework bundles the app ships with.
public func isChromiumBased(frameworks: [String]) -> Bool {
    frameworks.contains { f in
        f == "Electron Framework.framework" || f == "Chromium Embedded Framework.framework" || (f.hasSuffix(" Framework.framework") && (f.contains("Chrome") || f.contains("Chromium") || f.contains("Edge") || f.contains("Brave")))
    }
}

// MARK: - Menu bar

/// A menu title as the model may name it: case-insensitive, trimmed, without a trailing "..." or "…".
public func normalizeMenuTitle(_ s: String) -> String {
    var t = s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    while t.hasSuffix("...") { t = String(t.dropLast(3)).trimmingCharacters(in: .whitespaces) }
    while t.hasSuffix("…") { t = String(t.dropLast()).trimmingCharacters(in: .whitespaces) }
    return t
}

/// The index of the item a path component names: an exact (normalized) title. Nil when none or the name is empty.
public func menuIndex(_ titles: [String?], matching want: String) -> Int? {
    let w = normalizeMenuTitle(want)
    guard !w.isEmpty else { return nil }
    return titles.firstIndex { $0.map(normalizeMenuTitle) == w }
}

/// A menu item's key equivalent as macOS shows it ("⇧⌘S"), from AXMenuItemCmdChar and
/// AXMenuItemCmdModifiers (bit 0 shift, 1 option, 2 control, 3 no command). Nil without a key.
public func menuShortcut(char: String?, modifiers: Int?) -> String? {
    guard let c = char?.trimmingCharacters(in: .whitespaces), !c.isEmpty else { return nil }
    let m = modifiers ?? 0
    var out = ""
    if m & 4 != 0 { out += "⌃" }
    if m & 2 != 0 { out += "⌥" }
    if m & 1 != 0 { out += "⇧" }
    if m & 8 == 0 { out += "⌘" }
    return out + c.uppercased()
}

/// A listed menu title: one line, at most 120 characters; one that isn't printable text is withheld.
public func menuTitleForListing(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    let one = s.split(whereSeparator: \.isNewline).joined(separator: " ")
    if one.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.generalCategory == .format }) {
        return "(title withheld)"
    }
    return one.count > 120 ? String(one.prefix(119)) + "…" : one
}

// MARK: - Keys through accessibility

/// What a key means when the element under it can do it through accessibility.
public enum AXKeySemantic: Equatable {
    case confirm
    case cancel
    case deleteBackward
    case deleteForward
    case selectAll
}

/// The accessibility meaning of a key combination, or nil for keys that only work as keystrokes.
public func axKeySemantic(_ combo: String) -> AXKeySemantic? {
    switch combo.lowercased().replacingOccurrences(of: " ", with: "") {
    case "return", "enter": return .confirm
    case "escape", "esc": return .cancel
    case "backspace", "delete", "del": return .deleteBackward
    case "forward_delete", "forwarddelete": return .deleteForward
    case "cmd+a", "command+a", "meta+a": return .selectAll
    default: return nil
    }
}

/// The key name the keystroke route posts for a combination ("del" and "delete" are backspace).
public func keystrokeSpec(_ combo: String) -> String {
    let parts = combo.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let key = parts.last else { return combo }
    let alias: [String: String] = ["del": "delete", "forward_delete": "forwarddelete", "page_up": "pageup", "page_down": "pagedown", "arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right"]
    return (parts.dropLast() + [alias[key] ?? key]).joined(separator: "+")
}

/// The UTF-16 range a backspace (or forward delete) removes at a caret or selection in `value`: the
/// selection itself, else one whole character before (after) the caret. Nil when there's nothing to delete.
public func deletionRange(value: String, location: Int, length: Int, forward: Bool) -> (location: Int, length: Int)? {
    let ns = value as NSString
    let loc = max(0, min(location, ns.length))
    if length > 0 { return (loc, min(length, ns.length - loc)) }
    if forward {
        guard loc < ns.length else { return nil }
        let r = ns.rangeOfComposedCharacterSequence(at: loc)
        return (r.location, r.length)
    }
    guard loc > 0 else { return nil }
    let r = ns.rangeOfComposedCharacterSequence(at: loc - 1)
    return (r.location, r.length)
}

// MARK: - Text

/// Roles whose value is text the model may write.
public let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

/// How much of an element's value a window snapshot keeps: a text field's or area's value is its content (a document
/// in TextEdit, #1381 f2), kept long enough for ax_find to read; any other value is a label.
public func valueLimit(role: String?) -> Int { role.map(textRoles.contains) == true ? 4000 : 200 }

/// Roles that present a menu when clicked: opening one would bring the app to the front.
public let menuPresentingRoles: Set<String> = ["AXPopUpButton", "AXMenuButton"]

public func isSecureText(role: String?, subrole: String?) -> Bool {
    role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

/// How a background type writes into a field whose positional insert (AXSelectedText) failed.
public enum TextFallback: Equatable {
    /// The field is empty: setting its whole value loses nothing.
    case setValue
    /// Replacing the whole field was allowed (the previous content goes back to the caller).
    case replaceAll
    /// The field has content and replacing it wasn't allowed.
    case refuse
}

public func textFallback(currentValue: String, overwriteExisting: Bool) -> TextFallback {
    if currentValue.isEmpty { return .setValue }
    return overwriteExisting ? .replaceAll : .refuse
}

/// Whether a write took effect: the field now holds the text, or (an insert) its value changed to contain it.
public func textWriteEffective(before: String?, after: String?, text: String, replace: Bool) -> Bool {
    guard let after else { return false }
    if replace { return after == text }
    if text.isEmpty { return true }
    return after != before && after.contains(text)
}

// MARK: - Scrolling

/// A scroll bar value after `units` steps of `step` (a fraction of the range), within 0...1.
public func scrolledValue(current: Double, units: Double, step: Double = 0.05) -> Double {
    min(1, max(0, current + units * step))
}
