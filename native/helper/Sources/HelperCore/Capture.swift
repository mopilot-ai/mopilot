import Foundation

// MARK: - Capture retries

/// ScreenCaptureKit's error domain (SCStreamErrorDomain), spelled out so this stays free of the framework.
public let screenCaptureErrorDomain = "com.apple.ScreenCaptureKit.SCStreamErrorDomain"

/// Thrown by a capture when none of the apps it should show has a window on screen. A filter that
/// includes no app makes `SCScreenshotManager` fail with "Failed to start stream due to audio/video
/// capture failure" (-3811), so the capture checks first. Common for a moment while an app launches,
/// opens or closes a window or sheet, or while another Space is in front.
public struct NoWindowsToCapture: Error, Equatable {
    public init() {}
}

/// What a failed capture attempt calls for.
public enum CaptureFailure: Equatable {
    /// Screen Recording is off or the helper lacks the entitlement: retrying can't help.
    case permission
    /// A ScreenCaptureKit hiccup (the window list changed under the filter, the stream failed to start,
    /// the capture service connection dropped): refresh the shareable content and try again.
    case transient
    /// None of the requested apps has a window on screen yet.
    case noWindows
    /// Anything else (bad parameters, encoding): reported as is.
    case other
}

/// Sorts a capture error. SCStreamError userDeclined (-3801) and missingEntitlements (-3803) are
/// permission problems; every other ScreenCaptureKit error is treated as transient.
public func classifyCaptureError(_ error: Error) -> CaptureFailure {
    if error is NoWindowsToCapture { return .noWindows }
    if error is HelperError { return .other }
    let e = error as NSError
    guard e.domain == screenCaptureErrorDomain else { return .other }
    return e.code == -3801 || e.code == -3803 ? .permission : .transient
}

/// How long a capture waits before each retry, in milliseconds. A transient error is retried once; an
/// empty window set is retried for about a second, long enough for a window or sheet to come on screen.
public struct CaptureRetryPolicy: Equatable {
    public var transientDelaysMs: [Int]
    public var noWindowsDelaysMs: [Int]

    public init(transientDelaysMs: [Int] = [150], noWindowsDelaysMs: [Int] = [150, 300, 500]) {
        self.transientDelaysMs = transientDelaysMs
        self.noWindowsDelaysMs = noWindowsDelaysMs
    }
}

/// The error a capture reports once its retries are spent: stable reasons main turns into advice.
public func finalCaptureError(_ error: Error) -> Error {
    switch classifyCaptureError(error) {
    case .noWindows:
        return HelperError(9, "no_windows", "none of the requested apps has a window on screen")
    case .permission:
        return HelperError.permission(.screenRecording)
    case .transient:
        let e = error as NSError
        return HelperError(10, "capture_failed", "screen capture failed again after a retry: \(e.localizedDescription) (\(e.domain) \(e.code))")
    case .other:
        return error
    }
}

/// Runs `attempt` (which fetches fresh shareable content each time) until it succeeds, retrying
/// transient ScreenCaptureKit errors and an empty window set as `policy` allows. Once the retries are
/// spent, throws `finalCaptureError` of the last failure.
public func retryingCapture<T>(_ policy: CaptureRetryPolicy = CaptureRetryPolicy(),
                               sleep: (Int) async -> Void = { ms in try? await Task.sleep(nanoseconds: UInt64(max(ms, 0)) * 1_000_000) },
                               _ attempt: () async throws -> T) async throws -> T {
    func attemptFrom(transient: Int, empty: Int) async throws -> T {
        do {
            return try await attempt()
        } catch {
            var delay: Int?
            var transient = transient, empty = empty
            switch classifyCaptureError(error) {
            case .transient:
                delay = policy.transientDelaysMs.dropFirst(transient).first
                transient += 1
            case .noWindows:
                delay = policy.noWindowsDelaysMs.dropFirst(empty).first
                empty += 1
            case .permission, .other:
                delay = nil
            }
            guard let delay else { throw finalCaptureError(error) }
            await sleep(delay)
            return try await attemptFrom(transient: transient, empty: empty)
        }
    }
    return try await attemptFrom(transient: 0, empty: 0)
}

// MARK: - Activation settle

/// Whether `pid` has a normal-level window (layer 0, not fully transparent) in an on-screen window list:
/// an app just brought forward is ready to be captured once it does.
public func hasOnScreenWindow(_ windows: [HitWindow], pid: Int32) -> Bool {
    windows.contains { $0.pid == pid && $0.layer == 0 && $0.alpha > 0 && $0.bounds.width > 1 && $0.bounds.height > 1 }
}
