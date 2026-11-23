import XCTest
@testable import HelperCore

/// The pure parts of the display-scope input additions (HelperCore/DesktopInput.swift): the capture cap
/// for high-resolution models, the key-hold limit, which apps hide while a chat holds the desktop, and
/// the per-app substitution settings turned off around typed keystrokes and put back. None needs TCC.
final class DesktopInputTests: XCTestCase {
    func testCaptureAndHoldLimitsMatchTheModelsAndTheOfficialToolset() {
        XCTAssertEqual(maxCaptureSide, 2576)
        XCTAssertEqual(maxHoldMs, 100_000)
        XCTAssertEqual(cappedSide(1568, fallback: 2000), 1568)
        XCTAssertEqual(cappedSide(4000, fallback: 2000), 2576)
        XCTAssertEqual(cappedSide(nil, fallback: 2000), 2000)
        XCTAssertEqual(cappedSide(0, fallback: 3000), 2576)
        XCTAssertEqual(cappedSide(-5, fallback: 1568, limit: 1000), 1000)
        // a high-resolution capture stays inside the 2576 px edge
        let s = captureSize(widthPoints: 1728, heightPoints: 1117, scale: 2, maxSide: maxCaptureSide, maxPixels: 3_750_000)
        XCTAssertLessThanOrEqual(max(s.width, s.height), 2576)
        XCTAssertLessThanOrEqual(s.width * s.height, 3_760_000)
    }

    func testAppsToHideAreTheVisibleRegularAppsThatAreNotGrantedAndNotMoPilot() {
        let apps = [
            RunningApp(pid: 1, bundleId: "ai.mopilot.code", name: "MoPilot", hidden: false, regular: true),
            RunningApp(pid: 2, bundleId: "com.apple.Notes", name: "Notes", hidden: false, regular: true),
            RunningApp(pid: 3, bundleId: "com.tinyspeck.slackmacgap", name: "Slack", hidden: false, regular: true),
            RunningApp(pid: 4, bundleId: "com.apple.Safari", name: "Safari", hidden: true, regular: true),
            RunningApp(pid: 5, bundleId: "com.apple.dock", name: "Dock", hidden: false, regular: false),
            RunningApp(pid: 6, bundleId: nil, name: "Unnamed", hidden: false, regular: true),
        ]
        let hide = appsToHide(apps, keep: ["COM.APPLE.NOTES"], protectedPids: [1])
        XCTAssertEqual(hide.map(\.pid), [3, 6])
        XCTAssertEqual(hide[0].json["bundleId"] as? String, "com.tinyspeck.slackmacgap")
        XCTAssertEqual(hide[0].json["name"] as? String, "Slack")
        XCTAssertEqual(hide[1].json["bundleId"] as? String, "")
        XCTAssertEqual(RunningApp(pid: 7, bundleId: "a.b", name: nil, hidden: false, regular: true).json["name"] as? String, "a.b")
        XCTAssertEqual(RunningApp(pid: 8, bundleId: nil, name: nil, hidden: false, regular: true).json["name"] as? String, "")
        XCTAssertEqual(appsToHide([], keep: [], protectedPids: []), [])
    }

    func testSubstitutionsAreTurnedOffForTheCallAndPutBackAsTheyWere() {
        var store: [String: Any] = ["NSAutomaticSpellingCorrectionEnabled": true, "NSAutomaticQuoteSubstitutionEnabled": false]
        let set: (String, Any?) -> Void = { k, v in store[k] = v }
        let o = SubstitutionOverride.apply(get: { store[$0] }, set: set)
        XCTAssertEqual(Set(store.keys), Set(substitutionKeys))
        XCTAssertTrue(store.values.allSatisfy { ($0 as? Bool) == false })
        XCTAssertEqual(o.prior.count, substitutionKeys.count)
        o.restore(set: set)
        XCTAssertEqual(store.count, 2, "keys the app never had are removed again")
        XCTAssertEqual(store["NSAutomaticSpellingCorrectionEnabled"] as? Bool, true)
        XCTAssertEqual(store["NSAutomaticQuoteSubstitutionEnabled"] as? Bool, false)
    }
}
