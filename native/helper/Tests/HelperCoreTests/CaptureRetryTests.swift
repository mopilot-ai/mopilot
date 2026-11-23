import CoreGraphics
import Foundation
import XCTest
@testable import HelperCore

/// Screenshot retries (screenshot, ocr.elements): a transient ScreenCaptureKit failure or an empty
/// window set right after a window or sheet change is retried with fresh shareable content before an
/// error reaches main, and the error that does is one main can explain. None needs TCC.
final class CaptureRetryTests: XCTestCase {
    /// The error SCScreenshotManager gives for a filter that includes no app (observed on macOS).
    private let startFailure = NSError(domain: screenCaptureErrorDomain, code: -3811,
                                       userInfo: [NSLocalizedDescriptionKey: "Failed to start stream due to audio/video capture failure"])

    private final class Script {
        var outcomes: [Result<String, Error>]
        var attempts = 0
        var slept: [Int] = []
        init(_ outcomes: [Result<String, Error>]) { self.outcomes = outcomes }
        func next() throws -> String {
            attempts += 1
            return try outcomes.removeFirst().get()
        }
    }

    private func run(_ s: Script, _ policy: CaptureRetryPolicy = CaptureRetryPolicy()) async throws -> String {
        try await retryingCapture(policy, sleep: { s.slept.append($0) }) { try s.next() }
    }

    func testClassifiesCaptureErrors() {
        XCTAssertEqual(classifyCaptureError(NoWindowsToCapture()), .noWindows)
        XCTAssertEqual(classifyCaptureError(startFailure), .transient)
        XCTAssertEqual(classifyCaptureError(NSError(domain: screenCaptureErrorDomain, code: -3805)), .transient)
        XCTAssertEqual(classifyCaptureError(NSError(domain: screenCaptureErrorDomain, code: -3801)), .permission)
        XCTAssertEqual(classifyCaptureError(NSError(domain: screenCaptureErrorDomain, code: -3803)), .permission)
        XCTAssertEqual(classifyCaptureError(HelperError.invalidParams("region is off the display")), .other)
        XCTAssertEqual(classifyCaptureError(NSError(domain: NSCocoaErrorDomain, code: 1)), .other)
    }

    func testSucceedsFirstTimeWithoutWaiting() async throws {
        let s = Script([.success("shot")])
        let shot = try await run(s)
        XCTAssertEqual(shot, "shot")
        XCTAssertEqual(s.attempts, 1)
        XCTAssertEqual(s.slept, [])
    }

    func testRetriesATransientFailureOnceWithFreshContent() async throws {
        let s = Script([.failure(startFailure), .success("shot")])
        let shot = try await run(s)
        XCTAssertEqual(shot, "shot")
        XCTAssertEqual(s.attempts, 2)
        XCTAssertEqual(s.slept, [150])
    }

    func testReportsAFailureThatRepeatsAsCaptureFailed() async {
        let s = Script([.failure(startFailure), .failure(startFailure), .success("never")])
        do {
            _ = try await run(s)
            XCTFail("expected a failure")
        } catch let e as HelperError {
            XCTAssertEqual(e.code, 10)
            XCTAssertEqual(e.reason, "capture_failed")
            XCTAssertTrue(e.message.contains("Failed to start stream due to audio/video capture failure"), e.message)
            XCTAssertTrue(e.message.contains("-3811"), e.message)
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(s.attempts, 2, "a transient failure is retried once only")
    }

    func testWaitsAboutASecondForAWindowToComeOnScreen() async throws {
        let s = Script([.failure(NoWindowsToCapture()), .failure(NoWindowsToCapture()), .success("shot")])
        let shot = try await run(s)
        XCTAssertEqual(shot, "shot")
        XCTAssertEqual(s.slept, [150, 300])
    }

    func testReportsNoWindowsOnceTheWaitIsOver() async {
        let s = Script(Array(repeating: .failure(NoWindowsToCapture()), count: 5))
        do {
            _ = try await run(s)
            XCTFail("expected a failure")
        } catch let e as HelperError {
            XCTAssertEqual(e, HelperError(9, "no_windows", "none of the requested apps has a window on screen"))
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(s.attempts, 4)
        XCTAssertEqual(s.slept, [150, 300, 500])
    }

    func testTransientAndEmptyRetriesHaveSeparateBudgets() async throws {
        // a sheet closing: the window list changes under the filter, then the window is briefly gone
        let s = Script([.failure(startFailure), .failure(NoWindowsToCapture()), .success("shot")])
        let shot = try await run(s)
        XCTAssertEqual(shot, "shot")
        XCTAssertEqual(s.slept, [150, 150])
    }

    func testPermissionAndOtherErrorsAreNotRetried() async {
        let denied = Script([.failure(NSError(domain: screenCaptureErrorDomain, code: -3801)), .success("never")])
        do {
            _ = try await run(denied)
            XCTFail("expected a failure")
        } catch let e as HelperError {
            XCTAssertEqual(e, HelperError.permission(.screenRecording))
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(denied.attempts, 1)

        let bad = Script([.failure(HelperError.invalidParams("region is off the display")), .success("never")])
        do {
            _ = try await run(bad)
            XCTFail("expected a failure")
        } catch let e as HelperError {
            XCTAssertEqual(e, HelperError.invalidParams("region is off the display"))
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(bad.attempts, 1)
        XCTAssertEqual(bad.slept, [])
    }

    func testAPolicyWithoutRetriesReportsAtOnce() async {
        let s = Script([.failure(startFailure), .success("never")])
        do {
            _ = try await run(s, CaptureRetryPolicy(transientDelaysMs: [], noWindowsDelaysMs: []))
            XCTFail("expected a failure")
        } catch let e as HelperError {
            XCTAssertEqual(e.reason, "capture_failed")
        } catch {
            XCTFail("unexpected \(error)")
        }
        XCTAssertEqual(s.attempts, 1)
    }

    func testDefaultSleepWaits() async throws {
        var attempts = 0
        let started = Date()
        let shot: String = try await retryingCapture(CaptureRetryPolicy(transientDelaysMs: [20], noWindowsDelaysMs: [])) {
            attempts += 1
            if attempts == 1 { throw startFailure }
            return "shot"
        }
        XCTAssertEqual(shot, "shot")
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.015)
    }

    func testFinalCaptureErrorPassesOtherErrorsThrough() {
        let e = NSError(domain: NSCocoaErrorDomain, code: 7)
        XCTAssertEqual(finalCaptureError(e) as NSError, e)
    }

    // MARK: settle after activation

    func testAnAppIsReadyOnceItHasAVisibleNormalWindow() {
        func w(_ pid: Int32, layer: Int = 0, alpha: Double = 1, size: CGFloat = 400) -> HitWindow {
            HitWindow(pid: pid, layer: layer, alpha: alpha, bounds: CGRect(x: 0, y: 0, width: size, height: size), sharingState: 1, ownerIsSystem: false)
        }
        XCTAssertTrue(hasOnScreenWindow([w(2), w(3)], pid: 3))
        XCTAssertFalse(hasOnScreenWindow([], pid: 3))
        XCTAssertFalse(hasOnScreenWindow([w(2)], pid: 3), "another app's window")
        XCTAssertFalse(hasOnScreenWindow([w(3, layer: 25)], pid: 3), "a menu bar item is not a window to capture")
        XCTAssertFalse(hasOnScreenWindow([w(3, alpha: 0)], pid: 3), "a window still fading in")
        XCTAssertFalse(hasOnScreenWindow([w(3, size: 1)], pid: 3), "a placeholder window")
    }
}
