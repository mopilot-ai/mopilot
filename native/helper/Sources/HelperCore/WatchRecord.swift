import Foundation

// Watch-and-record's key naming (pure, so it is tested without a window server): what the recorder keeps of one key
// press. Printable input becomes the text typed; a key with Command, Control or Option held, or a named key (Return,
// Tab, an arrow, ...), becomes a shortcut such as "cmd+shift+t" or "return", in the names input.key takes.

/// What one key press is in a demonstration: text typed, or a key/shortcut pressed.
public enum RecordedKey: Equatable {
    case text(String)
    case combo(String)
}

/// The named non-printing keys (macOS virtual key codes), by the names parseKeyCombo takes.
private let recordedKeyNames: [UInt16: String] = [
    36: "return", 76: "return", 48: "tab", 51: "delete", 53: "escape", 117: "forwarddelete",
    115: "home", 119: "end", 116: "pageup", 121: "pagedown", 123: "left", 124: "right", 125: "down", 126: "up",
    122: "f1", 120: "f2", 99: "f3", 118: "f4", 96: "f5", 97: "f6", 98: "f7", 100: "f8",
    101: "f9", 109: "f10", 103: "f11", 111: "f12",
]

private let flagCommand: UInt64 = 0x100000
private let flagShift: UInt64 = 0x20000
private let flagOption: UInt64 = 0x80000
private let flagControl: UInt64 = 0x40000

/// The modifier names of `flags`, in the order input.key writes them.
public func recordedModifiers(_ flags: UInt64) -> [String] {
    var out: [String] = []
    if flags & flagControl != 0 { out.append("ctrl") }
    if flags & flagOption != 0 { out.append("alt") }
    if flags & flagShift != 0 { out.append("shift") }
    if flags & flagCommand != 0 { out.append("cmd") }
    return out
}

/// One key-down as the recorder keeps it, or nil when it is not worth keeping (a bare control character, a modifier
/// with nothing to press). `characters` is what the key typed; `unshifted` what it would type without modifiers.
public func recordKey(keyCode: UInt16, flags: UInt64, characters: String?, unshifted: String?) -> RecordedKey? {
    let shortcut = flags & (flagCommand | flagControl | flagOption) != 0
    let name = recordedKeyNames[keyCode] ?? unshifted.flatMap { $0.count == 1 && $0.unicodeScalars.allSatisfy { $0.value >= 32 } ? $0.lowercased() : nil }
    if shortcut || recordedKeyNames[keyCode] != nil {
        guard let name else { return nil }
        return .combo((recordedModifiers(flags) + [name]).joined(separator: "+"))
    }
    guard let characters, !characters.isEmpty, characters.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value != 127 }) else { return nil }
    return .text(characters)
}
