// Take-over detection: which pointer moves are a person reaching for the mouse, and which are the helper's own echoes, a virtual machine's pointer reports or another process's moves.
import CoreGraphics
import Foundation

// The input guard pauses control when the user takes over. A key, click or scroll from the HID system is
// always the user. A pointer move is not proof on its own: the window server re-emits and coalesces the
// helper's own moves without its user-data marker, a virtual machine's pointing device sends reports with
// no motion, and remote-control or automation processes post moves that claim the HID state. Only a move
// that travels away from where the pointer was counts, so a person who grabs the mouse still takes over
// at once, and nothing else does.

/// How far (points) the pointer must travel from where a move burst started before it is a take-over.
public let takeoverMoveThreshold: CGFloat = 8
/// A move this close (points) to where the helper last put the pointer is the helper's own echo.
public let ownEchoTolerance: CGFloat = 2
/// How long after the helper's last pointer event a move at that point is still its echo.
public let ownEchoWindowSeconds: Double = 1.5
/// A pause this long between moves starts a new burst (its own starting point).
public let moveBurstGapSeconds: Double = 0.5

/// What a guarded event is, for take-over purposes.
public enum PointerEventKind: Equatable {
    case move     // mouseMoved
    case drag     // a mouse-dragged event: a button is held
    case button   // a mouse-down
    case scroll
}

/// One mouse event as the tap sees it.
public struct PointerSample: Equatable {
    public let kind: PointerEventKind
    public let location: CGPoint
    /// mouseEventDeltaX / mouseEventDeltaY
    public let delta: CGVector
    /// eventSourceUnixProcessID: 0 for the HID system's own events, the poster's pid otherwise
    public let sourcePid: Int64
    /// seconds, any monotonic clock
    public let time: Double

    public init(kind: PointerEventKind, location: CGPoint, delta: CGVector = CGVector(dx: 1, dy: 1), sourcePid: Int64 = 0, time: Double) {
        self.kind = kind
        self.location = location
        self.delta = delta
        self.sourcePid = sourcePid
        self.time = time
    }
}

/// Tracks the helper's own pointer events and the current move burst, and says whether a physical mouse
/// event is the user taking over. Not thread-safe: the event tap and the helper's posts both run it under
/// the caller's lock (InputGuard uses the main run loop for the tap and a lock for own posts).
public struct TakeoverFilter {
    /// Where and when the helper last put the pointer.
    public private(set) var lastOwn: (point: CGPoint, time: Double)?
    /// Where the current burst of moves started, and when its last move came.
    public private(set) var burst: (start: CGPoint, last: Double)?

    public init() {}

    /// The helper posted a pointer event at `point`: moves back to it are echoes, and a burst starts over.
    public mutating func noteOwn(_ point: CGPoint, time: Double) {
        lastOwn = (point, time)
        burst = nil
    }

    /// Whether a physical (HID-state, not the helper's) mouse event is a take-over.
    public mutating func isTakeover(_ s: PointerSample) -> Bool {
        switch s.kind {
        case .button, .scroll, .drag:
            // deliberate input: a click, a scroll or a held button
            return true
        case .move:
            return isTakeoverMove(s)
        }
    }

    private mutating func isTakeoverMove(_ s: PointerSample) -> Bool {
        // another process posted it (remote control, automation, a VM's input bridge): a move alone hands
        // nothing over; its clicks, scrolls and keys still do
        if s.sourcePid > 0 { return false }
        // a report with no motion (a VM's absolute pointer, a window appearing under the cursor)
        if s.delta.dx == 0 && s.delta.dy == 0 { return false }
        // the window server's re-emitted or coalesced copy of the helper's own move
        if let own = lastOwn, s.time - own.time <= ownEchoWindowSeconds, distance(own.point, s.location) <= ownEchoTolerance {
            return false
        }
        let start: CGPoint
        if let b = burst, s.time - b.last <= moveBurstGapSeconds {
            start = b.start
        } else {
            // a new burst starts where the pointer was before this move
            start = CGPoint(x: s.location.x - s.delta.dx, y: s.location.y - s.delta.dy)
        }
        burst = (start, s.time)
        return distance(start, s.location) > takeoverMoveThreshold
    }
}

func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat {
    hypot(a.x - b.x, a.y - b.y)
}

/// Whether a physical event shows a person at the computer, for their idle time: anything but a pointer
/// move another process posted or a report with no motion (`pointer` nil: a key).
public func isUserPresence(_ pointer: PointerSample?) -> Bool {
    guard let p = pointer, p.kind == .move else { return true }
    return p.sourcePid == 0 && !(p.delta.dx == 0 && p.delta.dy == 0)
}

/// The user's idle time with posted input left out. `hidIdle` is the HID system's idle time, which posted
/// events reset too: the helper's own (`sinceOwnPost`, stamped on every route, including per-process posts
/// the input guard's session tap never sees) and other processes' synthetic input the tap saw
/// (`sinceOtherInput`). nil: none. When the latest HID event may be one of those posts, the guard's record
/// stands in: how long ago it last saw a person (`sinceUserInput`), or, having seen none, how long it has
/// watched (`sinceTapInstalled`; without the tap, at least since that post). Any other HID event counts as
/// a person, as far as anyone can tell, also one the tap can't see (keys under secure input).
public func userIdleSeconds(hidIdle: Double, sinceOwnPost: Double?, sinceUserInput: Double?,
                            sinceTapInstalled: Double? = nil, sinceOtherInput: Double? = nil) -> Double {
    let posts = [sinceOwnPost, sinceOtherInput].compactMap { $0 }.filter { hidIdle + 0.05 >= $0 }
    guard let post = posts.min() else { return hidIdle }
    if let watched = sinceTapInstalled { return max(hidIdle, min(sinceUserInput ?? watched, watched)) }
    return sinceUserInput ?? post
}
