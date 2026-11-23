import CoreGraphics
import Foundation

// The pure parts of checking what a background action did, and of keeping its overhead low: a coarse
// pixel grid of the window and its diff, the before/after probe that decides confirmed / no_change /
// unverifiable, an adaptive settle that waits for the app to stop changing (up to a cap) instead of a
// fixed sleep, the checks that run before an event is dispatched (the window moved, or one of the app's
// own windows covers the point), and the batch runner that gates once for a whole list of actions.

// MARK: - Pixel grid

/// A window's pixels averaged into a small grayscale grid: cheap to capture and compare, coarse enough
/// that a blinking caret doesn't count as a change while a typed character or an opened panel does.
public struct PixelGrid: Equatable {
    public let columns: Int
    public let rows: Int
    public let values: [UInt8]

    public init(columns: Int, rows: Int, values: [UInt8]) {
        self.columns = max(0, columns)
        self.rows = max(0, rows)
        self.values = values
    }

    /// Box-averages a `width`×`height` grayscale buffer into `columns`×`rows` cells. Nil when the buffer
    /// doesn't hold that many pixels or a size is not positive.
    public static func downsample(gray: [UInt8], width: Int, height: Int, columns: Int = 32, rows: Int = 32) -> PixelGrid? {
        guard width > 0, height > 0, columns > 0, rows > 0, gray.count >= width * height else { return nil }
        let cols = min(columns, width), rws = min(rows, height)
        var out = [UInt8](repeating: 0, count: cols * rws)
        for r in 0..<rws {
            let y0 = r * height / rws, y1 = max(y0 + 1, (r + 1) * height / rws)
            for c in 0..<cols {
                let x0 = c * width / cols, x1 = max(x0 + 1, (c + 1) * width / cols)
                var sum = 0
                for y in y0..<y1 { for x in x0..<x1 { sum += Int(gray[y * width + x]) } }
                out[r * cols + c] = UInt8(sum / ((y1 - y0) * (x1 - x0)))
            }
        }
        return PixelGrid(columns: cols, rows: rws, values: out)
    }

    /// Cells that differ from `other` by more than `threshold` gray levels; nil when the grids aren't comparable.
    public func changedCells(_ other: PixelGrid, threshold: Int = 10) -> Int? {
        guard columns == other.columns, rows == other.rows, values.count == other.values.count, !values.isEmpty else { return nil }
        return zip(values, other.values).reduce(0) { n, p in abs(Int(p.0) - Int(p.1)) > threshold ? n + 1 : n }
    }

    /// A 64-bit fingerprint (FNV-1a over the grid quantized to 16 levels), reported as the screenshot hash.
    public var hash: UInt64 {
        var h: UInt64 = 0xcbf2_9ce4_8422_2325
        for v in values {
            h ^= UInt64(v >> 4)
            h = h &* 0x0000_0100_0000_01b3
        }
        return h
    }

    public var hashHex: String { String(format: "%016llx", hash) }
}

// MARK: - Before/after probe

/// What the helper can observe about the app before and after an action. Nil fields weren't observed.
public struct EffectProbe: Equatable {
    /// The app's listed windows.
    public var windows: [UInt32]
    /// The target window's bounds (global points).
    public var bounds: CGRect?
    /// The app's focused element (role, position and title as one string).
    public var focused: String?
    /// The targeted element's state (value, selection, enabled, title as one string).
    public var element: String?
    /// A sheet or dialog is attached to the target window.
    public var sheet: Bool?
    /// The target window's pixels.
    public var grid: PixelGrid?

    public init(windows: [UInt32], bounds: CGRect? = nil, focused: String? = nil, element: String? = nil, sheet: Bool? = nil, grid: PixelGrid? = nil) {
        self.windows = windows
        self.bounds = bounds
        self.focused = focused
        self.element = element
        self.sheet = sheet
        self.grid = grid
    }

    /// Everything but the pixels: what the settle loop polls (cheap accessibility and window-server reads).
    public var signature: String {
        let b = bounds.map { "\(Int($0.minX)),\(Int($0.minY)),\(Int($0.width)),\(Int($0.height))" } ?? "-"
        return [windows.map(String.init).joined(separator: ","), b, focused ?? "-", element ?? "-", sheet.map { $0 ? "1" : "0" } ?? "-"].joined(separator: "|")
    }
}

/// What an action was seen to do.
public enum ObservedEffect: String, Equatable {
    /// Something observable changed.
    case confirmed
    /// It was observable and nothing changed.
    case noChange = "no_change"
    /// Nothing could be observed (no pixels, no element state to compare).
    case unverifiable
}

public struct EffectVerdict: Equatable {
    public let effect: ObservedEffect
    /// What changed: window_opened, window_closed, sheet_appeared, sheet_closed, window_moved, focus_changed, value_changed, pixels_changed.
    public let evidence: [String]
    /// Grid cells that changed, when both grids were captured.
    public let changedCells: Int?

    public init(effect: ObservedEffect, evidence: [String], changedCells: Int?) {
        self.effect = effect
        self.evidence = evidence
        self.changedCells = changedCells
    }

    public var json: [String: Any] {
        var o: [String: Any] = ["effect": effect.rawValue, "evidence": evidence]
        if let changedCells { o["changedCells"] = changedCells }
        return o
    }
}

private func sameRect(_ a: CGRect, _ b: CGRect, _ tolerance: Double) -> Bool {
    abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
}

/// Compares the probes taken before and after an action. Any change confirms it; with pixels or the
/// element's state on both sides and nothing changed it is no_change; otherwise unverifiable.
public func verifyEffect(before: EffectProbe, after: EffectProbe, pixelThreshold: Int = 10, minCells: Int = 1) -> EffectVerdict {
    var evidence: [String] = []
    let was = Set(before.windows), now = Set(after.windows)
    if !now.subtracting(was).isEmpty { evidence.append("window_opened") }
    if !was.subtracting(now).isEmpty { evidence.append("window_closed") }
    if before.sheet == false, after.sheet == true { evidence.append("sheet_appeared") }
    if before.sheet == true, after.sheet == false { evidence.append("sheet_closed") }
    if let a = before.bounds, let b = after.bounds, !sameRect(a, b, 1) { evidence.append("window_moved") }
    if before.focused != after.focused, before.focused != nil || after.focused != nil { evidence.append("focus_changed") }
    if before.element != after.element, before.element != nil || after.element != nil { evidence.append("value_changed") }
    var cells: Int?
    if let a = before.grid, let b = after.grid, let n = a.changedCells(b, threshold: pixelThreshold) {
        cells = n
        if n >= max(1, minCells) { evidence.append("pixels_changed") }
    }
    if !evidence.isEmpty { return EffectVerdict(effect: .confirmed, evidence: evidence, changedCells: cells) }
    let observable = cells != nil || (before.element != nil && after.element != nil)
    return EffectVerdict(effect: observable ? .noChange : .unverifiable, evidence: [], changedCells: cells)
}

// MARK: - Adaptive settle

/// How long to wait for an app to finish reacting: at least `minMs`, until nothing changed for `quietMs`,
/// at most `capMs`, sampling every `intervalMs`.
public struct SettlePolicy: Equatable {
    public let minMs: Double
    public let quietMs: Double
    public let capMs: Double
    public let intervalMs: Double

    public init(minMs: Double, quietMs: Double, capMs: Double, intervalMs: Double = 25) {
        let floor = max(0, minMs)
        self.minMs = floor
        self.capMs = max(floor, capMs)
        self.quietMs = max(0, quietMs)
        self.intervalMs = max(1, intervalMs)
    }

    /// Accessibility actions are done when the call returns: a short quiet window is enough.
    public static func accessibility(capMs: Double = 600) -> SettlePolicy { SettlePolicy(minMs: 0, quietMs: 50, capMs: capMs) }
    /// Events posted to the app's process are handled asynchronously: give it a moment before trusting quiet.
    public static func posted(capMs: Double = 600) -> SettlePolicy { SettlePolicy(minMs: 100, quietMs: 75, capMs: capMs) }

    /// The policy a request names ("ax" or "pid"), capped at `capMs` (default 600, at most 3000).
    public static func forRoute(_ route: String, capMs: Double?) -> SettlePolicy {
        let cap = min(max(capMs ?? 600, 0), 3000)
        return route == "ax" ? accessibility(capMs: cap) : posted(capMs: cap)
    }
}

public struct SettleOutcome: Equatable {
    public let elapsedMs: Double
    /// The probe stopped changing (false: the cap was reached first).
    public let stable: Bool
    public let samples: Int

    public init(elapsedMs: Double, stable: Bool, samples: Int) {
        self.elapsedMs = elapsedMs
        self.stable = stable
        self.samples = samples
    }

    public var json: [String: Any] { ["settleMs": Int(elapsedMs.rounded()), "stable": stable] }
}

/// Polls `probe` until it has been unchanged for the policy's quiet window (and the minimum has passed),
/// or the cap is reached. `now` is milliseconds on any monotonic clock; `sleep` takes milliseconds.
public func settle<S: Equatable>(_ policy: SettlePolicy, now: () -> Double, sleep: (Double) -> Void, probe: () -> S) -> SettleOutcome {
    let start = now()
    var last = probe()
    var changedAt = start
    var samples = 1
    var t = start
    while t - start < policy.minMs || t - changedAt < policy.quietMs {
        if t - start >= policy.capMs { return SettleOutcome(elapsedMs: t - start, stable: false, samples: samples) }
        sleep(min(policy.intervalMs, policy.capMs - (t - start)))
        let s = probe()
        samples += 1
        if s != last {
            last = s
            changedAt = now()
        }
        t = now()
    }
    return SettleOutcome(elapsedMs: t - start, stable: true, samples: samples)
}

// MARK: - Before dispatch

/// The window compared with where it was when the model's coordinates were taken.
public enum BoundsCheck: Equatable {
    case same
    /// Moved without resizing: the point moves with it.
    case moved(dx: Double, dy: Double)
    /// Resized: coordinates of the old screenshot no longer hold.
    case resized
}

public func checkBounds(expected: CGRect?, current: CGRect, tolerance: Double = 2) -> BoundsCheck {
    guard let e = expected else { return .same }
    if abs(e.width - current.width) > tolerance || abs(e.height - current.height) > tolerance { return .resized }
    let dx = current.minX - e.minX, dy = current.minY - e.minY
    if abs(dx) <= tolerance && abs(dy) <= tolerance { return .same }
    return .moved(dx: dx, dy: dy)
}

/// What is in front of the target window at a point.
public enum Occlusion: Equatable {
    case clear
    /// Another window of the same app (a dialog, a sheet, another document) is there: a click would be
    /// swallowed by it or blocked by its modal session.
    case ownWindow(CGRect)
    /// Another app's window covers it: events posted to the app's process still reach the target.
    case otherApp(Int32)
}

/// Walks the on-screen list (front to back) at `p` down to the target window (`targetBounds` of `pid`).
/// Skips the helper's own and MoPilot's capture-excluded overlay windows (`ignore`), and windows
/// above the normal levels that aren't the app's (menus, the Dock, notifications).
public func occlusion(at p: CGPoint, pid: Int32, targetBounds: CGRect, stack: [HitWindow], ignore: Set<Int32> = []) -> Occlusion {
    for w in stack where w.alpha > 0 && w.bounds.contains(p) {
        if ignore.contains(w.pid) { continue }
        if w.pid == pid {
            if sameRect(w.bounds, targetBounds, 1) { return .clear }
            if w.layer == 0 { return .ownWindow(w.bounds) }
            continue
        }
        if w.layer >= mainMenuWindowLevel { continue }
        return .otherApp(w.pid)
    }
    return .clear
}

/// Whether the app's own window in front of the point (`cover`) blocks input to the target: a dialog, a
/// sheet or a panel does (a modal session swallows the click); another of its document windows
/// (`documentWindows`, the standard windows it lists) does not, since posted events name the target window.
public func blocksInput(cover: CGRect, documentWindows: [CGRect]) -> Bool {
    !documentWindows.contains { sameRect($0, cover, 1) }
}

extension HelperError {
    /// One of the app's own windows covers the point (checked before dispatch).
    public static let occluded = HelperError(15, "occluded", "another window of the app (a dialog or sheet) covers that point; take a new app_screenshot of the window in front, or use element_index (accessibility works behind it)")
    /// The window was resized since the screenshot the coordinates came from.
    public static let windowChanged = HelperError(16, "window_changed", "the window was resized since the latest app_screenshot; take a new one before acting by coordinate")
}

// MARK: - Batches

/// The steps of an app.batch request: each {method, params}, a known method, at most `max`.
public func batchSteps(_ raw: Any?, allowed: Set<String>, max: Int = 50) throws -> [(method: String, params: [String: Any])] {
    guard let list = raw as? [[String: Any]], !list.isEmpty, list.count <= max else { throw HelperError.invalidParams("steps: 1 to \(max) {method, params}") }
    return try list.enumerated().map { i, s in
        guard let m = s["method"] as? String, allowed.contains(m) else { throw HelperError.invalidParams("steps[\(i)].method") }
        return (m, s["params"] as? [String: Any] ?? [:])
    }
}

public struct BatchRun {
    public var results: [[String: Any]] = []
    /// The step that failed (or wasn't run because the batch was cancelled), if any.
    public var failedAt: Int?
    public var error: HelperError?
    /// How many times the request was gated (checked and its target resolved): once per batch.
    public var gates = 0

    public init() {}

    public var json: [String: Any] {
        var o: [String: Any] = ["results": results, "completed": results.count, "gates": gates]
        if let failedAt { o["failedAt"] = failedAt }
        if let error { o["error"] = ["code": error.code, "reason": error.reason, "message": error.message] }
        return o
    }
}

/// Runs `steps` in order against one gated context: `gate` (permission, policy, the app and its window)
/// runs once, each step gets the context (and may update it), and the first failure or a cancel stops it.
public func runBatch<Context>(_ steps: [(method: String, params: [String: Any])], gate: () throws -> Context, cancelled: () -> Bool = { false },
                             perform: (_ method: String, _ params: [String: Any], _ context: inout Context) throws -> [String: Any]) -> BatchRun {
    var run = BatchRun()
    func fail(_ i: Int, _ e: Error) {
        run.failedAt = i
        run.error = (e as? HelperError) ?? HelperError(-32603, "internal", "\(e)")
    }
    var ctx: Context
    do {
        run.gates += 1
        ctx = try gate()
    } catch {
        fail(0, error)
        return run
    }
    for (i, s) in steps.enumerated() {
        if cancelled() {
            fail(i, HelperError.aborted)
            break
        }
        do {
            run.results.append(try perform(s.method, s.params, &ctx))
        } catch {
            fail(i, error)
            break
        }
    }
    return run
}
