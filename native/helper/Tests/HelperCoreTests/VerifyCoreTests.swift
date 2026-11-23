import CoreGraphics
import Foundation
import XCTest
@testable import HelperCore

/// HelperCore/Verify.swift: the pixel grid and its diff, the before/after verdict, the adaptive settle
/// (on a virtual clock), the checks before dispatch (moved or resized window, occlusion) and the batch
/// runner that gates once. None needs TCC or a screen.
final class VerifyCoreTests: XCTestCase {
    // MARK: pixel grid

    func testDownsampleAveragesCells() {
        // a 4x2 buffer: the left half black, the right half white
        let g = PixelGrid.downsample(gray: [0, 0, 255, 255, 0, 0, 255, 255], width: 4, height: 2, columns: 2, rows: 1)
        XCTAssertEqual(g, PixelGrid(columns: 2, rows: 1, values: [0, 255]))
        // more cells than pixels: one cell per pixel
        let small = PixelGrid.downsample(gray: [10, 20], width: 2, height: 1, columns: 32, rows: 32)
        XCTAssertEqual(small?.columns, 2)
        XCTAssertEqual(small?.rows, 1)
        XCTAssertEqual(small?.values, [10, 20])
        // uneven division still covers every pixel once
        let odd = PixelGrid.downsample(gray: [0, 30, 60, 90, 120, 150, 180, 210, 240], width: 3, height: 3, columns: 2, rows: 2)
        XCTAssertEqual(odd?.values.count, 4)
        XCTAssertEqual(odd?.values[0], 0)
        XCTAssertEqual(odd?.values[3], 180)
        // not enough pixels, or a size that isn't positive
        XCTAssertNil(PixelGrid.downsample(gray: [1, 2, 3], width: 2, height: 2))
        XCTAssertNil(PixelGrid.downsample(gray: [], width: 0, height: 1))
        XCTAssertNil(PixelGrid.downsample(gray: [1], width: 1, height: 0))
        XCTAssertNil(PixelGrid.downsample(gray: [1], width: 1, height: 1, columns: 0, rows: 1))
        XCTAssertNil(PixelGrid.downsample(gray: [1], width: 1, height: 1, columns: 1, rows: 0))
        // negative sizes are clamped
        XCTAssertEqual(PixelGrid(columns: -1, rows: -2, values: []).columns, 0)
        XCTAssertEqual(PixelGrid(columns: -1, rows: -2, values: []).rows, 0)
    }

    func testChangedCellsAndHash() {
        let a = PixelGrid(columns: 2, rows: 2, values: [100, 100, 100, 100])
        let caret = PixelGrid(columns: 2, rows: 2, values: [105, 100, 100, 100])
        let typed = PixelGrid(columns: 2, rows: 2, values: [140, 100, 100, 60])
        XCTAssertEqual(a.changedCells(caret), 0, "a small change is under the threshold")
        XCTAssertEqual(a.changedCells(typed), 2)
        XCTAssertEqual(a.changedCells(caret, threshold: 2), 1)
        // grids of different shapes, or empty ones, aren't comparable
        XCTAssertNil(a.changedCells(PixelGrid(columns: 1, rows: 4, values: [100, 100, 100, 100])))
        XCTAssertNil(a.changedCells(PixelGrid(columns: 2, rows: 1, values: [100, 100, 100, 100])))
        XCTAssertNil(a.changedCells(PixelGrid(columns: 2, rows: 2, values: [100])))
        XCTAssertNil(PixelGrid(columns: 0, rows: 0, values: []).changedCells(PixelGrid(columns: 0, rows: 0, values: [])))
        // the hash quantizes: the caret's grid hashes like the original, a typed character doesn't
        XCTAssertEqual(a.hash, caret.hash)
        XCTAssertNotEqual(a.hash, typed.hash)
        XCTAssertEqual(a.hashHex.count, 16)
        XCTAssertEqual(PixelGrid(columns: 0, rows: 0, values: []).hashHex, "cbf29ce484222325")
    }

    // MARK: verdict

    func testVerdictConfirmsAnyChange() {
        let base = EffectProbe(windows: [1], bounds: CGRect(x: 0, y: 0, width: 100, height: 100), focused: "f", element: "e", sheet: false, grid: PixelGrid(columns: 1, rows: 1, values: [0]))
        func changed(_ f: (inout EffectProbe) -> Void) -> EffectVerdict {
            var after = base
            f(&after)
            return verifyEffect(before: base, after: after)
        }
        XCTAssertEqual(changed { $0.windows = [1, 2] }.evidence, ["window_opened"])
        XCTAssertEqual(changed { $0.windows = [] }.evidence, ["window_closed"])
        XCTAssertEqual(changed { $0.sheet = true }.evidence, ["sheet_appeared"])
        XCTAssertEqual(changed { $0.bounds = CGRect(x: 30, y: 0, width: 100, height: 100) }.evidence, ["window_moved"])
        XCTAssertEqual(changed { $0.focused = "g" }.evidence, ["focus_changed"])
        XCTAssertEqual(changed { $0.element = "e2" }.evidence, ["value_changed"])
        let px = changed { $0.grid = PixelGrid(columns: 1, rows: 1, values: [200]) }
        XCTAssertEqual(px.evidence, ["pixels_changed"])
        XCTAssertEqual(px.changedCells, 1)
        XCTAssertEqual(px.effect, .confirmed)
        XCTAssertEqual(px.json["effect"] as? String, "confirmed")
        XCTAssertEqual(px.json["changedCells"] as? Int, 1)
        // a sheet that closes, a focus that goes away, an element that disappears
        var withSheet = base
        withSheet.sheet = true
        XCTAssertEqual(verifyEffect(before: withSheet, after: base).evidence, ["sheet_closed"])
        XCTAssertEqual(changed { $0.focused = nil }.evidence, ["focus_changed"])
        XCTAssertEqual(changed { $0.element = nil }.evidence, ["value_changed"])
        // and ones that appear
        XCTAssertEqual(verifyEffect(before: EffectProbe(windows: []), after: EffectProbe(windows: [], focused: "f", element: "e")).evidence, ["focus_changed", "value_changed"])
        // a move within a point is no move
        XCTAssertEqual(changed { $0.bounds = CGRect(x: 0.5, y: 0, width: 100, height: 100) }.effect, .noChange)
    }

    func testVerdictNoChangeOrUnverifiable() {
        let grid = PixelGrid(columns: 1, rows: 1, values: [50])
        let still = verifyEffect(before: EffectProbe(windows: [1], grid: grid), after: EffectProbe(windows: [1], grid: grid))
        XCTAssertEqual(still.effect, .noChange)
        XCTAssertEqual(still.changedCells, 0)
        XCTAssertNil(EffectVerdict(effect: .noChange, evidence: [], changedCells: nil).json["changedCells"])
        // the element's state on both sides is enough to say nothing changed
        XCTAssertEqual(verifyEffect(before: EffectProbe(windows: [], element: "x"), after: EffectProbe(windows: [], element: "x")).effect, .noChange)
        // nothing comparable: no pixels on one side, no element state
        XCTAssertEqual(verifyEffect(before: EffectProbe(windows: [1], grid: grid), after: EffectProbe(windows: [1])).effect, .unverifiable)
        XCTAssertEqual(verifyEffect(before: EffectProbe(windows: [1], element: "x"), after: EffectProbe(windows: [1], element: "x", grid: grid)).effect, .noChange)
        XCTAssertEqual(verifyEffect(before: EffectProbe(windows: [1], focused: "f"), after: EffectProbe(windows: [1], focused: "f")).effect, .unverifiable)
        // more changed cells needed than changed: no evidence from pixels
        let a = EffectProbe(windows: [], grid: PixelGrid(columns: 2, rows: 1, values: [0, 0]))
        let b = EffectProbe(windows: [], grid: PixelGrid(columns: 2, rows: 1, values: [200, 0]))
        XCTAssertEqual(verifyEffect(before: a, after: b, minCells: 2).effect, .noChange)
        XCTAssertEqual(verifyEffect(before: a, after: b, pixelThreshold: 250).effect, .noChange)
    }

    func testProbeSignature() {
        let p = EffectProbe(windows: [3, 4], bounds: CGRect(x: 1.6, y: 2, width: 30, height: 40), focused: "AXTextArea", element: "v", sheet: true)
        XCTAssertEqual(p.signature, "3,4|1,2,30,40|AXTextArea|v|1")
        XCTAssertEqual(EffectProbe(windows: [], sheet: false).signature, "|-|-|-|0")
        XCTAssertEqual(EffectProbe(windows: []).signature, "|-|-|-|-")
    }

    // MARK: settle

    /// A virtual clock: sleeping advances it.
    final class Clock {
        var t = 0.0
        func now() -> Double { t }
        func sleep(_ ms: Double) { t += ms }
    }

    func testSettleWaitsForQuiet() {
        let c = Clock()
        // the app changes until 130 ms, then stays still
        let out = settle(SettlePolicy(minMs: 0, quietMs: 50, capMs: 600, intervalMs: 25), now: c.now, sleep: c.sleep) { c.t < 130 ? Int(c.t) : 130 }
        XCTAssertTrue(out.stable)
        XCTAssertEqual(out.elapsedMs, 200, accuracy: 0.001)
        XCTAssertEqual(out.samples, 9)
        XCTAssertEqual(out.json["settleMs"] as? Int, 200)
        XCTAssertEqual(out.json["stable"] as? Bool, true)
    }

    func testSettleHonorsTheFloorAndTheCap() {
        let c = Clock()
        // nothing ever changes: done at the floor
        let floor = settle(SettlePolicy.posted(), now: c.now, sleep: c.sleep) { 1 }
        XCTAssertTrue(floor.stable)
        XCTAssertEqual(floor.elapsedMs, 100, accuracy: 0.001)
        // always changing: stops at the cap, unstable; the last sleep is cut to the cap
        let c2 = Clock()
        let cap = settle(SettlePolicy(minMs: 0, quietMs: 50, capMs: 110, intervalMs: 25), now: c2.now, sleep: c2.sleep) { c2.t }
        XCTAssertFalse(cap.stable)
        XCTAssertEqual(cap.elapsedMs, 110, accuracy: 0.001)
        // no floor, no quiet window: done at once
        let c3 = Clock()
        XCTAssertEqual(settle(SettlePolicy(minMs: 0, quietMs: 0, capMs: 100), now: c3.now, sleep: c3.sleep) { 0 }, SettleOutcome(elapsedMs: 0, stable: true, samples: 1))
    }

    func testSettlePolicies() {
        XCTAssertEqual(SettlePolicy.accessibility(), SettlePolicy(minMs: 0, quietMs: 50, capMs: 600))
        XCTAssertEqual(SettlePolicy.forRoute("ax", capMs: nil), SettlePolicy.accessibility())
        XCTAssertEqual(SettlePolicy.forRoute("pid", capMs: 200), SettlePolicy.posted(capMs: 200))
        XCTAssertEqual(SettlePolicy.forRoute("pid", capMs: 9000).capMs, 3000)
        XCTAssertEqual(SettlePolicy.forRoute("ax", capMs: -5).capMs, 0)
        // the cap is never below the floor, the interval never below 1 ms, nothing negative
        let p = SettlePolicy(minMs: 200, quietMs: -1, capMs: 50, intervalMs: 0)
        XCTAssertEqual(p.capMs, 200)
        XCTAssertEqual(p.quietMs, 0)
        XCTAssertEqual(p.intervalMs, 1)
        XCTAssertEqual(SettlePolicy(minMs: -3, quietMs: 0, capMs: 0).minMs, 0)
    }

    // MARK: before dispatch

    func testCheckBounds() {
        let r = CGRect(x: 100, y: 100, width: 400, height: 300)
        XCTAssertEqual(checkBounds(expected: nil, current: r), .same)
        XCTAssertEqual(checkBounds(expected: r, current: r.offsetBy(dx: 1, dy: -1)), .same)
        XCTAssertEqual(checkBounds(expected: r, current: r.offsetBy(dx: 40, dy: -20)), .moved(dx: 40, dy: -20))
        XCTAssertEqual(checkBounds(expected: r, current: r.offsetBy(dx: 0, dy: 10)), .moved(dx: 0, dy: 10))
        XCTAssertEqual(checkBounds(expected: r, current: CGRect(x: 100, y: 100, width: 500, height: 300)), .resized)
        XCTAssertEqual(checkBounds(expected: r, current: CGRect(x: 100, y: 100, width: 400, height: 200)), .resized)
    }

    func testOcclusion() {
        let target = CGRect(x: 0, y: 0, width: 500, height: 400)
        let mine = HitWindow(pid: 7, layer: 0, alpha: 1, bounds: target)
        let sheet = HitWindow(pid: 7, layer: 0, alpha: 1, bounds: CGRect(x: 100, y: 0, width: 300, height: 200))
        let palette = HitWindow(pid: 7, layer: 3, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 50, height: 50))
        let other = HitWindow(pid: 9, layer: 0, alpha: 1, bounds: CGRect(x: 0, y: 300, width: 100, height: 100))
        let menu = HitWindow(pid: 1, layer: 101, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1000, height: 30))
        let overlay = HitWindow(pid: 42, layer: 1000, alpha: 1, bounds: CGRect(x: 0, y: 0, width: 1000, height: 1000))
        let clear = HitWindow(pid: 9, layer: 0, alpha: 0, bounds: target)
        let stack = [overlay, menu, clear, palette, sheet, other, mine]
        let at = { (x: Double, y: Double) in occlusion(at: CGPoint(x: x, y: y), pid: 7, targetBounds: target, stack: stack, ignore: [42]) }
        XCTAssertEqual(at(200, 100), .ownWindow(sheet.bounds), "the app's dialog is in front")
        XCTAssertEqual(at(20, 350), .otherApp(9), "another app's window: posted events still reach the target")
        XCTAssertEqual(at(20, 20), .clear, "the menu bar, the app's palette and the overlay are looked through")
        XCTAssertEqual(at(450, 300), .clear)
        XCTAssertEqual(at(900, 900), .clear, "nothing at all there")
        XCTAssertEqual(occlusion(at: CGPoint(x: 450, y: 300), pid: 7, targetBounds: target, stack: [overlay]), .clear, "windows above the normal levels are looked through")
    }

    func testOwnWindowsThatBlockInput() {
        let doc = CGRect(x: 0, y: 0, width: 400, height: 300)
        let sheet = CGRect(x: 50, y: 0, width: 300, height: 200)
        // another document window of the app: the posted events still name the target
        XCTAssertFalse(blocksInput(cover: doc.offsetBy(dx: 0.5, dy: 0), documentWindows: [doc]))
        // a sheet, a dialog or a panel (not a standard window the app lists): the click would be swallowed
        XCTAssertTrue(blocksInput(cover: sheet, documentWindows: [doc]))
        XCTAssertTrue(blocksInput(cover: sheet, documentWindows: []))
    }

    func testStructuredErrors() {
        XCTAssertEqual(HelperError.occluded.reason, "occluded")
        XCTAssertEqual(HelperError.occluded.code, 15)
        XCTAssertEqual(HelperError.windowChanged.reason, "window_changed")
        XCTAssertEqual(HelperError.windowChanged.code, 16)
    }

    // MARK: batches

    func testBatchSteps() throws {
        let steps = try batchSteps([["method": "app.click", "params": ["x": 1]], ["method": "app.key"]], allowed: ["app.click", "app.key"])
        XCTAssertEqual(steps.map(\.method), ["app.click", "app.key"])
        XCTAssertEqual(steps[0].params["x"] as? Int, 1)
        XCTAssertTrue(steps[1].params.isEmpty)
        XCTAssertThrowsError(try batchSteps(nil, allowed: ["app.click"]))
        XCTAssertThrowsError(try batchSteps([[String: Any]](), allowed: ["app.click"]))
        XCTAssertThrowsError(try batchSteps([["method": "app.click"], ["method": "app.click"]], allowed: ["app.click"], max: 1))
        XCTAssertThrowsError(try batchSteps([["method": "app.menu"]], allowed: ["app.click"])) { e in
            XCTAssertEqual((e as? HelperError)?.message, "steps[0].method")
        }
        XCTAssertThrowsError(try batchSteps([["params": [:]]], allowed: ["app.click"]))
    }

    func testRunBatchGatesOnceAndStopsAtTheFirstFailure() {
        var gates = 0
        var seen: [String] = []
        let steps: [(method: String, params: [String: Any])] = [("a", [:]), ("b", [:]), ("c", [:])]
        let ok = runBatch(steps, gate: { () -> Int in gates += 1; return 10 }) { m, _, ctx in
            seen.append("\(m)\(ctx)")
            ctx += 1
            return ["ok": true]
        }
        XCTAssertEqual(gates, 1)
        XCTAssertEqual(ok.gates, 1)
        XCTAssertEqual(seen, ["a10", "b11", "c12"], "each step sees what the one before left in the context")
        XCTAssertEqual(ok.results.count, 3)
        XCTAssertNil(ok.failedAt)
        XCTAssertEqual(ok.json["completed"] as? Int, 3)
        XCTAssertNil(ok.json["error"])

        let failed = runBatch(steps, gate: { 0 }) { m, _, _ in
            if m == "b" { throw HelperError.windowGone }
            return [:]
        }
        XCTAssertEqual(failed.results.count, 1)
        XCTAssertEqual(failed.failedAt, 1)
        XCTAssertEqual(failed.error, .windowGone)
        XCTAssertEqual(failed.json["failedAt"] as? Int, 1)
        XCTAssertEqual((failed.json["error"] as? [String: Any])?["reason"] as? String, "window_gone")

        // an error that isn't the helper's own is reported as internal
        struct Odd: Error {}
        let odd = runBatch(steps, gate: { 0 }) { _, _, _ in throw Odd() }
        XCTAssertEqual(odd.error?.reason, "internal")
    }

    func testRunBatchGateFailureAndCancel() {
        let steps: [(method: String, params: [String: Any])] = [("a", [:]), ("b", [:])]
        let refused = runBatch(steps, gate: { () throws -> Int in throw HelperError.notRunning }) { _, _, _ in [:] }
        XCTAssertEqual(refused.failedAt, 0)
        XCTAssertEqual(refused.error, .notRunning)
        XCTAssertEqual(refused.gates, 1)
        XCTAssertTrue(refused.results.isEmpty)

        var n = 0
        let cancelled = runBatch(steps, gate: { 0 }, cancelled: { n >= 1 }) { _, _, _ in
            n += 1
            return [:]
        }
        XCTAssertEqual(cancelled.results.count, 1)
        XCTAssertEqual(cancelled.failedAt, 1)
        XCTAssertEqual(cancelled.error, .aborted)
    }
}
