// XCTest drives real iOS taps through production Markdown, native stacks and approval sheets on an isolated simulator.
import XCTest

final class PhoneLinksUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "ai.mopilot.phone")

  func element(_ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  func tap(_ label: String) {
    let node = element(label)
    requireExists(node, label)
    // A screen being popped still covers the one under it for its animation: only what stays covered fails, with its tree.
    let hittable = expectation(for: NSPredicate(format: "hittable == true"), evaluatedWith: node)
    if XCTWaiter().wait(for: [hittable], timeout: 5) != .completed {
      print("PHONE_SEND_UI_TREE_BEGIN\n\(app.debugDescription)\nPHONE_SEND_UI_TREE_END")
      XCTFail("Not hittable: \(label)")
    }
    node.tap()
  }

  /// Taps a link's own glyphs: a link is inline text, so the centre of its wide paragraph (where `tap()` lands) is empty space.
  /// `y` picks the paragraph in a reply of several, as a fraction of the reply's height.
  func tapLink(_ prefix: String, y: CGFloat = 0.5) {
    let node = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    requireExists(node, prefix)
    node.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: y)).withOffset(CGVector(dx: 30, dy: 0)).tap()
  }

  func requireExists(_ node: XCUIElement, _ label: String, timeout: TimeInterval = 20) {
    let exists = node.waitForExistence(timeout: timeout)
    if !exists {
      // Only runner-local fake data; the public error summary keeps bounded marked trees.
      print("PHONE_SEND_UI_TREE_BEGIN\n\(app.debugDescription)\nPHONE_SEND_UI_TREE_END")
    }
    XCTAssertTrue(exists, "Missing \(label)")
  }

  func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.launch()
  }

  func testReplyLinksAndCyclicBackStack() {
    tap("Open chat Link origin")
    tapLink("MoPilot: [Open linked target]")
    requireExists(element("Back to Link origin"), "Back to Link origin")
    shot("reply-link-target")
    tapLink("MoPilot: Native target reply.", y: 0.8)
    tap("Back to chats")
    requireExists(element("Open chat Link origin"), "Open chat Link origin")
    // Repeat the journey, exercising Back to the source rather than a cycle.
    tap("Open chat Link origin")
    tapLink("MoPilot: [Open linked target]")
    tap("Back to Link origin")
    tap("Back to chats")
    shot("reply-links-back-home")
  }

  func testFamilyNeedsInputAndPlanLink() {
    tap("Open chat Family parent")
    requireExists(element("Child approval"), "Child approval")
    shot("family-opens-child-approval")
    tapLink("Plan destination")
    requireExists(element("Back to Waiting child"), "Back to Waiting child")
    let approve = element("Approve plan")
    XCTAssertFalse(approve.exists && approve.isHittable, "The old approval sheet still covers the target")
    shot("plan-link-dismissed-sheet")
    tap("Back to Waiting child")
    requireExists(element("MoPilot: Waiting child transcript."), "MoPilot: Waiting child transcript.")
    // A chat that waits on a plan shows it in a sheet whose scrim covers the header: it is closed before leaving, as a person does.
    tap("Close plan")
    tap("Back to chats")
    requireExists(element("Open chat Family parent"), "Open chat Family parent")
  }
}
