// The hard floor: apps the helper never sends input to and never reads, whatever main asks for.
// Main can add bundle ids at launch but cannot remove the built-in ones.

public struct DenyRule: Equatable {
    /// A bundle id, or a prefix written as "com.example.*" (matches com.example itself and anything under it).
    public let pattern: String
    public let reason: String
    /// Also cut out of screenshots (password managers, auth prompts, MoPilot itself).
    public let hideFromCapture: Bool

    public init(_ pattern: String, _ reason: String, hide: Bool) {
        self.pattern = pattern
        self.reason = reason
        self.hideFromCapture = hide
    }

    func matches(_ bundleId: String) -> Bool {
        let id = bundleId.lowercased()
        let p = pattern.lowercased()
        if p.hasSuffix(".*") {
            let stem = String(p.dropLast(2))
            return id == stem || id.hasPrefix(stem + ".")
        }
        return id == p
    }
}

public struct DenyList {
    public static let builtIn: [DenyRule] = [
        DenyRule("ai.mopilot.code.*", "MoPilot", hide: true),
        // The whole of System Settings, not only Privacy & Security: pane titles are localized and a
        // window title is easy to change, so pane-level matching would be a weaker floor.
        DenyRule("com.apple.systempreferences", "System Settings", hide: false),
        DenyRule("com.apple.SecurityAgent", "authentication prompt", hide: true),
        DenyRule("com.apple.LocalAuthentication.UIAgent", "authentication prompt", hide: true),
        DenyRule("com.apple.loginwindow", "login window", hide: true),
        // macOS's permission and consent prompts: a click there could grant (or revoke) a privacy permission
        DenyRule("com.apple.tcc.AuthorizationPromptService", "permission prompt", hide: true),
        DenyRule("com.apple.UserNotificationCenter", "permission prompt", hide: true),
        DenyRule("com.apple.accessibility.universalAccessAuthWarn", "permission prompt", hide: true),
        DenyRule("com.apple.screencaptureui", "permission prompt", hide: true),
        DenyRule("com.apple.coreservices.uiagent", "permission prompt", hide: true),
        DenyRule("com.apple.CoreLocationAgent", "permission prompt", hide: true),
        DenyRule("com.apple.NetAuthAgent", "authentication prompt", hide: true),
        DenyRule("com.apple.keychainaccess", "Keychain Access", hide: true),
        DenyRule("com.apple.Passwords.*", "Passwords", hide: true),
        DenyRule("com.1password.*", "password manager", hide: true),
        DenyRule("com.agilebits.*", "password manager", hide: true),
        DenyRule("com.bitwarden.desktop", "password manager", hide: true),
        DenyRule("com.lastpass.LastPass", "password manager", hide: true),
        DenyRule("in.sinew.Enpass-Desktop", "password manager", hide: true),
        DenyRule("org.keepassxc.keepassxc", "password manager", hide: true),
    ]

    public private(set) var rules: [DenyRule]

    /// `extra` comes from main's launch config: more bundle ids (or "prefix.*") to refuse and hide.
    public init(extra: [String] = []) {
        rules = DenyList.builtIn
        for id in extra where !id.isEmpty && !rules.contains(where: { $0.pattern.lowercased() == id.lowercased() }) {
            rules.append(DenyRule(id, "blocked by MoPilot", hide: true))
        }
    }

    public func rule(for bundleId: String?) -> DenyRule? {
        guard let bundleId, !bundleId.isEmpty else { return nil }
        return rules.first { $0.matches(bundleId) }
    }

    public func isHiddenFromCapture(_ bundleId: String?) -> Bool {
        rule(for: bundleId)?.hideFromCapture ?? false
    }
}
