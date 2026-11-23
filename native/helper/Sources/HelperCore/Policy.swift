// Who may talk to the helper, and which apps an event may land on.

/// A process an event would reach: the app owning the window under a point, or the frontmost app.
public struct Target: Equatable {
    public let pid: Int32?
    public let bundleId: String?
    public let name: String?

    public init(pid: Int32?, bundleId: String?, name: String? = nil) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
    }
}

public enum Verdict: Equatable {
    case allowed
    case refused(String)
}

public struct TargetPolicy {
    /// MoPilot's main process and the helper itself, whatever their bundle ids (a dev build runs as Electron).
    public var protectedPids: Set<Int32>
    public var denyList: DenyList

    public init(protectedPids: Set<Int32>, denyList: DenyList) {
        self.protectedPids = protectedPids
        self.denyList = denyList
    }

    /// Every candidate must pass. No candidate at all is refused: an event whose target can't be named
    /// doesn't get sent.
    public func check(_ targets: [Target]) -> Verdict {
        if targets.isEmpty { return .refused("target unknown") }
        for t in targets {
            guard let pid = t.pid, pid > 0 else { return .refused("target unknown") }
            if protectedPids.contains(pid) { return .refused("MoPilot") }
            if let rule = denyList.rule(for: t.bundleId) { return .refused(rule.reason) }
        }
        return .allowed
    }
}

/// Main's per-call app grant: when `bundleIds` is given, every target must be one of those apps (so a
/// window that moved under the pointer since main asked can't take the event).
public func restrict(_ targets: [Target], to bundleIds: [String]?) -> Verdict {
    guard let bundleIds else { return .allowed }
    let ok = Set(bundleIds.map { $0.lowercased() })
    for t in targets {
        guard let id = t.bundleId?.lowercased(), ok.contains(id) else { return .refused("not approved (\(t.name ?? t.bundleId ?? "unknown"))") }
    }
    return targets.isEmpty ? .refused("target unknown") : .allowed
}

public enum PeerVerdict: Equatable {
    case accept
    case reject(String)
}

/// The pid inside a darwin audit_token_t (its eight 32-bit words; the pid is word 5).
public func pidFromAuditToken(_ words: [UInt32]) -> Int32? {
    words.count == 8 ? Int32(bitPattern: words[5]) : nil
}

/// A connection is accepted only from the main pid registered at launch, and only one at a time.
/// `tokenPid` comes from LOCAL_PEERTOKEN (cannot be spoofed by the peer); `peerPid` from LOCAL_PEERPID
/// is a cross-check.
public func checkPeer(tokenPid: Int32?, peerPid: Int32?, expectedPid: Int32, busy: Bool) -> PeerVerdict {
    guard let tokenPid else { return .reject("no audit token") }
    if tokenPid != expectedPid { return .reject("pid \(tokenPid) is not the registered main pid") }
    if let peerPid, peerPid != tokenPid { return .reject("peer pid mismatch") }
    if busy { return .reject("another connection is active") }
    return .accept
}

/// Constant-time comparison for the per-launch token.
public func tokensEqual(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    var diff = UInt8(x.count == y.count ? 0 : 1)
    for i in 0..<max(x.count, y.count) {
        diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0)
    }
    return diff == 0 && !x.isEmpty
}

// MARK: - Physical input

/// Stamped into CGEventField.eventSourceUserData on every event the helper posts.
public let ownEventMarker: Int64 = 0x4D6F_5069_6C6F_74 // "MoPilot"

/// CGEventSourceStateID.hidSystemState.
public let hidSystemStateID: Int64 = 1

public enum InputOrigin: Equatable {
    case own       // posted by this helper
    case physical  // from the HID system (a real keyboard, mouse or trackpad)
    case synthetic // posted by some other process
}

/// Anything not ours that claims the HID system state counts as physical. Erring that way only ever
/// pauses or aborts control, never keeps it going. An event the helper's own process posted (`sourcePid`
/// is `selfPid`) is its own even when the window server re-emitted it without the user-data marker.
public func classifyInput(userData: Int64, sourceStateID: Int64, sourcePid: Int64 = 0, selfPid: Int64 = 0) -> InputOrigin {
    if userData == ownEventMarker { return .own }
    if selfPid > 0 && sourcePid == selfPid { return .own }
    if sourceStateID == hidSystemStateID { return .physical }
    return .synthetic
}

public enum GuardEvent: Equatable {
    case escape
    case key
    case mouse
}

public enum PauseReason: String, Equatable {
    case escape   // the user pressed Esc: abort the current action
    case takeover // the user moved the mouse or typed: hand the desktop back
}

public struct GuardDecision: Equatable {
    public let pause: PauseReason?
    /// Drop the event so it never reaches an app (only Esc while the agent is in control).
    public let swallow: Bool
}

/// `active`: a controller holds the desktop and isn't paused.
public func guardDecision(_ event: GuardEvent, origin: InputOrigin, active: Bool) -> GuardDecision {
    guard active, origin == .physical else { return GuardDecision(pause: nil, swallow: false) }
    switch event {
    case .escape: return GuardDecision(pause: .escape, swallow: true)
    case .key, .mouse: return GuardDecision(pause: .takeover, swallow: false)
    }
}

/// A take-over pause for input a person gives MoPilot itself (its docked panel, a card in it) is dropped: they are
/// answering the chat in control, not taking the desktop. `landsOnMoPilot` is asked only for such a pause.
public func sparingMoPilot(_ d: GuardDecision, landsOnMoPilot: () -> Bool) -> GuardDecision {
    guard d.pause == .takeover, landsOnMoPilot() else { return d }
    return GuardDecision(pause: nil, swallow: d.swallow)
}

/// guardDecision for an event the tap saw, with a mouse event's `pointer` sample checked by `filter`
/// (TakeoverFilter): a pointer move that is an echo, a report with no motion or a few points of drift
/// never pauses control.
public func guardDecision(_ event: GuardEvent, origin: InputOrigin, active: Bool, pointer: PointerSample?, filter: inout TakeoverFilter) -> GuardDecision {
    if event == .mouse, active, origin == .physical, let pointer, !filter.isTakeover(pointer) {
        return GuardDecision(pause: nil, swallow: false)
    }
    return guardDecision(event, origin: origin, active: active)
}

// MARK: - Events from other processes

extension TargetPolicy {
    /// MoPilot itself: its own and the helper's processes, and any ai.mopilot.code.* app.
    public func isMoPilot(_ t: Target) -> Bool {
        if let pid = t.pid, protectedPids.contains(pid) { return true }
        return denyList.rule(for: t.bundleId)?.reason == "MoPilot"
    }
}

/// Apple's own assistive technologies. They may post events into any window (VoiceOver, Voice Control,
/// Switch Control, the accessibility daemons); while the helper runs, every other synthetic event
/// is dropped before it lands on MoPilot (dropForeignEvent). A bundle id alone is spoofable, so the
/// caller also checks the source process is signed by Apple.
public func isAssistiveBundle(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    let exact: Set<String> = [
        "com.apple.voiceover", "com.apple.universalaccessd", "com.apple.universalaccessauthwarn",
        "com.apple.accessibilityuiserver", "com.apple.assistivetouch",
    ]
    if exact.contains(id) { return true }
    return ["com.apple.voicecontrol", "com.apple.accessibility", "com.apple.assistivecontrol", "com.apple.switchcontrol"].contains {
        id == $0 || id.hasPrefix($0 + ".")
    }
}

