// Watch-and-record (record a skill): while main has it on (record.start), what a person does with the mouse and
// keyboard is reported to main as record.event notifications: a click (where, with which button, on which app, window
// and element) and a key press (text typed, or a shortcut). Only the apps MoPilot could control are reported: a
// click or key in an app on the deny list, or in MoPilot, is dropped. A password field's keys are never read
// (one "secure" event says a secret was typed), and no field value is read. Nothing runs while recording is off.
import AppKit
import ApplicationServices
import HelperCore

/// A label longer than this is cut here.
private let labelChars = 120

final class WatchRecorder {
    private let queue = DispatchQueue(label: "computer-use.watch-record")
    private let lock = NSLock()
    private var startedAt: Double?
    /// Whether input another process posts is recorded too (a check from a script); a person's alone by default.
    private var includeSynthetic = false
    /// The policy to check each event's app against (the deny list can grow while recording).
    var policy: () -> TargetPolicy = { TargetPolicy(protectedPids: [], denyList: DenyList(extra: [])) }
    var notify: (String, [String: Any]) -> Void = { _, _ in }

    /// Starts recording; false when it already is on.
    func start(includeSynthetic synthetic: Bool = false) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if startedAt != nil { return false }
        startedAt = ProcessInfo.processInfo.systemUptime
        includeSynthetic = synthetic
        return true
    }

    /// Stops recording; false when it was not on.
    func stop() -> Bool {
        lock.lock(); defer { lock.unlock() }
        let was = startedAt != nil
        startedAt = nil
        return was
    }

    /// When recording started, if input of this kind is recorded now.
    private func origin(physical: Bool) -> Double? {
        lock.lock(); defer { lock.unlock() }
        return physical || includeSynthetic ? startedAt : nil
    }

    /// An input event that went through the tap (main thread): what the event was aimed at, and whether a password field had
    /// focus, are read now, while they are true (the click may close the window, a key may be the last before Tab); the
    /// rest is read off the tap's thread.
    func note(_ type: CGEventType, _ event: CGEvent, physical: Bool) {
        guard let t0 = origin(physical: physical) else { return }
        let ms = Int((ProcessInfo.processInfo.systemUptime - t0) * 1000)
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let at = event.location
            let button = type == .leftMouseDown ? "left" : type == .rightMouseDown ? "right" : "middle"
            let count = Int(event.getIntegerValueField(.mouseEventClickState))
            let flags = event.flags.rawValue
            let owner = windowOwner(at: at)
            queue.async { [self] in click(ms: ms, at: at, owner: owner, button: button, count: count, flags: flags) }
        case .keyDown:
            if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
            let code = UInt16(event.getIntegerValueField(.keyboardEventKeycode))
            let flags = event.flags.rawValue
            var buffer = [UniChar](repeating: 0, count: 16)
            var length = 0
            event.keyboardGetUnicodeString(maxStringLength: 16, actualStringLength: &length, unicodeString: &buffer)
            let characters = String(utf16CodeUnits: buffer, count: length)
            let unshifted = NSEvent(cgEvent: event)?.charactersIgnoringModifiers
            // a focus that cannot be read in time counts as a password field: its keys are not kept
            let secure = secureFocusQuick() ?? true
            let front = frontmostPid().map { pid -> Target in
                let app = NSRunningApplication(processIdentifier: pid)
                return Target(pid: pid, bundleId: app?.bundleIdentifier, name: app?.localizedName)
            }
            queue.async { [self] in key(ms: ms, code: code, flags: flags, characters: characters, unshifted: unshifted, front: front, secure: secure) }
        default:
            break
        }
    }

    private func app(of targets: [Target]) -> [String: Any]? {
        guard case .allowed = policy().check(targets), let t = targets.first(where: { $0.bundleId != nil }), let id = t.bundleId else { return nil }
        return ["bundleId": id, "name": t.name ?? id]
    }

    private func cut(_ s: String?) -> String? {
        guard let s = s?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
        return String(s.prefix(labelChars))
    }

    private func click(ms: Int, at: CGPoint, owner: Target?, button: String, count: Int, flags: UInt64) {
        // the window under the pointer when it was pressed names the app; the accessibility hit test, if it can still
        // name one, must be allowed too
        guard let owner, let app = app(of: [owner]) else { return }
        let found = targets(at: at)
        if !found.isEmpty, case .refused = policy().check(found) { return }
        var out: [String: Any] = ["t": ms, "kind": "click", "button": button, "count": max(1, count), "x": Int(at.x), "y": Int(at.y), "app": app]
        let mods = recordedModifiers(flags)
        if !mods.isEmpty { out["modifiers"] = mods }
        if let hit = axHit(at: at, owner: windowOwner(at: at)), !isSecure(hit.element) {
            var element: [String: Any] = [:]
            if let role = axString(hit.element, kAXRoleAttribute) { element["role"] = role }
            if let label = cut(axString(hit.element, kAXTitleAttribute)) ?? cut(axString(hit.element, kAXDescriptionAttribute)) { element["label"] = label }
            if !element.isEmpty { out["element"] = element }
            var window: CFTypeRef?
            if AXUIElementCopyAttributeValue(hit.element, kAXWindowAttribute as CFString, &window) == .success, let window, CFGetTypeID(window) == AXUIElementGetTypeID(),
               let title = cut(axString(window as! AXUIElement, kAXTitleAttribute)) {
                out["window"] = title
            }
        }
        notify("record.event", out)
    }

    private func key(ms: Int, code: UInt16, flags: UInt64, characters: String, unshifted: String?, front: Target?, secure: Bool) {
        guard let front, let app = app(of: [front]) else { return }
        if secure {
            notify("record.event", ["t": ms, "kind": "secure", "app": app])
            return
        }
        guard let recorded = recordKey(keyCode: code, flags: flags, characters: characters, unshifted: unshifted) else { return }
        var out: [String: Any] = ["t": ms, "kind": "key", "app": app]
        switch recorded {
        case .text(let text): out["text"] = text
        case .combo(let combo): out["combo"] = combo
        }
        notify("record.event", out)
    }
}

/// Whether the keyboard focus is a password field, asked with a short timeout (the event tap waits for the answer, so a hung
/// app must not hold up everyone's typing); nil when it could not be told in time.
private func secureFocusQuick() -> Bool? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.05)
    var focused: CFTypeRef?
    let found = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused)
    if found == .noValue { return false }
    guard found == .success, let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
    let element = focused as! AXUIElement
    AXUIElementSetMessagingTimeout(element, 0.05)
    var unreadable = false
    for attribute in [kAXSubroleAttribute, kAXRoleAttribute] {
        var value: CFTypeRef?
        switch AXUIElementCopyAttributeValue(element, attribute as CFString, &value) {
        case .success: if (value as? String) == "AXSecureTextField" { return true }
        case .attributeUnsupported, .noValue: break
        default: unreadable = true
        }
    }
    return unreadable ? nil : false
}
