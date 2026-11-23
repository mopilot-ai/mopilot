import CoreGraphics
import Foundation
import XCTest
@testable import HelperCore

final class DenyListTests: XCTestCase {
    let deny = DenyList()

    func testBuiltInsAreDenied() {
        XCTAssertEqual(deny.rule(for: "ai.mopilot.code")?.reason, "MoPilot")
        XCTAssertEqual(deny.rule(for: "ai.mopilot.code.computer-use")?.reason, "MoPilot")
        XCTAssertEqual(deny.rule(for: "com.apple.systempreferences")?.reason, "System Settings")
        XCTAssertEqual(deny.rule(for: "com.apple.keychainaccess")?.reason, "Keychain Access")
        XCTAssertEqual(deny.rule(for: "com.apple.Passwords")?.reason, "Passwords")
        XCTAssertEqual(deny.rule(for: "com.1password.1password")?.reason, "password manager")
        XCTAssertEqual(deny.rule(for: "com.apple.SecurityAgent")?.reason, "authentication prompt")
        // macOS's permission prompts: a click there could grant (or revoke) a privacy permission
        XCTAssertEqual(deny.rule(for: "com.apple.tcc.AuthorizationPromptService")?.reason, "permission prompt")
        XCTAssertEqual(deny.rule(for: "com.apple.UserNotificationCenter")?.reason, "permission prompt")
    }

    func testMatchingIsCaseInsensitiveAndPrefixesNeedADot() {
        XCTAssertNotNil(deny.rule(for: "COM.APPLE.KEYCHAINACCESS"))
        XCTAssertNil(deny.rule(for: "ai.mopilot.codex"))
        XCTAssertNil(deny.rule(for: "com.1passwordx"))
        XCTAssertNil(deny.rule(for: "com.apple.TextEdit"))
        XCTAssertNil(deny.rule(for: nil))
        XCTAssertNil(deny.rule(for: ""))
    }

    func testExtraIdsAddButNeverRemove() {
        let d = DenyList(extra: ["com.example.bank", "com.example.trading.*", "com.apple.keychainaccess", ""])
        XCTAssertNotNil(d.rule(for: "com.example.bank"))
        XCTAssertNotNil(d.rule(for: "com.example.trading.pro"))
        XCTAssertTrue(d.isHiddenFromCapture("com.example.bank"))
        XCTAssertEqual(d.rule(for: "com.apple.keychainaccess")?.reason, "Keychain Access")
        XCTAssertEqual(d.rules.count, DenyList.builtIn.count + 2)
    }

    func testCaptureHiding() {
        XCTAssertTrue(deny.isHiddenFromCapture("ai.mopilot.code"))
        XCTAssertTrue(deny.isHiddenFromCapture("com.bitwarden.desktop"))
        XCTAssertFalse(deny.isHiddenFromCapture("com.apple.systempreferences"))
        XCTAssertFalse(deny.isHiddenFromCapture("com.apple.Safari"))
    }
}

final class TargetPolicyTests: XCTestCase {
    let policy = TargetPolicy(protectedPids: [100, 200], denyList: DenyList())

    func testAllowsOrdinaryApps() {
        XCTAssertEqual(policy.check([Target(pid: 300, bundleId: "com.apple.TextEdit")]), .allowed)
        XCTAssertEqual(policy.check([Target(pid: 300, bundleId: nil)]), .allowed)
    }

    func testRefusesMainAndHelperByPidWhateverTheBundleId() {
        // A dev build of MoPilot runs as com.github.Electron.
        XCTAssertEqual(policy.check([Target(pid: 100, bundleId: "com.github.Electron")]), .refused("MoPilot"))
        XCTAssertEqual(policy.check([Target(pid: 200, bundleId: nil)]), .refused("MoPilot"))
    }

    func testRefusesDeniedBundles() {
        XCTAssertEqual(policy.check([Target(pid: 300, bundleId: "com.apple.keychainaccess")]), .refused("Keychain Access"))
    }

    func testEveryCandidateMustPass() {
        let ok = Target(pid: 300, bundleId: "com.apple.TextEdit")
        let bad = Target(pid: 301, bundleId: "com.apple.systempreferences")
        XCTAssertEqual(policy.check([ok, bad]), .refused("System Settings"))
        XCTAssertEqual(policy.check([bad, ok]), .refused("System Settings"))
    }

    func testUnknownTargetsAreRefused() {
        XCTAssertEqual(policy.check([]), .refused("target unknown"))
        XCTAssertEqual(policy.check([Target(pid: nil, bundleId: "com.apple.TextEdit")]), .refused("target unknown"))
        XCTAssertEqual(policy.check([Target(pid: 0, bundleId: nil)]), .refused("target unknown"))
    }

    func testRestrictToGrantedApps() {
        let notes = Target(pid: 300, bundleId: "com.apple.Notes", name: "Notes")
        let mail = Target(pid: 301, bundleId: "com.apple.mail", name: "Mail")
        XCTAssertEqual(restrict([notes, mail], to: nil), .allowed)
        XCTAssertEqual(restrict([notes], to: ["COM.APPLE.NOTES"]), .allowed)
        XCTAssertEqual(restrict([notes, mail], to: ["com.apple.Notes"]), .refused("not approved (Mail)"))
        XCTAssertEqual(restrict([Target(pid: 302, bundleId: nil)], to: ["com.apple.Notes"]), .refused("not approved (unknown)"))
        XCTAssertEqual(restrict([], to: ["com.apple.Notes"]), .refused("target unknown"))
    }
}

final class PeerCheckTests: XCTestCase {
    func testPidFromAuditToken() {
        XCTAssertEqual(pidFromAuditToken([0, 501, 501, 501, 501, 4242, 100, 7]), 4242)
        XCTAssertNil(pidFromAuditToken([1, 2, 3]))
    }

    func testAcceptsOnlyTheRegisteredPid() {
        XCTAssertEqual(checkPeer(tokenPid: 4242, peerPid: 4242, expectedPid: 4242, busy: false), .accept)
        XCTAssertEqual(checkPeer(tokenPid: 4242, peerPid: nil, expectedPid: 4242, busy: false), .accept)
        XCTAssertEqual(checkPeer(tokenPid: 999, peerPid: 999, expectedPid: 4242, busy: false), .reject("pid 999 is not the registered main pid"))
    }

    func testRejectsMissingTokenMismatchAndSecondConnection() {
        XCTAssertEqual(checkPeer(tokenPid: nil, peerPid: 4242, expectedPid: 4242, busy: false), .reject("no audit token"))
        XCTAssertEqual(checkPeer(tokenPid: 4242, peerPid: 4243, expectedPid: 4242, busy: false), .reject("peer pid mismatch"))
        XCTAssertEqual(checkPeer(tokenPid: 4242, peerPid: 4242, expectedPid: 4242, busy: true), .reject("another connection is active"))
    }

    func testTokens() {
        XCTAssertTrue(tokensEqual("abc123", "abc123"))
        XCTAssertFalse(tokensEqual("abc123", "abc124"))
        XCTAssertFalse(tokensEqual("abc123", "abc1234"))
        XCTAssertFalse(tokensEqual("", ""))
    }
}

final class InputGuardTests: XCTestCase {
    func testClassification() {
        XCTAssertEqual(classifyInput(userData: ownEventMarker, sourceStateID: hidSystemStateID), .own)
        XCTAssertEqual(classifyInput(userData: 0, sourceStateID: hidSystemStateID), .physical)
        XCTAssertEqual(classifyInput(userData: 0, sourceStateID: 0), .synthetic)
        XCTAssertEqual(classifyInput(userData: 0, sourceStateID: 12345), .synthetic)
    }

    func testPhysicalEscAbortsAndIsSwallowedWhileActive() {
        XCTAssertEqual(guardDecision(.escape, origin: .physical, active: true), GuardDecision(pause: .escape, swallow: true))
        XCTAssertEqual(guardDecision(.escape, origin: .physical, active: false), GuardDecision(pause: nil, swallow: false))
    }

    func testPhysicalInputTakesOver() {
        XCTAssertEqual(guardDecision(.mouse, origin: .physical, active: true), GuardDecision(pause: .takeover, swallow: false))
        XCTAssertEqual(guardDecision(.key, origin: .physical, active: true), GuardDecision(pause: .takeover, swallow: false))
    }

    func testInputOnMoPilotsOwnPanelNeverTakesOver() {
        let takeover = guardDecision(.mouse, origin: .physical, active: true)
        var asked = 0
        XCTAssertEqual(sparingMoPilot(takeover) { asked += 1; return true }, GuardDecision(pause: nil, swallow: false))
        XCTAssertEqual(sparingMoPilot(takeover) { asked += 1; return false }, takeover)
        XCTAssertEqual(asked, 2)
        // Esc still stops, and nothing is asked for an event that pauses nothing
        let esc = guardDecision(.escape, origin: .physical, active: true)
        XCTAssertEqual(sparingMoPilot(esc) { asked += 1; return true }, esc)
        let idle = guardDecision(.key, origin: .physical, active: false)
        XCTAssertEqual(sparingMoPilot(idle) { asked += 1; return true }, idle)
        XCTAssertEqual(asked, 2)
    }

    func testOwnAndSyntheticInputIsIgnored() {
        for origin in [InputOrigin.own, .synthetic] {
            for ev in [GuardEvent.escape, .key, .mouse] {
                XCTAssertEqual(guardDecision(ev, origin: origin, active: true), GuardDecision(pause: nil, swallow: false))
            }
        }
    }
}

final class SupportTests: XCTestCase {
    func testCaptureSize() {
        XCTAssertTrue(captureSize(widthPoints: 1512, heightPoints: 982, scale: 2) == (2000, 1299))
        XCTAssertTrue(captureSize(widthPoints: 982, heightPoints: 1512, scale: 2) == (1299, 2000))
        XCTAssertTrue(captureSize(widthPoints: 1280, heightPoints: 800, scale: 1) == (1280, 800))
        XCTAssertTrue(captureSize(widthPoints: 1280, heightPoints: 800, scale: 1, maxSide: 640) == (640, 400))
    }

    func testKeyCombos() {
        XCTAssertEqual(parseKeyCombo("Return"), KeyCombo(keyCode: 36, flags: 0))
        XCTAssertEqual(parseKeyCombo("cmd+shift+t"), KeyCombo(keyCode: 17, flags: 0x100000 | 0x20000))
        XCTAssertEqual(parseKeyCombo("escape")?.keyCode, escapeKeyCode)
        XCTAssertNil(parseKeyCombo("hyper+a"))
        XCTAssertNil(parseKeyCombo("cmd+"))
        XCTAssertNil(parseKeyCombo("nosuchkey"))
    }

    func testSettingsURLs() {
        XCTAssertEqual(Permission.screenRecording.settingsURL, "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        XCTAssertEqual(Permission.accessibility.settingsURL, "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    func testLaunchConfigValidation() throws {
        let token = String(repeating: "a", count: 64)
        let ok = try LaunchConfig.parse(Data(#"{"socket":"/tmp/x.sock","token":"\#(token)","mainPid":4242}"#.utf8))
        XCTAssertEqual(ok.mainPid, 4242)
        XCTAssertThrowsError(try LaunchConfig.parse(Data(#"{"socket":"rel.sock","token":"\#(token)","mainPid":4242}"#.utf8)))
        XCTAssertThrowsError(try LaunchConfig.parse(Data(#"{"socket":"/tmp/x.sock","token":"short","mainPid":4242}"#.utf8)))
        XCTAssertThrowsError(try LaunchConfig.parse(Data(#"{"socket":"/tmp/x.sock","token":"\#(token)","mainPid":1}"#.utf8)))
        let long = "/" + String(repeating: "d", count: 110)
        XCTAssertThrowsError(try LaunchConfig.parse(Data(#"{"socket":"\#(long)","token":"\#(token)","mainPid":4242}"#.utf8)))
    }

    func testDesktopLockIsExclusiveAcrossOpenFiles() throws {
        let path = NSTemporaryDirectory() + "mpc-lock-test-\(UUID().uuidString)"
        defer { try? FileManager.default.removeItem(atPath: path) }
        let a = DesktopLock(path: path), b = DesktopLock(path: path)
        XCTAssertNil(a.tryAcquire(holder: "chat A"))
        XCTAssertTrue(a.isHeld)
        let busy = b.tryAcquire(holder: "chat B")
        XCTAssertNotNil(busy)
        XCTAssertTrue(busy!.contains("chat A"))
        a.release()
        XCTAssertNil(b.tryAcquire(holder: "chat B"))
        b.release()
    }
}

final class SpeechTests: XCTestCase {
    func testLocaleFromLanguageSetting() {
        XCTAssertEqual(speechLocaleIdentifier(language: "en", system: "fr_FR"), "en-US")
        XCTAssertEqual(speechLocaleIdentifier(language: "zh", system: "en_US"), "zh-CN")
        XCTAssertEqual(speechLocaleIdentifier(language: "en_GB", system: "en_US"), "en-GB")
        XCTAssertEqual(speechLocaleIdentifier(language: "auto", system: "de_DE"), "de-DE")
        XCTAssertEqual(speechLocaleIdentifier(language: nil, system: "de_DE@rg=atzzzz"), "de-DE")
        XCTAssertEqual(speechLocaleIdentifier(language: "xx", system: "de_DE"), "de_DE")
    }

    func testAudioDecoding() {
        XCTAssertEqual(decodeSpeechAudio(Data([1, 2, 3]).base64EncodedString()), Data([1, 2, 3]))
        XCTAssertNil(decodeSpeechAudio(""))
        XCTAssertNil(decodeSpeechAudio("not base64!"))
        XCTAssertNil(decodeSpeechAudio(nil))
    }
}

final class ForeignEventTests: XCTestCase {
    func testMoPilotIsOwnPidsAndItsBundles() {
        let p = TargetPolicy(protectedPids: [100, 200], denyList: DenyList())
        XCTAssertTrue(p.isMoPilot(Target(pid: 100, bundleId: "com.github.Electron")))
        XCTAssertTrue(p.isMoPilot(Target(pid: 5, bundleId: "ai.mopilot.code")))
        XCTAssertFalse(p.isMoPilot(Target(pid: 5, bundleId: "com.apple.systempreferences")))
        XCTAssertFalse(p.isMoPilot(Target(pid: 5, bundleId: nil)))
    }

    func testAssistiveAllowlist() {
        XCTAssertTrue(isAssistiveBundle("com.apple.VoiceOver"))
        XCTAssertTrue(isAssistiveBundle("com.apple.universalaccessd"))
        XCTAssertTrue(isAssistiveBundle("com.apple.accessibility.heard"))
        XCTAssertFalse(isAssistiveBundle("com.apple.accessibilityfake"))
        XCTAssertFalse(isAssistiveBundle("com.example.Automator"))
        XCTAssertFalse(isAssistiveBundle(nil))
    }

    func testDropOnlySyntheticForeignEventsLandingOnMoPilot() {
        func drop(origin: InputOrigin = .synthetic, pid: Int64 = 300, lands: Bool = true, mopilot: Bool = false, assistive: Bool = false) -> Bool {
            dropForeignEvent(origin: origin, sourcePid: pid, landsOnMoPilot: lands, sourceIsMoPilot: mopilot, sourceIsAssistive: assistive)
        }
        // another app's click or key on a MoPilot window (an approval card, a menu): dropped whether or
        // not a controller holds the desktop
        XCTAssertTrue(drop())
        XCTAssertFalse(drop(pid: 0))
        XCTAssertFalse(drop(lands: false))
        XCTAssertFalse(drop(assistive: true))
        XCTAssertFalse(drop(mopilot: true))
        // a person's input (the HID system state), even with a source pid, and the helper's own: never dropped
        XCTAssertFalse(drop(origin: .physical))
        XCTAssertFalse(drop(origin: .own))
    }

    func testForeignLookupOnlyWhenADropIsPossible() {
        XCTAssertTrue(mayDropForeignEvent(origin: .synthetic, sourcePid: 300))
        XCTAssertFalse(mayDropForeignEvent(origin: .physical, sourcePid: 300))
        XCTAssertFalse(mayDropForeignEvent(origin: .own, sourcePid: 300))
        XCTAssertFalse(mayDropForeignEvent(origin: .synthetic, sourcePid: 0))
    }

    /// A person's keys and clicks always go through; the only one swallowed is Esc while a controller is in control.
    func testPhysicalInputIsNeverDroppedExceptEscDuringControl() {
        for pid: Int64 in [0, 1, 300] {
            for lands in [true, false] {
                XCTAssertFalse(dropForeignEvent(origin: .physical, sourcePid: pid, landsOnMoPilot: lands, sourceIsMoPilot: false, sourceIsAssistive: false))
            }
        }
        for active in [true, false] {
            for ev in [GuardEvent.key, .mouse] { XCTAssertFalse(guardDecision(ev, origin: .physical, active: active).swallow) }
        }
        XCTAssertFalse(guardDecision(.escape, origin: .physical, active: false).swallow)
        XCTAssertTrue(guardDecision(.escape, origin: .physical, active: true).swallow)
    }
}

final class GuardTapLifecycleTests: XCTestCase {
    final class Handle {}

    final class Fake {
        var created = 0, destroyed = 0, enabled = 0
        var allow = true
        var live: Handle?
        lazy var tap = GuardTapLifecycle(
            create: { [unowned self] in
                guard self.allow else { return nil }
                self.created += 1
                let h = Handle()
                self.live = h
                return h
            },
            destroy: { [unowned self] h in
                XCTAssertTrue(h === self.live)
                self.destroyed += 1
                self.live = nil
            },
            enable: { [unowned self] h in
                XCTAssertTrue(h === self.live)
                self.enabled += 1
            }
        )
    }

    func testInstallIsIdempotentAndRemovalIsClean() {
        let f = Fake()
        XCTAssertFalse(f.tap.installed)
        XCTAssertTrue(f.tap.install())
        XCTAssertTrue(f.tap.installed)
        XCTAssertTrue(f.tap.install())
        XCTAssertEqual(f.created, 1)
        // the helper exits: the tap and its source go, once
        f.tap.uninstall()
        XCTAssertFalse(f.tap.installed)
        XCTAssertEqual(f.destroyed, 1)
        f.tap.uninstall()
        XCTAssertEqual(f.destroyed, 1)
        XCTAssertNil(f.live)
        // a new tap after that is a fresh one
        XCTAssertTrue(f.tap.install())
        XCTAssertEqual(f.created, 2)
    }

    func testNoAccessibilityMeansNoTapUntilItIsGranted() {
        let f = Fake()
        f.allow = false
        XCTAssertFalse(f.tap.install())
        XCTAssertFalse(f.tap.installed)
        f.tap.uninstall()
        XCTAssertEqual(f.destroyed, 0)
        f.allow = true
        XCTAssertTrue(f.tap.install())
        XCTAssertTrue(f.tap.installed)
    }

    func testDisabledTapIsReenabledOnlyWhileItIsOurs() {
        let f = Fake()
        f.tap.reenable()
        XCTAssertEqual(f.enabled, 0)
        f.tap.install()
        f.tap.reenable()
        XCTAssertEqual(f.enabled, 1)
        f.tap.uninstall()
        f.tap.reenable()
        XCTAssertEqual(f.enabled, 1)
    }

    func testTapDisabledNotices() {
        XCTAssertTrue(isTapDisabledNotice(0xFFFF_FFFE))
        XCTAssertTrue(isTapDisabledNotice(0xFFFF_FFFF))
        XCTAssertFalse(isTapDisabledNotice(10)) // keyDown
        XCTAssertFalse(isTapDisabledNotice(1)) // leftMouseDown
        XCTAssertEqual(CGEventType.tapDisabledByTimeout.rawValue, tapDisabledByTimeoutType)
        XCTAssertEqual(CGEventType.tapDisabledByUserInput.rawValue, tapDisabledByUserInputType)
    }
}

final class ElementTests: XCTestCase {
    func testFlattenKeepsTextAndActionableNodes() {
        let tree: [String: Any] = [
            "id": "0", "role": "AXApplication", "title": "Notes",
            "children": [
                ["id": "0.0", "role": "AXButton", "frame": ["x": 10.0, "y": 10.0, "w": 20.0, "h": 20.0]],
                ["id": "0.1", "role": "AXStaticText", "value": "Hello", "frame": ["x": 0.0, "y": 40.0, "w": 50.0, "h": 12.0]],
                ["id": "0.2", "role": "AXGroup", "frame": ["x": 0.0, "y": 0.0, "w": 100.0, "h": 100.0]],
                ["id": "0.3", "role": "AXStaticText", "value": "Zero size", "frame": ["x": 0.0, "y": 0.0, "w": 0.0, "h": 5.0]],
            ],
        ]
        let els = flattenAX(tree)
        XCTAssertEqual(els.map(\.id), ["ax:0.0", "ax:0.1"])
        XCTAssertEqual(els[1].text, "Hello")
        XCTAssertEqual(els[1].frame, CGRect(x: 0, y: 40, width: 50, height: 12))
    }

    func testVisionRectFlipsAndScales() {
        // the top-left quarter of a 2000x1000 image of a 1000x500pt display at (100, 50)
        let r = visionRectToPoints(CGRect(x: 0, y: 0.5, width: 0.5, height: 0.5), imageWidth: 2000, imageHeight: 1000,
                                   origin: CGPoint(x: 100, y: 50), pixelsPerPoint: 2)
        XCTAssertEqual(r, CGRect(x: 100, y: 50, width: 500, height: 250))
    }

    func testMergeDropsOcrLinesTheTreeHasAndOrdersTheRest() {
        let ax = [UIElement(id: "ax:0.1", text: "Save", role: "AXButton", frame: CGRect(x: 10, y: 10, width: 40, height: 20), source: "ax")]
        let ocr = [
            UIElement(id: "ocr:0", text: "Later", role: "text", frame: CGRect(x: 10, y: 200, width: 40, height: 10), source: "ocr", confidence: 0.9),
            UIElement(id: "ocr:1", text: "save", role: "text", frame: CGRect(x: 12, y: 12, width: 30, height: 14), source: "ocr", confidence: 0.9),
            UIElement(id: "ocr:2", text: "Save", role: "text", frame: CGRect(x: 300, y: 12, width: 30, height: 14), source: "ocr", confidence: 0.9),
            UIElement(id: "ocr:3", text: "  ", role: "text", frame: CGRect(x: 0, y: 0, width: 5, height: 5), source: "ocr"),
        ]
        let (els, truncated) = mergeElements(ax: ax, ocr: ocr)
        XCTAssertEqual(els.map(\.id), ["ax:0.1", "ocr:2", "ocr:0"])
        XCTAssertFalse(truncated)
    }

    func testMergeLimit() {
        let ocr = (0..<5).map { UIElement(id: "ocr:\($0)", text: "w\($0)", role: "text", frame: CGRect(x: 0, y: Double($0) * 20, width: 10, height: 10), source: "ocr") }
        let (els, truncated) = mergeElements(ax: [], ocr: ocr, limit: 3)
        XCTAssertEqual(els.count, 3)
        XCTAssertTrue(truncated)
    }
}

final class GlowTests: XCTestCase {
    func w(_ pid: Int32, _ rect: CGRect, layer: Int = 0, alpha: Double = 1) -> WindowInfo { WindowInfo(pid: pid, layer: layer, alpha: alpha, bounds: rect) }

    func testFollowsTheTopmostOrdinaryWindowOfThePid() {
        let list = [
            w(7, CGRect(x: 0, y: 0, width: 20, height: 20)),  // a tooltip
            w(7, CGRect(x: 0, y: 0, width: 400, height: 300), layer: 25),  // a menu bar extra
            w(9, CGRect(x: 5, y: 5, width: 500, height: 500)),
            w(7, CGRect(x: 100, y: 120, width: 800, height: 600)),
            w(7, CGRect(x: 0, y: 0, width: 300, height: 300)),
        ]
        XCTAssertEqual(Glow.targetFrame(list, pid: 7), CGRect(x: 100, y: 120, width: 800, height: 600))
        XCTAssertNil(Glow.targetFrame(list, pid: 8))
        XCTAssertNil(Glow.targetFrame([w(7, CGRect(x: 0, y: 0, width: 400, height: 400), alpha: 0)], pid: 7))
    }

    func testOverlayFrameFlipsToAppKitCoordinatesAndReachesPastTheEdge() {
        let f = Glow.overlayFrame(window: CGRect(x: 100, y: 120, width: 800, height: 600), primaryHeight: 1000)
        XCTAssertEqual(f, CGRect(x: 90, y: 270, width: 820, height: 620))
    }
}
