import Foundation

// The input guard's event tap: its lifetime, and what it may drop. Pure, so the rules are tested without
// Accessibility or a window server.
//
// The tap lives as long as the helper (installed at launch, or as soon as Accessibility is granted, and
// removed on exit). It drops input another process synthesized into a MoPilot window, so nothing but
// a person (or Apple's assistive technologies) can answer MoPilot's approval cards or use its menus
// while the helper runs. A person's input always goes through; only a physical Esc while a controller
// holds the desktop is swallowed (guardDecision).

/// The tap's event types the system sends when it turned the tap off (kCGEventTapDisabledByTimeout,
/// kCGEventTapDisabledByUserInput).
public let tapDisabledByTimeoutType: UInt32 = 0xFFFF_FFFE
public let tapDisabledByUserInputType: UInt32 = 0xFFFF_FFFF

/// Whether `rawType` is the system telling the tap it was turned off.
public func isTapDisabledNotice(_ rawType: UInt32) -> Bool {
    rawType == tapDisabledByTimeoutType || rawType == tapDisabledByUserInputType
}

/// Owns one event tap. Thread-safe. `create` returns the tap's handle (nil while Accessibility isn't
/// granted), `destroy` disables and removes it, `enable` turns a tap the system disabled back on.
public final class GuardTapLifecycle {
    private let lock = NSLock()
    private var handle: AnyObject?
    private let create: () -> AnyObject?
    private let destroy: (AnyObject) -> Void
    private let enable: (AnyObject) -> Void

    public init(create: @escaping () -> AnyObject?, destroy: @escaping (AnyObject) -> Void, enable: @escaping (AnyObject) -> Void) {
        self.create = create
        self.destroy = destroy
        self.enable = enable
    }

    public var installed: Bool {
        lock.lock(); defer { lock.unlock() }
        return handle != nil
    }

    /// Creates the tap unless it exists. Returns false when it can't be created (no Accessibility).
    @discardableResult
    public func install() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if handle != nil { return true }
        handle = create()
        return handle != nil
    }

    /// Removes the tap (the helper is exiting). Idempotent.
    public func uninstall() {
        lock.lock()
        let h = handle
        handle = nil
        lock.unlock()
        if let h { destroy(h) }
    }

    /// The system turned the tap off (a slow callback, or secure input): turn it back on if it is still
    /// ours. The event that carried the notice is always let through.
    public func reenable() {
        lock.lock()
        let h = handle
        lock.unlock()
        if let h { enable(h) }
    }
}

/// Whether the tap drops an event another process posted (`sourcePid` > 0) that lands on a MoPilot
/// window: only input that is positively synthetic (never anything claiming the HID system state, never
/// the helper's own), and never from MoPilot itself or an Apple assistive technology. This holds
/// whenever the helper runs, whether or not a controller holds the desktop.
public func dropForeignEvent(origin: InputOrigin, sourcePid: Int64, landsOnMoPilot: Bool, sourceIsMoPilot: Bool, sourceIsAssistive: Bool) -> Bool {
    guard origin == .synthetic, sourcePid > 0, landsOnMoPilot else { return false }
    return !sourceIsMoPilot && !sourceIsAssistive
}

/// Whether the tap needs to know if a foreign event lands on MoPilot (that look-up hits the window
/// server, so it is skipped whenever the answer can't change the outcome).
public func mayDropForeignEvent(origin: InputOrigin, sourcePid: Int64) -> Bool {
    origin == .synthetic && sourcePid > 0
}
