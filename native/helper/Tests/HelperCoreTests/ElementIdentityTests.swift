// elementMismatch: the expectElement contract between main (desktopPolicy.cjs identityOf) and the helper's
// ax.press, ax.focus and app.* element requests; pidsShown: which captured apps the image really shows.
import CoreGraphics
import XCTest
@testable import HelperCore

final class ElementIdentityTests: XCTestCase {
    func testSameElementPasses() {
        XCTAssertNil(elementMismatch(nil, role: "AXButton", title: "Delete", description: nil))
        XCTAssertNil(elementMismatch(["role": "AXButton", "title": "Send"], role: "AXButton", title: "Send", description: nil))
        XCTAssertNil(elementMismatch(["role": "AXCheckBox", "description": "Bold"], role: "AXCheckBox", title: "", description: "Bold"))
        // the snapshot keeps the first 200 characters
        let long = String(repeating: "a", count: 300)
        XCTAssertNil(elementMismatch(["role": "AXLink", "title": String(long.prefix(200))], role: "AXLink", title: long, description: nil))
    }

    func testAnotherControlAtTheSamePathIsNamed() {
        XCTAssertEqual(elementMismatch(["role": "AXButton", "title": "Archive"], role: "AXButton", title: "Delete", description: nil), "AXButton \"Delete\"")
        XCTAssertEqual(elementMismatch(["role": "AXButton", "title": "Send"], role: "AXTextField", title: nil, description: "To"), "AXTextField \"To\"")
        XCTAssertEqual(elementMismatch(["role": "AXButton"], role: "AXButton", title: nil, description: "Trash"), "AXButton \"Trash\"")
        XCTAssertEqual(elementMismatch(["role": "AXButton", "title": "Send"], role: nil, title: nil, description: nil), "an element")
    }

    func testShownAppsAreThoseWithAWindowOnTheFrame() {
        let display = CGRect(x: 0, y: 0, width: 1000, height: 800)
        let windows = [
            HitWindow(pid: 1, layer: 0, alpha: 1, bounds: CGRect(x: 10, y: 10, width: 200, height: 200)),
            HitWindow(pid: 2, layer: 0, alpha: 1, bounds: CGRect(x: 1200, y: 10, width: 200, height: 200)),
            HitWindow(pid: 3, layer: 3, alpha: 1, bounds: CGRect(x: 10, y: 10, width: 200, height: 200)),
            HitWindow(pid: 6, layer: 0, alpha: 1, bounds: CGRect(x: 10, y: 10, width: 200, height: 200), sharingState: 0),
            HitWindow(pid: 4, layer: 0, alpha: 0, bounds: CGRect(x: 10, y: 10, width: 200, height: 200)),
            HitWindow(pid: 5, layer: 0, alpha: 1, bounds: CGRect(x: 10, y: 10, width: 200, height: 200)),
        ]
        // a floating panel is captured too; a window left out of capture is not
        XCTAssertEqual(pidsShown(windows: windows, includedPids: [1, 2, 3, 4, 6], frame: display), [1, 3])
        XCTAssertEqual(pidsShown(windows: windows, includedPids: [2], frame: display), [])
    }

    func testElementChangedError() {
        let e = HelperError.elementChanged("0.3.1", now: "AXButton \"Delete\"")
        XCTAssertEqual(e.reason, "element_changed")
        XCTAssertTrue(e.message.contains("element 0.3.1 is now AXButton \"Delete\""))
    }
}
