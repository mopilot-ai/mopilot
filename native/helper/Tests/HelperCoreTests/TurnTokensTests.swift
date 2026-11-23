// The helper's `(chat, turn)` token gate (design D1): revoked turns are refused but for requests that give the Mac back,
// and the desktop lock is granted per token.
import XCTest
@testable import HelperCore

final class TurnTokensTests: XCTestCase {
    func testParsesTheTokenField() {
        XCTAssertEqual(TurnToken(["chat": "c1", "turn": 3]), TurnToken(chat: "c1", turn: 3))
        XCTAssertNil(TurnToken(nil))
        XCTAssertNil(TurnToken("c1"))
        XCTAssertNil(TurnToken(["chat": "", "turn": 3]))
        XCTAssertNil(TurnToken(["chat": "c1"]))
        XCTAssertNil(TurnToken(["chat": "c1", "turn": "3"]))
        XCTAssertNil(TurnToken(["chat": "c1", "turn": true]))
        XCTAssertEqual(TurnToken(["chat": "c1", "thread": "t1", "turn": 3]), TurnToken(chat: "c1", thread: "t1", turn: 3))
        XCTAssertEqual(TurnToken(["chat": "c1", "thread": "", "turn": 3]), TurnToken(chat: "c1", turn: 3))
        XCTAssertEqual(TurnToken.number(4), 4)
        XCTAssertNil(TurnToken.number(false))
    }

    func testACodexThreadsTurnEndLeavesTheChatsOtherThreadsAlone() {
        let gate = TurnGate()
        let a = TurnToken(chat: "c1", thread: "sub-a", turn: 1)
        let b = TurnToken(chat: "c1", thread: "sub-b", turn: 1)
        let parent = TurnToken(chat: "c1", thread: "parent", turn: 1)
        gate.granted(b)
        XCTAssertFalse(gate.revoke(chat: "c1", thread: "sub-a", through: 1), "the lock is sub-b's")
        XCTAssertFalse(gate.admits("input.click", a))
        XCTAssertTrue(gate.admits("input.click", b))
        XCTAssertTrue(gate.admits("input.click", parent))
        XCTAssertTrue(gate.admits("input.click", TurnToken(chat: "c1", thread: "sub-a", turn: 2)), "sub-a's next turn")
        // Stop on the chat: every thread's turn up to then
        XCTAssertTrue(gate.revoke(chat: "c1", through: 2))
        XCTAssertFalse(gate.admits("input.click", b))
        XCTAssertFalse(gate.admits("input.click", parent))
        XCTAssertFalse(gate.admits("input.click", TurnToken(chat: "c1", thread: "sub-a", turn: 2)))
        XCTAssertTrue(gate.admits("input.click", TurnToken(chat: "c1", thread: "sub-b", turn: 3)))
        // a thread's later revoke still counts after the chat's, and a new thread is never born stale
        gate.revoke(chat: "c1", thread: "sub-b", through: 3)
        XCTAssertFalse(gate.admits("input.click", TurnToken(chat: "c1", thread: "sub-b", turn: 3)))
        XCTAssertTrue(gate.admits("input.click", TurnToken(chat: "c1", thread: "sub-c", turn: 3)))
        gate.revoke(chat: "c1", through: 4)
        XCTAssertTrue(gate.admits("input.click", TurnToken(chat: "c1", thread: "sub-b", turn: 5)))
    }

    func testRefusesRevokedTurnsButNotWhatGivesTheMacBack() {
        let gate = TurnGate()
        let old = TurnToken(chat: "c1", turn: 0)
        XCTAssertTrue(gate.admits("input.click", old))
        XCTAssertTrue(gate.admits("input.click", nil))
        XCTAssertFalse(gate.revoke(chat: "c1", through: 0))
        XCTAssertFalse(gate.admits("input.click", old))
        XCTAssertFalse(gate.admits("control.acquire", old))
        for method in ["control.release", "input.release", "apps.restore", "pasteboard.restore", "app.cancel", "glow.stop"] {
            XCTAssertTrue(gate.admits(method, old), method)
        }
        // a request with no token (Settings, an older main) and the chat's next turn are not refused
        XCTAssertTrue(gate.admits("input.click", nil))
        XCTAssertTrue(gate.admits("input.click", TurnToken(chat: "c1", turn: 5)))
        // another chat's turns are its own
        XCTAssertTrue(gate.admits("input.click", TurnToken(chat: "c2", turn: 0)))
        // an older revoke arriving late does not bring a revoked turn back
        gate.revoke(chat: "c1", through: -1)
        XCTAssertFalse(gate.admits("input.click", old))
    }

    func testTheLockGoesWithTheTurnItWasGrantedTo() {
        let gate = TurnGate()
        gate.granted(TurnToken(chat: "c1", turn: 2))
        XCTAssertEqual(gate.lockHolder, TurnToken(chat: "c1", turn: 2))
        XCTAssertFalse(gate.revoke(chat: "c2", through: 9), "another chat's turn")
        XCTAssertFalse(gate.revoke(chat: "c1", through: 1), "an older turn of the chat")
        XCTAssertTrue(gate.revoke(chat: "c1", through: 2))
        XCTAssertNil(gate.lockHolder)
        XCTAssertFalse(gate.revoke(chat: "c1", through: 2), "let go once")
        // a lock taken with no token (a native hold) is never revoked
        gate.granted(nil)
        XCTAssertFalse(gate.revoke(chat: "c1", through: 99))
        gate.granted(TurnToken(chat: "c1", turn: 100))
        gate.released()
        XCTAssertNil(gate.lockHolder)
        XCTAssertFalse(gate.revoke(chat: "c1", through: 100))
    }
}
