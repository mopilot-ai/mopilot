// Tests for the brief-foreground decisions (HelperCore/BriefForeground.swift): start, user take-over, and restore plans.
import CoreGraphics
import XCTest
@testable import HelperCore

final class BriefForegroundTests: XCTestCase {
    func testMethods() {
        XCTAssertTrue(briefForegroundMethods.contains("app.setText"))
        XCTAssertTrue(briefForegroundMethods.contains("app.click"))
        XCTAssertFalse(briefForegroundMethods.contains("app.focus"))
        XCTAssertTrue(briefForegroundMethods.contains("app.menu"))
        // a menu press refreshes its top-level menu first; nothing else does
        XCTAssertEqual(foregroundMenuRefresh("app.menu", ["path": ["File", "Export as PDF…"]]), "File")
        XCTAssertNil(foregroundMenuRefresh("app.menu", ["path": ["File"]]))
        XCTAssertNil(foregroundMenuRefresh("app.menu", ["list": ["File"]]))
        XCTAssertNil(foregroundMenuRefresh("app.click", ["path": ["File", "New"]]))
    }

    func testMayStart() {
        XCTAssertTrue(briefForegroundMayStart(userIdleSeconds: 5))
        XCTAssertTrue(briefForegroundMayStart(userIdleSeconds: briefForegroundMinIdleSeconds))
        XCTAssertFalse(briefForegroundMayStart(userIdleSeconds: 0.2))
        XCTAssertFalse(briefForegroundMayStart(userIdleSeconds: .nan))
        XCTAssertTrue(briefForegroundMayStart(userIdleSeconds: 0.2, minIdle: 0.1))
    }

    func testUserActed() {
        XCTAssertTrue(userActedDuring(elapsedSeconds: 0.5, userIdleSeconds: 0.1))
        XCTAssertFalse(userActedDuring(elapsedSeconds: 0.5, userIdleSeconds: 3))
        XCTAssertFalse(userActedDuring(elapsedSeconds: 0.5, userIdleSeconds: .infinity))
    }

    func testRestoreBringsBackPreviousAppAndPointer() {
        let plan = planForegroundRestore(previousFront: 10, target: 20, pointerBefore: CGPoint(x: 5, y: 5), pointerAfter: CGPoint(x: 50, y: 5), userActed: false)
        XCTAssertEqual(plan, ForegroundRestore(activatePid: 10, pointer: CGPoint(x: 5, y: 5), userTookOver: false))
    }

    func testRestoreLeavesUnmovedPointerAndTargetFront() {
        let plan = planForegroundRestore(previousFront: 20, target: 20, pointerBefore: CGPoint(x: 5, y: 5), pointerAfter: CGPoint(x: 5.5, y: 5), userActed: false)
        XCTAssertEqual(plan, ForegroundRestore(activatePid: nil, pointer: nil, userTookOver: false))
        let none = planForegroundRestore(previousFront: nil, target: 20, pointerBefore: nil, pointerAfter: CGPoint(x: 1, y: 1), userActed: false)
        XCTAssertNil(none.activatePid)
        XCTAssertNil(none.pointer)
    }

    func testUserTookOverRestoresNothing() {
        let plan = planForegroundRestore(previousFront: 10, target: 20, pointerBefore: .zero, pointerAfter: CGPoint(x: 90, y: 90), userActed: true)
        XCTAssertEqual(plan, ForegroundRestore(activatePid: nil, pointer: nil, userTookOver: true))
    }

    func testClickRouteIsHIDOnlyWhereTheAppIsOnTopInBriefForeground() {
        XCTAssertEqual(clickRoute(foreground: true, ownerPid: 42, targetPid: 42), "hid")
        // another app's window is on top at the point: never a HID click there
        XCTAssertEqual(clickRoute(foreground: true, ownerPid: 7, targetPid: 42), "pid")
        XCTAssertEqual(clickRoute(foreground: true, ownerPid: nil, targetPid: 42), "pid")
        // in the background it is posted to the process
        XCTAssertEqual(clickRoute(foreground: false, ownerPid: 42, targetPid: 42), "pid")
    }

    func testClickResultNamesTheOwnerOnlyWhenForegroundDidNotTakeTheHIDRoute() {
        let hid = clickResult(route: "hid", foreground: true, ownerPid: 42, targetPid: 42)
        XCTAssertEqual(hid["route"] as? String, "hid")
        XCTAssertNil(hid["ownerPid"])
        let covered = clickResult(route: "pid", foreground: true, ownerPid: 7, targetPid: 42)
        XCTAssertEqual(covered["ownerPid"] as? Int, 7)
        XCTAssertEqual(covered["targetPid"] as? Int, 42)
        XCTAssertEqual(clickResult(route: "pid", foreground: true, ownerPid: nil, targetPid: 42)["ownerPid"] as? Int, -1)
        // in the background there is nothing to explain
        let bg = clickResult(route: "pid", foreground: false, ownerPid: 7, targetPid: 42)
        XCTAssertNil(bg["ownerPid"])
        XCTAssertEqual(bg["ok"] as? Bool, true)
    }
}
