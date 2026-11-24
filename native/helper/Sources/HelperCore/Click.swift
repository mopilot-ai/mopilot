// How a display-scope click lands: the pause between its events, bringing the window's app forward first, and the accessibility fallback for source-list rows and out-of-process panels.
import Foundation

// A click posted as move, down and up with no time between them, into an app that isn't in front, is
// often lost: the first click on an inactive window only activates it (AppKit views that don't accept the
// first mouse, such as a source list's rows), and an out-of-process remote view (NSOpenPanel's file
// browser, hosted by its own service) can see the press before the pointer has arrived. A person's click
// takes tens of milliseconds and reaches an app that is already active. So does the helper's, and when
// the element under the point can be pressed or selected through accessibility, that is used where the
// pointer can't be relied on.

/// Between the move to the point and the first press, so the window server routes the press to the
/// window now under the pointer.
public let clickMoveSettleMicros: UInt32 = 40_000
/// How long the button is held, as a person's click.
public let clickHoldMicros: UInt32 = 35_000
/// Between the clicks of a double or triple click, well under the system's double-click interval.
public let clickGapMicros: UInt32 = 60_000
/// How long an app brought forward for a click may take to become frontmost.
public let clickActivateWaitMicros: UInt32 = 400_000
/// After a click, before a row's selection is read back.
public let clickSettleMicros: UInt32 = 120_000

/// The window and the element a click at a point would reach.
public struct ClickTarget: Equatable {
    /// The frontmost app.
    public let frontmostPid: Int32?
    /// The owner of the topmost window under the point.
    public let ownerPid: Int32?
    /// The owner is a regular app (one a person switches to); accessory windows and system UI are clicked as they are.
    public let ownerIsRegular: Bool
    /// The process of the accessibility element under the point (an out-of-process view's own service).
    public let hitPid: Int32?

    public init(frontmostPid: Int32?, ownerPid: Int32?, ownerIsRegular: Bool, hitPid: Int32?) {
        self.frontmostPid = frontmostPid
        self.ownerPid = ownerPid
        self.ownerIsRegular = ownerIsRegular
        self.hitPid = hitPid
    }
}

public struct ClickPlan: Equatable {
    /// Bring this app forward before the click (nil: it already is, or it isn't one to activate).
    public let activatePid: Int32?
    /// The element under the point belongs to another process than the window (a remote view).
    public let remoteView: Bool

    public init(activatePid: Int32?, remoteView: Bool) {
        self.activatePid = activatePid
        self.remoteView = remoteView
    }
}

public func planClick(_ t: ClickTarget) -> ClickPlan {
    var activate: Int32?
    if let owner = t.ownerPid, t.ownerIsRegular, owner != t.frontmostPid { activate = owner }
    let remote = t.hitPid != nil && t.ownerPid != nil && t.hitPid != t.ownerPid
    return ClickPlan(activatePid: activate, remoteView: remote)
}

/// What accessibility says of the element under the point.
public struct HitElement: Equatable {
    /// It offers AXPress.
    public let pressable: Bool
    /// It, or the row it is in, has a settable AXSelected (a list, outline or browser row).
    public let selectable: Bool

    public init(pressable: Bool, selectable: Bool) {
        self.pressable = pressable
        self.selectable = selectable
    }
}

/// A plain click: one left click with no modifier keys (the only kind accessibility can stand in for).
public func isPlainClick(button: String, count: Int, flags: UInt64) -> Bool {
    button == "left" && count <= 1 && flags == 0
}

/// Whether to press the element through accessibility instead of posting the click: a plain click on a
/// pressable element inside an out-of-process remote view, where posted clicks are not reliably delivered.
public func pressInsteadOfClick(plan: ClickPlan, plain: Bool, hit: HitElement?) -> Bool {
    plain && plan.remoteView && hit?.pressable == true
}

/// Whether to select the row through accessibility after the posted click: a plain click on a selectable
/// row that is still not selected once the click settled (the click was lost). Never when the element hit
/// has an action of its own (a checkbox, button or disclosure triangle in the row), whose click doesn't
/// select the row by design. `selectedAfter` nil: unknown.
public func selectAfterClick(plain: Bool, hit: HitElement?, selectedAfter: Bool?) -> Bool {
    guard let hit, plain, hit.selectable, !hit.pressable else { return false }
    return selectedAfter == false
}

/// Whether a wheel event at `target` needs the pointer moved there first: the wheel lands under the pointer, so only a pointer
/// already on the point (within a point) can stay. An unknown pointer position is moved.
public func wheelNeedsPointerMove(pointer: CGPoint?, target: CGPoint) -> Bool {
    guard let pointer else { return true }
    return abs(pointer.x - target.x) > 1 || abs(pointer.y - target.y) > 1
}
