import CoreGraphics
import Foundation
import XCTest
@testable import HelperCore

final class HelperCoreEdgeTests: XCTestCase {
    func testLaunchFileIsConsumedBeforeValidation() throws {
        let path = NSTemporaryDirectory() + "mopilot-launch-\(UUID().uuidString).json"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let config = LaunchConfig(socket: "/tmp/helper.sock", token: String(repeating: "x", count: 32),
                                  mainPid: 2, denyBundleIds: ["com.example.bank"])
        try JSONEncoder().encode(config).write(to: URL(fileURLWithPath: path))
        XCTAssertEqual(try LaunchConfig.load(path: path), config)
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        try Data("invalid JSON".utf8).write(to: URL(fileURLWithPath: path))
        XCTAssertThrowsError(try LaunchConfig.load(path: path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
        XCTAssertThrowsError(try LaunchConfig.load(path: path))
    }

    func testLaunchSocketLimitCountsUTF8Bytes() throws {
        let token = String(repeating: "x", count: 32)
        let allowed = LaunchConfig(socket: "/" + String(repeating: "a", count: 102), token: token, mainPid: 2)
        XCTAssertEqual(try LaunchConfig.parse(JSONEncoder().encode(allowed)), allowed)
        let tooLong = LaunchConfig(socket: "/" + String(repeating: "a", count: 103), token: token, mainPid: 2)
        XCTAssertThrowsError(try LaunchConfig.parse(JSONEncoder().encode(tooLong)))
        let unicode = LaunchConfig(socket: "/" + String(repeating: "你", count: 35), token: token, mainPid: 2)
        XCTAssertThrowsError(try LaunchConfig.parse(JSONEncoder().encode(unicode)))
    }

    func testCaptureDimensionsNeverBecomeZeroOrUpscaleSmallDisplays() {
        let tiny = captureSize(widthPoints: 0, heightPoints: -1, scale: 0, maxSide: 0)
        XCTAssertEqual(tiny.width, 1)
        XCTAssertEqual(tiny.height, 1)
        let small = captureSize(widthPoints: 10, heightPoints: 20, scale: 0.5)
        XCTAssertEqual(small.width, 10)
        XCTAssertEqual(small.height, 20)
    }

    func testEveryPermissionHasItsOwnSettingsAnchorAndError() {
        XCTAssertEqual(Permission.inputMonitoring.settingsURL,
                       "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")
        for permission in Permission.allCases {
            let error = HelperError.permission(permission)
            XCTAssertEqual(error.code, 1)
            XCTAssertEqual(error.reason, "permission_denied")
            XCTAssertEqual(error.message, "\(permission.rawValue) permission not granted")
        }
    }

    func testHelperErrorsPreserveRPCCodeAndActionableReason() {
        XCTAssertEqual(HelperError.invalidParams("missing x"), HelperError(-32602, "invalid_params", "missing x"))
        XCTAssertEqual(HelperError.methodNotFound("unknown"), HelperError(-32601, "method_not_found", "unknown method unknown"))
        XCTAssertEqual(HelperError.refused("Passwords"), HelperError(2, "target_refused", "refused: target is Passwords"))
        XCTAssertEqual(HelperError.paused(.escape), HelperError(4, "paused", "paused by the user (escape); resume first"))
        XCTAssertEqual(HelperError.lockBusy("chat A"), HelperError(5, "lock_busy", "the desktop is in use by chat A"))
        XCTAssertEqual(HelperError.notControlling.code, 3)
        XCTAssertEqual(HelperError.aborted.code, 6)
        XCTAssertEqual(HelperError.unauthorized.code, 7)
    }

    func testDesktopLockHandlesRepeatedAcquireReleaseAndMissingParent() {
        let path = NSTemporaryDirectory() + "mopilot-lock-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let lock = DesktopLock(path: path)
        XCTAssertFalse(lock.isHeld)
        lock.release()
        XCTAssertNil(lock.tryAcquire(holder: "chat A"))
        XCTAssertNil(lock.tryAcquire(holder: "chat A"))
        lock.release()
        lock.release()
        XCTAssertFalse(lock.isHeld)
        XCTAssertNotNil(DesktopLock(path: path + "/missing/lock").tryAcquire(holder: "chat B"))
    }

    func testElementJSONIncludesConfidenceOnlyWhenKnown() {
        let frame = CGRect(x: 10, y: 20, width: 30, height: 40)
        let plain = UIElement(id: "ax:1", text: "Save", role: "AXButton", frame: frame, source: "ax")
        XCTAssertNil(plain.json["confidence"])
        XCTAssertEqual(plain.json["id"] as? String, "ax:1")
        XCTAssertEqual(plain.json["frame"] as? [String: Double], ["x": 10, "y": 20, "w": 30, "h": 40])
        let ocr = UIElement(id: "ocr:1", text: "Save", role: "text", frame: frame, source: "ocr", confidence: 0.75)
        XCTAssertEqual(ocr.json["confidence"] as? Double, 0.75)
    }

    func testFlattenTraversesUnframedParentsAndUsesDescriptionThenHelp() {
        let tree: [String: Any] = ["children": [
            ["id": "1", "description": "Described", "frame": ["w": 20.0, "h": 10.0]],
            ["id": "2", "help": "Help text", "frame": ["x": 5.0, "y": 7.0, "w": 20.0, "h": 10.0]],
            ["id": "3", "title": "", "value": 42, "frame": ["w": 20.0, "h": 10.0]],
        ]]
        let elements = flattenAX(tree)
        XCTAssertEqual(elements.map(\.text), ["Described", "Help text"])
        XCTAssertEqual(elements[0].frame, CGRect(x: 0, y: 0, width: 20, height: 10))
        XCTAssertEqual(flattenAX([:]), [])
    }

    func testMergeSortsSameRowLeftToRightAndClampsNonpositiveLimit() {
        let right = UIElement(id: "r", text: "Right", role: "text", frame: CGRect(x: 40, y: 10, width: 10, height: 10), source: "ocr")
        let left = UIElement(id: "l", text: "Left", role: "text", frame: CGRect(x: 10, y: 10, width: 10, height: 10), source: "ocr")
        let (all, truncated) = mergeElements(ax: [], ocr: [right, left])
        XCTAssertEqual(all.map(\.id), ["l", "r"])
        XCTAssertFalse(truncated)
        let (limited, cut) = mergeElements(ax: [], ocr: [right, left], limit: 0)
        XCTAssertEqual(limited.map(\.id), ["l"])
        XCTAssertTrue(cut)
    }

    func testKeyAliasesAndWhitespaceCombineFlagsWithoutDuplication() {
        XCTAssertEqual(parseKeyCombo(" control + option + shift + command + fn +a"),
                       KeyCombo(keyCode: 0, flags: 0x40000 | 0x80000 | 0x20000 | 0x100000 | 0x800000))
        XCTAssertEqual(parseKeyCombo("cmd+command+a"), KeyCombo(keyCode: 0, flags: 0x100000))
        XCTAssertNil(parseKeyCombo(""))
        XCTAssertNil(parseKeyCombo("+a"))
    }

    func testSpeechLocaleIgnoresWhitespaceAndCaseForLanguageSelection() {
        XCTAssertEqual(speechLocaleIdentifier(language: " AUTO ", system: "de_DE"), "de-DE")
        XCTAssertEqual(speechLocaleIdentifier(language: " ", system: "de_DE"), "de-DE")
        XCTAssertEqual(speechLocaleIdentifier(language: " FR ", system: "de_DE"), "fr-FR")
        XCTAssertEqual(speechLocaleIdentifier(language: "pt_BR", system: "de_DE"), "pt-BR")
    }

    func testAutoSpeechLocalePicksTheFirstSupportedOfTheUsersLanguages() {
        let supported: Set<String> = ["en_US", "en-GB", "zh_CN", "zh-TW", "fr-FR", "fr-CA"]
        // region keywords and underscores still match exactly
        XCTAssertEqual(speechLocaleIdentifier(language: "auto", system: "en_GB@rg=gbzzzz", preferred: [], supported: supported), "en-GB")
        // the user's languages come before the system locale; a script-tagged language finds its usual region
        XCTAssertEqual(autoSpeechLocale(preferred: ["zh-Hans-US", "en-US"], system: "en_US", supported: supported), "zh-CN")
        // an unsupported region falls back to another region of the same language
        XCTAssertEqual(autoSpeechLocale(preferred: ["fr-BE"], system: "xx", supported: supported), "fr-FR")
        XCTAssertEqual(autoSpeechLocale(preferred: ["en-IN"], system: "xx", supported: ["en-AU", "en-GB"]), "en-AU")
        // nothing supported: en-US
        XCTAssertEqual(autoSpeechLocale(preferred: ["xx-YY", ""], system: "", supported: supported), "en-US")
        XCTAssertEqual(plainLocale("@rg=gbzzzz"), "")
    }
}
