import CoreGraphics
import Foundation

// Which window an event at a point lands on, and which display a capture of some apps shows. Pure, so
// it is tested without a screen.

/// One window of the on-screen list as the hit test sees it.
public struct HitWindow: Equatable {
    public var pid: Int32
    public var layer: Int
    public var alpha: Double
    public var bounds: CGRect
    /// kCGWindowSharingState: 0 is "none" (the window opted out of capture).
    public var sharingState: Int
    /// The owner has no bundle id (the Window Server's own windows, such as the menu bar).
    public var ownerIsSystem: Bool
    /// A system container that covers the screen but passes events through except where it draws, such as
    /// Notification Center's full-screen window while a banner shows, or the Dock's: the window list can't tell
    /// what they draw from the empty rest, so the hit test looks through them and the accessibility hit names a
    /// real banner or the Dock itself.
    public var passesEventsThrough: Bool

    public init(pid: Int32, layer: Int, alpha: Double, bounds: CGRect, sharingState: Int = 1, ownerIsSystem: Bool = false,
                passesEventsThrough: Bool = false) {
        self.pid = pid
        self.layer = layer
        self.alpha = alpha
        self.bounds = bounds
        self.sharingState = sharingState
        self.ownerIsSystem = ownerIsSystem
        self.passesEventsThrough = passesEventsThrough
    }
}

public enum HitResult: Equatable {
    /// The window that takes an event at the point.
    case window(HitWindow)
    /// The menu bar: events there go to the frontmost app's menus.
    case menuBar
    case none
}

/// The main menu window level (kCGMainMenuWindowLevel).
public let mainMenuWindowLevel = 24
/// MoPilot's own "using your computer" overlay sits at or above this level (the screen-saver level).
public let overlayWindowLevel = 1000
/// The Window Server's own pointer-level windows (kCGCursorWindowLevel): the cursor image and the recording indicator.
/// They sit on top of everything at the pointer, belong to no app and take no events, so a click is never aimed at them.
/// Measured in the mopilot-bench VM (#3810): while a recorder runs, a 28x40 "Cursor" window follows the pointer.
public let cursorWindowLevel = 2_147_483_630
/// System UI that keeps a transparent window over the whole screen above the apps: Notification Center while a
/// banner or alert shows, and the Dock (its window spans the display, though it draws only the Dock itself).
public let passThroughBundleIds: Set<String> = ["com.apple.notificationcenterui", "com.apple.dock"]

/// The window an event at `p` lands on. `windows` is front to back. Skips the helper's own windows
/// (`selfPid`), MoPilot's click-through status overlay (a window of a protected pid at the overlay
/// level that opted out of capture) and system containers that pass events through, and the Window Server's pointer-level windows (the cursor, the recording indicator). Ordinary MoPilot
/// windows are still found (and refused).
public func hitTest(_ windows: [HitWindow], at p: CGPoint, selfPid: Int32, protectedPids: Set<Int32>) -> HitResult {
    for w in windows where w.alpha > 0 && w.bounds.contains(p) {
        if w.pid == selfPid || w.passesEventsThrough { continue }
        if w.ownerIsSystem && w.layer >= cursorWindowLevel { continue }
        if protectedPids.contains(w.pid) && w.layer >= overlayWindowLevel && w.sharingState == 0 { continue }
        if w.ownerIsSystem && w.layer == mainMenuWindowLevel { return .menuBar }
        return .window(w)
    }
    return .none
}

/// The display a capture of some apps should show: the one holding the largest ordinary window of the
/// first app in `preferredPids` that has one, else of the largest window of any included app, else nil.
public func chooseDisplay(windows: [HitWindow], preferredPids: [Int32], includedPids: Set<Int32>, displays: [(id: UInt32, bounds: CGRect)]) -> UInt32? {
    func area(_ w: HitWindow) -> CGFloat { w.bounds.width * w.bounds.height }
    func displayOf(_ w: HitWindow) -> UInt32? {
        let c = CGPoint(x: w.bounds.midX, y: w.bounds.midY)
        return displays.first { $0.bounds.contains(c) }?.id
    }
    let ordinary = windows.filter { $0.layer == 0 && $0.alpha > 0 && $0.bounds.width >= 40 && $0.bounds.height >= 40 }
    for pid in preferredPids {
        if let w = ordinary.filter({ $0.pid == pid }).max(by: { area($0) < area($1) }), let d = displayOf(w) { return d }
    }
    if let w = ordinary.filter({ includedPids.contains($0.pid) }).max(by: { area($0) < area($1) }) { return displayOf(w) }
    return nil
}

/// The included apps with a visible window on `frame` (a captured display or region), panels included, and not
/// one that opted out of capture: what the image actually shows, as opposed to every included app with a window
/// somewhere on screen.
public func pidsShown(windows: [HitWindow], includedPids: Set<Int32>, frame: CGRect) -> Set<Int32> {
    Set(windows.filter { includedPids.contains($0.pid) && $0.alpha > 0 && $0.sharingState != 0 && $0.bounds.intersects(frame) }.map(\.pid))
}
