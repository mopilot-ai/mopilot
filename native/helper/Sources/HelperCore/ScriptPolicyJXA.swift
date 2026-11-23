import Foundation

// The JXA half of app.script's static check (#3571 G7, #3664): JXA's tokenizer, the identifiers a body may not use, and
// the classification of every spelling of a property name (dot, literal computed member, object or destructuring key)
// as a read, a write or a verb that can't be undone. ScriptPolicy.swift holds the AppleScript half and the shared parts.

// MARK: - JavaScript for Automation

/// Identifiers a JXA body may not use: other apps and the current one (Application, the shell through standard
/// additions), the Objective-C bridge, dynamic code, and the ways to reach a constructor (and from it Function).
let jxaDenied: [String: String] = [
    "Application": "a reference to an application (the script already runs against the named app as `app`)",
    "ObjC": "the Objective-C bridge",
    "$": "the Objective-C bridge",
    "Library": "script libraries",
    "eval": "dynamic code",
    "Function": "dynamic code",
    "constructor": "dynamic code (constructors)",
    "prototype": "dynamic code (prototypes)",
    "Object": "reflection (Object)",
    "Reflect": "reflection",
    "Proxy": "reflection",
    "Symbol": "reflection",
    "globalThis": "the global object",
    "this": "the global object",
    "with": "with statements",
    "async": "async functions (the script runs synchronously)",
    "await": "async functions (the script runs synchronously)",
    "import": "imports",
    "require": "imports",
    "Automation": "the Automation object",
    "doShellScript": "do shell script",
    "includeStandardAdditions": "standard additions (the shell, dialogs, the clipboard)",
    "runScript": "running another script",
    "loadScript": "loading another script",
    "openLocation": "openLocation, which hands a URL to another app",
    "keystroke": "synthesized keystrokes",
    "keyCode": "synthesized key codes",
    "displayDialog": "dialogs, which wait for a person",
    "displayAlert": "dialogs, which wait for a person",
    "theClipboard": "the clipboard (use the clipboard tools)",
    "setTheClipboardTo": "the clipboard (use the clipboard tools)",
]

/// JXA's tokens, read as JavaScript reads them (#3664): over Unicode scalars (a combining mark after a quote doesn't
/// hide the quote), comments are skipped, a string's value has its escapes decoded (so `"delete"` is `delete`), a
/// regular expression literal is one value (so a quote or `//` inside it hides nothing), and a number ends where
/// JavaScript ends it (`1..x` is `1.` and `.x`). Template literals, HTML-like comments, backslashes outside strings
/// (unicode-escaped identifiers) and a `/` whose reading depends on more than the tokens before it are refused.
public func jxaTokens(_ source: String) throws -> [ScriptToken] {
    var out: [ScriptToken] = []
    let s = Array(source.unicodeScalars)
    var i = 0
    // whether only whitespace and comments came since the last line break (where `-->` starts a comment)
    var lineStart = true
    func at(_ k: Int) -> Unicode.Scalar? { k < s.count ? s[k] : nil }
    func digits(_ ok: (Unicode.Scalar) -> Bool) { while let d = at(i), ok(d) || d == "_" { i += 1 } }
    while i < s.count {
        let c = s[i]
        let wasLineStart = lineStart
        lineStart = false
        if c == "/" && at(i + 1) == "/" {
            while i < s.count && !isLineBreak(s[i]) { i += 1 }
        } else if c == "/" && at(i + 1) == "*" {
            i += 2
            let from = i
            while i < s.count && !(s[i] == "*" && at(i + 1) == "/") { i += 1 }
            if i >= s.count { throw ScriptRefusal(reason: "an unterminated /* comment") }
            lineStart = wasLineStart || s[from..<i].contains(where: isLineBreak)
            i += 2
        } else if c == "<" && at(i + 1) == "!" && at(i + 2) == "-" && at(i + 3) == "-"
                    || wasLineStart && c == "-" && at(i + 1) == "-" && at(i + 2) == ">" {
            throw ScriptRefusal(reason: "HTML-like comments (<!-- and -->)")
        } else if c == "/" {
            switch slashReading(out) {
            case .division: out.append(.punct("/")); i += 1
            case .ambiguous: throw ScriptRefusal(reason: "a / right after } or ++/-- (add parentheses)")
            case .regex:
                // a regular expression literal: to the `/` outside a [class], then its flags
                var inClass = false
                i += 1
                while let r = at(i), r != "/" || inClass, !isLineBreak(r) {
                    if r == "[" { inClass = true } else if r == "]" { inClass = false }
                    i += r == "\\" ? 2 : 1
                }
                if at(i) != "/" { throw ScriptRefusal(reason: "an unterminated regular expression") }
                i += 1
                digits { $0.properties.isIDContinue }
                out.append(.regex)
            }
        } else if c == "\"" || c == "'" {
            var v = String.UnicodeScalarView()
            i += 1
            while i < s.count && s[i] != c && !isLineBreak(s[i]) {
                if s[i] == "\\" { i += 1; try v.append(contentsOf: jxaEscape(s, &i)) } else { v.append(s[i]); i += 1 }
            }
            if i >= s.count || s[i] != c { throw ScriptRefusal(reason: "an unterminated string") }
            i += 1
            out.append(.string(String(v)))
        } else if c == "`" {
            throw ScriptRefusal(reason: "template literals (use quotes and +)")
        } else if c == "\\" {
            throw ScriptRefusal(reason: "escapes outside strings")
        } else if c.properties.isIDStart || c == "_" || c == "$" {
            var v = String.UnicodeScalarView()
            while let n = at(i), n.properties.isIDContinue || n == "$" || n == "\u{200C}" || n == "\u{200D}" { v.append(n); i += 1 }
            out.append(.word(String(v)))
        } else if isDigit(c) {
            if c == "0", let p = at(i + 1), "xXoObB".unicodeScalars.contains(p) {
                i += 2
                digits { $0.properties.isASCIIHexDigit }
            } else {
                digits(isDigit)
                if at(i) == "." { i += 1; digits(isDigit) }
                if let e = at(i), e == "e" || e == "E" {
                    i += 1
                    if let sign = at(i), sign == "+" || sign == "-" { i += 1 }
                    digits(isDigit)
                }
            }
            if at(i) == "n" { i += 1 }
            if let n = at(i), n.properties.isIDContinue || n == "$" { throw ScriptRefusal(reason: "a number run into a name") }
            out.append(.number)
        } else {
            if isLineBreak(c) {
                lineStart = true
            } else if c.properties.isWhitespace || c == "\u{FEFF}" {
                lineStart = wasLineStart
            } else if c.isASCII {
                out.append(.punct(Character(c)))
            } else {
                // JavaScript reads no other character outside strings and comments as code
                throw ScriptRefusal(reason: "a character outside strings that isn't part of a name (U+\(String(c.value, radix: 16, uppercase: true)))")
            }
            i += 1
        }
    }
    return out
}

/// JavaScript's line terminators.
private func isLineBreak(_ c: Unicode.Scalar) -> Bool { c == "\n" || c == "\r" || c == "\u{2028}" || c == "\u{2029}" }

/// An ASCII digit (JavaScript's numbers use no other).
private func isDigit(_ c: Unicode.Scalar) -> Bool { c.isASCII && c.properties.numericType != nil }

private enum SlashReading { case division, regex, ambiguous }

/// How JavaScript reads a `/` after `out`: division after a value, a regular expression where a value starts.
/// After `)` it is a regular expression only when the parentheses are an if/while/for/with head; after `}` (a block
/// or an object) and after `++`/`--` (postfix or prefix, which the tokens don't tell apart) it is ambiguous.
private func slashReading(_ out: [ScriptToken]) -> SlashReading {
    guard let last = out.last else { return .regex }
    let n = out.count
    switch last {
    case .punct("}"): return .ambiguous
    case .punct("+"), .punct("-"):
        return n > 1 && out[n - 2] == last ? .ambiguous : .regex
    case .punct(")"):
        // (a method spelled like a keyword, a.if(1), is a call)
        guard let open = matching(out, from: n - 1, "(", ")", backward: true), open > 0,
              !(open > 1 && out[open - 2] == .punct(".")) else { return .division }
        return [.word("if"), .word("while"), .word("for"), .word("with")].contains(out[open - 1]) ? .regex : .division
    case .word:
        // a property name is a value even when it is spelled like a keyword (a.return / 2)
        if n > 1 && out[n - 2] == .punct(".") { return .division }
        return afterValue(last) ? .division : .regex
    default:
        return afterValue(last) ? .division : .regex
    }
}

/// The value of the escape after a `\` at `i` in a string, as JavaScript reads it; `i` moves past it.
private func jxaEscape(_ s: [Unicode.Scalar], _ i: inout Int) throws -> String.UnicodeScalarView {
    let malformed = ScriptRefusal(reason: "a malformed escape in a string")
    guard i < s.count else { return String.UnicodeScalarView() }
    let e = s[i]
    i += 1
    func code(_ count: Int) throws -> UInt32 {
        guard i + count <= s.count, count > 0,
              s[i..<(i + count)].allSatisfy(\.properties.isASCIIHexDigit),
              let v = UInt32(String(String.UnicodeScalarView(s[i..<(i + count)])), radix: 16) else { throw malformed }
        i += count
        return v
    }
    func scalar(_ v: UInt32) throws -> String.UnicodeScalarView {
        guard let u = Unicode.Scalar(v) else { throw malformed }
        return String.UnicodeScalarView([u])
    }
    switch e {
    case "n": return "\n".unicodeScalars
    case "t": return "\t".unicodeScalars
    case "r": return "\r".unicodeScalars
    case "b": return "\u{8}".unicodeScalars
    case "f": return "\u{C}".unicodeScalars
    case "v": return "\u{B}".unicodeScalars
    case "0": return "\u{0}".unicodeScalars
    case "x": return try scalar(code(2))
    case "u":
        if i < s.count, s[i] == "{" {
            guard let close = s[i...].firstIndex(of: "}") else { throw malformed }
            i += 1
            defer { i += 1 }
            return try scalar(code(close - i))
        }
        let high = try code(4)
        // a surrogate pair written as two escapes is one character
        if (0xD800...0xDBFF).contains(high), i + 1 < s.count, s[i] == "\\", s[i + 1] == "u" {
            i += 2
            let low = try code(4)
            guard (0xDC00...0xDFFF).contains(low) else { throw malformed }
            return try scalar(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00))
        }
        return try scalar(high)
    default:
        // a line continuation is nothing (\r\n included); any other character stands for itself
        if e == "\r" && i < s.count && s[i] == "\n" { i += 1 }
        return isLineBreak(e) ? String.UnicodeScalarView() : String.UnicodeScalarView([e])
    }
}

/// The static check of a JXA body (run with the named app as `app`). A computed member (`x[…]`) holds one literal,
/// so no name is built at run time; a string literal there is checked like an identifier. Every spelling of a property
/// name (`.name`, `["name"]`, an object or destructuring key) is classified alike (#3664): a verb there is the app's
/// command whether it is called, aliased or destructured, and a member that is assigned (`=`, `+=`, `++`, a
/// destructuring or for-in/of target, `delete`) is a property set.
public func checkJXA(_ source: String, dictionary: () -> AppDictionary?) throws -> ScriptCheck {
    let tokens = try jxaTokens(source)
    var writes = false
    var irreversible: [String] = []
    func deny(_ name: String) throws {
        if let why = jxaDenied[name] { throw ScriptRefusal(reason: why) }
        if name.hasPrefix("__") { throw ScriptRefusal(reason: "internal properties (__…)") }
        if name.hasPrefix("system") { throw ScriptRefusal(reason: "System Events and system information") }
    }
    // a property name: one of the app's commands when it names a verb (doJavaScript is `do`, emptyTrash is `empty`)
    var mentioned: [String] = []
    func property(_ name: String) {
        mentioned += [name.lowercased(), leadingWord(name)]
        // a capitalized member is a class of the app's dictionary (app.Document(…)), made only to push a new element
        if name.first?.isUppercase == true { writes = true }
        let whole = name.lowercased()
        let verb = isVerb(whole) ? whole : leadingWord(name)
        guard isVerb(verb) else { return }
        writes = true
        if irreversibleVerbs.contains(verb) && !irreversible.contains(verb) { irreversible.append(verb) }
    }
    // the open brackets, each with whether it is a for head (where `of` is a keyword)
    var openers: [(Character, forHead: Bool)] = []
    for (k, t) in tokens.enumerated() {
        let prev = k > 0 ? tokens[k - 1] : nil
        let next = k + 1 < tokens.count ? tokens[k + 1] : nil
        switch t {
        case .word(let w):
            try deny(w)
            if prev == .punct(".") {
                property(w)
                if assigns(tokens, at: k + 1) { writes = true }
            } else if isKey(prev: prev, next: next, in: openers.last?.0) {
                property(w)
            } else if w == "of" && openers.last?.forHead != true {
                // `of` is a name anywhere else, and `of[…]` or `of / …` would read as something it isn't
                throw ScriptRefusal(reason: "`of` as a name")
            } else if w == "delete" && operandHasMember(tokens, from: k + 1) {
                writes = true
            } else if w == "for" && next == .punct("("), forHeadAssignsMember(tokens, at: k + 1) {
                writes = true
            }
        case .string(let v):
            if isKey(prev: prev, next: next, in: openers.last?.0) { try deny(v); property(v) }
        case .punct("["):
            // `[` after a value is a member access, and `[…]` before `:` or `(` a computed key: exactly one literal inside
            let close = matching(tokens, from: k, "[", "]")
            let after = close.flatMap { $0 + 1 < tokens.count ? tokens[$0 + 1] : nil }
            // (`?.[` is a member access too)
            let member = prev.map(afterValue) ?? false || prev == .punct(".") && k > 1 && tokens[k - 2] == .punct("?")
            guard member || after == .punct(":") || after == .punct("(") else { break }
            guard let close, close == k + 2 else { throw ScriptRefusal(reason: computedRefusal) }
            switch tokens[k + 1] {
            case .number: break
            case .string(let v): try deny(v); property(v)
            default: throw ScriptRefusal(reason: computedRefusal)
            }
            if member && assigns(tokens, at: close + 1) { writes = true }
        case .punct("+"), .punct("-"):
            // a prefix increment of a member: ++a.b, --a["b"], ++(a.b)
            if next == t, operandHasMember(tokens, from: k + 2) { writes = true }
        case .punct(let p) where ")]}".contains(p):
            // an assignment to a parenthesized member or a destructuring pattern with a member target:
            // (a.b) = …, (a.b)++, ({a: x.b} = …), [x.b] = …
            let open: Character = p == ")" ? "(" : p == "]" ? "[" : "{"
            if assigns(tokens, at: k + 1), let o = matching(tokens, from: k, open, p, backward: true),
               !(o > 0 && [.word("const"), .word("let"), .word("var")].contains(tokens[o - 1])),
               hasMember(tokens, o + 1..<k) {
                writes = true
            }
        default:
            break
        }
        if case .punct(let p) = t {
            if "([{".contains(p) { openers.append((p, p == "(" && prev == .word("for"))) } else if ")]}".contains(p) { _ = openers.popLast() }
        }
    }
    // a name that starts a command of the app's dictionary runs it (app.next(), app.playpause()), whether or not the
    // verb lists know it; with no dictionary there is no telling (#3772)
    if !writes && irreversible.isEmpty { writes = usesWriteCommand(mentioned, dictionary()) }
    return ScriptCheck(writes: writes || !irreversible.isEmpty, irreversible: irreversible)
}

private let computedRefusal = "a computed member or key that isn't one literal (x[0] or x[\"name\"])"

/// A verb of the app's dictionary that changes something (and `set`, the generic property set).
private func isVerb(_ w: String) -> Bool { w == "set" || appleScriptWriteVerbs.contains(w) || irreversibleVerbs.contains(w) }

/// The first word of a camel-case name, lowercased: `doJavaScript` → `do`.
private func leadingWord(_ name: String) -> String {
    var out = ""
    for (i, c) in name.enumerated() {
        if i > 0 && !c.isLowercase { break }
        out.append(c)
    }
    return out.lowercased()
}

/// Whether the token between `prev` and `next` is an object or destructuring key: `{name: …}`, `{name, …}`, `{name}`.
private func isKey(prev: ScriptToken?, next: ScriptToken?, in opener: Character?) -> Bool {
    guard opener == "{", prev == .punct("{") || prev == .punct(",") else { return false }
    return [.punct(":"), .punct(","), .punct("}"), .punct("=")].contains(next)
}

private let compoundAssignments = ["+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]

/// Whether the operator at `j` assigns to what precedes it: `=` (not `==` or `=>`), a compound assignment, `++` or `--`.
private func assigns(_ t: [ScriptToken], at j: Int) -> Bool {
    var ops = ""
    var i = j
    while i < t.count, ops.count < 4, case .punct(let p) = t[i], "=+-*/%<>&|^?".contains(p) { ops.append(p); i += 1 }
    if ops.hasPrefix("++") || ops.hasPrefix("--") { return true }
    if ops.hasPrefix("=") { return !ops.hasPrefix("==") && !ops.hasPrefix("=>") }
    return compoundAssignments.contains { ops.hasPrefix($0) }
}

/// Whether the unary operand starting at `j` reaches a member: `a.b`, `a?.b`, `a[0]`, `(a).b`, `(a.b)`.
private func operandHasMember(_ t: [ScriptToken], from j: Int) -> Bool {
    var m = j
    while m < t.count {
        switch t[m] {
        case .punct("."): return true
        case .punct("("), .punct("["):
            let (open, close): (Character, Character) = t[m] == .punct("(") ? ("(", ")") : ("[", "]")
            guard let end = matching(t, from: m, open, close) else { return false }
            if m > j || hasMember(t, m + 1..<end) { return true }
            m = end + 1
        case .word, .string, .number, .punct("?"): m += 1
        default: return false
        }
    }
    return false
}

/// Whether the for head opening at `j` (`(`) assigns each item to a member: `for (a.b of …)`, `for ([a.b] in …)`.
private func forHeadAssignsMember(_ t: [ScriptToken], at j: Int) -> Bool {
    guard let close = matching(t, from: j, "(", ")"), j + 1 < close else { return false }
    if [.word("const"), .word("let"), .word("var")].contains(t[j + 1]) { return false }
    var depth = 0
    for m in (j + 1)..<close {
        switch t[m] {
        case .punct("("), .punct("["), .punct("{"): depth += 1
        case .punct(")"), .punct("]"), .punct("}"): depth -= 1
        case .word("in"), .word("of"): if depth == 0 { return hasMember(t, j + 1..<m) }
        default: break
        }
    }
    return false
}

/// Whether the tokens in `r` reach a member: a `.`, or a `[` after a value.
private func hasMember(_ t: [ScriptToken], _ r: Range<Int>) -> Bool {
    r.contains { t[$0] == .punct(".") || t[$0] == .punct("[") && $0 > r.lowerBound && afterValue(t[$0 - 1]) }
}

/// Whether a `[` after `prev` reads a member of a value (not an array literal).
private func afterValue(_ prev: ScriptToken) -> Bool {
    switch prev {
    case .word(let w):
        return !["return", "typeof", "in", "of", "case", "do", "else", "new", "void", "yield", "await", "delete", "throw", "instanceof", "const", "let", "var"].contains(w)
    case .punct(let p): return p == ")" || p == "]"
    default: return true
    }
}

/// The index of the bracket that closes the `open` at `k` (or, backward, opens the `close` at `k`), or nil.
private func matching(_ t: [ScriptToken], from k: Int, _ open: Character, _ close: Character, backward: Bool = false) -> Int? {
    let (inner, outer) = backward ? (close, open) : (open, close)
    var depth = 0
    for j in backward ? Array((0...k).reversed()) : Array(k..<t.count) {
        if t[j] == .punct(inner) { depth += 1 } else if t[j] == .punct(outer) { depth -= 1; if depth == 0 { return j } }
    }
    return nil
}
