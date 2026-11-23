import CoreGraphics
import XCTest
@testable import HelperCore

/// Marks on a sparse window (HelperCore/Marks.swift, #3571 G7): which OCR lines are numbered, in what order, and where
/// the number labels go.
final class MarksTests: XCTestCase {
    private func line(_ text: String, _ x: Double, _ y: Double, _ w: Double = 40, _ h: Double = 12) -> UIElement {
        UIElement(id: "ocr:\(text)", text: text, role: "text", frame: CGRect(x: x, y: y, width: w, height: h), source: "ocr")
    }

    func testChoosesUncoveredLinesInReadingOrderFromStart() {
        let window = CGRect(x: 100, y: 50, width: 500, height: 400)
        let ocr = [
            line("Send", 300, 100),
            line("Inbox", 120, 101), // same line as Send (centers 1 pt apart): left first
            line("Title", 120, 60),
            line("   ", 120, 200), // blank
            line("Outside", 900, 100), // outside the window
            line("Covered", 120, 300), // inside an accessibility element main listed
        ]
        let marks = chooseMarks(ocr: ocr, taken: [CGRect(x: 110, y: 290, width: 100, height: 40)], window: window, start: 4)
        XCTAssertEqual(marks.map(\.text), ["Title", "Inbox", "Send"])
        XCTAssertEqual(marks.map(\.n), [4, 5, 6])
        XCTAssertEqual(marks[0].frame, CGRect(x: 120, y: 60, width: 40, height: 12))
        let json = marks[0].json
        XCTAssertEqual(json["n"] as? Int, 4)
        XCTAssertEqual(json["text"] as? String, "Title")
        XCTAssertEqual(json["frame"] as? [String: Double], ["x": 120, "y": 60, "w": 40, "h": 12])
    }

    func testLimitAndLongText() {
        let window = CGRect(x: 0, y: 0, width: 1000, height: 1000)
        let ocr = (0..<100).map { line("L\($0)", 10, Double($0) * 9) }
        XCTAssertEqual(chooseMarks(ocr: ocr, taken: [], window: window, start: 1).count, maxMarks)
        XCTAssertEqual(chooseMarks(ocr: ocr, taken: [], window: window, start: 1, limit: 3).map(\.text), ["L0", "L1", "L2"])
        XCTAssertEqual(chooseMarks(ocr: ocr, taken: [], window: window, start: 1, limit: -1).count, 0)
        let long = chooseMarks(ocr: [line(String(repeating: "x", count: 300), 10, 10)], taken: [], window: window, start: 1)
        XCTAssertEqual(long[0].text.count, 200)
    }

    func testPixelRectAndLabels() {
        XCTAssertEqual(pixelRect(CGRect(x: 110, y: 60, width: 40, height: 20), origin: CGPoint(x: 100, y: 50), ppp: 2),
                       CGRect(x: 20, y: 20, width: 80, height: 40))
        let image = CGSize(width: 200, height: 100)
        let size = CGSize(width: 20, height: 14)
        // above the box
        XCTAssertEqual(labelRect(box: CGRect(x: 50, y: 40, width: 30, height: 10), size: size, image: image), CGRect(x: 50, y: 26, width: 20, height: 14))
        // no room above: inside the box's top
        XCTAssertEqual(labelRect(box: CGRect(x: 50, y: 5, width: 30, height: 10), size: size, image: image), CGRect(x: 50, y: 5, width: 20, height: 14))
        // kept inside the image on the right and the bottom
        XCTAssertEqual(labelRect(box: CGRect(x: 195, y: 99, width: 5, height: 1), size: size, image: image), CGRect(x: 180, y: 85, width: 20, height: 14))
        // a box left of the image
        XCTAssertEqual(labelRect(box: CGRect(x: -10, y: 40, width: 5, height: 5), size: size, image: image).minX, 0)
        // an image smaller than the label
        XCTAssertEqual(labelRect(box: .zero, size: size, image: CGSize(width: 5, height: 5)).origin, .zero)
    }

    func testReusesTheHeldShotOnlyForTheSameWindowSizedTheSameWayAndFresh() {
        let key = ShotKey(windowId: 7, maxSide: 1568, maxPixels: nil, scale: 1)
        XCTAssertTrue(canReuseShot(held: key, heldAtMs: 1000, want: key, nowMs: 1000))
        XCTAssertTrue(canReuseShot(held: key, heldAtMs: 1000, want: key, nowMs: 1000 + reuseShotMs))
        XCTAssertFalse(canReuseShot(held: key, heldAtMs: 1000, want: key, nowMs: 1001 + reuseShotMs))
        // a clock that went backwards is not a fresh capture
        XCTAssertFalse(canReuseShot(held: key, heldAtMs: 1000, want: key, nowMs: 900))
        XCTAssertFalse(canReuseShot(held: nil, heldAtMs: 0, want: key, nowMs: 0))
        for other in [ShotKey(windowId: 8, maxSide: 1568, maxPixels: nil, scale: 1), ShotKey(windowId: 7, maxSide: 1000, maxPixels: nil, scale: 1),
                      ShotKey(windowId: 7, maxSide: 1568, maxPixels: 1_000_000, scale: 1), ShotKey(windowId: 7, maxSide: 1568, maxPixels: nil, scale: 0.5)] {
            XCTAssertFalse(canReuseShot(held: key, heldAtMs: 1000, want: other, nowMs: 1000))
        }
    }
}
