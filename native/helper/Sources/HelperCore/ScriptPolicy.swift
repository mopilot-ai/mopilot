import Foundation

// Scripts against one app (app.script, #3571 G7): whether an app is scriptable, the static check a script passes before
// it runs (what it may not reach, whether it writes, which verbs can't be undone), and the wrapper that points it at the
// named app only. The check is deny-by-token over a tokenizer that skips comments and string literals, so a word inside
// a string never counts and a word outside one always does. The JXA check is in ScriptPolicyJXA.swift.

/// The languages app.script runs: AppleScript, and JavaScript for Automation (JXA).
public enum ScriptLanguage: String, CaseIterable {
    case applescript
    case javascript

    /// osascript's -l name.
    public var osaName: String { self == .applescript ? "AppleScript" : "JavaScript" }

    /// The language a request names (case-insensitive, with "jxa" and "js" for JavaScript); AppleScript when none.
    public static func parse(_ v: Any?) -> ScriptLanguage? {
        guard let s = v as? String else { return v == nil ? .applescript : nil }
        switch s.lowercased() {
        case "", "applescript", "as": return .applescript
        case "javascript", "jxa", "js": return .javascript
        default: return nil
        }
    }
}

/// The longest script app.script takes, in characters.
public let maxScriptLength = 20_000

/// Whether an app's Info.plist says it has a scripting dictionary (NSAppleScriptEnabled, or an OSAScriptingDefinition).
public func isScriptable(info: [String: Any]?) -> Bool {
    guard let info else { return false }
    if let sdef = info["OSAScriptingDefinition"] as? String, !sdef.isEmpty { return true }
    switch info["NSAppleScriptEnabled"] {
    case let b as Bool: return b
    case let s as String: return ["yes", "true", "1"].contains(s.lowercased())
    default: return false
    }
}

/// What the static check found: the script may run, whether it writes (needs the full tier), and the verbs in it that
/// can't be undone (the user confirms them first).
public struct ScriptCheck: Equatable {
    public let writes: Bool
    public let irreversible: [String]

    public var json: [String: Any] { ["ok": true, "writes": writes, "irreversible": irreversible] }
}

/// Why a script was refused; `reason` names the construct, for the model.
public struct ScriptRefusal: Error, Equatable {
    public let reason: String
}

/// A word of a script outside comments and strings (lowercased for AppleScript), or a string literal's value.
public enum ScriptToken: Equatable {
    case word(String)
    case string(String)
    case number
    /// A JavaScript regular expression literal.
    case regex
    case punct(Character)
}

// MARK: - AppleScript

/// Words that reach outside the named app: another app (application, app, System Events, "using terms from"), the
/// shell, other scripts, AppleScriptObjC, raw Apple event codes, synthesized keys, the clipboard, URLs handed to
/// whatever app opens them, and dialogs that would wait for a person nobody told to look.
let appleScriptDenied: [String: String] = [
    "application": "a reference to an application (the script already runs against the named app only)",
    "app": "a reference to an application (the script already runs against the named app only)",
    "shell": "do shell script",
    "script": "running, loading or storing another script (do shell script, run script, do script)",
    "framework": "AppleScriptObjC (use framework)",
    "use": "use statements (scripting additions, frameworks, other apps)",
    "keystroke": "synthesized keystrokes (System Events)",
    "system": "System Events and system information",
    "clipboard": "the clipboard (use the clipboard tools)",
    "display": "dialogs and alerts (display dialog), which wait for a person",
    "choose": "choose dialogs, which wait for a person",
    "location": "open location, which hands a URL to another app",
    "osax": "scripting additions",
]

/// Word pairs refused only together ("key code", "key down").
let appleScriptDeniedPairs: [(String, String, String)] = [
    ("key", "code", "synthesized key codes (System Events)"),
    ("key", "down", "synthesized key presses (System Events)"),
    ("key", "up", "synthesized key presses (System Events)"),
]

let fileAccessReason = "file access outside the app (read, write, open for access, info for, list folder)"
let soundReason = "speech, sounds and the system volume (say, beep, set volume)"

/// Commands of the standard scripting additions (StandardAdditions.osax), which AppleScript resolves inside `tell
/// application id …` as if the app had them, that reach outside the named app: the file system, the speakers and the
/// system volume (#3780). The pure helpers (`path to`, `current date`, `delay`, `random number`, string commands) are
/// not listed. A phrase is refused as written; `unless` names the words after it that make it the app's own property
/// (`set volume of document 1 to 3`).
let appleScriptDeniedPhrases: [(words: [String], reason: String, unless: Set<String>)] = [
    (["open", "for", "access"], fileAccessReason, []),
    (["close", "access"], fileAccessReason, []),
    (["get", "eof"], fileAccessReason, []),
    (["set", "eof"], fileAccessReason, []),
    (["info", "for"], fileAccessReason, []),
    (["list", "folder"], fileAccessReason, []),
    (["list", "disks"], fileAccessReason, []),
    (["mount", "volume"], fileAccessReason, []),
    (["get", "volume", "settings"], soundReason, []),
    (["set", "volume"], soundReason, ["of", "to"]),
]

/// Single words that are an addition's command unless the app's own dictionary has a term that starts with them and
/// the script spells it whole (iTerm's `write`, Mail's `read status`, Finder's `read only`).
let appleScriptAdditionWords: [String: String] = ["read": fileAccessReason, "write": fileAccessReason, "say": soundReason, "beep": soundReason]

/// Verbs that change something in the app; any one makes the script a write. `set` is a write unless it only assigns
/// a local variable (`set total to …`).
let appleScriptWriteVerbs: Set<String> = [
    "make", "duplicate", "move", "delete", "open", "save", "close", "print", "quit", "activate", "select", "reveal",
    "empty", "eject", "erase", "restart", "shut", "sleep", "create", "add", "remove", "send", "reply", "forward", "launch",
    "run", "do", "perform", "click", "import", "export", "paste", "cut", "update", "sync", "play", "pause", "stop",
    "mount", "convert", "compile", "insert", "replace", "undo", "redo", "sort", "write", "store", "crop", "rotate", "flip",
    "scale", "resize", "upload", "download", "refresh", "reload", "mark", "flag", "archive", "publish", "share", "post",
    "submit", "accept", "decline", "cancel", "lock", "unlock", "clean", "arrange", "restore", "rename", "redirect",
    "bounce", "join", "leave", "invite", "complete", "check", "uncheck", "translate", "transform", "copy", "reopen",
]

/// Verbs that can't be undone; the user confirms a script that has one.
let irreversibleVerbs: Set<String> = [
    "delete", "empty", "erase", "shut", "restart", "send", "reply", "forward", "submit", "post", "publish", "redirect",
    "bounce", "eject", "trash", "deletemessage", "purchase", "pay", "buy",
]

/// AppleScript's tokens: comments (`--` and `#` to the end of the line, nested `(* *)`) are skipped, strings are
/// values, `|pipe identifiers|` are words, raw codes («…») are refused.
public func appleScriptTokens(_ source: String) throws -> [ScriptToken] {
    var out: [ScriptToken] = []
    let s = Array(source)
    var i = 0
    func at(_ k: Int) -> Character? { k < s.count ? s[k] : nil }
    while i < s.count {
        let c = s[i]
        if c == "-" && at(i + 1) == "-" || c == "#" {
            while i < s.count && !s[i].isNewline { i += 1 }
        } else if c == "(" && at(i + 1) == "*" {
            var depth = 1
            i += 2
            while i < s.count && depth > 0 {
                if s[i] == "(" && at(i + 1) == "*" { depth += 1; i += 2 }
                else if s[i] == "*" && at(i + 1) == ")" { depth -= 1; i += 2 }
                else { i += 1 }
            }
            if depth > 0 { throw ScriptRefusal(reason: "an unterminated (* comment") }
        } else if c == "\"" || c == "“" || c == "”" {
            var v = ""
            i += 1
            while i < s.count && s[i] != "\"" && s[i] != "”" && s[i] != "“" {
                if s[i] == "\\", let n = at(i + 1) { v.append(n); i += 2 } else { v.append(s[i]); i += 1 }
            }
            if i >= s.count { throw ScriptRefusal(reason: "an unterminated string") }
            i += 1
            out.append(.string(v))
        } else if c == "|" {
            var v = ""
            i += 1
            while i < s.count && s[i] != "|" { v.append(s[i]); i += 1 }
            if i >= s.count { throw ScriptRefusal(reason: "an unterminated |identifier|") }
            i += 1
            out.append(.word(v.lowercased()))
        } else if c == "«" || c == "»" {
            throw ScriptRefusal(reason: "raw Apple event codes («…»)")
        } else if c.isLetter || c == "_" {
            var v = ""
            while i < s.count && (s[i].isLetter || s[i].isNumber || s[i] == "_") { v.append(s[i]); i += 1 }
            out.append(.word(v.lowercased()))
        } else if c.isNumber {
            while i < s.count && (s[i].isNumber || s[i] == ".") { i += 1 }
            out.append(.number)
        } else {
            if !c.isWhitespace && c != "¬" { out.append(.punct(c)) }
            i += 1
        }
    }
    return out
}

/// Properties every scriptable app has (the standard suite and the shared item classes). `sdef` leaves the Cocoa
/// standard suite (xi:include) unresolved for many apps, so these are always properties, listed or not.
let baseAppProperties: Set<String> = [
    "name", "id", "index", "frontmost", "visible", "version", "selection", "bounds", "position", "size", "text",
    "contents", "class", "properties", "modified", "zoomed", "miniaturized", "collating", "copies", "target printer",
    "closeable", "resizable", "zoomable", "miniaturizable", "document", "file", "starting page", "ending page",
    "pages across", "pages down", "fax number", "error handling", "requested print time", "titled", "floating",
    "modal", "hasclosebox", "hastitlebar",
]

/// The static check of an AppleScript body (the part inside `tell application id …`). `set <word> to …` assigns a
/// local variable only when the script declares the word, or when the app's dictionary (read at most once and only
/// when needed) has no property by that name; with no dictionary every undeclared word is a property, because
/// AppleScript resolves a name to the app's property first (#3726). A script no verb marks as a write is still a
/// write when it uses a command of the dictionary that isn't a read, or when there is no dictionary (#3772).
public func checkAppleScript(_ source: String, dictionary: () -> AppDictionary?) throws -> ScriptCheck {
    let tokens = try appleScriptTokens(source)
    let declared = declaredLocals(tokens)
    func isProperty(_ w: String) -> Bool {
        if declared.contains(w) { return false }
        if baseAppProperties.contains(w) { return true }
        guard let known = dictionary() else { return true }
        return known.properties.contains(w)
    }
    var writes = false
    var irreversible: [String] = []
    let flat = flatWords(tokens)
    try refuseAdditions(flat, dictionary: dictionary)
    for (k, t) in tokens.enumerated() {
        guard case .word(let w) = t else { continue }
        if let why = appleScriptDenied[w] { throw ScriptRefusal(reason: why) }
        if k + 1 < tokens.count, case .word(let next) = tokens[k + 1],
           let pair = appleScriptDeniedPairs.first(where: { $0.0 == w && $0.1 == next }) {
            throw ScriptRefusal(reason: pair.2)
        }
        if w == "set" {
            // `set x to …`: a local variable unless x is a property of the app; `set name of … to …` sets a property
            if !(assignsWord(tokens, at: k).map { !isProperty($0) } ?? false) { writes = true }
        } else if appleScriptWriteVerbs.contains(w) {
            writes = true
        }
        if irreversibleVerbs.contains(w) && !irreversible.contains(w) {
            // "move … to trash" can't be undone from a script either
            irreversible.append(w)
        }
    }
    if !writes && irreversible.isEmpty {
        writes = usesWriteCommand(tokens.compactMap { if case .word(let w) = $0 { return w } else { return nil } }, dictionary())
    }
    return ScriptCheck(writes: writes || !irreversible.isEmpty, irreversible: irreversible)
}

/// The words of a script in order, a piped name (`|open for access|`) as its words, and nil for anything that isn't a
/// word (a string, a number, punctuation), so a phrase never spans one.
private func flatWords(_ t: [ScriptToken]) -> [String?] {
    t.flatMap { tok -> [String?] in
        guard case .word(let w) = tok else { return [nil] }
        return w.split(separator: " ").map { String($0) }
    }
}

/// Refuses the scripting-addition commands that reach outside the app (#3780). The app's own dictionary wins for a
/// term it defines and the script spells whole; with no dictionary the word is refused.
private func refuseAdditions(_ flat: [String?], dictionary: () -> AppDictionary?) throws {
    var consumed = 0
    for i in flat.indices {
        guard i >= consumed, let w = flat[i] else { continue }
        for phrase in appleScriptDeniedPhrases where phrase.words[0] == w && i + phrase.words.count <= flat.count {
            guard (0..<phrase.words.count).allSatisfy({ flat[i + $0] == phrase.words[$0] }) else { continue }
            let after = i + phrase.words.count < flat.count ? flat[i + phrase.words.count] : nil
            if let after, phrase.unless.contains(after) { continue }
            throw ScriptRefusal(reason: phrase.reason)
        }
        if let why = appleScriptAdditionWords[w] {
            // the app's own term (`read write`, an enumerator) uses up its words
            guard let length = dictionary()?.termLength(flat, at: i) else { throw ScriptRefusal(reason: why) }
            consumed = i + length
        }
    }
}

/// The word the `set` at `k` assigns when it is `set <word> to …`.
private func assignsWord(_ t: [ScriptToken], at k: Int) -> String? {
    guard k + 2 < t.count, case .word(let w) = t[k + 1], t[k + 2] == .word("to") else { return nil }
    return w
}

/// The names a script declares as its own: `local a, b`, `global a`, `property a : …`, `repeat with a from|in …`. The
/// tokens carry no scope, so a script that defines handlers (`on name`, `to name(…)`) declares nothing: a `local`
/// inside one handler must not hide an app property at the top level.
private func declaredLocals(_ t: [ScriptToken]) -> Set<String> {
    var out: Set<String> = []
    for (k, tok) in t.enumerated() {
        guard case .word(let w) = tok else { continue }
        let next: ScriptToken? = k + 1 < t.count ? t[k + 1] : nil
        let after: ScriptToken? = k + 2 < t.count ? t[k + 2] : nil
        switch w {
        case "on" where next != .word("error"), "to" where after == .punct("("):
            if case .word? = next { return [] }
        case "local", "global":
            var j = k + 1
            while j < t.count, case .word(let n) = t[j] {
                out.insert(n)
                guard j + 1 < t.count, t[j + 1] == .punct(",") else { break }
                j += 2
            }
        case "property":
            // a declaration (`property a : 1`), not a read (`property a of b`)
            if case .word(let n)? = next, after == .punct(":") { out.insert(n) }
        case "with":
            if k > 0, t[k - 1] == .word("repeat"), case .word(let n)? = next, after == .word("from") || after == .word("in") {
                out.insert(n)
            }
        default:
            break
        }
    }
    return out
}

/// What the static check needs of an app's scripting dictionary: the names of its properties, the first words of its
/// commands (`fast forward` is `fast`, as JXA spells it `fastForward`), the commands that start with a read verb but
/// are more than it (`get URL` as `geturl`, JXA's `getURL`), and every full term it defines (commands, properties,
/// classes, enumerators: `read status`, `read only`), all lowercased.
public struct AppDictionary: Equatable {
    public let properties: Set<String>
    public let commands: Set<String>
    public let readLedCommands: Set<String>
    public let names: Set<String>

    public init(properties: Set<String>, commands: Set<String>, readLedCommands: Set<String> = [], names: Set<String> = []) {
        self.properties = properties
        self.commands = commands
        self.readLedCommands = readLedCommands
        self.names = names
    }

    /// The number of words from `i` on that spell one of the app's own terms (so `read status` is Mail's, not the
    /// addition's `read`), the longest such term; nil when none.
    func termLength(_ words: [String?], at i: Int) -> Int? {
        names.compactMap { name -> Int? in
            let parts = name.split(separator: " ").map(String.init)
            return i + parts.count <= words.count && (0..<parts.count).allSatisfy { words[i + $0] == parts[$0] } ? parts.count : nil
        }.max()
    }
}

/// Commands of a dictionary that only read, when they are the bare verb; every other command can change something.
let readOnlyCommands: Set<String> = ["get", "count", "exists", "extract"]

/// Whether a script no verb marks as a write is one anyway: with no dictionary there is no telling a command from a
/// name, and a word that starts one of the dictionary's commands runs it (`next`, `playpause`, `login`, `search`). A
/// read verb counts when it is the bare verb, but not when it leads a longer command (Terminal's `get URL` opens a
/// window): the words after it, joined, are checked too. A piped name (`|fast forward|`) is several words.
func usesWriteCommand(_ names: [String], _ dictionary: AppDictionary?) -> Bool {
    guard let dictionary else { return true }
    let words = names.flatMap { $0.split(separator: " ").map(String.init) }
    for (i, w) in words.enumerated() {
        if dictionary.commands.contains(w) && !readOnlyCommands.contains(w) { return true }
        if dictionary.readLedCommands.contains(w) { return true }
        var joined = w
        for next in words.dropFirst(i + 1).prefix(3) {
            joined += next
            if dictionary.readLedCommands.contains(joined) { return true }
        }
    }
    return false
}

/// The dictionary `sdef <app>` printed as XML; nil when it can't be read.
public func sdefDictionary(_ xml: Data) -> AppDictionary? {
    final class Collector: NSObject, XMLParserDelegate {
        var properties: Set<String> = []
        var commands: Set<String> = []
        var readLed: Set<String> = []
        var names: Set<String> = []
        func parser(_ parser: XMLParser, didStartElement element: String, namespaceURI: String?, qualifiedName: String?,
                    attributes: [String: String] = [:]) {
            guard let name = attributes["name"]?.lowercased() else { return }
            if ["property", "class", "enumerator", "value-type", "record-type", "command", "event"].contains(element) {
                names.insert(name)
                if let plural = attributes["plural"]?.lowercased() { names.insert(plural) }
            }
            if element == "property" { properties.insert(name) }
            guard element == "command" || element == "event", let first = name.split(separator: " ").first else { return }
            commands.insert(String(first))
            if ["get", "count", "exists"].contains(String(first)) && name.contains(" ") { readLed.insert(name.replacingOccurrences(of: " ", with: "")) }
        }
    }
    let collector = Collector()
    let parser = XMLParser(data: xml)
    parser.delegate = collector
    return parser.parse() ? AppDictionary(properties: collector.properties, commands: collector.commands, readLedCommands: collector.readLed,
                                                        names: collector.names) : nil
}

/// The dictionary a check asks for, read at most once.
private final class DictionaryReader {
    private let read: () -> AppDictionary?
    private var value: AppDictionary??

    init(_ read: @escaping () -> AppDictionary?) { self.read = read }

    func get() -> AppDictionary? {
        if value == nil { value = .some(read()) }
        return value!
    }
}

// MARK: - Both

/// The static check of a script body in `language`: refused when empty, too long, or reaching outside the named app.
public func checkScript(_ source: String, language: ScriptLanguage,
                        dictionary: @escaping () -> AppDictionary?) -> Result<ScriptCheck, ScriptRefusal> {
    if source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .failure(ScriptRefusal(reason: "an empty script")) }
    if source.count > maxScriptLength { return .failure(ScriptRefusal(reason: "a script over \(maxScriptLength) characters")) }
    if source.unicodeScalars.contains(where: { $0.value == 0 }) { return .failure(ScriptRefusal(reason: "a NUL character")) }
    // the tokenizers and checks throw only ScriptRefusal
    let reader = DictionaryReader(dictionary)
    return Result { try language == .applescript ? checkAppleScript(source, dictionary: reader.get) : checkJXA(source, dictionary: reader.get) }
        .mapError { $0 as! ScriptRefusal }
}

/// Whether a bundle id is one osascript's `application id "…"` can name safely (letters, digits, dots, dashes).
public func validBundleId(_ id: String) -> Bool {
    !id.isEmpty && id.count <= 255 && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "." || $0 == "-" || $0 == "_" }
}

/// The program osascript runs: the checked body pointed at the named app only. AppleScript: inside
/// `tell application id "<id>"`; JXA: inside a strict-mode function where the app is `app` (the body returns its result).
public func wrappedScript(_ source: String, language: ScriptLanguage, bundleId: String) -> String {
    switch language {
    case .applescript:
        return "tell application id \"\(bundleId)\"\n\(source)\nend tell\n"
    case .javascript:
        return "(function () {\n'use strict';\nconst app = Application(\"\(bundleId)\");\n\(source)\n})()\n"
    }
}

// MARK: - Running

/// How long a script or Shortcut may run: the request's milliseconds within [1 s, 120 s], 30 s when none.
public func scriptTimeoutMs(_ requested: Double?) -> Int {
    guard let requested, requested.isFinite else { return 30_000 }
    return Int(min(max(requested, 1_000), 120_000))
}

/// The most text a script's result (or error) returns, in characters.
public let maxScriptOutput = 50_000

/// Text clipped to `limit` characters, with whether it was clipped.
public func clippedOutput(_ text: String, limit: Int = maxScriptOutput) -> (text: String, truncated: Bool) {
    text.count <= limit ? (text, false) : (String(text.prefix(limit)), true)
}

/// What macOS's Automation check (AEDeterminePermissionToAutomateTarget) answered: granted, denied, ask (the user has
/// not been asked yet), not_running (the target app isn't running), or error.
public func automationStatus(_ status: Int32) -> String {
    switch status {
    case 0: return "granted"
    case -1743: return "denied" // errAEEventNotPermitted
    case -1744: return "ask" // errAEEventWouldRequireUserConsent
    case -600: return "not_running" // procNotFound
    default: return "error"
    }
}

/// A Shortcut name `shortcuts run` may be given: not empty, at most 255 characters, no control characters, and not
/// starting with "-" (which the command would read as an option).
public func validShortcutName(_ name: String) -> Bool {
    !name.trimmingCharacters(in: .whitespaces).isEmpty && name.count <= 255 && !name.hasPrefix("-")
        && !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 })
}

/// The Shortcut names `shortcuts list` printed, one per line.
public func shortcutNames(_ listing: String) -> [String] {
    listing.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
}

/// `shortcuts run`'s arguments for a Shortcut, with its input and output files when given.
public func shortcutRunArguments(_ name: String, inputPath: String?, outputPath: String?) -> [String] {
    var a = ["run", name]
    if let inputPath { a += ["--input-path", inputPath] }
    if let outputPath { a += ["--output-path", outputPath, "--output-type", "public.plain-text"] }
    return a
}
