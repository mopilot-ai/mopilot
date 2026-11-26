// The texts this helper signs, built here from structured fields (never taken as text from a caller), byte for byte
// as the Host builds them (host/src/codePairApproval.mjs `approvalTextFrom`, ENROL_TAG): a caller cannot show one
// reason in the prompt and have another text signed.
import CryptoKit
import Foundation

public let approvalTag = "mopilot-code-pair-approval-v1"
public let enrolTag = "mopilot-code-pair-enrol-v1"

public enum FieldError: Error, Equatable {
    case bad(String)
}

/// The fields the Host gives (`host.codePair.approvalText` → `fields`). `name` is the name as the Host stores it;
/// it is hashed exactly as given (UTF-8), never cleaned again here.
public struct ApprovalFields: Decodable, Equatable {
    public let hostId: String
    public let offerId: String
    public let safety: String
    public let peer: String
    public let name: String
    public let carryHash: String
    public let link: String
    public let notAfter: Int64

    public init(hostId: String, offerId: String, safety: String, peer: String, name: String, carryHash: String, link: String, notAfter: Int64) {
        self.hostId = hostId
        self.offerId = offerId
        self.safety = safety
        self.peer = peer
        self.name = name
        self.carryHash = carryHash
        self.link = link
        self.notAfter = notAfter
    }
}

func matches(_ value: String, _ pattern: String) -> Bool {
    // \A and \z: the whole string, with nothing after a final newline
    value.range(of: "\\A(?:\(pattern))\\z", options: .regularExpression) != nil
}

/// Every part but the name's hash is checked for its shape, so no part can carry a `|` or another part.
public func checked(_ f: ApprovalFields) throws -> ApprovalFields {
    if !matches(f.hostId, "[A-Za-z0-9_-]{1,64}") { throw FieldError.bad("hostId") }
    if !matches(f.offerId, "r_[A-Za-z0-9_-]{22}") { throw FieldError.bad("offerId") }
    if !matches(f.safety, "[0-9 ]{1,32}") { throw FieldError.bad("safety") }
    if !matches(f.peer, "[0-9a-f]{64}") { throw FieldError.bad("peer") }
    if f.name.isEmpty || f.name.utf16.count > 80 { throw FieldError.bad("name") }
    if !matches(f.carryHash, "[0-9a-f]{64}") { throw FieldError.bad("carryHash") }
    if !matches(f.link, "([A-Za-z0-9_-]{1,64})?") { throw FieldError.bad("link") }
    if f.notAfter <= 0 { throw FieldError.bad("notAfter") }
    return f
}

public func sha256Hex(_ s: String) -> String {
    SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// The approval text, always as allowed: this helper only ever signs a yes the person gave.
public func approvalText(_ f: ApprovalFields) throws -> String {
    let c = try checked(f)
    return [approvalTag, c.hostId, c.offerId, c.safety, c.peer, sha256Hex(c.name), c.carryHash, c.link, String(c.notAfter), "1"]
        .joined(separator: "|")
}

/// The enrolment text: proof the helper holds the key it hands the Host.
public func enrolText(hostId: String, key: String, weak: Bool) throws -> String {
    if !matches(hostId, "[A-Za-z0-9_-]{1,64}") { throw FieldError.bad("hostId") }
    if !matches(key, "[A-Za-z0-9+/]{87}=") { throw FieldError.bad("key") }
    return [enrolTag, hostId, key, weak ? "weak" : "strong"].joined(separator: "|")
}

/// The other Mac's name as the prompt shows it: for display only, never part of the sentence's meaning. Quotes,
/// control and format characters and line breaks are taken out, and it is cut short, so a name cannot rewrite the prompt or push
/// the safety number out of sight.
public func displayName(_ name: String) -> String {
    let quotes: Set<Character> = ["\"", "'", "\u{201C}", "\u{201D}", "\u{2018}", "\u{2019}", "\u{00AB}", "\u{00BB}", "`"]
    // control (Cc) and format (Cf) characters go: bidi overrides and isolates, zero-width marks and joiners, the BOM,
    // and line and paragraph separators, so a name cannot reorder or hide the sentence after it
    let kept = name.unicodeScalars.filter {
        $0.properties.generalCategory != .control && $0.properties.generalCategory != .format
            && $0.properties.generalCategory != .lineSeparator && $0.properties.generalCategory != .paragraphSeparator
            && !CharacterSet.newlines.contains($0)
    }
    var cleaned = String(String.UnicodeScalarView(kept)).filter { !quotes.contains($0) }.trimmingCharacters(in: .whitespaces)
    if cleaned.count > 32 { cleaned = String(cleaned.prefix(31)) + "\u{2026}" }
    return cleaned.isEmpty ? "unnamed" : cleaned
}

/// The reason the system prompt shows: a fixed sentence first, the safety number early, then the name the other
/// device gave itself (display only), and the owner's condition for pairing without a sandbox (#5617 option A).
public func approvalReason(_ f: ApprovalFields) -> String {
    "allow another Mac to fully control this Mac as you. Safety number \(f.safety). Named by the other device: \(displayName(f.name)). Removing it later may not undo what it already did"
}
