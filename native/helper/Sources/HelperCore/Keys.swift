import Foundation

// Key names to macOS virtual key codes (ANSI layout) and modifier flags, for input.key.

public let escapeKeyCode: UInt16 = 53

private let namedKeys: [String: UInt16] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
    "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
    "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
    "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
    ".": 47, "`": 50,
]

/// CGEventFlags raw values.
private let modifierFlags: [String: UInt64] = [
    "cmd": 0x100000, "command": 0x100000, "meta": 0x100000, "super": 0x100000, "win": 0x100000,
    "shift": 0x20000,
    "alt": 0x80000, "option": 0x80000, "opt": 0x80000,
    "ctrl": 0x40000, "control": 0x40000,
    "fn": 0x800000,
]

public struct KeyCombo: Equatable {
    public let keyCode: UInt16
    public let flags: UInt64
}

/// "cmd+shift+t", "Return", "ctrl+a". The key comes last; unknown names give nil.
public func parseKeyCombo(_ spec: String) -> KeyCombo? {
    var parts = spec.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard let key = parts.popLast(), !key.isEmpty, let code = namedKeys[key] else { return nil }
    var flags: UInt64 = 0
    for m in parts {
        guard let f = modifierFlags[m.trimmingCharacters(in: .whitespaces)] else { return nil }
        flags |= f
    }
    return KeyCombo(keyCode: code, flags: flags)
}

/// Modifier names only ("cmd+shift", "alt"), for a click with keys held; nil when a name is unknown.
/// An empty spec is no modifiers.
public func parseModifiers(_ spec: String) -> UInt64? {
    let parts = spec.lowercased().split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    var flags: UInt64 = 0
    for m in parts {
        guard let f = modifierFlags[m] else { return nil }
        flags |= f
    }
    return flags
}
