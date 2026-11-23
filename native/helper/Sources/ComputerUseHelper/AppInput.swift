// Process-targeted mouse and keyboard events for background app control.
import CoreGraphics
import Foundation
import HelperCore

/// Background events come from a private source state, so they never mix with the user's own modifier keys.
private let appSource = CGEventSource(stateID: .privateState)

/// Set by the helper to send a notification to main (Server.notify).
var clickNotify: ((String, [String: Any]) -> Void)?

/// Tells main the click's mouse-down went out, so its cursor can leave then and not when the action's answer comes (#3810): the answer waits for the post-click settle. Whether the click worked is only the answer's.
func signalClick(_ signal: String?) {
    guard let signal else { return }
    clickNotify?("click.dispatched", ["signal": signal])
}

// MARK: - Events to the app's process

private func postToApp(_ e: CGEvent?, pid: pid_t, windowId: CGWindowID) {
    guard let e else { return }
    markOwnPost(e)
    e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
    e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
    e.postToPid(pid)
}

private func buttonTypes(_ b: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
    switch b {
    case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
    case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
    }
}

func appClick(pid: pid_t, windowId: CGWindowID, at p: CGPoint, button: String, count: Int, flags: UInt64, signal: String? = nil) {
    let (down, up, _, b) = buttonTypes(button)
    postToApp(CGEvent(mouseEventSource: appSource, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: b), pid: pid, windowId: windowId)
    // timed as a person's click, as the display-scope one (HelperCore/Click.swift)
    usleep(clickMoveSettleMicros)
    for i in 1...max(1, min(count, 3)) {
        if i > 1 { usleep(clickGapMicros) }
        for type in [down, up] {
            let e = CGEvent(mouseEventSource: appSource, mouseType: type, mouseCursorPosition: p, mouseButton: b)
            e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
            if flags != 0 { e?.flags = CGEventFlags(rawValue: flags) }
            postToApp(e, pid: pid, windowId: windowId)
            if type == down, i == 1 { signalClick(signal) }
            if type == down { usleep(clickHoldMicros) }
        }
    }
}

/// An app click by the route clickRoute (HelperCore/BriefForeground.swift) picks; the answer names the route taken.
func routedClick(pid: pid_t, windowId: CGWindowID, at p: CGPoint, button: String, count: Int, flags: UInt64, foreground: Bool, signal: String? = nil) -> [String: Any] {
    let owner = windowOwner(at: p)?.pid
    let route = clickRoute(foreground: foreground, ownerPid: owner, targetPid: pid)
    if route == "hid" {
        postClick(at: p, button: MouseButton(rawValue: button) ?? .left, count: count, flags: flags, signal: signal)
    } else {
        appClick(pid: pid, windowId: windowId, at: p, button: button, count: count, flags: flags, signal: signal)
    }
    return clickResult(route: route, foreground: foreground, ownerPid: owner, targetPid: pid)
}

func appDrag(pid: pid_t, windowId: CGWindowID, through points: [CGPoint]) {
    guard let first = points.first else { return }
    postToApp(CGEvent(mouseEventSource: appSource, mouseType: .mouseMoved, mouseCursorPosition: first, mouseButton: .left), pid: pid, windowId: windowId)
    postToApp(CGEvent(mouseEventSource: appSource, mouseType: .leftMouseDown, mouseCursorPosition: first, mouseButton: .left), pid: pid, windowId: windowId)
    var last = first
    for p in points.dropFirst() {
        for s in 1...6 {
            let t = Double(s) / 6
            let q = CGPoint(x: last.x + (p.x - last.x) * t, y: last.y + (p.y - last.y) * t)
            postToApp(CGEvent(mouseEventSource: appSource, mouseType: .leftMouseDragged, mouseCursorPosition: q, mouseButton: .left), pid: pid, windowId: windowId)
            usleep(6000)
        }
        last = p
    }
    postToApp(CGEvent(mouseEventSource: appSource, mouseType: .leftMouseUp, mouseCursorPosition: last, mouseButton: .left), pid: pid, windowId: windowId)
}

func appKeystroke(pid: pid_t, windowId: CGWindowID, _ combo: KeyCombo) {
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: appSource, virtualKey: combo.keyCode, keyDown: down)
        e?.flags = CGEventFlags(rawValue: combo.flags)
        postToApp(e, pid: pid, windowId: windowId)
    }
}

func appCharacters(pid: pid_t, windowId: CGWindowID, _ text: String) -> Int {
    var typed = 0
    for c in text {
        let units = Array(String(c).utf16)
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: appSource, virtualKey: 0, keyDown: down)
            e?.flags = []
            units.withUnsafeBufferPointer { e?.keyboardSetUnicodeString(stringLength: $0.count, unicodeString: $0.baseAddress) }
            postToApp(e, pid: pid, windowId: windowId)
        }
        typed += 1
        usleep(4000)
    }
    return typed
}

func appWheel(pid: pid_t, windowId: CGWindowID, at p: CGPoint, lines: Int32) {
    let e = CGEvent(scrollWheelEvent2Source: appSource, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0)
    e?.location = p
    postToApp(e, pid: pid, windowId: windowId)
}
