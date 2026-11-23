import Foundation
import XCTest
@testable import HelperCore

/// The pure parts of app.filePanel (HelperCore/FilePanel.swift): the folder and name a request may send, telling a
/// Save or Open panel from other sheets, and reading whether the panel shows the folder. None needs TCC.
final class FilePanelTests: XCTestCase {
    func testTargetPathIsAbsoluteAndPlain() {
        XCTAssertEqual(panelTargetPath("/Users/me/Documents"), "/Users/me/Documents")
        XCTAssertEqual(panelTargetPath("/"), "/")
        XCTAssertNil(panelTargetPath("~/Documents"))
        XCTAssertNil(panelTargetPath("Documents"))
        XCTAssertNil(panelTargetPath("/a\nb"))
        XCTAssertNil(panelTargetPath("/a\u{7f}b"))
        XCTAssertNil(panelTargetPath("/" + String(repeating: "a", count: 1024)))
    }

    func testFileNameIsANameOnly() {
        XCTAssertTrue(validPanelFileName("report.pdf"))
        XCTAssertFalse(validPanelFileName(""))
        XCTAssertFalse(validPanelFileName("a/b.pdf"))
        XCTAssertFalse(validPanelFileName("."))
        XCTAssertFalse(validPanelFileName(".."))
        XCTAssertFalse(validPanelFileName("a\tb"))
        XCTAssertFalse(validPanelFileName(String(repeating: "x", count: 256)))
    }

    func testPanelByIdentifierOrShapeButNotAnAlert() {
        XCTAssertTrue(looksLikeFilePanel([PanelElement(role: "AXSheet", identifier: "save-panel")]))
        XCTAssertTrue(looksLikeFilePanel([PanelElement(role: "AXSheet"), PanelElement(role: "AXTextField", identifier: saveAsFieldIdentifier)]))
        XCTAssertTrue(looksLikeFilePanel([PanelElement(role: "AXPopUpButton", identifier: wherePopupIdentifier)]))
        XCTAssertTrue(looksLikeFilePanel([PanelElement(role: "AXPopUpButton"), PanelElement(role: "AXButton"), PanelElement(role: "AXOutline")]))
        XCTAssertTrue(looksLikeFilePanel([PanelElement(role: "AXPopUpButton"), PanelElement(role: "AXButton"), PanelElement(role: "AXBrowser")]))
        // an alert sheet: buttons and text, no location or file list
        XCTAssertFalse(looksLikeFilePanel([PanelElement(role: "AXSheet"), PanelElement(role: "AXButton"), PanelElement(role: "AXStaticText", identifier: "other")]))
        XCTAssertFalse(looksLikeFilePanel([PanelElement(role: "AXPopUpButton"), PanelElement(role: "AXOutline")]))
        XCTAssertEqual(PanelElement(role: "AXButton"), PanelElement(role: "AXButton", identifier: nil))
    }

    func testSidebarRowOnlyForStandardFoldersByTheirShownName() {
        let rows = ["Favorites", "Applications", "Desktop", "Documents", "Downloads", "Locations", "admin", " Macintosh HD "]
        XCTAssertEqual(sidebarRow(for: "/Users/admin/Documents", home: "/Users/admin", displayName: "Documents", rows: rows), 3)
        XCTAssertEqual(sidebarRow(for: "/Users/admin", home: "/Users/admin", displayName: "admin", rows: rows), 6)
        XCTAssertEqual(sidebarRow(for: "/", home: "/Users/admin", displayName: "Macintosh HD", rows: rows), 7)
        XCTAssertEqual(sidebarRow(for: "/Applications", home: "/Users/admin", displayName: "applications", rows: rows), 1)
        // a folder named like a sidebar row elsewhere, or not in the sidebar, or no name
        XCTAssertNil(sidebarRow(for: "/Users/admin/Work/Documents", home: "/Users/admin", displayName: "Documents", rows: rows))
        XCTAssertNil(sidebarRow(for: "/Users/admin/Downloads", home: "/Users/admin", displayName: "Downloads", rows: ["Desktop"]))
        XCTAssertNil(sidebarRow(for: "/Users/admin/Desktop", home: "/Users/admin", displayName: nil, rows: rows))
        XCTAssertNil(sidebarRow(for: "/Users/admin/Desktop", home: "/Users/admin", displayName: "", rows: rows))
    }

    func testSearchOrderPutsTheNamedWindowFirstAndNeverHidesTheOthers() {
        // TextEdit's Open panel is a window of its own (#1381 f2): naming the document window still reaches it
        XCTAssertEqual(panelSearchOrder(named: 10, listed: [12, 10, 11]), [10, 12, 11])
        XCTAssertEqual(panelSearchOrder(named: nil, listed: [12, 10]), [12, 10])
        // a window that closed since (the panel was reopened under a new id): every listed window, not window_gone
        XCTAssertEqual(panelSearchOrder(named: 600, listed: [587, 1]), [587, 1])
        XCTAssertEqual(panelSearchOrder(named: 5, listed: []), [])
    }

    func testGoToPathIsTheFolderOrTheFileInIt() {
        XCTAssertEqual(goToPath(folder: "/Users/me/Downloads", fileName: nil), "/Users/me/Downloads")
        XCTAssertEqual(goToPath(folder: "/Users/me/Downloads", fileName: "passport-scan.txt"), "/Users/me/Downloads/passport-scan.txt")
        XCTAssertEqual(goToPath(folder: "/", fileName: "a.txt"), "/a.txt")
    }

    func testGoToFolderIsFoundByItsShortcut() {
        XCTAssertTrue(isGoToFolderShortcut(char: "G", modifiers: 1))
        XCTAssertTrue(isGoToFolderShortcut(char: "g", modifiers: 1))
        XCTAssertFalse(isGoToFolderShortcut(char: "G", modifiers: 0))
        XCTAssertFalse(isGoToFolderShortcut(char: "D", modifiers: 1))
        XCTAssertFalse(isGoToFolderShortcut(char: nil, modifiers: nil))
    }

    func testFinderOpensDocumentsOnly() {
        let txt: Set<String> = ["public.plain-text", "public.text", "public.data"]
        XCTAssertNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: txt))
        XCTAssertNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: ["com.adobe.pdf", "public.data"]))
        XCTAssertNotNil(finderOpenRefusal(isDirectory: true, isAlias: false, isExecutable: false, conforms: ["com.apple.application"]))
        // an alias of an app is a plain file: refused as an alias, whatever it points to
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: true, isExecutable: false, conforms: txt))
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: true, conforms: txt))
        // a script is plain text, an SVG an image, HTML text: the runnable type wins
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: txt.union(["public.shell-script"])))
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: ["public.image", "public.svg-image"]))
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: ["public.text", "public.html"]))
        // an unknown or importing type is not a document
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: ["public.data"]))
        XCTAssertNotNil(finderOpenRefusal(isDirectory: false, isAlias: false, isExecutable: false, conforms: ["public.vcard", "public.text"]))
    }

    func testConfirmOutcomeNeverReadsAnAlertAsDone() {
        XCTAssertEqual(panelConfirmOutcome(panelGone: true, alertButtons: []), .closed)
        XCTAssertEqual(panelConfirmOutcome(panelGone: false, alertButtons: ["Cancel", "Replace"]), .prompt)
        XCTAssertEqual(panelConfirmOutcome(panelGone: false, alertButtons: []), .open)
        XCTAssertEqual(PanelConfirmOutcome.prompt.rawValue, "prompt")
    }

    func testPanelShowsFolderByDisplayNameOrLastComponent() {
        XCTAssertEqual(panelShowsFolder(["Rich Text Document", "Reports"], folder: "/Users/me/Reports", displayName: "Reports"), true)
        XCTAssertEqual(panelShowsFolder([" macintosh hd "], folder: "/", displayName: "Macintosh HD"), true)
        // a localized display name, or none
        XCTAssertEqual(panelShowsFolder(["文稿"], folder: "/Users/me/Documents", displayName: "文稿"), true)
        XCTAssertEqual(panelShowsFolder(["Documents"], folder: "/Users/me/Documents", displayName: nil), true)
        XCTAssertEqual(panelShowsFolder(["Macintosh HD"], folder: "/Users/me/Reports", displayName: "Reports"), false)
        XCTAssertNil(panelShowsFolder([], folder: "/x", displayName: "x"))
        XCTAssertNil(panelShowsFolder(["  "], folder: "/x", displayName: "x"))
    }
}
