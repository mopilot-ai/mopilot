// The helper's record of its own input (every route it posts by) and who sent the Escape that MoPilot's Esc-to-stop shortcut received.
import Foundation

// Events the helper posts per process (CGEvent.postToPid, background control) never pass the input guard's
// session tap, yet they reset the HID idle time and can reach MoPilot's global Esc shortcut. So every
// post is stamped here, on every route, as it goes out; the guard's tap adds what it sees (a person's keys,
// other agents' synthetic ones). Esc-to-stop asks who sent the latest Escape: only a person's stops a turn.

/// How recent (seconds) an Escape must be to be the one Esc-to-stop just received.
public let escapeAttributionWindowSeconds: Double = 1.5

/// When the helper last posted any input, and last posted an Escape key-down. Thread-safe.
public final class OwnPostClock {
    public static let shared = OwnPostClock(now: { ProcessInfo.processInfo.systemUptime })

    private let lock = NSLock()
    private let now: () -> Double
    private var lastPost: Double?
    private var lastEscape: Double?

    public init(now: @escaping () -> Double) {
        self.now = now
    }

    /// One event the helper is about to post (`escapeDown`: an Escape key-down).
    public func note(escapeDown: Bool) {
        lock.lock(); defer { lock.unlock() }
        let t = now()
        lastPost = t
        if escapeDown { lastEscape = t }
    }

    /// Seconds since the helper last posted (nil: never).
    public var sinceLastPost: Double? {
        lock.lock(); defer { lock.unlock() }
        return lastPost.map { now() - $0 }
    }

    /// Seconds since the helper last posted an Escape key-down (nil: never).
    public var sinceEscape: Double? {
        lock.lock(); defer { lock.unlock() }
        return lastEscape.map { now() - $0 }
    }
}

/// Whether an event is an Escape key-down (`type` is its CGEventType's raw value).
public func isEscapeDown(type: UInt32, keyCode: Int64) -> Bool {
    type == 10 /* kCGEventKeyDown */ && keyCode == Int64(escapeKeyCode)
}

/// How recent (seconds) the helper's own posted Escape must be to explain one the tap didn't see (a
/// per-process post): short, so a person's Esc the tap missed soon after is not taken for it.
public let ownEscapeAttributionWindowSeconds: Double = 0.5

/// Who sent an Escape.
public enum EscapeSender: String, Equatable {
    case person   // a physical key (or anything claiming the HID state, as the take-over check counts it)
    case agent    // the helper's own post, or one another process synthesized (Codex's computer use)
    case unknown  // nothing seen recently: the guard isn't watching, or the key bypassed it
}

/// Whether an Escape key-down the tap saw is a person's: anything claiming the HID state (as the take-over
/// check counts it), or an Apple assistive technology's (Voice Control's "press Escape"); never the helper's
/// own or another process's synthetic key.
public func isPersonEscape(origin: InputOrigin, sourceIsAssistive: Bool) -> Bool {
    origin == .physical || (origin == .synthetic && sourceIsAssistive)
}

/// Who sent the latest Escape, from the guard tap's last Escape key-down (`sinceTapEscape` seconds ago, a
/// person's when `tapByPerson`) and the helper's last posted one (`sinceOwnEscape`). The tap's record within
/// `window` decides unless the helper posted an Escape after it; with no tap record, an own post within
/// `ownWindow` is the agent's. Anything else is unknown, which Esc-to-stop honours.
public func escapeSender(sinceTapEscape: Double?, tapByPerson: Bool?, sinceOwnEscape: Double?,
                         window: Double = escapeAttributionWindowSeconds,
                         ownWindow: Double = ownEscapeAttributionWindowSeconds) -> EscapeSender {
    let own = sinceOwnEscape.flatMap { $0 <= window ? $0 : nil }
    if let t = sinceTapEscape, t <= window, let person = tapByPerson, own.map({ t <= $0 }) ?? true {
        return person ? .person : .agent
    }
    guard let o = own, o <= ownWindow || sinceTapEscape.map({ $0 <= window }) == true else { return .unknown }
    return .agent
}
