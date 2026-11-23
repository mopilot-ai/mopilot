import CoreGraphics
import Foundation
import XCTest
@testable import HelperCore

/// The pure parts of the desktop_* helper requests: hit testing (target.info, input.* point checks),
/// the display a capture of granted apps shows, modifier and key-name parsing (input.click modifiers,
/// input.key), and screenshot sizing with a pixel budget (screenshot maxPixels). None needs TCC.
final class DesktopCoreTests: XCTestCase {
    private let selfPid: Int32 = 50
    private let mainPid: Int32 = 60

    private func window(_ pid: Int32, _ rect: CGRect, layer: Int = 0, alpha: Double = 1, sharing: Int = 1, system: Bool = false) -> HitWindow {
        HitWindow(pid: pid, layer: layer, alpha: alpha, bounds: rect, sharingState: sharing, ownerIsSystem: system)
    }

    // MARK: hitTest

    func testHitTestReturnsTheFrontmostVisibleWindowAtThePoint() {
        let back = window(1, CGRect(x: 0, y: 0, width: 500, height: 500))
        let front = window(2, CGRect(x: 100, y: 100, width: 100, height: 100))
        let windows = [front, back]
        XCTAssertEqual(hitTest(windows, at: CGPoint(x: 150, y: 150), selfPid: selfPid, protectedPids: [mainPid]), .window(front))
        XCTAssertEqual(hitTest(windows, at: CGPoint(x: 20, y: 20), selfPid: selfPid, protectedPids: [mainPid]), .window(back))
        XCTAssertEqual(hitTest(windows, at: CGPoint(x: 900, y: 900), selfPid: selfPid, protectedPids: [mainPid]), HitResult.none)
        XCTAssertEqual(hitTest([], at: .zero, selfPid: selfPid, protectedPids: []), HitResult.none)
    }

    func testHitTestLooksThroughTransparentAndHelperWindows() {
        let target = window(3, CGRect(x: 0, y: 0, width: 400, height: 400))
        let invisible = window(4, CGRect(x: 0, y: 0, width: 400, height: 400), alpha: 0)
        let glow = window(selfPid, CGRect(x: 0, y: 0, width: 400, height: 400), layer: 2000)
        XCTAssertEqual(hitTest([glow, invisible, target], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(target))
    }

    func testHitTestLooksThroughNotificationCenterAndDockFullScreenContainers() {
        // a banner up: Notification Center keeps a transparent window over the whole screen, above the apps
        let app = window(3, CGRect(x: 0, y: 0, width: 400, height: 400))
        let center = HitWindow(pid: 7, layer: 21, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 2560, height: 1440), passesEventsThrough: true)
        XCTAssertEqual(hitTest([center, app], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(app))
        XCTAssertEqual(hitTest([center, app], at: CGPoint(x: 2000, y: 1000), selfPid: selfPid, protectedPids: [mainPid]), HitResult.none)
        // an ordinary window that covers the screen still takes the event
        let cover = window(8, CGRect(x: 0, y: 0, width: 2560, height: 1440), layer: 21)
        XCTAssertEqual(hitTest([cover, app], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(cover))
        XCTAssertFalse(window(3, .zero).passesEventsThrough)
        XCTAssertEqual(passThroughBundleIds, ["com.apple.notificationcenterui", "com.apple.dock"])
        // the Dock's full-screen window under a banner: both looked through
        let dock = HitWindow(pid: 9, layer: 20, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 2560, height: 1440), passesEventsThrough: true)
        XCTAssertEqual(hitTest([center, dock, app], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(app))
    }

    func testHitTestSkipsOnlyMoPilotsCaptureExcludedOverlay() {
        let target = window(3, CGRect(x: 0, y: 0, width: 400, height: 400))
        let at = CGPoint(x: 10, y: 10)
        // the status overlay: MoPilot's pid, at or above the screen-saver level, opted out of capture
        let overlay = window(mainPid, CGRect(x: 0, y: 0, width: 400, height: 400), layer: overlayWindowLevel, sharing: 0)
        XCTAssertEqual(hitTest([overlay, target], at: at, selfPid: selfPid, protectedPids: [mainPid]), .window(target))
        // an ordinary MoPilot window is still found (and refused by the policy later)
        let ordinary = window(mainPid, CGRect(x: 0, y: 0, width: 400, height: 400))
        XCTAssertEqual(hitTest([ordinary, target], at: at, selfPid: selfPid, protectedPids: [mainPid]), .window(ordinary))
        // high level but capturable, or below the overlay level: not the overlay
        let shared = window(mainPid, CGRect(x: 0, y: 0, width: 400, height: 400), layer: overlayWindowLevel, sharing: 1)
        XCTAssertEqual(hitTest([shared, target], at: at, selfPid: selfPid, protectedPids: [mainPid]), .window(shared))
        let lower = window(mainPid, CGRect(x: 0, y: 0, width: 400, height: 400), layer: overlayWindowLevel - 1, sharing: 0)
        XCTAssertEqual(hitTest([lower, target], at: at, selfPid: selfPid, protectedPids: [mainPid]), .window(lower))
        // another app's capture-excluded window at that level is not skipped
        let other = window(7, CGRect(x: 0, y: 0, width: 400, height: 400), layer: overlayWindowLevel, sharing: 0)
        XCTAssertEqual(hitTest([other, target], at: at, selfPid: selfPid, protectedPids: [mainPid]), .window(other))
    }

    func testHitTestLooksThroughTheWindowServersCursorAndRecordingIndicatorOnly() {
        // while a recorder runs, the Window Server's 28x40 "Cursor" window sits on the pointer, above every app
        let app = window(3, CGRect(x: 0, y: 0, width: 400, height: 400))
        let cursor = window(199, CGRect(x: 5, y: 5, width: 28, height: 40), layer: cursorWindowLevel, system: true)
        let indicator = window(199, CGRect(x: 0, y: 0, width: 29, height: 28), layer: cursorWindowLevel, system: true)
        XCTAssertEqual(hitTest([cursor, indicator, app], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(app))
        // empty desktop under the cursor: nothing to click, not "unknown"
        XCTAssertEqual(hitTest([cursor], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), HitResult.none)
        // an app's window at that level, or a system window just below it, still takes the event
        let appAbove = window(9, CGRect(x: 0, y: 0, width: 400, height: 400), layer: cursorWindowLevel)
        XCTAssertEqual(hitTest([appAbove, app], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(appAbove))
        let below = window(199, CGRect(x: 0, y: 0, width: 400, height: 400), layer: cursorWindowLevel - 1, system: true)
        XCTAssertEqual(hitTest([below, app], at: CGPoint(x: 10, y: 10), selfPid: selfPid, protectedPids: [mainPid]), .window(below))
    }

    func testHitTestReportsTheMenuBarOnlyForTheSystemsMainMenuWindow() {
        let menu = window(0, CGRect(x: 0, y: 0, width: 1000, height: 24), layer: mainMenuWindowLevel, system: true)
        let app = window(3, CGRect(x: 0, y: 0, width: 1000, height: 800))
        XCTAssertEqual(hitTest([menu, app], at: CGPoint(x: 5, y: 5), selfPid: selfPid, protectedPids: []), .menuBar)
        // a system window at another level is just a window; an app window at the menu level is not the menu bar
        let dock = window(0, CGRect(x: 0, y: 0, width: 1000, height: 24), layer: 20, system: true)
        XCTAssertEqual(hitTest([dock, app], at: CGPoint(x: 5, y: 5), selfPid: selfPid, protectedPids: []), .window(dock))
        let appMenuLevel = window(9, CGRect(x: 0, y: 0, width: 1000, height: 24), layer: mainMenuWindowLevel)
        XCTAssertEqual(hitTest([appMenuLevel], at: CGPoint(x: 5, y: 5), selfPid: selfPid, protectedPids: []), .window(appMenuLevel))
    }

    // MARK: chooseDisplay

    private let displays: [(id: UInt32, bounds: CGRect)] = [
        (id: 1, bounds: CGRect(x: 0, y: 0, width: 1000, height: 800)),
        (id: 2, bounds: CGRect(x: 1000, y: 0, width: 1000, height: 800)),
    ]

    func testChooseDisplayFollowsTheFirstPreferredAppsLargestWindow() {
        let windows = [
            window(10, CGRect(x: 10, y: 10, width: 100, height: 100)), // display 1, small
            window(10, CGRect(x: 1100, y: 10, width: 600, height: 600)), // display 2, large
            window(11, CGRect(x: 10, y: 10, width: 900, height: 700)), // display 1, another app
        ]
        XCTAssertEqual(chooseDisplay(windows: windows, preferredPids: [10, 11], includedPids: [10, 11], displays: displays), 2)
        // a preferred app with no window gives way to the next preferred one
        XCTAssertEqual(chooseDisplay(windows: windows, preferredPids: [99, 11], includedPids: [10, 11], displays: displays), 1)
    }

    func testChooseDisplayIgnoresNonOrdinaryWindowsAndFallsBackToIncludedApps() {
        let windows = [
            window(10, CGRect(x: 1100, y: 10, width: 800, height: 700), layer: 3), // floating panel
            window(10, CGRect(x: 1100, y: 10, width: 800, height: 700), alpha: 0), // hidden
            window(10, CGRect(x: 1100, y: 10, width: 39, height: 700)), // too narrow
            window(10, CGRect(x: 1100, y: 10, width: 700, height: 39)), // too short
            window(12, CGRect(x: 1100, y: 10, width: 200, height: 200)), // included, display 2
            window(13, CGRect(x: 10, y: 10, width: 900, height: 700)), // largest, but not included
        ]
        XCTAssertEqual(chooseDisplay(windows: windows, preferredPids: [10], includedPids: [12], displays: displays), 2)
        XCTAssertNil(chooseDisplay(windows: windows, preferredPids: [10], includedPids: [], displays: displays))
        XCTAssertNil(chooseDisplay(windows: [], preferredPids: [], includedPids: [12], displays: displays))
    }

    func testChooseDisplaySkipsAWindowWhoseCenterIsOnNoDisplay() {
        let offscreen = window(10, CGRect(x: 5000, y: 5000, width: 400, height: 400))
        let onTwo = window(11, CGRect(x: 1100, y: 10, width: 100, height: 100))
        XCTAssertEqual(chooseDisplay(windows: [offscreen, onTwo], preferredPids: [10, 11], includedPids: [], displays: displays), 2)
        XCTAssertNil(chooseDisplay(windows: [offscreen], preferredPids: [], includedPids: [10], displays: displays))
    }

    // MARK: modifiers and keys

    func testParseModifiersForAClickWithKeysHeld() {
        XCTAssertEqual(parseModifiers(""), 0)
        XCTAssertEqual(parseModifiers("cmd"), 0x100000)
        XCTAssertEqual(parseModifiers("cmd+shift"), 0x120000)
        XCTAssertEqual(parseModifiers(" Shift + ALT "), 0x20000 | 0x80000)
        XCTAssertEqual(parseModifiers("ctrl+option+fn"), 0x40000 | 0x80000 | 0x800000)
        XCTAssertEqual(parseModifiers("super"), 0x100000)
        XCTAssertEqual(parseModifiers("win+cmd"), 0x100000)
        XCTAssertEqual(parseModifiers("cmd++"), 0x100000, "empty parts are ignored")
        XCTAssertNil(parseModifiers("hyper"))
        XCTAssertNil(parseModifiers("cmd+a"), "a key is not a modifier")
    }

    func testKeyCombosAcceptSuperAndWinAsCommand() {
        XCTAssertEqual(parseKeyCombo("super+c"), KeyCombo(keyCode: 8, flags: 0x100000))
        XCTAssertEqual(parseKeyCombo("win+v"), KeyCombo(keyCode: 9, flags: 0x100000))
        XCTAssertEqual(parseKeyCombo("super+shift+t"), parseKeyCombo("cmd+shift+t"))
        XCTAssertEqual(parseKeyCombo("forwarddelete")?.keyCode, 117)
        XCTAssertEqual(parseKeyCombo("pagedown")?.keyCode, 121)
        XCTAssertNil(parseKeyCombo("hyper+c"))
    }

    // MARK: screenshot sizing

    func testCaptureSizeHonorsAPixelBudgetAsWellAsTheLongEdge() {
        // a 1512x982 point Retina display, sized for the model: long edge <= 1568 and <= 1.15 MP
        let s = captureSize(widthPoints: 1512, heightPoints: 982, scale: 2, maxSide: 1568, maxPixels: 1_150_000)
        XCTAssertLessThanOrEqual(max(s.width, s.height), 1568)
        XCTAssertLessThanOrEqual(Double(s.width * s.height), 1_150_000 * 1.005)
        XCTAssertEqual(s.width, 1331)
        XCTAssertEqual(s.height, 864)
        // the aspect ratio is kept
        XCTAssertEqual(Double(s.width) / Double(s.height), 1512.0 / 982.0, accuracy: 0.01)
        // a narrow display is bounded by the long edge, not the pixel budget
        let tall = captureSize(widthPoints: 400, heightPoints: 3000, scale: 1, maxSide: 1568, maxPixels: 1_150_000)
        XCTAssertEqual(tall.height, 1568)
        XCTAssertEqual(tall.width, 209)
    }

    func testCaptureSizeIgnoresAMissingOrNonPositivePixelBudget() {
        let plain = captureSize(widthPoints: 1512, heightPoints: 982, scale: 2, maxSide: 1568)
        XCTAssertTrue(plain == (1568, 1018))
        XCTAssertTrue(captureSize(widthPoints: 1512, heightPoints: 982, scale: 2, maxSide: 1568, maxPixels: 0) == plain)
        XCTAssertTrue(captureSize(widthPoints: 1512, heightPoints: 982, scale: 2, maxSide: 1568, maxPixels: -5) == plain)
        // a budget larger than the image never upscales
        XCTAssertTrue(captureSize(widthPoints: 800, heightPoints: 600, scale: 1, maxSide: 1568, maxPixels: 10_000_000) == (800, 600))
    }
}
