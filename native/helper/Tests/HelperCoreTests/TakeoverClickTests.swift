// Take-over detection (only a person's input pauses control) and how a display-scope click lands (activation, remote views, row selection).
import CoreGraphics
import XCTest
@testable import HelperCore

final class TakeoverTests: XCTestCase {
    private func move(_ x: CGFloat, _ y: CGFloat, dx: CGFloat = 1, dy: CGFloat = 0, pid: Int64 = 0, at t: Double) -> PointerSample {
        PointerSample(kind: .move, location: CGPoint(x: x, y: y), delta: CGVector(dx: dx, dy: dy), sourcePid: pid, time: t)
    }

    func testOwnPidIsOwnWithoutTheMarker() {
        XCTAssertEqual(classifyInput(userData: 0, sourceStateID: hidSystemStateID, sourcePid: 4242, selfPid: 4242), .own)
        XCTAssertEqual(classifyInput(userData: 0, sourceStateID: hidSystemStateID, sourcePid: 77, selfPid: 4242), .physical)
        // selfPid unknown: a pid-0 hardware event is never "own"
        XCTAssertEqual(classifyInput(userData: 0, sourceStateID: hidSystemStateID, sourcePid: 0, selfPid: 0), .physical)
    }

    func testDeliberateInputAlwaysTakesOver() {
        var f = TakeoverFilter()
        for kind in [PointerEventKind.button, .scroll, .drag] {
            XCTAssertTrue(f.isTakeover(PointerSample(kind: kind, location: .zero, delta: CGVector(dx: 0, dy: 0), sourcePid: 99, time: 0)))
        }
    }

    func testZeroDeltaReportIsNotATakeover() {
        var f = TakeoverFilter()
        XCTAssertFalse(f.isTakeover(move(100, 100, dx: 0, dy: 0, at: 1)))
    }

    func testAnotherProcessesMoveIsNotATakeover() {
        var f = TakeoverFilter()
        XCTAssertFalse(f.isTakeover(move(500, 500, dx: 400, dy: 400, pid: 321, at: 1)))
    }

    func testOwnEchoIsNotATakeoverButOnlyNearAndSoon() {
        var f = TakeoverFilter()
        f.noteOwn(CGPoint(x: 200, y: 200), time: 10)
        XCTAssertNotNil(f.lastOwn)
        XCTAssertNil(f.burst)
        // the coalesced copy of the helper's move, one point off, a moment later
        XCTAssertFalse(f.isTakeover(move(201, 200, dx: 30, dy: 0, at: 10.2)))
        // the same point long after: a real move (a burst of 30 points)
        XCTAssertTrue(f.isTakeover(move(201, 200, dx: 30, dy: 0, at: 20)))
    }

    func testSmallDriftIsNotATakeoverButTravelIs() {
        var f = TakeoverFilter()
        XCTAssertFalse(f.isTakeover(move(101, 100, dx: 1, dy: 0, at: 1)))
        XCTAssertFalse(f.isTakeover(move(103, 100, dx: 2, dy: 0, at: 1.1)))
        XCTAssertEqual(f.burst?.start, CGPoint(x: 100, y: 100))
        // the same burst keeps travelling: 10 points from where it started
        XCTAssertTrue(f.isTakeover(move(110, 100, dx: 7, dy: 0, at: 1.2)))
    }

    func testAPauseStartsANewBurst() {
        var f = TakeoverFilter()
        XCTAssertFalse(f.isTakeover(move(105, 100, dx: 5, dy: 0, at: 1)))
        // 5 more points, but after a pause: a new burst of 5, not 10
        XCTAssertFalse(f.isTakeover(move(110, 100, dx: 5, dy: 0, at: 2)))
        XCTAssertEqual(f.burst?.start, CGPoint(x: 105, y: 100))
    }

    func testGuardDecisionWithTheFilter() {
        var f = TakeoverFilter()
        let jitter = move(101, 100, at: 1)
        XCTAssertEqual(guardDecision(.mouse, origin: .physical, active: true, pointer: jitter, filter: &f), GuardDecision(pause: nil, swallow: false))
        let grab = move(140, 100, dx: 40, at: 1.1)
        XCTAssertEqual(guardDecision(.mouse, origin: .physical, active: true, pointer: grab, filter: &f), GuardDecision(pause: .takeover, swallow: false))
        // without a sample, or for keys, the plain decision
        XCTAssertEqual(guardDecision(.mouse, origin: .physical, active: true, pointer: nil, filter: &f), GuardDecision(pause: .takeover, swallow: false))
        XCTAssertEqual(guardDecision(.escape, origin: .physical, active: true, pointer: nil, filter: &f), GuardDecision(pause: .escape, swallow: true))
        // inactive, or not physical: nothing, and the filter isn't consulted
        XCTAssertEqual(guardDecision(.mouse, origin: .physical, active: false, pointer: grab, filter: &f), GuardDecision(pause: nil, swallow: false))
        XCTAssertEqual(guardDecision(.mouse, origin: .synthetic, active: true, pointer: grab, filter: &f), GuardDecision(pause: nil, swallow: false))
    }

    func testUserPresenceLeavesPointerNoiseOut() {
        XCTAssertTrue(isUserPresence(nil))
        XCTAssertTrue(isUserPresence(move(10, 10, at: 1)))
        XCTAssertTrue(isUserPresence(PointerSample(kind: .button, location: .zero, delta: CGVector(dx: 0, dy: 0), sourcePid: 5, time: 1)))
        XCTAssertFalse(isUserPresence(move(10, 10, dx: 0, dy: 0, at: 1)))
        XCTAssertFalse(isUserPresence(move(10, 10, pid: 5, at: 1)))
    }

    func testUserIdleLeavesTheHelpersOwnInputOut() {
        // never posted: the HID idle time as it is
        XCTAssertEqual(userIdleSeconds(hidIdle: 3, sinceOwnPost: nil, sinceUserInput: nil), 3)
        // the last HID event is newer than the helper's last post: someone else's
        XCTAssertEqual(userIdleSeconds(hidIdle: 1, sinceOwnPost: 5, sinceUserInput: 1), 1)
        // the last HID event is the helper's own: the guard's record of the user
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.2, sinceOwnPost: 0.2, sinceUserInput: 40), 40)
        // ... or, with no record, at least since the helper posted
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.2, sinceOwnPost: 0.2, sinceUserInput: nil), 0.2)
    }

    func testUserIdleIsWhatTheGuardSawWhileItWatches() {
        // a per-process post (never seen by the tap, stamped on the own-post clock) reset the HID idle time;
        // nobody has been seen since the tap went in 30s ago: idle 30s, not 0.27s
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.27, sinceOwnPost: 0.27, sinceUserInput: nil, sinceTapInstalled: 30), 30)
        // ... nor does another process's post the tap saw (Codex's computer use) make the user present
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.1, sinceOwnPost: 9, sinceUserInput: 12, sinceTapInstalled: 30, sinceOtherInput: 0.1), 12)
        // a person seen 0.2s ago is present, whatever was posted since
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.1, sinceOwnPost: 0.1, sinceUserInput: 0.2, sinceTapInstalled: 30), 0.2)
        // a HID event no post explains is a person's, even one the tap can't see (keys under secure input)
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.05, sinceOwnPost: 3, sinceUserInput: nil, sinceTapInstalled: 60, sinceOtherInput: 4), 0.05)
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.05, sinceOwnPost: nil, sinceUserInput: nil, sinceTapInstalled: 60), 0.05)
        // nothing happened since a post older than the tap: at least the HID idle time
        XCTAssertEqual(userIdleSeconds(hidIdle: 100, sinceOwnPost: 100, sinceUserInput: nil, sinceTapInstalled: 5), 100)
        // a record older than the tap (cannot happen) is capped at its age
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.1, sinceOwnPost: 0.1, sinceUserInput: 50, sinceTapInstalled: 5), 5)
        // without the tap, another process's post explains the HID time as the helper's own does
        XCTAssertEqual(userIdleSeconds(hidIdle: 0.2, sinceOwnPost: nil, sinceUserInput: nil, sinceOtherInput: 0.2), 0.2)
        // the brief foreground may start straight after a background click
        XCTAssertTrue(briefForegroundMayStart(userIdleSeconds: userIdleSeconds(hidIdle: 0.27, sinceOwnPost: 0.27, sinceUserInput: nil, sinceTapInstalled: 60)))
    }

    func testOwnPostClockStampsEveryPostAndEscapes() {
        var t = 10.0
        let clock = OwnPostClock(now: { t })
        XCTAssertNil(clock.sinceLastPost)
        XCTAssertNil(clock.sinceEscape)
        clock.note(escapeDown: true)
        t = 10.5
        clock.note(escapeDown: false)
        t = 11
        XCTAssertEqual(clock.sinceLastPost, 0.5)
        XCTAssertEqual(clock.sinceEscape, 1)
        XCTAssertTrue(isEscapeDown(type: 10, keyCode: 53))
        XCTAssertFalse(isEscapeDown(type: 11, keyCode: 53))
        XCTAssertFalse(isEscapeDown(type: 10, keyCode: 36))
    }

    func testEscapeSenderCountsOnlyAPersonsKey() {
        // the tap saw a person's Escape just now
        XCTAssertEqual(escapeSender(sinceTapEscape: 0.01, tapByPerson: true, sinceOwnEscape: nil), .person)
        // the tap saw another process's synthetic Escape (Codex's computer use), or the helper's own
        XCTAssertEqual(escapeSender(sinceTapEscape: 0.01, tapByPerson: false, sinceOwnEscape: nil), .agent)
        XCTAssertEqual(escapeSender(sinceTapEscape: 0.01, tapByPerson: false, sinceOwnEscape: 0.02), .agent)
        // the helper posted one per process, which the tap never sees
        XCTAssertEqual(escapeSender(sinceTapEscape: nil, tapByPerson: nil, sinceOwnEscape: 0.05), .agent)
        // ... but not so long ago that a person's key the tap missed would be taken for it
        XCTAssertEqual(escapeSender(sinceTapEscape: nil, tapByPerson: nil, sinceOwnEscape: 0.8), .unknown)
        // the newest wins: a person's key after the helper's post, and the helper's post after a person's key
        XCTAssertEqual(escapeSender(sinceTapEscape: 0.01, tapByPerson: true, sinceOwnEscape: 0.3), .person)
        XCTAssertEqual(escapeSender(sinceTapEscape: 1.0, tapByPerson: true, sinceOwnEscape: 0.8), .agent)
        // nothing recent: unknown, which Esc-to-stop honours
        XCTAssertEqual(escapeSender(sinceTapEscape: 9, tapByPerson: false, sinceOwnEscape: 9), .unknown)
        XCTAssertEqual(escapeSender(sinceTapEscape: nil, tapByPerson: nil, sinceOwnEscape: nil), .unknown)
        XCTAssertEqual(escapeSender(sinceTapEscape: 0.01, tapByPerson: nil, sinceOwnEscape: nil), .unknown)
        // a person's: the HID state, or an Apple assistive technology (Voice Control); never a post
        XCTAssertTrue(isPersonEscape(origin: .physical, sourceIsAssistive: false))
        XCTAssertTrue(isPersonEscape(origin: .synthetic, sourceIsAssistive: true))
        XCTAssertFalse(isPersonEscape(origin: .synthetic, sourceIsAssistive: false))
        XCTAssertFalse(isPersonEscape(origin: .own, sourceIsAssistive: true))
    }

}

final class ClickPlanTests: XCTestCase {
    func testActivatesARegularOwnerThatIsNotInFront() {
        XCTAssertEqual(planClick(ClickTarget(frontmostPid: 1, ownerPid: 2, ownerIsRegular: true, hitPid: 2)), ClickPlan(activatePid: 2, remoteView: false))
        XCTAssertEqual(planClick(ClickTarget(frontmostPid: 2, ownerPid: 2, ownerIsRegular: true, hitPid: 2)), ClickPlan(activatePid: nil, remoteView: false))
        // system UI and accessory windows are clicked as they are
        XCTAssertEqual(planClick(ClickTarget(frontmostPid: 1, ownerPid: 3, ownerIsRegular: false, hitPid: nil)), ClickPlan(activatePid: nil, remoteView: false))
        XCTAssertEqual(planClick(ClickTarget(frontmostPid: 1, ownerPid: nil, ownerIsRegular: false, hitPid: 9)), ClickPlan(activatePid: nil, remoteView: false))
    }

    func testRemoteViewIsAnElementOfAnotherProcess() {
        // TextEdit's open panel: the window is TextEdit's, the file browser is the panel service's
        XCTAssertTrue(planClick(ClickTarget(frontmostPid: 2, ownerPid: 2, ownerIsRegular: true, hitPid: 7)).remoteView)
    }

    func testPlainClick() {
        XCTAssertTrue(isPlainClick(button: "left", count: 1, flags: 0))
        XCTAssertFalse(isPlainClick(button: "right", count: 1, flags: 0))
        XCTAssertFalse(isPlainClick(button: "left", count: 2, flags: 0))
        XCTAssertFalse(isPlainClick(button: "left", count: 1, flags: 0x100000))
    }

    func testPressInsteadOfClickOnlyInARemoteViewOnAPressableElement() {
        let remote = ClickPlan(activatePid: nil, remoteView: true)
        let local = ClickPlan(activatePid: nil, remoteView: false)
        let button = HitElement(pressable: true, selectable: false)
        XCTAssertTrue(pressInsteadOfClick(plan: remote, plain: true, hit: button))
        XCTAssertFalse(pressInsteadOfClick(plan: local, plain: true, hit: button))
        XCTAssertFalse(pressInsteadOfClick(plan: remote, plain: false, hit: button))
        XCTAssertFalse(pressInsteadOfClick(plan: remote, plain: true, hit: HitElement(pressable: false, selectable: true)))
        XCTAssertFalse(pressInsteadOfClick(plan: remote, plain: true, hit: nil))
    }

    func testSelectAfterAClickThatDidNotSelectTheRow() {
        let row = HitElement(pressable: false, selectable: true)
        XCTAssertTrue(selectAfterClick(plain: true, hit: row, selectedAfter: false))
        XCTAssertFalse(selectAfterClick(plain: true, hit: row, selectedAfter: true))
        XCTAssertFalse(selectAfterClick(plain: true, hit: row, selectedAfter: nil))
        XCTAssertFalse(selectAfterClick(plain: false, hit: row, selectedAfter: false))
        XCTAssertFalse(selectAfterClick(plain: true, hit: HitElement(pressable: true, selectable: false), selectedAfter: false))
        XCTAssertFalse(selectAfterClick(plain: true, hit: nil, selectedAfter: false))
        // a checkbox or disclosure triangle in the row: its click doesn't select the row by design
        XCTAssertFalse(selectAfterClick(plain: true, hit: HitElement(pressable: true, selectable: true), selectedAfter: false))
    }

    func testTimingIsAPersonsClick() {
        XCTAssertGreaterThan(clickMoveSettleMicros, 0)
        XCTAssertGreaterThan(clickHoldMicros, 0)
        // a double click's clicks stay well inside the shortest double-click interval macOS offers (~150 ms)
        XCTAssertLessThan(clickHoldMicros + clickGapMicros, 150_000)
    }
}
