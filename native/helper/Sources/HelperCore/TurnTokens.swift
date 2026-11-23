// The `(chat, turn)` token main sends with each request (design D1): requests of a turn main revoked (it ended or
// was stopped) are refused, except those that give the Mac back, and the desktop lock is granted per token.
import Foundation

/// The turn a request belongs to: main's chat id, the Codex thread when turns are kept per thread, and the turn
/// number (larger is newer; main issues every number once).
public struct TurnToken: Equatable {
    public let chat: String
    public let thread: String?
    public let turn: Int

    public init(chat: String, thread: String? = nil, turn: Int) {
        self.chat = chat
        self.thread = thread
        self.turn = turn
    }

    /// The token in a request's `turn` field; nil when there is none (setup, Settings, an older main) or it is malformed.
    public init?(_ value: Any?) {
        guard let d = value as? [String: Any], let chat = d["chat"] as? String, !chat.isEmpty,
              let n = TurnToken.number(d["turn"]) else { return nil }
        let thread = (d["thread"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        self.init(chat: chat, thread: thread, turn: n)
    }

    /// A JSON integer (never a boolean, which JSONSerialization also reads as NSNumber).
    public static func number(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.intValue
    }
}

/// Which turns main revoked, and the token the desktop lock was granted to. Thread-safe.
public final class TurnGate {
    /// Requests that give the Mac back (let go of the lock and held input, show hidden apps, put the clipboard back,
    /// stop a batch) or only talk to the helper: they run for a revoked turn too. Keep in step with GIVES_BACK in
    /// electron/capabilities/computer.cjs.
    public static let givesBack: Set<String> = [
        "control.release", "input.release", "glow.stop", "pasteboard.restore", "app.cancel", "turn.revoke", "apps.restore",
        "hello", "ping", "shutdown",
    ]

    private let lock = NSLock()
    /// chat -> the newest turn revoked for the whole chat: every token of the chat up to it is refused
    private var revoked: [String: Int] = [:]
    /// chat and thread -> the newest turn revoked for that Codex thread only
    private var revokedThreads: [ThreadKey: Int] = [:]

    private struct ThreadKey: Hashable {
        let chat: String
        let thread: String
    }
    private var holder: TurnToken?

    public init() {}

    /// Whether a request may run: it carries no token, gives the Mac back, or its turn was not revoked.
    public func admits(_ method: String, _ token: TurnToken?) -> Bool {
        guard let token, !TurnGate.givesBack.contains(method) else { return true }
        lock.lock(); defer { lock.unlock() }
        return isCurrent(token)
    }

    /// The desktop lock was granted to `token` (nil: a request with no turn, which is never revoked).
    public func granted(_ token: TurnToken?) {
        lock.lock(); defer { lock.unlock() }
        holder = token
    }

    /// The desktop lock was let go.
    public func released() {
        lock.lock(); defer { lock.unlock() }
        holder = nil
    }

    /// The token the desktop lock is held for, if any.
    public var lockHolder: TurnToken? {
        lock.lock(); defer { lock.unlock() }
        return holder
    }

    /// Main revoked the chat's turns up to `turn`: every thread's, or with `thread`, only that Codex thread's. Returns
    /// true when the desktop lock was held for one of them: the caller lets go of it.
    @discardableResult
    public func revoke(chat: String, thread: String? = nil, through turn: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let thread {
            let key = ThreadKey(chat: chat, thread: thread)
            revokedThreads[key] = max(revokedThreads[key] ?? Int.min, turn)
        } else {
            revoked[chat] = max(revoked[chat] ?? Int.min, turn)
            // every thread's revoke up to here is covered by the chat's, and later thread turns are numbered above it
            revokedThreads = revokedThreads.filter { $0.key.chat != chat || $0.value > turn }
        }
        guard let holder, !isCurrent(holder) else { return false }
        self.holder = nil
        return true
    }

    /// Caller holds `lock`.
    private func isCurrent(_ token: TurnToken) -> Bool {
        if let through = revoked[token.chat], token.turn <= through { return false }
        guard let thread = token.thread, let through = revokedThreads[ThreadKey(chat: token.chat, thread: thread)] else { return true }
        return token.turn > through
    }
}
