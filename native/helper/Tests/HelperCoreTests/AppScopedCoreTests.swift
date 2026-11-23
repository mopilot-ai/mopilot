import CoreGraphics
import Foundation
import XCTest
@testable import HelperCore

/// The pure parts of app-scoped (background) control (HelperCore/AppScoped.swift): the window
/// coordinate frame, window state and listing, matching accessibility windows to window-server ones,
/// the Chromium check, menu titles and shortcuts, keys through accessibility, text deletion and
/// fallbacks, scrolling, and the structured errors. None needs TCC.
final class AppScopedCoreTests: XCTestCase {
    // MARK: errors

    func testStructuredErrors() {
        let u = HelperError.unsupported("menu", "use app_menu")
        XCTAssertEqual(u.code, 12)
        XCTAssertEqual(u.reason, "unsupported")
        XCTAssertEqual(u.message, "unsupported(menu): use app_menu")
        let d = HelperError.menuDisabled(["Format", "Make Plain Text"])
        XCTAssertEqual(d.code, 17)
        XCTAssertEqual(d.reason, "menu_disabled")
        XCTAssertEqual(d.message, "Format > Make Plain Text is disabled right now")
        XCTAssertEqual(HelperError.notRunning.reason, "not_running")
        XCTAssertEqual(HelperError.windowGone.reason, "window_gone")
        XCTAssertEqual(HelperError.elementGone("0.1").message, "element 0.1 is gone; take a new app_screenshot")
        XCTAssertEqual(HelperError.elementGone("0.1").reason, "element_gone")
    }

    // MARK: window frame

    func testWindowFrameMapsPixelsToScreenPointsAndBack() {
        // a 800x600-point window at (100, 50) on a 2x display, capped at 1568 on the long side
        let f = WindowFrame.forWindow(bounds: CGRect(x: 100, y: 50, width: 800, height: 600), scale: 2, maxSide: 1568, maxPixels: nil)
        XCTAssertEqual(f.width, 1568)
        XCTAssertEqual(f.height, 1176)
        XCTAssertEqual(f.pixelsPerPoint, 1.96, accuracy: 1e-9)
        let p = f.toScreen(CGPoint(x: 196, y: 98))
        XCTAssertEqual(p.x, 200, accuracy: 1e-9)
        XCTAssertEqual(p.y, 100, accuracy: 1e-9)
        let back = f.toPixels(CGPoint(x: 200, y: 100))
        XCTAssertEqual(back.x, 196, accuracy: 1e-9)
        XCTAssertEqual(back.y, 98, accuracy: 1e-9)
        XCTAssertTrue(f.contains(pixel: CGPoint(x: 0, y: 0)))
        XCTAssertTrue(f.contains(pixel: CGPoint(x: 1567, y: 1175)))
        XCTAssertFalse(f.contains(pixel: CGPoint(x: 1568, y: 0)))
        XCTAssertFalse(f.contains(pixel: CGPoint(x: 0, y: 1176)))
        XCTAssertFalse(f.contains(pixel: CGPoint(x: -1, y: 0)))
        XCTAssertFalse(f.contains(pixel: CGPoint(x: 0, y: -1)))
        // a pixel budget shrinks it further; a degenerate window still has a 1x1 frame
        let budget = WindowFrame.forWindow(bounds: CGRect(x: 0, y: 0, width: 800, height: 600), scale: 2, maxSide: 1568, maxPixels: 480_000)
        XCTAssertEqual(budget.width, 800)
        XCTAssertEqual(budget.height, 600)
        let zero = WindowFrame(bounds: .zero, width: 0, height: -3)
        XCTAssertEqual(zero.width, 1)
        XCTAssertEqual(zero.height, 1)
        XCTAssertEqual(zero.pixelsPerPoint, 1)
    }

    // MARK: window state and listing

    func testWindowState() {
        XCTAssertEqual(windowState(isOnScreen: true, isMinimized: false, appHidden: false), .visible)
        XCTAssertEqual(windowState(isOnScreen: false, isMinimized: false, appHidden: false), .offSpace)
        XCTAssertEqual(windowState(isOnScreen: false, isMinimized: true, appHidden: false), .minimized)
        XCTAssertEqual(windowState(isOnScreen: false, isMinimized: true, appHidden: true), .appHidden)
        XCTAssertEqual(WindowState.offSpace.rawValue, "off_space")
        XCTAssertEqual(WindowState.appHidden.rawValue, "app_hidden")
        XCTAssertTrue(acceptsPostedEvents(.visible))
        XCTAssertFalse(acceptsPostedEvents(.offSpace))
        XCTAssertFalse(acceptsPostedEvents(.minimized))
        XCTAssertFalse(acceptsPostedEvents(.appHidden))
    }

    func testKeepWindow() {
        XCTAssertTrue(keepWindow(onScreen: true, axMatched: false, appHidden: false))
        XCTAssertTrue(keepWindow(onScreen: false, axMatched: true, appHidden: false))
        XCTAssertTrue(keepWindow(onScreen: false, axMatched: false, appHidden: true))
        XCTAssertFalse(keepWindow(onScreen: false, axMatched: false, appHidden: false))
    }

    func testListableWindowsDropsTinyTransparentAndOddLevelWindowsAndPutsPanelsLast() {
        func w(_ id: UInt32, _ size: Double, layer: Int = 0, alpha: Double = 1) -> ListedWindow {
            ListedWindow(id: id, title: "w\(id)", bounds: CGRect(x: 0, y: 0, width: size, height: size), layer: layer, alpha: alpha, onScreen: true)
        }
        let list = [w(1, 300, layer: 3), w(2, 300), w(3, 10), w(4, 300, alpha: 0), w(5, 300, layer: 25), w(6, 300, layer: -1), w(7, 300)]
        XCTAssertEqual(listableWindows(list).map(\.id), [2, 7, 1])
        XCTAssertEqual(listableWindows([w(8, 30)], minSide: 20).map(\.id), [8])
    }

    func testMatchAXWindow() {
        let bounds = CGRect(x: 10, y: 20, width: 400, height: 300)
        // one window with the same frame
        let one = [AXWindowCandidate(frame: CGRect(x: 0, y: 0, width: 50, height: 50), title: "A"), AXWindowCandidate(frame: CGRect(x: 11, y: 21, width: 401, height: 299), title: "B")]
        XCTAssertEqual(matchAXWindow(bounds: bounds, title: "", candidates: one), 1)
        // several with that frame: the one with the same title, else the first
        let twins = [AXWindowCandidate(frame: bounds, title: "A"), AXWindowCandidate(frame: bounds, title: "B")]
        XCTAssertEqual(matchAXWindow(bounds: bounds, title: "B", candidates: twins), 1)
        XCTAssertEqual(matchAXWindow(bounds: bounds, title: "C", candidates: twins), 0)
        XCTAssertEqual(matchAXWindow(bounds: bounds, title: nil, candidates: [AXWindowCandidate(frame: bounds, title: nil), AXWindowCandidate(frame: bounds, title: "x")]), 0)
        // no frame matches (a minimized window has moved): the same title and size
        let moved = [AXWindowCandidate(frame: nil, title: "Doc"), AXWindowCandidate(frame: CGRect(x: 900, y: 900, width: 400, height: 300), title: "Other"),
                     AXWindowCandidate(frame: CGRect(x: 900, y: 900, width: 100, height: 300), title: "Doc"), AXWindowCandidate(frame: CGRect(x: 900, y: 900, width: 400, height: 301), title: "Doc")]
        XCTAssertEqual(matchAXWindow(bounds: bounds, title: "Doc", candidates: moved), 3)
        XCTAssertNil(matchAXWindow(bounds: bounds, title: "Doc", candidates: Array(moved.prefix(3))))
        XCTAssertNil(matchAXWindow(bounds: bounds, title: "", candidates: moved))
        XCTAssertNil(matchAXWindow(bounds: bounds, title: nil, candidates: []))
        XCTAssertNil(matchAXWindow(bounds: bounds, title: "Doc", candidates: [AXWindowCandidate(frame: CGRect(x: 0, y: 0, width: 400, height: 300), title: nil)]))
    }

    // MARK: chromium

    func testIsChromiumBased() {
        XCTAssertTrue(isChromiumBased(frameworks: ["Sparkle.framework", "Electron Framework.framework"]))
        XCTAssertTrue(isChromiumBased(frameworks: ["Chromium Embedded Framework.framework"]))
        XCTAssertTrue(isChromiumBased(frameworks: ["Google Chrome Framework.framework"]))
        XCTAssertTrue(isChromiumBased(frameworks: ["Chromium Framework.framework"]))
        XCTAssertTrue(isChromiumBased(frameworks: ["Microsoft Edge Framework.framework"]))
        XCTAssertTrue(isChromiumBased(frameworks: ["Brave Browser Framework.framework"]))
        XCTAssertFalse(isChromiumBased(frameworks: ["Sparkle.framework", "Some Framework.framework", "Chrome.framework"]))
        XCTAssertFalse(isChromiumBased(frameworks: []))
    }

    // MARK: menus

    func testMenuTitlesAndMatching() {
        XCTAssertEqual(normalizeMenuTitle("  Export as PDF...  "), "export as pdf")
        XCTAssertEqual(normalizeMenuTitle("Save As…"), "save as")
        XCTAssertEqual(normalizeMenuTitle("Odd ... ..."), "odd")
        XCTAssertEqual(menuIndex(["File", nil, "Export as PDF…"], matching: "export as pdf..."), 2)
        XCTAssertEqual(menuIndex(["File", "Edit"], matching: "EDIT"), 1)
        XCTAssertNil(menuIndex(["File"], matching: "Edi"))
        XCTAssertNil(menuIndex(["", "File"], matching: "..."))
    }

    func testMenuShortcut() {
        XCTAssertEqual(menuShortcut(char: "s", modifiers: 0), "⌘S")
        XCTAssertEqual(menuShortcut(char: "S", modifiers: nil), "⌘S")
        XCTAssertEqual(menuShortcut(char: "s", modifiers: 1), "⇧⌘S")
        XCTAssertEqual(menuShortcut(char: "f", modifiers: 2 | 4), "⌃⌥⌘F")
        XCTAssertEqual(menuShortcut(char: "x", modifiers: 8 | 4), "⌃X")
        XCTAssertNil(menuShortcut(char: " ", modifiers: 0))
        XCTAssertNil(menuShortcut(char: nil, modifiers: 0))
    }

    func testMenuTitleForListing() {
        XCTAssertNil(menuTitleForListing(nil))
        XCTAssertNil(menuTitleForListing(""))
        XCTAssertEqual(menuTitleForListing("Open Recent"), "Open Recent")
        XCTAssertEqual(menuTitleForListing("two\nlines"), "two lines")
        XCTAssertEqual(menuTitleForListing("bad\u{202E}text"), "(title withheld)")
        XCTAssertEqual(menuTitleForListing("tab\there"), "(title withheld)")
        let long = String(repeating: "a", count: 200)
        XCTAssertEqual(menuTitleForListing(long)?.count, 120)
        XCTAssertEqual(menuTitleForListing(long)?.hasSuffix("…"), true)
        XCTAssertEqual(menuTitleForListing(String(repeating: "b", count: 120)), String(repeating: "b", count: 120))
    }

    // MARK: keys

    func testAXKeySemantic() {
        XCTAssertEqual(axKeySemantic("Return"), .confirm)
        XCTAssertEqual(axKeySemantic("enter"), .confirm)
        XCTAssertEqual(axKeySemantic("escape"), .cancel)
        XCTAssertEqual(axKeySemantic("esc"), .cancel)
        XCTAssertEqual(axKeySemantic("backspace"), .deleteBackward)
        XCTAssertEqual(axKeySemantic("delete"), .deleteBackward)
        XCTAssertEqual(axKeySemantic("del"), .deleteBackward)
        XCTAssertEqual(axKeySemantic("forward_delete"), .deleteForward)
        XCTAssertEqual(axKeySemantic("forwarddelete"), .deleteForward)
        XCTAssertEqual(axKeySemantic("cmd + a"), .selectAll)
        XCTAssertEqual(axKeySemantic("command+a"), .selectAll)
        XCTAssertEqual(axKeySemantic("meta+a"), .selectAll)
        XCTAssertNil(axKeySemantic("tab"))
        XCTAssertNil(axKeySemantic("shift+return"))
    }

    func testKeystrokeSpec() {
        XCTAssertEqual(keystrokeSpec("del"), "delete")
        XCTAssertEqual(keystrokeSpec("forward_delete"), "forwarddelete")
        XCTAssertEqual(keystrokeSpec("shift+Page_Down"), "shift+pagedown")
        XCTAssertEqual(keystrokeSpec("page_up"), "pageup")
        XCTAssertEqual(keystrokeSpec("cmd+ArrowUp"), "cmd+up")
        XCTAssertEqual(keystrokeSpec("arrowdown"), "down")
        XCTAssertEqual(keystrokeSpec("arrowleft"), "left")
        XCTAssertEqual(keystrokeSpec("arrowright"), "right")
        XCTAssertEqual(keystrokeSpec("tab"), "tab")
        XCTAssertEqual(keystrokeSpec(""), "")
        XCTAssertNotNil(parseKeyCombo(keystrokeSpec("shift+cmd+down")))
    }

    func testDeletionRange() {
        // a selection is deleted as it is (clamped to the text)
        XCTAssertTrue(deletionRange(value: "hello", location: 1, length: 2, forward: false)! == (1, 2))
        XCTAssertTrue(deletionRange(value: "hello", location: 3, length: 10, forward: true)! == (3, 2))
        // one character before or after the caret, whole emoji and composed characters
        XCTAssertTrue(deletionRange(value: "hello", location: 5, length: 0, forward: false)! == (4, 1))
        XCTAssertTrue(deletionRange(value: "a😀", location: 3, length: 0, forward: false)! == (1, 2))
        XCTAssertTrue(deletionRange(value: "😀b", location: 0, length: 0, forward: true)! == (0, 2))
        XCTAssertTrue(deletionRange(value: "e\u{301}x", location: 2, length: 0, forward: false)! == (0, 2))
        // nothing to delete at the ends; a caret past the end is clamped
        XCTAssertNil(deletionRange(value: "hi", location: 0, length: 0, forward: false))
        XCTAssertNil(deletionRange(value: "hi", location: 2, length: 0, forward: true))
        XCTAssertTrue(deletionRange(value: "hi", location: 99, length: 0, forward: false)! == (1, 1))
        XCTAssertTrue(deletionRange(value: "hi", location: -4, length: 0, forward: true)! == (0, 1))
    }

    // MARK: text

    func testTextRolesAndSecureFields() {
        XCTAssertTrue(textRoles.contains("AXTextArea"))
        XCTAssertEqual(valueLimit(role: "AXTextArea"), 4000)
        XCTAssertEqual(valueLimit(role: "AXButton"), 200)
        XCTAssertEqual(valueLimit(role: nil), 200)
        XCTAssertTrue(menuPresentingRoles.contains("AXPopUpButton"))
        XCTAssertTrue(isSecureText(role: "AXSecureTextField", subrole: nil))
        XCTAssertTrue(isSecureText(role: "AXTextField", subrole: "AXSecureTextField"))
        XCTAssertFalse(isSecureText(role: "AXTextField", subrole: nil))
        XCTAssertFalse(isSecureText(role: nil, subrole: nil))
    }

    func testTextFallback() {
        XCTAssertEqual(textFallback(currentValue: "", overwriteExisting: false), .setValue)
        XCTAssertEqual(textFallback(currentValue: "", overwriteExisting: true), .setValue)
        XCTAssertEqual(textFallback(currentValue: "draft", overwriteExisting: false), .refuse)
        XCTAssertEqual(textFallback(currentValue: "draft", overwriteExisting: true), .replaceAll)
    }

    func testTextWriteEffective() {
        XCTAssertFalse(textWriteEffective(before: "a", after: nil, text: "b", replace: false))
        XCTAssertTrue(textWriteEffective(before: "a", after: "b", text: "b", replace: true))
        XCTAssertFalse(textWriteEffective(before: "a", after: "a", text: "b", replace: true))
        XCTAssertTrue(textWriteEffective(before: "a", after: "a", text: "", replace: false))
        XCTAssertTrue(textWriteEffective(before: "hello", after: "hello world", text: " world", replace: false))
        XCTAssertFalse(textWriteEffective(before: "hello world", after: "hello world", text: "world", replace: false))
        XCTAssertFalse(textWriteEffective(before: nil, after: "x", text: "y", replace: false))
    }

    // MARK: scrolling

    func testScrolledValue() {
        XCTAssertEqual(scrolledValue(current: 0.5, units: 2), 0.6, accuracy: 1e-9)
        XCTAssertEqual(scrolledValue(current: 0.5, units: -3), 0.35, accuracy: 1e-9)
        XCTAssertEqual(scrolledValue(current: 0.9, units: 5), 1)
        XCTAssertEqual(scrolledValue(current: 0.1, units: -5), 0)
        XCTAssertEqual(scrolledValue(current: 0, units: 1, step: 0.5), 0.5)
    }
}
