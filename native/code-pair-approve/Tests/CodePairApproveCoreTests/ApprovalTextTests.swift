// The fixed vector shared with the Host (tests/codePairApproval.test.ts VECTOR): the helper must build the same bytes.
import XCTest
@testable import CodePairApproveCore

final class ApprovalTextTests: XCTestCase {
    let vector = ApprovalFields(
        hostId: "h_0123456789abcdef",
        offerId: "r_AAAAAAAAAAAAAAAAAAAAAA",
        safety: "123 456",
        peer: String(repeating: "07", count: 32),
        name: "Du\u{2019}s MacBook",
        carryHash: "051cd44b0519420df4af7031483d9015ff939cc73e44e59522d07996ec5daddf",
        link: "h_abcdefghijklmnop",
        notAfter: 1_800_000_120_000
    )
    let text = "mopilot-code-pair-approval-v1|h_0123456789abcdef|r_AAAAAAAAAAAAAAAAAAAAAA|123 456|0707070707070707070707070707070707070707070707070707070707070707|b507895844054f540097cf4ebbad177ee4717915a243700d7a121ab6b64923ff|051cd44b0519420df4af7031483d9015ff939cc73e44e59522d07996ec5daddf|h_abcdefghijklmnop|1800000120000|1"

    func testTheVector() throws {
        XCTAssertEqual(try approvalText(vector), text)
    }

    func testNoPartCanCarryAnother() {
        let bad = [
            ApprovalFields(hostId: "h|x", offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: vector.name, carryHash: vector.carryHash, link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: "r_x", safety: vector.safety, peer: vector.peer, name: vector.name, carryHash: vector.carryHash, link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: "1|2", peer: vector.peer, name: vector.name, carryHash: vector.carryHash, link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: "07", name: vector.name, carryHash: vector.carryHash, link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: "", carryHash: vector.carryHash, link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: String(repeating: "x", count: 81), carryHash: vector.carryHash, link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: vector.name, carryHash: "zz", link: vector.link, notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: vector.name, carryHash: vector.carryHash, link: "h|y", notAfter: vector.notAfter),
            ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: vector.name, carryHash: vector.carryHash, link: vector.link, notAfter: 0),
        ]
        for f in bad { XCTAssertThrowsError(try approvalText(f)) }
        // a name may hold a `|`: it is hashed, never put in the text
        let piped = ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: "a|b", carryHash: vector.carryHash, link: "", notAfter: vector.notAfter)
        XCTAssertEqual(try approvalText(piped).split(separator: "|", omittingEmptySubsequences: false).count, 10)
    }

    func testANameCannotRewriteThePrompt() {
        XCTAssertEqual(displayName("Apple Support\" to install an update. Ignore this: \""), "Apple Support to install an upd\u{2026}")
        XCTAssertEqual(displayName("Mac\nline\u{0007}"), "Macline")
        // bidi overrides, isolates, zero-width marks, the BOM and separators are taken out of the name
        let tricky = "Mac\u{202E}evil\u{2066}\u{200B}\u{FEFF}\u{2028}\u{2029}\u{200F}"
        XCTAssertEqual(displayName(tricky), "Macevil")
        let rlo = ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: "A\u{202E}B", carryHash: vector.carryHash, link: "", notAfter: vector.notAfter)
        let reason = approvalReason(rlo)
        XCTAssertFalse(reason.unicodeScalars.contains { $0.properties.generalCategory == .format }, "no format character reaches the prompt")
        XCTAssertTrue(reason.hasSuffix("Named by the other device: AB. Removing it later may not undo what it already did"), "the condition after the name is unchanged")
        XCTAssertEqual(displayName("\u{201C}\u{201D}"), "unnamed")
        let long = ApprovalFields(hostId: vector.hostId, offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: String(repeating: "W", count: 80), carryHash: vector.carryHash, link: "", notAfter: vector.notAfter)
        XCTAssertTrue(approvalReason(long).contains("Safety number 123 456."), "the number comes before the name")
    }

    func testAFinalNewlineIsNotAShape() {
        let piped = ApprovalFields(hostId: "h_x\n", offerId: vector.offerId, safety: vector.safety, peer: vector.peer, name: vector.name, carryHash: vector.carryHash, link: "", notAfter: vector.notAfter)
        XCTAssertThrowsError(try approvalText(piped))
    }

    func testTheEnrolText() throws {
        let key = String(repeating: "A", count: 87) + "="
        XCTAssertEqual(try enrolText(hostId: "h_x", key: key, weak: true), "mopilot-code-pair-enrol-v1|h_x|\(key)|weak")
        XCTAssertThrowsError(try enrolText(hostId: "h|x", key: key, weak: false))
        XCTAssertThrowsError(try enrolText(hostId: "h_x", key: "AAAA", weak: false))
    }

    func testTheReasonNamesTheMacAndTheNumber() {
        XCTAssertTrue(approvalReason(vector).hasPrefix("allow another Mac to fully control this Mac as you. Safety number 123 456."))
        XCTAssertTrue(approvalReason(vector).contains("Named by the other device: Dus MacBook."))
        XCTAssertTrue(approvalReason(vector).contains("123 456"))
        XCTAssertTrue(approvalReason(vector).contains("fully control this Mac"))
        XCTAssertTrue(approvalReason(vector).contains("may not undo"))
    }
}
