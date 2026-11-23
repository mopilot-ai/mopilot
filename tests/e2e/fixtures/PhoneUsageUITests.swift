// Real iOS taps open Settings > Usage on the production app against a deterministic fake Mac.
import XCTest

final class PhoneUsageUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "ai.mopilot.phone")

  func element(_ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  func containing(_ text: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  // A miss prints the app tree between markers: the workflow log is public and keeps no screenshot or artifact.
  func requireExists(_ node: XCUIElement, _ label: String, timeout: TimeInterval = 20) {
    let exists = node.waitForExistence(timeout: timeout)
    if !exists {
      shot("missing-native-control")
      print("PHONE_SEND_UI_TREE_BEGIN\nMissing \(label)\n\(app.debugDescription)\nPHONE_SEND_UI_TREE_END")
    }
    XCTAssertTrue(exists, "Missing \(label)")
  }

  func evidence(_ line: String) { print("PHONE_USAGE_EVIDENCE \(line)") }

  func tap(_ label: String) {
    let node = element(label)
    requireExists(node, label)
    XCTAssertTrue(node.isHittable, "Not hittable: \(label), frame \(node.frame)")
    node.tap()
  }

  func hidden(_ node: XCUIElement) {
    expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: node)
    waitForExpectations(timeout: 10)
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.terminate()
    app.launch()
  }

  func openUsage() {
    tap("Open menu")
    tap("Settings")
    tap("Usage")
    requireExists(containing("Claude Code · Work"), "Claude Code account group")
  }

  func testSettingsShowsUsagePerAccount() {
    openUsage()
    // each account is its own group with its harness, label and active mark
    requireExists(element("Claude Code · Work · Active"), "active Claude account")
    requireExists(element("Codex · Personal"), "Codex Personal account")
    requireExists(element("Codex · Spare"), "Codex Spare account")
    requireExists(element("Sign in on your Mac"), "signed-out account line")
    // remaining percentage and a reset time per window
    requireExists(containing("75% left"), "5-hour remaining")
    requireExists(containing("40% left"), "weekly remaining")
    requireExists(containing("90% left"), "Codex weekly remaining")
    requireExists(containing("Resets Friday 9 AM"), "text reset time")
    requireExists(containing("Resets 1/1/2100"), "dated reset time")
    evidence("groups Work(active)/Personal/Spare; windows 75% left, 40% left, 90% left; signin line; resets present")
    shot("usage-accounts")
  }

  func testSettingsUsageRefreshAndBack() {
    openUsage()
    requireExists(containing("75% left"), "initial remaining")
    tap("Refresh usage")
    requireExists(containing("65% left"), "refreshed remaining (a fresh read)")
    evidence("refresh re-read usage: 75% left -> 65% left")
    shot("usage-refreshed")
    tap("Back")
    requireExists(element("Usage"), "Settings list after back")
    hidden(containing("Claude Code · Work"))
    evidence("back returned to Settings")
  }
}
