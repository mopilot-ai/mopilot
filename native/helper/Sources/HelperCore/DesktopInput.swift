import Foundation

// The pure parts of the display-scope input additions: the capture size cap, the longest key hold, which
// running apps hide while a chat holds the desktop, and the app's text substitutions turned off around
// typed keystrokes (and put back after).

// MARK: - Limits

/// The longest image side the helper captures: high-resolution vision models take 2576 px on the long
/// edge (Anthropic's docs for Claude Opus 4.7 and later). This is only an upper bound: main asks for the
/// size the chat's harness really passes to the model (2000 px for Claude Code, #3920) or less.
public let maxCaptureSide = 2576

/// The longest a key is held down (input.key holdMs), as the official computer-use toolset's 100 s.
public let maxHoldMs = 100_000

/// A requested size, capped at `limit` (nil or non-positive: `fallback`).
public func cappedSide(_ requested: Int?, fallback: Int, limit: Int = maxCaptureSide) -> Int {
    guard let requested, requested > 0 else { return min(fallback, limit) }
    return min(requested, limit)
}

// MARK: - Hide before action

/// A running app as the hide-before-action pass sees it.
public struct RunningApp: Equatable {
    public let pid: Int32
    public let bundleId: String?
    public let name: String?
    /// Already hidden: left alone, and not shown again later.
    public let hidden: Bool
    /// A regular app with windows a person switches between (accessory and background apps are left alone).
    public let regular: Bool

    public init(pid: Int32, bundleId: String?, name: String?, hidden: Bool, regular: Bool) {
        self.pid = pid
        self.bundleId = bundleId
        self.name = name
        self.hidden = hidden
        self.regular = regular
    }

    public var json: [String: Any] { ["pid": Int(pid), "bundleId": bundleId ?? "", "name": name ?? bundleId ?? ""] }
}

/// The apps to hide while a chat holds the desktop: every visible regular app except the granted ones
/// (`keep`, bundle ids, any case) and MoPilot itself (`protectedPids`, whose own windows main hides).
public func appsToHide(_ apps: [RunningApp], keep: [String], protectedPids: Set<Int32>) -> [RunningApp] {
    let kept = Set(keep.map { $0.lowercased() })
    return apps.filter { a in
        guard a.regular, !a.hidden, !protectedPids.contains(a.pid) else { return false }
        guard let id = a.bundleId?.lowercased() else { return true }
        return !kept.contains(id)
    }
}

// MARK: - Text substitutions

/// The per-app defaults behind Edit > Substitutions and Spelling (AppKit and WebKit text views), turned
/// off around typed keystrokes so autocorrect, text replacement and smart punctuation leave the text as is.
public let substitutionKeys = [
    "NSAutomaticSpellingCorrectionEnabled",
    "NSAutomaticTextReplacementEnabled",
    "NSAutomaticQuoteSubstitutionEnabled",
    "NSAutomaticDashSubstitutionEnabled",
    "NSAutomaticPeriodSubstitutionEnabled",
    "NSAutomaticCapitalizationEnabled",
    "WebAutomaticSpellingCorrectionEnabled",
    "WebAutomaticTextReplacementEnabled",
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticDashSubstitutionEnabled",
]

/// An app's substitution settings, switched off for one call and put back after (a value the app never
/// had is removed again rather than left as false).
public struct SubstitutionOverride {
    /// each key with the app's own value before (nil when it had none), in substitutionKeys order
    public let prior: [(key: String, value: Any?)]

    /// Reads each key with `get`, then sets it to false with `set`.
    public static func apply(get: (String) -> Any?, set: (String, Any?) -> Void) -> SubstitutionOverride {
        var prior: [(key: String, value: Any?)] = []
        for k in substitutionKeys {
            prior.append((k, get(k)))
            set(k, false)
        }
        return SubstitutionOverride(prior: prior)
    }

    /// Puts every key back as it was.
    public func restore(set: (String, Any?) -> Void) {
        for (k, v) in prior {
            set(k, v)
        }
    }
}
