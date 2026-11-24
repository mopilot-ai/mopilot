// Brief foreground for app-scoped control: when the user may be interrupted, whether activation took, and what to restore after.
import CoreGraphics
import Foundation

/// The methods a brief foreground may wrap: the ones that post input or write text, and a menu press (an app such as
/// TextEdit keeps File > Export as PDF disabled while it isn't active, #3571 G7). Not app.focus (it refuses a frontmost
/// app) or captures.
public let briefForegroundMethods: Set<String> = ["app.press", "app.click", "app.setText", "app.key", "app.scroll", "app.drag", "app.menu"]

/// The top-level menu to refresh first when a menu press runs in brief foreground: the app validates its items (enables
/// Export as PDF) only when the menu opens while it is active. Nil for any other request.
public func foregroundMenuRefresh(_ method: String, _ params: [String: Any]) -> String? {
    guard method == "app.menu", let path = params["path"] as? [String], path.count >= 2 else { return nil }
    return path[0]
}

/// How long the user must have left the mouse and keyboard alone before the app is brought forward.
public let briefForegroundMinIdleSeconds = 0.75

/// Whether the target may be brought forward now: not while the user is typing or moving the pointer
/// (their physical input wins, as it pauses display-scope control).
public func briefForegroundMayStart(userIdleSeconds: Double, minIdle: Double = briefForegroundMinIdleSeconds) -> Bool {
    userIdleSeconds.isFinite && userIdleSeconds >= minIdle
}

/// Whether the user touched the mouse or keyboard while the app was in front: the last physical input
/// is more recent than the moment the brief foreground started.
public func userActedDuring(elapsedSeconds: Double, userIdleSeconds: Double) -> Bool {
    userIdleSeconds.isFinite && userIdleSeconds < elapsedSeconds
}

/// What to put back once the action ran.
public struct ForegroundRestore: Equatable {
    /// The app to bring back to the front (nil: leave the front as it is).
    public let activatePid: Int32?
    /// Where to put the pointer back (nil: it didn't move, or the user moved it).
    public let pointer: CGPoint?
    /// The user took over during the action: nothing is restored behind their back.
    public let userTookOver: Bool

    public init(activatePid: Int32?, pointer: CGPoint?, userTookOver: Bool) {
        self.activatePid = activatePid
        self.pointer = pointer
        self.userTookOver = userTookOver
    }
}

/// The restore plan: the previous front app comes back unless it was the target itself or the user acted
/// meanwhile; the pointer goes back when it moved more than a point and the user didn't move it.
public func planForegroundRestore(previousFront: Int32?, target: Int32, pointerBefore: CGPoint?, pointerAfter: CGPoint?, userActed: Bool) -> ForegroundRestore {
    if userActed { return ForegroundRestore(activatePid: nil, pointer: nil, userTookOver: true) }
    let activate = previousFront.flatMap { $0 == target ? nil : $0 }
    var pointer: CGPoint?
    if let a = pointerBefore, let b = pointerAfter, hypot(a.x - b.x, a.y - b.y) > 1 { pointer = a }
    return ForegroundRestore(activatePid: activate, pointer: pointer, userTookOver: false)
}

/// The route an app click takes. Chromium and Electron web content (a canvas, #3571 G7 CM-D23) ignores mouse events posted
/// to its process, so with the app brought to the front (brief foreground) a click at a point where the app's own
/// window is on top goes out at the HID level, as a person's would. At any other point, or with the app in the
/// background, it is posted to the process: a HID click there would land on whatever is on top.
public func clickRoute(foreground: Bool, ownerPid: Int32?, targetPid: Int32) -> String {
    pointerRoute(foreground: foreground, ownerPid: ownerPid, targetPid: targetPid)
}

/// The route an app wheel scroll takes, by the same rule as a click: WeChat-style apps ignore a wheel event posted to
/// their process, so in brief foreground, where the app's own window is on top at the point, a real wheel event goes out
/// at the HID level (the pointer is moved to the point first and restored afterwards); anywhere else it is posted to the process.
public func scrollRoute(foreground: Bool, ownerPid: Int32?, targetPid: Int32) -> String {
    pointerRoute(foreground: foreground, ownerPid: ownerPid, targetPid: targetPid)
}

/// The one rule behind clickRoute and scrollRoute: a real-pointer ("hid") event only with the app in front and its own window under the point.
func pointerRoute(foreground: Bool, ownerPid: Int32?, targetPid: Int32) -> String {
    foreground && ownerPid == targetPid ? "hid" : "pid"
}

/// The answer to an app click: the route taken, and, when the app was brought to the front but the click was still posted to
/// its process, who owned the window at the point and which pid the click was for, so a click that did nothing can be told
/// apart (a window of another process on top, or none found) from a helper without the HID route.
public func clickResult(route: String, foreground: Bool, ownerPid: Int32?, targetPid: Int32) -> [String: Any] {
    var out: [String: Any] = ["ok": true, "route": route]
    if foreground && route != "hid" {
        out["ownerPid"] = ownerPid.map { Int($0) } ?? -1
        out["targetPid"] = Int(targetPid)
    }
    return out
}
