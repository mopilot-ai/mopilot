// XCTest controls the runner-local fake Mac while tapping the production phone screens in a scratch simulator app.
import XCTest

final class PhoneSendUITests: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "ai.mopilot.phone")
  let origin = "__NATIVE_SEND_ORIGIN__"

  func element(_ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
  }

  @discardableResult
  func control(_ command: String) -> [String: Any] {
    let done = expectation(description: command)
    var result: [String: Any] = [:]
    var request = URLRequest(url: URL(string: "\(origin)/control/\(command)")!)
    request.httpMethod = "POST"
    request.timeoutInterval = 10
    URLSession.shared.dataTask(with: request) { data, _, error in
      XCTAssertNil(error)
      if let data = data, let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { result = value }
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 12)
    XCTAssertNil(result["error"])
    return result
  }

  func waitPending(_ field: String) {
    let deadline = Date().addingTimeInterval(10)
    while Date() < deadline {
      if control("state")[field] as? Bool == true { return }
      Thread.sleep(forTimeInterval: 0.1)
    }
    XCTFail("Fake Mac never received \(field)")
  }

  func tap(_ label: String) {
    let node = element(label)
    requireExists(node, label)
    XCTAssertTrue(node.isHittable, "Not hittable: \(label)")
    node.tap()
  }

  func type(_ label: String, _ text: String) {
    // While empty, React Native's iOS TextInput reads "<accessibilityLabel> <placeholder>" as its label (seen in the CI tree),
    // so the empty composer is found by the label it starts with; typed text drops the placeholder half.
    let field = app.textViews.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
    requireExists(field, label)
    field.tap()
    field.typeText(text)
  }

  /// Bubbles on screen showing this text. React Native text reaches XCTest as a StaticText nested in an identical StaticText
  /// (the CI tree shows it for every label), so matches count once per distinct frame: a second bubble sits elsewhere.
  func bubbleCount(_ text: String) -> Int {
    let matches = app.staticTexts.matching(NSPredicate(format: "label IN %@", ["You: \(text)", "You, live: \(text)", text])).allElementsBoundByIndex
    let frames = Set(matches.map { "\($0.frame)" })
    if frames.count != 1 {
      print("PHONE_SEND_UI_TREE_BEGIN\nBubble matches for \(text): \(matches.map { "\($0.label) \($0.frame)" })\n\(app.debugDescription)\nPHONE_SEND_UI_TREE_END")
    }
    return frames.count
  }

  /// Tiles of a message's pictures on screen. Each reads "Open picture" once the picture is drawn (the phone's own preview, or the
  /// one read back from the Mac); a second message with the same picture sits at another frame, so frames are counted.
  func pictureCount() -> Int {
    let matches = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Open picture")).allElementsBoundByIndex
    let frames = Set(matches.map { "\($0.frame)" })
    if frames.count != 1 { printTree("Picture tiles: \(matches.map { "\($0.label) \($0.frame)" })") }
    return frames.count
  }

  func printTree(_ note: String) {
    print("PHONE_SEND_UI_TREE_BEGIN\n\(note)\n\(app.debugDescription)\nPHONE_SEND_UI_TREE_END")
  }

  /// Named steps reach XCTest's own trace ("t = 12.30s <name>"), so the public log shows how far a journey got.
  func step(_ name: String, _ body: () -> Void) {
    XCTContext.runActivity(named: name) { _ in body() }
  }

  /// Taps once the control is on screen and settled: a sheet slides up, so its rows exist a moment before they are hittable.
  func press(_ label: String) {
    let node = element(label)
    requireExists(node, label)
    let deadline = Date().addingTimeInterval(5)
    while !node.isHittable && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
    XCTAssertTrue(node.isHittable, "Not hittable: \(label)")
    node.tap()
  }

  func requireGone(_ label: String, timeout: TimeInterval = 10) {
    let node = element(label)
    let deadline = Date().addingTimeInterval(timeout)
    while node.exists && Date() < deadline { Thread.sleep(forTimeInterval: 0.2) }
    if node.exists { printTree("Still showing \(label)") }
    XCTAssertFalse(node.exists, "Still showing \(label)")
  }

  /// Adds the fake library's one photo through Add to session and waits until it is uploaded; returns the id the Mac gave it.
  func attachPhoto() -> String {
    press("Add to session")
    press("Photos")
    requireExists(element("native-photo.png, attached"), "native-photo.png, attached")
    let uploads = control("state")["uploads"] as? [[String: Any]] ?? []
    XCTAssertEqual(uploads.count, 1)
    XCTAssertEqual(uploads.first?["name"] as? String, "native-photo.png")
    XCTAssertEqual(uploads.first?["mime"] as? String, "image/png")
    return uploads.first?["id"] as? String ?? ""
  }

  /// New session on a Host: the machine picked from the Run on sheet and a folder there, as a person would choose them.
  func chooseHostFolder() {
    press("New session")
    // the machine list arrives after the page opens; the Mac's own row is then named by the list instead of the pairing
    requireExists(element("Computer, This Mac"), "Computer, This Mac")
    press("Computer, This Mac")
    press("Fake Host")
    requireExists(element("Computer, Fake Host"), "Computer, Fake Host")
    press("Folder, Choose a folder")
    press("work")
    press("Use this folder")
    requireExists(element("Folder, work"), "Folder, work")
  }

  func shot(_ name: String) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  func requireExists(_ node: XCUIElement, _ label: String, timeout: TimeInterval = 20) {
    let exists = node.waitForExistence(timeout: timeout)
    if !exists {
      shot("missing-native-control")
      let tree = app.debugDescription
      let attachment = XCTAttachment(string: tree)
      attachment.name = "missing-control-ui-tree"
      attachment.lifetime = .keepAlways
      add(attachment)
      // This app contains only runner-local fake data. The public error summary retains bounded marked trees.
      print("PHONE_SEND_UI_TREE_BEGIN\n\(tree)\nPHONE_SEND_UI_TREE_END")
    }
    XCTAssertTrue(exists, "Missing \(label)")
  }

  override func setUpWithError() throws {
    continueAfterFailure = false
    app.terminate()
    control("reset")
    app.launch()
  }

  func testPendingStartWarningAndRecords() {
    tap("New session")
    type("Describe a task or ask a question", "First native prompt")
    tap("Start chat")
    // The RPC cannot resolve until control(acceptStart), so this assertion proves the pending frame.
    requireExists(element("You: First native prompt"), "You: First native prompt", timeout: 3)
    waitPending("pendingStart")
    XCTAssertFalse(element("Back to chats").exists)
    XCTAssertEqual(bubbleCount("First native prompt"), 1)
    shot("start-pending-user-bubble")
    control("acceptStart")
    requireExists(element("Back to chats"), "Back to chats", timeout: 20)
    requireExists(element("Mac accepted start; transcript pending."), "Mac accepted start; transcript pending.", timeout: 20)
    XCTAssertEqual(bubbleCount("First native prompt"), 1)
    requireExists(element("Activity: Running without user record"), "Activity: Running without user record", timeout: 20)
    XCTAssertLessThan(element("You: First native prompt").frame.maxY, element("Activity: Running without user record").frame.minY)
    shot("start-warning-without-user-record")
    control("record")
    requireExists(element("Activity: Record 1 applied"), "Activity: Record 1 applied", timeout: 20)
    XCTAssertEqual(bubbleCount("First native prompt"), 1)
    type("Message this chat", "Second native prompt")
    tap("Send message")
    waitPending("pendingSend")
    XCTAssertEqual(bubbleCount("Second native prompt"), 1)
    control("ackSend")
    requireExists(element("You: Second native prompt"), "You: Second native prompt", timeout: 5)
    XCTAssertEqual(bubbleCount("Second native prompt"), 1)
    shot("send-ack-before-record")
    control("record")
    requireExists(element("Activity: Record 2 applied"), "Activity: Record 2 applied", timeout: 20)
    XCTAssertEqual(bubbleCount("Second native prompt"), 1)
    shot("records-replace-pending-once")
  }

  func testRefusalRestoresDraftAndRetryId() {
    tap("New session")
    type("Describe a task or ask a question", "Restore this prompt")
    tap("Start chat")
    requireExists(element("You: Restore this prompt"), "You: Restore this prompt", timeout: 3)
    waitPending("pendingStart")
    control("refuseStart")
    requireExists(element("Fake Mac refused this start."), "Fake Mac refused this start.", timeout: 20)
    let field = app.textViews.matching(NSPredicate(format: "label == %@", "Describe a task or ask a question")).firstMatch
    XCTAssertEqual(field.value as? String, "Restore this prompt")
    shot("refused-start-draft-restored")
    tap("Start chat")
    waitPending("pendingStart")
    let ids = control("state")["startIds"] as? [String] ?? []
    XCTAssertEqual(ids.count, 2)
    XCTAssertEqual(ids.first, ids.last)
    control("acceptStart")
    requireExists(element("Back to chats"), "Back to chats", timeout: 20)
    XCTAssertEqual(bubbleCount("Restore this prompt"), 1)
  }

  func testLocalPictureOnlySendShowsOnePictureAndOpensViewer() {
    step("start and record a local chat") {
      tap("New session")
      type("Describe a task or ask a question", "Picture chat")
      tap("Start chat")
      waitPending("pendingStart")
      control("acceptStart")
      requireExists(element("Back to chats"), "Back to chats", timeout: 20)
      control("record")
      requireExists(element("Activity: Record 1 applied"), "Activity: Record 1 applied", timeout: 20)
    }
    var uploaded = ""
    step("attach the photo through Add to session") { uploaded = attachPhoto() }
    step("send the photo with no text") {
      press("Send message")
      waitPending("pendingSend")
    }
    step("the optimistic message shows the picture once and carries the upload") {
      requireExists(element("Open picture"), "Open picture", timeout: 5)
      XCTAssertEqual(pictureCount(), 1)
      XCTAssertEqual(control("state")["sendAttachments"] as? [[String]], [[uploaded]])
      shot("picture-pending-bubble")
    }
    step("the Mac accepts it and the one picture stays") {
      control("ackSend")
      Thread.sleep(forTimeInterval: 1)
      XCTAssertEqual(pictureCount(), 1)
    }
    step("the Mac's record replaces it without a second picture") {
      control("record")
      requireExists(element("Activity: Record 2 applied"), "Activity: Record 2 applied", timeout: 20)
      Thread.sleep(forTimeInterval: 1)
      XCTAssertEqual(pictureCount(), 1)
      XCTAssertFalse(element("Loading picture").exists)
      shot("picture-record-replaced-once")
    }
    step("a tap opens the full-screen viewer and Close image leaves it") {
      press("Open picture")
      requireExists(element("Close image"), "Close image", timeout: 10)
      press("Close image")
      requireGone("Close image")
      XCTAssertEqual(pictureCount(), 1)
    }
  }

  func testHostPictureOnlyStartUploadsAndShowsOnePicture() {
    control("hosts")
    step("choose the Host and its folder") { chooseHostFolder() }
    var uploaded = ""
    step("attach the photo with no text") { uploaded = attachPhoto() }
    step("Start chat holds the Mac's reply and shows the picture once") {
      press("Start chat")
      waitPending("pendingStart")
      requireExists(element("Open picture"), "Open picture", timeout: 5)
      XCTAssertEqual(pictureCount(), 1)
      let state = control("state")
      XCTAssertEqual(state["startAttachments"] as? [[String]], [[uploaded]])
      let hosts = state["startHosts"] as? [[String: Any]] ?? []
      XCTAssertEqual(hosts.count, 1)
      XCTAssertEqual(hosts.first?["hostId"] as? String, "host-1")
      XCTAssertEqual(hosts.first?["folder"] as? String, "/srv/work")
      shot("host-start-pending-picture")
    }
    step("the chat opens with one picture") {
      control("acceptStart")
      requireExists(element("Back to chats"), "Back to chats", timeout: 20)
      Thread.sleep(forTimeInterval: 1)
      XCTAssertEqual(pictureCount(), 1)
    }
    step("the Mac's record replaces it without a second picture") {
      control("record")
      requireExists(element("Activity: Record 1 applied"), "Activity: Record 1 applied", timeout: 20)
      Thread.sleep(forTimeInterval: 1)
      XCTAssertEqual(pictureCount(), 1)
      XCTAssertFalse(element("Loading picture").exists)
      shot("host-start-record-replaced-once")
    }
  }

  func testLegacyHostPictureStartFailsVisiblyAndKeepsAttachment() {
    control("hosts")
    control("legacy")
    step("choose the Host and its folder") { chooseHostFolder() }
    step("attach the photo with no text") { _ = attachPhoto() }
    step("Start chat says to update the computer and sends nothing") {
      press("Start chat")
      let update = "Update MoPilot on this computer to send pictures. Your attachment is kept."
      requireExists(element(update), update, timeout: 10)
      XCTAssertEqual(control("state")["startIds"] as? [String] ?? [], [])
      XCTAssertEqual(control("state")["startAttachments"] as? [[String]] ?? [], [])
      shot("legacy-host-picture-refused")
    }
    step("the attachment and the page are kept") {
      requireExists(element("native-photo.png, attached"), "native-photo.png, attached", timeout: 5)
      XCTAssertFalse(element("Open picture").exists)
      XCTAssertTrue(element("Start chat").exists)
    }
  }
}
