// Desktop permissions, target resolution, accessibility and input dispatch.
import AppKit
import ApplicationServices
import Foundation
import HelperCore

// MARK: - Permissions

func permissionStatus() -> [String: Bool] {
    [
        Permission.accessibility.rawValue: AXIsProcessTrusted(),
        Permission.screenRecording.rawValue: CGPreflightScreenCaptureAccess(),
        Permission.inputMonitoring.rawValue: CGPreflightListenEventAccess(),
    ]
}

/// Shows the system prompt for `p` (only the first time; after that macOS just answers).
func requestPermission(_ p: Permission) {
    switch p {
    case .accessibility:
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    case .screenRecording:
        _ = CGRequestScreenCaptureAccess()
    case .inputMonitoring:
        _ = CGRequestListenEventAccess()
    }
}

func openSettings(_ p: Permission) -> Bool {
    guard let url = URL(string: p.settingsURL) else { return false }
    return NSWorkspace.shared.open(url)
}

// MARK: - Targets

func bundleId(of pid: pid_t) -> String? {
    NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
}

private func target(pid: pid_t) -> Target {
    let app = NSRunningApplication(processIdentifier: pid)
    return Target(pid: pid, bundleId: app?.bundleIdentifier, name: app?.localizedName)
}

/// MoPilot's main pid, whose click-through status overlay the hit test looks through (set once at launch).
var overlayOwnerPids: Set<pid_t> = []

/// The frontmost app's pid, from any thread.
func frontmostPid() -> pid_t? {
    if Thread.isMainThread { return NSWorkspace.shared.frontmostApplication?.processIdentifier }
    return DispatchQueue.main.sync { NSWorkspace.shared.frontmostApplication?.processIdentifier }
}

/// The on-screen window list, front to back.
func onScreenWindows() -> [HitWindow] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.compactMap { w in
        guard let b = w[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: b),
              let pid = w[kCGWindowOwnerPID as String] as? Int32 else { return nil }
        let bundleId = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier
        return HitWindow(pid: pid, layer: w[kCGWindowLayer as String] as? Int ?? 0, alpha: w[kCGWindowAlpha as String] as? Double ?? 1,
                         bounds: rect, sharingState: w[kCGWindowSharingState as String] as? Int ?? 1, ownerIsSystem: bundleId == nil,
                         passesEventsThrough: bundleId.map(passThroughBundleIds.contains) ?? false)
    }
}

/// The owner of the topmost visible window containing `p` (global points, top-left origin). The helper's
/// glow and MoPilot's status overlay are click-through, so the event lands on what is under them;
/// on the menu bar it is the frontmost app, whose menus those are.
func windowOwner(at p: CGPoint) -> Target? {
    switch hitTest(onScreenWindows(), at: p, selfPid: getpid(), protectedPids: overlayOwnerPids) {
    case .window(let w): return target(pid: w.pid)
    case .menuBar: return frontmostPid().map { target(pid: $0) }
    case .none: return nil
    }
}

/// Who a click or scroll at `p` would reach: the accessibility hit test and the window list, both
/// checked (either one being denied refuses the event).
func targets(at p: CGPoint) -> [Target] {
    var out: [Target] = []
    let owner = windowOwner(at: p)
    if let hit = axHit(at: p, owner: owner) { out.append(target(pid: hit.pid)) }
    if let owner { out.append(owner) }
    return out
}

/// The accessibility element under `p` and its process, except the helper's own and MoPilot's
/// click-through overlay: the overlay belongs to MoPilot's main process, and a hit on it while the
/// window list sees another app's window there (`owner`) is the overlay, not a MoPilot window.
func axHit(at p: CGPoint, owner: Target?) -> (element: AXUIElement, pid: pid_t)? {
    var el: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(p.x), Float(p.y), &el) == .success, let el else { return nil }
    AXUIElementSetMessagingTimeout(el, 1.0)
    var pid: pid_t = 0
    guard AXUIElementGetPid(el, &pid) == .success, pid > 0, pid != getpid() else { return nil }
    let throughOverlay = overlayOwnerPids.contains(pid) && owner.map { !overlayOwnerPids.contains($0.pid ?? 0) } == true
    return throughOverlay ? nil : (el, pid)
}

/// The current pointer location in global points (top-left origin).
func cursorLocation() -> CGPoint {
    CGEvent(source: nil)?.location ?? .zero
}

/// Who keystrokes would reach: the frontmost app, and the system-wide focused application.
func keyboardTargets() -> [Target] {
    var out: [Target] = []
    if let front = frontmostPid() { out.append(target(pid: front)) }
    var app: CFTypeRef?
    if AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &app) == .success,
       let app, CFGetTypeID(app) == AXUIElementGetTypeID() {
        var pid: pid_t = 0
        if AXUIElementGetPid(app as! AXUIElement, &pid) == .success { out.append(target(pid: pid)) }
    }
    return out
}

/// True when keyboard focus is in a password field (agents never type into one).
func focusIsSecureField() -> Bool {
    var el: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &el) == .success,
          let el, CFGetTypeID(el) == AXUIElementGetTypeID() else { return false }
    let e = el as! AXUIElement
    return axString(e, kAXSubroleAttribute) == "AXSecureTextField" || axString(e, kAXRoleAttribute) == "AXSecureTextField"
}

// MARK: - Accessibility tree

func axString(_ e: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, attr as CFString, &v) == .success, let v else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

private func axFrame(_ e: AXUIElement) -> [String: Double]? {
    var pos: CFTypeRef?, size: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, kAXPositionAttribute as CFString, &pos) == .success,
          AXUIElementCopyAttributeValue(e, kAXSizeAttribute as CFString, &size) == .success,
          let pos, let size else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    AXValueGetValue(pos as! AXValue, .cgPoint, &p)
    AXValueGetValue(size as! AXValue, .cgSize, &s)
    return ["x": p.x, "y": p.y, "w": s.width, "h": s.height]
}

/// A depth- and size-limited snapshot of an app's accessibility tree. Password fields never carry a value.
func axSnapshot(pid: pid_t, maxDepth: Int, maxNodes: Int) -> [String: Any] {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    var count = 0
    var truncated = false

    func walk(_ e: AXUIElement, _ path: String, _ depth: Int) -> [String: Any]? {
        if count >= maxNodes { truncated = true; return nil }
        count += 1
        var node: [String: Any] = ["id": path]
        let role = axString(e, kAXRoleAttribute)
        let subrole = axString(e, kAXSubroleAttribute)
        if let role { node["role"] = role }
        if let subrole { node["subrole"] = subrole }
        for (key, attr) in [("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("help", kAXHelpAttribute)] {
            if let s = axString(e, attr), !s.isEmpty { node[key] = String(s.prefix(200)) }
        }
        let secure = role == "AXSecureTextField" || subrole == "AXSecureTextField"
        if !secure, let v = axString(e, kAXValueAttribute), !v.isEmpty { node["value"] = String(v.prefix(200)) }
        if let f = axFrame(e) { node["frame"] = f }
        if axString(e, kAXFocusedAttribute) == "1" { node["focused"] = true }
        if axString(e, kAXEnabledAttribute) == "0" { node["enabled"] = false }
        if depth < maxDepth {
            var kids: CFTypeRef?
            if AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success, let arr = kids as? [AXUIElement] {
                var children: [[String: Any]] = []
                for (i, k) in arr.enumerated() {
                    guard let c = walk(k, "\(path).\(i)", depth + 1) else { break }
                    children.append(c)
                }
                if !children.isEmpty { node["children"] = children }
            }
        } else {
            truncated = true
        }
        return node
    }

    let root = walk(app, "0", 0) ?? [:]
    return ["root": root, "nodes": count, "truncated": truncated]
}

/// The element an `ax.snapshot` id ("0.3.1": the app, then child indexes) names now, if the tree still has it.
func axElement(pid: pid_t, path: String) -> AXUIElement? {
    let parts = path.split(separator: ".").compactMap { Int($0) }
    guard parts.first == 0 else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 1.0)
    var e = app
    for i in parts.dropFirst() {
        var kids: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, kAXChildrenAttribute as CFString, &kids) == .success,
              let arr = kids as? [AXUIElement], i >= 0, i < arr.count else { return nil }
        e = arr[i]
    }
    return e
}

func axFrameOf(_ e: AXUIElement) -> CGRect? {
    guard let f = axFrame(e) else { return nil }
    return CGRect(x: f["x"] ?? 0, y: f["y"] ?? 0, width: f["w"] ?? 0, height: f["h"] ?? 0)
}

/// Performs the element's press action. True when the app reports it done.
func axPress(_ e: AXUIElement) -> Bool {
    var names: CFArray?
    guard AXUIElementCopyActionNames(e, &names) == .success, let list = names as? [String], list.contains(kAXPressAction as String) else { return false }
    return AXUIElementPerformAction(e, kAXPressAction as CFString) == .success
}

/// Gives the element keyboard focus. True when the app accepted it.
func axFocus(_ e: AXUIElement) -> Bool {
    AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
}

/// The displays, in global points, with their backing scale.
func displayList() -> [[String: Any]] {
    let main = CGMainDisplayID()
    return NSScreen.screens.compactMap { s in
        guard let id = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return nil }
        let b = CGDisplayBounds(CGDirectDisplayID(id.uint32Value))
        return ["id": id.intValue, "x": b.minX, "y": b.minY, "width": b.width, "height": b.height, "scale": s.backingScaleFactor,
                "main": CGDirectDisplayID(id.uint32Value) == main, "name": s.localizedName]
    }
}

// MARK: - Input

private let source = CGEventSource(stateID: .hidSystemState)

private func post(_ e: CGEvent?) {
    guard let e else { return }
    markOwnPost(e)
    e.post(tap: .cghidEventTap)
}

enum MouseButton: String {
    case left, right, middle
}

private func buttonEvents(_ button: MouseButton) -> (down: CGEventType, up: CGEventType, button: CGMouseButton) {
    switch button {
    case .left: return (.leftMouseDown, .leftMouseUp, .left)
    case .right: return (.rightMouseDown, .rightMouseUp, .right)
    case .middle: return (.otherMouseDown, .otherMouseUp, .center)
    }
}

/// `flags`: modifier keys held for the click (CGEventFlags raw value), 0 for none. Timed as a person's
/// click (HelperCore/Click.swift): the pointer arrives first, and the button is held for a moment.
func postClick(at p: CGPoint, button: MouseButton, count: Int, flags: UInt64 = 0, signal: String? = nil) {
    let (down, up, cgButton) = buttonEvents(button)
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: cgButton))
    usleep(clickMoveSettleMicros)
    for i in 1...max(1, min(count, 3)) {
        if i > 1 { usleep(clickGapMicros) }
        for type in [down, up] {
            let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: cgButton)
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            if flags != 0 { e?.flags = CGEventFlags(rawValue: flags) }
            post(e)
            if type == down, i == 1 { signalClick(signal) }
            if type == down { usleep(clickHoldMicros) }
        }
    }
}

/// The accessibility element a click at `p` would reach (MoPilot's overlay looked through, as targets(at:)).
func elementAt(_ p: CGPoint) -> (element: AXUIElement, pid: pid_t)? {
    axHit(at: p, owner: windowOwner(at: p))
}

/// The element itself when it is a row, else the row it is in (a few levels up: a cell, its text).
func rowOf(_ e: AXUIElement) -> AXUIElement? {
    var cur: AXUIElement? = e
    for _ in 0..<5 {
        guard let c = cur else { return nil }
        if axString(c, kAXRoleAttribute) == (kAXRowRole as String) { return c }
        var parent: CFTypeRef?
        guard AXUIElementCopyAttributeValue(c, kAXParentAttribute as CFString, &parent) == .success, let parent,
              CFGetTypeID(parent) == AXUIElementGetTypeID() else { return nil }
        let next = parent as! AXUIElement
        AXUIElementSetMessagingTimeout(next, 1.0)
        cur = next
    }
    return nil
}

/// What accessibility says of `e`, and its row (when selectable).
func hitElement(_ e: AXUIElement) -> (hit: HitElement, row: AXUIElement?) {
    var names: CFArray?
    let pressable = AXUIElementCopyActionNames(e, &names) == .success && (names as? [String])?.contains(kAXPressAction as String) == true
    let row = rowOf(e).flatMap { isSettable($0, kAXSelectedAttribute) ? $0 : nil }
    return (HitElement(pressable: pressable, selectable: row != nil), row)
}

/// A row's AXSelected (nil: unreadable).
func isSelected(_ row: AXUIElement) -> Bool? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(row, kAXSelectedAttribute as CFString, &v) == .success else { return nil }
    return (v as? Bool)
}

/// Brings the app forward for a click and waits (briefly) until it is frontmost. Main thread hops inside.
func activateForClick(_ pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid) else { return false }
    // accessibility's AXFrontmost first: a background helper's activate() alone may be declined
    _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    _ = DispatchQueue.main.sync { app.activate() }
    var waited: UInt32 = 0
    while frontmostPid() != pid && waited < clickActivateWaitMicros {
        usleep(20_000)
        waited += 20_000
    }
    return frontmostPid() == pid
}

/// Moves the pointer; while the left button is held (desktop_left_mouse_down) the move is a drag step.
func postMove(to p: CGPoint) {
    let dragging = CGEventSource.buttonState(.hidSystemState, button: .left)
    post(CGEvent(mouseEventSource: source, mouseType: dragging ? .leftMouseDragged : .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
}

/// Presses or lets go of a mouse button where the pointer is (or at `p`).
func postButton(_ button: MouseButton, down: Bool, at p: CGPoint) {
    let (d, u, cgButton) = buttonEvents(button)
    post(CGEvent(mouseEventSource: source, mouseType: down ? d : u, mouseCursorPosition: p, mouseButton: cgButton))
}

/// One step of a left-button drag.
func postDragged(to p: CGPoint) {
    post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
}

/// Presses (down) or lets go of (up) a key combination: modifiers first and last, around the key.
func postKeyEdge(_ combo: KeyCombo, down: Bool) {
    let e = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: down)
    e?.flags = down ? CGEventFlags(rawValue: combo.flags) : []
    post(e)
}

func postKey(_ combo: KeyCombo) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: down)
        e?.flags = CGEventFlags(rawValue: combo.flags)
        post(e)
    }
}

/// Types one user-perceived character as a unicode key event pair.
func postCharacter(_ c: Character) {
    let units = Array(String(c).utf16)
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
        e?.flags = []
        units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
        post(e)
    }
}

/// Scrolls by wheel lines ("clicks" of a mouse wheel) rather than pixels.
func postScrollLines(at p: CGPoint, dx: Int32, dy: Int32) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
}

func postScroll(at p: CGPoint, dx: Int32, dy: Int32) {
    post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
}

// MARK: - Focused text (desktop_type: insert through accessibility, read back)

/// The system-wide keyboard-focused element and its pid.
func focusedElement() -> (element: AXUIElement, pid: pid_t)? {
    var el: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &el) == .success,
          let el, CFGetTypeID(el) == AXUIElementGetTypeID() else { return nil }
    let e = el as! AXUIElement
    AXUIElementSetMessagingTimeout(e, 1.0)
    var pid: pid_t = 0
    guard AXUIElementGetPid(e, &pid) == .success, pid > 0 else { return nil }
    return (e, pid)
}

func isSecure(_ e: AXUIElement) -> Bool {
    axString(e, kAXSubroleAttribute) == "AXSecureTextField" || axString(e, kAXRoleAttribute) == "AXSecureTextField"
}

func isSettable(_ e: AXUIElement, _ attr: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(e, attr as CFString, &settable) == .success && settable.boolValue
}

/// The longest field value read back (a longer one is reported truncated, and not checked).
private let maxFieldValue = 100_000

/// {pid, bundleId, role, value?, selection?: {location, length} (UTF-16), truncated?, settable}.
func focusedText(_ e: AXUIElement, pid: pid_t, bundleId: String?) -> [String: Any] {
    var out: [String: Any] = ["pid": Int(pid), "bundleId": bundleId ?? "", "role": axString(e, kAXRoleAttribute) ?? "",
                              "settable": isSettable(e, kAXSelectedTextAttribute)]
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(e, kAXValueAttribute as CFString, &v) == .success, let s = v as? String {
        if s.utf16.count > maxFieldValue {
            out["truncated"] = true
            out["value"] = String(s.prefix(1000))
        } else {
            out["value"] = s
        }
    }
    var r: CFTypeRef?
    if AXUIElementCopyAttributeValue(e, kAXSelectedTextRangeAttribute as CFString, &r) == .success, let r, CFGetTypeID(r) == AXValueGetTypeID() {
        var range = CFRange()
        if AXValueGetValue(r as! AXValue, .cfRange, &range) { out["selection"] = ["location": range.location, "length": range.length] }
    }
    return out
}

// MARK: - Hide before action

/// Hides every visible regular app but `keep` and MoPilot; returns what it hid. Main thread.
func hideApps(keep: [String], protectedPids: Set<pid_t>) -> [[String: Any]] {
    let apps = NSWorkspace.shared.runningApplications.map {
        RunningApp(pid: $0.processIdentifier, bundleId: $0.bundleIdentifier, name: $0.localizedName, hidden: $0.isHidden, regular: $0.activationPolicy == .regular)
    }
    var out: [[String: Any]] = []
    for a in appsToHide(apps, keep: keep, protectedPids: protectedPids) where NSRunningApplication(processIdentifier: a.pid)?.hide() == true {
        out.append(a.json)
    }
    return out
}

/// Shows the apps hideApps hid, then brings `activate` (if any) to the front. Main thread.
func restoreApps(pids: [pid_t], activate: pid_t?) -> Bool {
    for pid in pids { _ = NSRunningApplication(processIdentifier: pid)?.unhide() }
    guard let activate, let app = NSRunningApplication(processIdentifier: activate) else { return true }
    return app.activate(options: [])
}

// MARK: - The user's clipboard

/// Every item on the general pasteboard, with every type's data. Main thread.
func savePasteboard() -> [[(NSPasteboard.PasteboardType, Data)]] {
    (NSPasteboard.general.pasteboardItems ?? []).map { item in item.types.compactMap { t in item.data(forType: t).map { (t, $0) } } }
}

/// Puts saved pasteboard items back. Main thread.
func restorePasteboard(_ saved: [[(NSPasteboard.PasteboardType, Data)]]) {
    let pb = NSPasteboard.general
    pb.clearContents()
    let items = saved.map { types -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (t, d) in types { item.setData(d, forType: t) }
        return item
    }
    if !items.isEmpty { pb.writeObjects(items) }
}

// MARK: - Text substitutions

/// Turns the app's own autocorrect, text replacement and smart punctuation off (its preferences domain,
/// best effort: a text view may keep the setting it was created with); the returned function puts them
/// back as they were.
func disableSubstitutions(bundleId: String) -> () -> Void {
    let app = bundleId as CFString
    let set: (String, Any?) -> Void = { k, v in CFPreferencesSetAppValue(k as CFString, v.map { $0 as CFPropertyList }, app) }
    let o = SubstitutionOverride.apply(get: { CFPreferencesCopyAppValue($0 as CFString, app) }, set: set)
    CFPreferencesAppSynchronize(app)
    return {
        o.restore(set: set)
        CFPreferencesAppSynchronize(app)
    }
}
