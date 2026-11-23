// Native app discovery, metadata, launching and activation settling.
import AppKit
import Foundation
import HelperCore

/// The running apps a person would switch between (regular activation policy).
func runningApps() -> [[String: Any]] {
    let front = frontmostPid()
    return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { a in
        [
            "pid": Int(a.processIdentifier),
            "bundleId": a.bundleIdentifier ?? "",
            "name": a.localizedName ?? a.bundleIdentifier ?? "",
            "frontmost": a.processIdentifier == front,
            "hidden": a.isHidden,
        ]
    }
}

private let appDirs: [String] = [
    "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
    "/System/Library/CoreServices", "/System/Library/CoreServices/Applications", (NSHomeDirectory() as NSString).appendingPathComponent("Applications"),
]

private func appInfo(at url: URL) -> [String: Any]? {
    guard let b = Bundle(url: url), let id = b.bundleIdentifier else { return nil }
    let name = (b.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (b.object(forInfoDictionaryKey: "CFBundleName") as? String)
        ?? url.deletingPathExtension().lastPathComponent
    let running = NSRunningApplication.runningApplications(withBundleIdentifier: id).first
    var out: [String: Any] = ["bundleId": id, "name": url.deletingPathExtension().lastPathComponent, "displayName": name, "path": url.path, "running": running != nil]
    if let running { out["pid"] = Int(running.processIdentifier) }
    return out
}

/// An app by bundle id or by name (running apps first, then the usual Applications folders; an exact
/// name before a unique partial one). Nil when nothing matches.
func findApp(_ query: String) -> [String: Any]? {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard !q.isEmpty else { return nil }
    let lower = q.lowercased().replacingOccurrences(of: ".app", with: "")
    if q.contains("."), !q.contains(" "), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: q), let info = appInfo(at: url) {
        return info
    }
    let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    if let a = running.first(where: { ($0.localizedName ?? "").lowercased() == lower }), let url = a.bundleURL, let info = appInfo(at: url) {
        return info
    }
    var candidates: [URL] = []
    for dir in appDirs {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
        for n in names where n.hasSuffix(".app") { candidates.append(URL(fileURLWithPath: dir).appendingPathComponent(n)) }
    }
    let stem = { (u: URL) in u.deletingPathExtension().lastPathComponent.lowercased() }
    if let u = candidates.first(where: { stem($0) == lower }), let info = appInfo(at: u) { return info }
    let partial = candidates.filter { stem($0).contains(lower) }
    if partial.count == 1, let info = appInfo(at: partial[0]) { return info }
    if let a = running.filter({ ($0.localizedName ?? "").lowercased().contains(lower) }).first, running.filter({ ($0.localizedName ?? "").lowercased().contains(lower) }).count == 1,
       let url = a.bundleURL, let info = appInfo(at: url) {
        return info
    }
    return nil
}

/// Launches (or brings forward) the app with this bundle id and waits for it to be frontmost (up to ~3 s).
func openApp(bundleId: String) throws -> [String: Any] {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
        throw HelperError.invalidParams("no app with bundle id \(bundleId)")
    }
    let done = DispatchSemaphore(value: 0)
    var opened: NSRunningApplication?
    var failure: Error?
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, error in
        opened = app
        failure = error
        done.signal()
    }
    if done.wait(timeout: .now() + 15) == .timedOut { throw HelperError(-32603, "internal", "timed out opening \(bundleId)") }
    if let failure { throw HelperError(-32603, "internal", failure.localizedDescription) }
    guard let app = opened else { throw HelperError(-32603, "internal", "could not open \(bundleId)") }
    DispatchQueue.main.sync { _ = app.activate(options: [.activateAllWindows]) }
    for _ in 0..<30 where frontmostPid() != app.processIdentifier { usleep(100_000) }
    settleAfterActivation(pid: app.processIdentifier)
    return ["pid": Int(app.processIdentifier), "bundleId": app.bundleIdentifier ?? bundleId, "name": app.localizedName ?? bundleId, "frontmost": frontmostPid() == app.processIdentifier]
}

/// After an app comes forward, waits (up to ~1.5 s) for one of its windows to be on screen, then lets
/// it finish drawing, so the screenshot that usually follows sees the window rather than nothing.
func settleAfterActivation(pid: pid_t) {
    for _ in 0..<15 where !hasOnScreenWindow(onScreenWindows(), pid: pid) { usleep(100_000) }
    usleep(150_000)
}
