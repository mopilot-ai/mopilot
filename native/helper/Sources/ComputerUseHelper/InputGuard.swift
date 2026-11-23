import AppKit
import HelperCore
import Security

/// A session event tap (needs Accessibility) on the main run loop for as long as the helper runs
/// (GuardTapLifecycle). It drops input another process synthesized into a MoPilot window, so only a
/// person (or Apple's assistive technologies) can answer MoPilot's cards or use its menus. While a
/// controller holds the desktop it watches for the user: a physical Esc aborts the current action and is
/// swallowed; any other physical key, click or scroll, or a pointer move that really travels
/// (TakeoverFilter: not the helper's own echo, not a report with no motion, not another process's move),
/// pauses control (take-over) and goes through. It also re-checks the helper's own clicks and keystrokes
/// just before they land, so a window that moved under the cursor after the policy check still can't
/// receive them. A person's input is never
/// dropped (Esc during control is the one key it swallows).
final class InputGuard {
    /// Whether a controller holds the desktop and isn't paused.
    var isActive: () -> Bool = { false }
    var onPause: (PauseReason, Int64) -> Void = { _, _ in }
    /// Re-check for our own mouse-down and key-down events.
    var ownEventAllowed: (CGEvent) -> Bool = { _ in true }

    /// Input that is not the helper's own, as it passes the tap (watch-and-record, WatchRecord.swift).
    var onInput: (CGEventType, CGEvent, Bool) -> Void = { _, _, _ in }

    /// Whether an event would reach a MoPilot window.
    var landsOnMoPilot: (CGEvent) -> Bool = { _ in false }
    var protectedPids: () -> Set<pid_t> = { [] }

    private var assistiveCache: [pid_t: Bool] = [:]
    private let landingTypes: Set<CGEventType> = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                                  .leftMouseDragged, .rightMouseDragged, .scrollWheel]
    /// Set once in init; read from the server's threads too (controlState), so not lazy.
    private var lifecycle: GuardTapLifecycle!
    /// Which pointer moves are the user taking over (main run loop only, like the tap).
    private var takeover = TakeoverFilter()
    private let clock = NSLock()
    /// When the tap was installed (nil: it isn't), it last saw a person and other (posted) input, and the last
    /// Escape key-down it saw (and whether a person sent it).
    private var installedAt: Double?
    private var lastUserAt: Double?
    private var lastOtherAt: Double?
    private var lastEscape: (at: Double, person: Bool)?

    /// The user's idle time with posted input left out (any thread): the helper's own on every route and
    /// what the tap saw other processes post, so neither reads as a person at the computer.
    func userIdle(hidIdle: Double) -> Double {
        clock.lock(); defer { clock.unlock() }
        let now = ProcessInfo.processInfo.systemUptime
        return userIdleSeconds(hidIdle: hidIdle, sinceOwnPost: OwnPostClock.shared.sinceLastPost,
                               sinceUserInput: lastUserAt.map { now - $0 }, sinceTapInstalled: installedAt.map { now - $0 },
                               sinceOtherInput: lastOtherAt.map { now - $0 })
    }

    /// Who sent the latest Escape (any thread): Esc-to-stop stops a turn only for a person's.
    func escapeSender() -> EscapeSender {
        clock.lock(); defer { clock.unlock() }
        let now = ProcessInfo.processInfo.systemUptime
        return HelperCore.escapeSender(sinceTapEscape: lastEscape.map { now - $0.at }, tapByPerson: lastEscape?.person,
                                       sinceOwnEscape: OwnPostClock.shared.sinceEscape)
    }

    /// Input the tap let through: a person's, or another process's post (or pointer noise).
    private func stampInput(person: Bool, at now: Double) {
        clock.lock(); defer { clock.unlock() }
        if person { lastUserAt = now } else { lastOtherAt = now }
    }

    private func stampEscape(person: Bool, at now: Double) {
        clock.lock(); defer { clock.unlock() }
        lastEscape = (now, person)
    }

    /// The tap came (or went): idle time is what it has seen since.
    private func stampInstalled(_ installed: Bool) {
        clock.lock(); defer { clock.unlock() }
        if !installed {
            installedAt = nil
            lastUserAt = nil
            lastOtherAt = nil
        } else if installedAt == nil {
            installedAt = ProcessInfo.processInfo.systemUptime
        }
    }

    init() {
        lifecycle = GuardTapLifecycle(
            create: { [unowned self] in self.createTap() },
            destroy: { handle in
                guard let t = handle as? TapHandle else { return }
                CGEvent.tapEnable(tap: t.port, enable: false)
                CFRunLoopRemoveSource(CFRunLoopGetMain(), t.source, .commonModes)
                CFMachPortInvalidate(t.port)
            },
            enable: { handle in
                if let t = handle as? TapHandle { CGEvent.tapEnable(tap: t.port, enable: true) }
            }
        )
    }

    /// An Apple-signed process with an assistive technology's bundle id (cached per pid).
    private func isAppleAssistive(_ pid: pid_t) -> Bool {
        if let hit = assistiveCache[pid] { return hit }
        let ok = isAssistiveBundle(bundleId(of: pid)) && isAppleSigned(pid)
        if assistiveCache.count > 256 { assistiveCache.removeAll() }
        assistiveCache[pid] = ok
        return ok
    }

    var installed: Bool { lifecycle.installed }

    /// Installs the tap (at launch, or once Accessibility is granted). Returns false while Accessibility
    /// isn't granted. Main thread.
    @discardableResult
    func install() -> Bool {
        let ok = lifecycle.install()
        stampInstalled(ok)
        return ok
    }

    /// Removes the tap and its run-loop source (the helper is exiting). Idempotent. Main thread.
    func uninstall() {
        lifecycle.uninstall()
        stampInstalled(false)
    }

    private func createTap() -> TapHandle? {
        let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .mouseMoved,
                                    .leftMouseDragged, .rightMouseDragged, .scrollWheel]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                           eventsOfInterest: mask, callback: tapCallback,
                                           userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return nil }
        guard let src = CFMachPortCreateRunLoopSource(nil, port, 0) else {
            CFMachPortInvalidate(port)
            return nil
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        return TapHandle(port: port, source: src)
    }

    fileprivate func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        if isTapDisabledNotice(type.rawValue) {
            lifecycle.reenable()
            return Unmanaged.passUnretained(event)
        }
        let sourcePid = event.getIntegerValueField(.eventSourceUnixProcessID)
        let origin = classifyInput(userData: event.getIntegerValueField(.eventSourceUserData),
                                   sourceStateID: event.getIntegerValueField(.eventSourceStateID),
                                   sourcePid: sourcePid, selfPid: Int64(getpid()))
        let now = ProcessInfo.processInfo.systemUptime
        let kind: GuardEvent
        switch type {
        case .keyDown:
            kind = UInt16(event.getIntegerValueField(.keyboardEventKeycode)) == escapeKeyCode ? .escape : .key
        default:
            kind = .mouse
        }
        // Esc-to-stop asks who sent the latest Escape (a person's, or an agent's post)
        if kind == .escape {
            let assistive = origin == .synthetic && sourcePid > 0 && isAppleAssistive(pid_t(sourcePid))
            stampEscape(person: isPersonEscape(origin: origin, sourceIsAssistive: assistive), at: now)
        }
        // Events another process synthesized into a MoPilot window never land (Apple's assistive
        // technologies excepted). Anything claiming the HID system state is a person's input and always goes
        // through.
        if mayDropForeignEvent(origin: origin, sourcePid: sourcePid), landingTypes.contains(type), landsOnMoPilot(event) {
            let pid = pid_t(sourcePid)
            if dropForeignEvent(origin: origin, sourcePid: sourcePid, landsOnMoPilot: true,
                                sourceIsMoPilot: protectedPids().contains(pid), sourceIsAssistive: isAppleAssistive(pid)) {
                log("dropped a synthetic event from pid \(pid) aimed at MoPilot")
                stampInput(person: false, at: now)
                return nil
            }
        }
        if origin == .own {
            if kind == .mouse { takeover.noteOwn(event.location, time: now) }
            let landing = type == .keyDown || type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown
            if landing && !ownEventAllowed(event) {
                log("dropped an own event whose target changed to a protected app")
                return nil
            }
            return Unmanaged.passUnretained(event)
        }
        let pointer = kind == .mouse ? pointerSample(type, event, sourcePid: sourcePid, time: now) : nil
        stampInput(person: origin == .physical && isUserPresence(pointer), at: now)
        let d = sparingMoPilot(guardDecision(kind, origin: origin, active: isActive(), pointer: pointer, filter: &takeover)) { landsOnMoPilot(event) }
        // what reached the app, and who sent it (watch-and-record keeps a person's input alone)
        if !d.swallow { onInput(type, event, origin == .physical) }
        if let reason = d.pause { onPause(reason, sourcePid) }
        return d.swallow ? nil : Unmanaged.passUnretained(event)
    }
}

/// A mouse event as the take-over filter sees it.
private func pointerSample(_ type: CGEventType, _ event: CGEvent, sourcePid: Int64, time: Double) -> PointerSample {
    let kind: PointerEventKind
    switch type {
    case .mouseMoved: kind = .move
    case .leftMouseDragged, .rightMouseDragged: kind = .drag
    case .scrollWheel: kind = .scroll
    default: kind = .button
    }
    let delta = CGVector(dx: event.getDoubleValueField(.mouseEventDeltaX), dy: event.getDoubleValueField(.mouseEventDeltaY))
    return PointerSample(kind: kind, location: event.location, delta: delta, sourcePid: sourcePid, time: time)
}

/// The tap's mach port and its run-loop source, removed together.
private final class TapHandle {
    let port: CFMachPort
    let source: CFRunLoopSource
    init(port: CFMachPort, source: CFRunLoopSource) {
        self.port = port
        self.source = source
    }
}

/// True when the process with `pid` is signed by Apple.
private func isAppleSigned(_ pid: pid_t) -> Bool {
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid: pid] as CFDictionary, [], &code) == errSecSuccess, let code else { return false }
    var req: SecRequirement?
    guard SecRequirementCreateWithString("anchor apple" as CFString, [], &req) == errSecSuccess, let req else { return false }
    return SecCodeCheckValidity(code, [], req) == errSecSuccess
}

private func tapCallback(proxy: CGEventTapProxy, type: CGEventType, event: CGEvent, refcon: UnsafeMutableRawPointer?) -> Unmanaged<CGEvent>? {
    guard let refcon else { return Unmanaged.passUnretained(event) }
    return Unmanaged<InputGuard>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
}

/// Marks an event the helper is about to post as its own and stamps it on the own-post clock. Every posting
/// route goes through it (the HID tap and per process), so per-process posts, which the tap never sees, are
/// still the helper's own input for the idle time and Esc-to-stop.
func markOwnPost(_ e: CGEvent) {
    e.setIntegerValueField(.eventSourceUserData, value: ownEventMarker)
    OwnPostClock.shared.note(escapeDown: isEscapeDown(type: e.type.rawValue, keyCode: e.getIntegerValueField(.keyboardEventKeycode)))
}
