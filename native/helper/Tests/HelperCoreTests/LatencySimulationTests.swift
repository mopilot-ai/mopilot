import Foundation
import XCTest
@testable import HelperCore

/// A unit-level simulation of per-action overhead for background (app-scoped) actions, on a virtual clock.
/// It runs the real `runBatch` (gate once) and `settle` (adaptive) against modeled costs, and compares:
///
/// - legacy: one request per action, each gated (permission, policy, window listing) and preceded by
///   main's attendance check (a round trip for the idle time); no settle, no verification;
/// - fixed: the same, verified after a fixed 400 ms sleep (what desktop_batch waits before its screenshot);
/// - adaptive: a batch gated once, each action verified after an adaptive settle (capped at 600 ms).
///
/// The costs are assumptions (a unix-socket round trip, an accessibility read, a small window capture,
/// and how long an app takes to finish reacting), not measurements of a real app; the comparison is
/// what the test pins. `print`s the p50/p95 table that the PR reports.
final class LatencySimulationTests: XCTestCase {
    /// xorshift64*: deterministic, so the numbers are the same on every run.
    struct Rng {
        var s: UInt64
        mutating func unit() -> Double {
            s ^= s >> 12
            s ^= s << 25
            s ^= s >> 27
            return Double((s &* 0x2545_F491_4F6C_DD1D) >> 11) / Double(1 << 53)
        }
    }

    final class Clock {
        var t = 0.0
        func now() -> Double { t }
        func sleep(_ ms: Double) { t += ms }
    }

    struct Model {
        var rng: Rng
        mutating func ipc() -> Double { 1.2 + rng.unit() * 0.6 }
        mutating func gate() -> Double { 0.4 + rng.unit() * 0.3 }
        mutating func enumerate() -> Double { 4 + rng.unit() * 6 }
        mutating func dispatch(ax: Bool) -> Double { ax ? 2 + rng.unit() * 3 : 9 + rng.unit() * 4 }
        mutating func axProbe() -> Double { 1 + rng.unit() }
        mutating func pixelProbe() -> Double { 12 + rng.unit() * 8 }
        /// How long the app keeps changing after the action: mostly short, with a tail.
        mutating func reaction(ax: Bool) -> Double {
            let u = rng.unit()
            let tail = rng.unit() < 0.08 ? 300.0 : 0
            return (ax ? 15 + 120 * u * u : 30 + 250 * u * u) + tail
        }
    }

    static func percentile(_ xs: [Double], _ p: Double) -> Double {
        let s = xs.sorted()
        return s[min(s.count - 1, Int((Double(s.count - 1) * p).rounded()))]
    }

    /// One verified action on the virtual clock: probe, dispatch, settle (adaptive or fixed), probe again.
    /// Returns the time it took, and whether the verdict came while the app was still changing.
    static func verified(_ m: inout Model, _ c: Clock, ax: Bool, fixedMs: Double?) -> (ms: Double, early: Bool) {
        let start = c.t
        c.t += m.axProbe() + m.pixelProbe()
        c.t += m.dispatch(ax: ax)
        let changingUntil = c.t + m.reaction(ax: ax)
        let early: Bool
        if let fixedMs {
            c.t += fixedMs
            early = c.t < changingUntil
            c.t += m.axProbe() + m.pixelProbe()
        } else {
            var n = 0
            var model = m
            early = !settle(SettlePolicy.forRoute(ax ? "ax" : "pid", capMs: 600), now: c.now, sleep: c.sleep) { () -> Int in
                // each sample reads accessibility; posted events also sample the pixels
                c.t += model.axProbe() + (ax ? 0 : model.pixelProbe())
                n += 1
                return c.t < changingUntil ? n : -1
            }.stable
            m = model
            // the accessibility route didn't sample pixels while settling: one capture for the verdict
            if ax { c.t += m.pixelProbe() }
        }
        return (c.t - start, early)
    }

    struct Row {
        let name: String
        let p50: Double
        let p95: Double
        /// Verdicts taken while the app was still changing, in percent.
        let early: Double
    }

    static func simulate(batches: Int = 400, perBatch: Int = 8) -> [Row] {
        var legacy: [Double] = [], fixed: [Double] = [], adaptive: [Double] = []
        var gatedOnly: [Double] = []
        var fixedEarly = 0, adaptiveEarly = 0
        var gates = 0
        var m = Model(rng: Rng(s: 0x9E37_79B9_7F4A_7C15))
        for b in 0..<batches {
            let routes = (0..<perBatch).map { (b + $0) % 2 == 0 }
            // legacy and fixed: a request per action, each gated
            for ax in routes {
                let base = m.ipc() + m.ipc() + m.gate() + m.enumerate() + m.dispatch(ax: ax)
                legacy.append(base)
                let c = Clock()
                let v = verified(&m, c, ax: ax, fixedMs: 400)
                if v.early { fixedEarly += 1 }
                fixed.append(m.ipc() + m.ipc() + m.gate() + m.enumerate() + v.ms)
            }
            // adaptive: one request for the batch, gated once; the first step carries the gate
            let c = Clock()
            var first = true
            let steps = routes.map { (method: $0 ? "app.press" : "app.click", params: [String: Any]()) }
            var mm = m
            let run = runBatch(steps, gate: { () -> Int in
                c.t += mm.ipc() + mm.ipc() + mm.gate() + mm.enumerate()
                return 0
            }) { method, _, _ in
                let start = c.t
                let ax = method == "app.press"
                // a step that opened or closed a window lists them again (one in ten)
                if mm.rng.unit() < 0.1 { c.t += mm.enumerate() }
                if verified(&mm, c, ax: ax, fixedMs: nil).early { adaptiveEarly += 1 }
                adaptive.append(c.t - (first ? 0 : start))
                first = false
                return [:]
            }
            m = mm
            gates += run.gates
            // the gate alone: the same batch, unverified
            let g = runBatch(steps, gate: { () -> Double in m.ipc() + m.ipc() + m.gate() + m.enumerate() }) { method, _, carried in
                let t = carried + m.dispatch(ax: method == "app.press") + (m.rng.unit() < 0.1 ? m.enumerate() : 0)
                carried = 0
                gatedOnly.append(t)
                return [:]
            }
            gates += g.gates
        }
        XCTAssertEqual(gates, 2 * batches, "one gate per batch")
        return [
            Row(name: "legacy (per call, unverified)", p50: percentile(legacy, 0.5), p95: percentile(legacy, 0.95), early: -1),
            Row(name: "unverified, batch-gated", p50: percentile(gatedOnly, 0.5), p95: percentile(gatedOnly, 0.95), early: -1),
            Row(name: "verified, fixed 400 ms settle", p50: percentile(fixed, 0.5), p95: percentile(fixed, 0.95), early: 100 * Double(fixedEarly) / Double(fixed.count)),
            Row(name: "verified, adaptive settle, batch-gated", p50: percentile(adaptive, 0.5), p95: percentile(adaptive, 0.95), early: 100 * Double(adaptiveEarly) / Double(adaptive.count)),
        ]
    }

    func testAdaptiveVerifiedActionsBeatAFixedSettle() {
        let rows = Self.simulate()
        for r in rows {
            let early = r.early < 0 ? "no verdict" : String(format: "verdict while the app was still changing %.1f%%", r.early)
            print(String(format: "latency-sim %@: p50 %.1f ms, p95 %.1f ms, %@", r.name, r.p50, r.p95, early))
        }
        let (legacy, gated, fixed, adaptive) = (rows[0], rows[1], rows[2], rows[3])
        // gating once per batch takes most of the per-call overhead off every action but the first
        XCTAssertLessThan(gated.p50, legacy.p50 * 0.7)
        // verification costs time, but far less than a fixed sleep at the median; in the tail an app that
        // reacts slowly is waited for (up to the cap), where a fixed sleep would verify too early
        XCTAssertLessThan(adaptive.p50, fixed.p50 / 2)
        XCTAssertLessThan(adaptive.p95, 600 + 80)
        XCTAssertLessThan(adaptive.early, fixed.early)
        XCTAssertGreaterThan(adaptive.p50, legacy.p50)
        // deterministic: the same table every run
        let again = Self.simulate()
        XCTAssertEqual(again.map(\.p50), rows.map(\.p50))
    }

    /// desktop_batch's wait before its closing screenshot: a fixed 400 ms against screen.settle.
    func testScreenSettleAgainstAFixedWait() {
        var m = Model(rng: Rng(s: 42))
        var waits: [Double] = []
        for _ in 0..<1000 {
            let c = Clock()
            let until = m.reaction(ax: false)
            var n = 0
            var model = m
            let out = settle(SettlePolicy(minMs: 80, quietMs: 100, capMs: 400), now: c.now, sleep: c.sleep) { () -> Int in
                c.t += model.axProbe() + 2
                n += 1
                return c.t < until ? n : -1
            }
            m = model
            waits.append(out.elapsedMs)
        }
        let p50 = Self.percentile(waits, 0.5), p95 = Self.percentile(waits, 0.95)
        print(String(format: "latency-sim desktop_batch settle: fixed 400.0 ms; adaptive p50 %.1f ms, p95 %.1f ms", p50, p95))
        XCTAssertLessThan(p50, 400)
        XCTAssertLessThanOrEqual(p95, 400 + 10, "never much past the cap (one sample)")
    }
}
