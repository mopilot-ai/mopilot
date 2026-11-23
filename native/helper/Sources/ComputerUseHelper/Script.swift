// Scripts and Shortcuts (#3571 G7): app.script runs a checked AppleScript or JXA body against one scriptable app
// through osascript, after macOS's Automation permission for that app is granted (asked first when it never was);
// shortcuts.list and shortcuts.run run the user's own Shortcuts by name. Each run is a child process with a time limit,
// stopped by app.cancel with its runId (Stop, Esc, the turn's end). The policy is HelperCore/ScriptPolicy.swift.
import AppKit
import CoreServices
import Foundation
import HelperCore

/// Off the work queue: a script can run for a while, and a prompt waits for the user.
private let scriptQueue = DispatchQueue(label: "computer-use.script", attributes: .concurrent)
private let runsLock = NSLock()
/// Running children by runId, and the runIds app.cancel stopped.
private var runs: [String: Process] = [:]
private var cancelledRuns = Set<String>()

/// The requests answered off the work queue, so a long script (or a window's OCR) never holds up other apps' actions:
/// scripts and Shortcuts here, marks in AppMarks.swift.
let scriptMethods: Set<String> = ["app.script", "app.scriptable", "shortcuts.list", "shortcuts.run", "app.marks"]

/// app.cancel: stops the batch or the script run with this id.
func cancelAppRun(_ id: String) {
    cancelAppBatch(id)
    cancelScriptRun(id)
}

/// Stops the run with this id (and keeps a run that hasn't started yet from starting).
func cancelScriptRun(_ id: String) {
    runsLock.lock()
    cancelledRuns.insert(id)
    let p = runs[id]
    runsLock.unlock()
    guard let p, p.isRunning else { return }
    p.terminate()
    scriptQueue.asyncAfter(deadline: .now() + 1) { if p.isRunning { kill(p.processIdentifier, SIGKILL) } }
}

private func wasCancelled(_ id: String?) -> Bool {
    guard let id else { return false }
    runsLock.lock()
    defer { runsLock.unlock() }
    return cancelledRuns.contains(id)
}

/// What a child process did.
private struct RunOutput {
    var status: Int32
    var stdout: String
    var stderr: String
    var timedOut: Bool
    var cancelled: Bool
}

/// Runs `path args` with `input` on stdin, at most `timeoutMs`, stopped by app.cancel with `runId`.
private func runChild(_ path: String, _ args: [String], input: String?, timeoutMs: Int, runId: String?) throws -> RunOutput {
    if wasCancelled(runId) { throw HelperError.aborted }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe(), err = Pipe(), inp = Pipe()
    p.standardOutput = out
    p.standardError = err
    p.standardInput = inp
    var outData = Data(), errData = Data()
    let group = DispatchGroup()
    group.enter()
    scriptQueue.async { outData = out.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    group.enter()
    scriptQueue.async { errData = err.fileHandleForReading.readDataToEndOfFile(); group.leave() }
    try p.run()
    if let runId {
        runsLock.lock()
        runs[runId] = p
        runsLock.unlock()
        // a cancel that came between the start and the line above
        if wasCancelled(runId) { p.terminate() }
    }
    defer {
        if let runId {
            runsLock.lock()
            runs[runId] = nil
            cancelledRuns.remove(runId)
            runsLock.unlock()
        }
    }
    if let input { inp.fileHandleForWriting.write(Data(input.utf8)) }
    try? inp.fileHandleForWriting.close()
    var timedOut = false
    let timer = DispatchWorkItem { if p.isRunning { timedOut = true; p.terminate() } }
    scriptQueue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs), execute: timer)
    p.waitUntilExit()
    timer.cancel()
    group.wait()
    return RunOutput(status: p.terminationStatus, stdout: String(decoding: outData, as: UTF8.self),
                     stderr: String(decoding: errData, as: UTF8.self), timedOut: timedOut, cancelled: wasCancelled(runId))
}

/// macOS's Automation permission to send Apple events to `bundleId`, asking the user when `ask` and never asked.
private func automationPermission(_ bundleId: String, ask: Bool) -> String {
    let target = NSAppleEventDescriptor(bundleIdentifier: bundleId)
    guard let desc = target.aeDesc else { return "error" }
    return automationStatus(AEDeterminePermissionToAutomateTarget(desc, typeWildCard, typeWildCard, ask))
}

/// Whether the installed app with this bundle id has a scripting dictionary.
func appIsScriptable(_ bundleId: String) -> Bool {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return false }
    return isScriptable(info: Bundle(url: url)?.infoDictionary)
}

private let propertyCacheLock = NSLock()
private var propertyCache: [String: AppDictionary] = [:]
private var propertyFailures: [String: Date] = [:]

/// The app's scripting dictionary (read with `sdef`, cached per app version), or nil when it can't be read: the check
/// then treats the script as a write (it can't tell a command or property from a variable).
private func appDictionary(_ bundleId: String) -> AppDictionary? {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else { return nil }
    let version = (Bundle(url: url)?.infoDictionary?["CFBundleVersion"] as? String) ?? ""
    let key = "\(url.path)@\(version)"
    propertyCacheLock.lock()
    let cached = propertyCache[key]
    propertyCacheLock.unlock()
    if let cached { return cached }
    // an app whose dictionary can't be read isn't asked again for a minute (the check treats it as all properties)
    propertyCacheLock.lock()
    let failedAt = propertyFailures[key]
    propertyCacheLock.unlock()
    if let failedAt, Date().timeIntervalSince(failedAt) < 60 { return nil }
    guard let r = try? runChild("/usr/bin/sdef", [url.path], input: nil, timeoutMs: 15_000, runId: nil), r.status == 0,
          let names = sdefDictionary(Data(r.stdout.utf8)) else {
        propertyCacheLock.lock()
        propertyFailures[key] = Date()
        propertyCacheLock.unlock()
        return nil
    }
    propertyCacheLock.lock()
    propertyCache[key] = names
    propertyCacheLock.unlock()
    return names
}

private func scriptTarget(_ params: [String: Any]) throws -> String {
    guard let id = (params["bundleIds"] as? [String])?.first ?? params["bundleId"] as? String, validBundleId(id) else {
        throw HelperError.invalidParams("bundleId")
    }
    return id
}

private func runScript(_ params: [String: Any]) throws -> Any {
    let bundleId = try scriptTarget(params)
    guard let language = ScriptLanguage.parse(params["language"]) else { throw HelperError.invalidParams("language") }
    guard let source = params["source"] as? String else { throw HelperError.invalidParams("source") }
    guard appIsScriptable(bundleId) else {
        throw HelperError.unsupported("not_scriptable", "this app has no scripting dictionary; use the other desktop_app_* tools")
    }
    let check: ScriptCheck
    // (the check asks the app's scripting dictionary which names are properties and commands, only when it needs to)
    switch checkScript(source, language: language, dictionary: { appDictionary(bundleId) }) {
    case .success(let c): check = c
    case .failure(let r): throw HelperError(24, "script_refused", "refused: the script uses \(r.reason)")
    }
    if params["check"] as? Bool == true { return check.json.merging(["scriptable": true]) { a, _ in a } }
    // the Automation permission first: macOS asks the user once, and the script runs only when it is granted
    var permission = automationPermission(bundleId, ask: false)
    if permission == "ask" { permission = automationPermission(bundleId, ask: true) }
    switch permission {
    case "granted": break
    case "not_running": throw HelperError.notRunning
    case "denied":
        throw HelperError(23, "automation_denied", "macOS Automation permission for this app is off: the user turns on the app under MoPilot in System Settings > Privacy & Security > Automation")
    default: throw HelperError(23, "automation_denied", "macOS could not confirm the Automation permission for this app")
    }
    let r = try runChild("/usr/bin/osascript", ["-l", language.osaName], input: wrappedScript(source, language: language, bundleId: bundleId),
                         timeoutMs: scriptTimeoutMs(params["timeoutMs"] as? Double), runId: params["runId"] as? String)
    return try scriptResult(r, what: "script")
}

/// A run's answer: its text, or why it stopped.
private func scriptResult(_ r: RunOutput, what: String) throws -> [String: Any] {
    if r.cancelled { throw HelperError.aborted }
    if r.timedOut { throw HelperError(20, "script_timeout", "the \(what) did not finish in time and was stopped") }
    let out = clippedOutput(r.stdout.trimmingCharacters(in: .newlines))
    let err = clippedOutput(r.stderr.trimmingCharacters(in: .whitespacesAndNewlines), limit: 4000)
    return ["ok": r.status == 0, "output": out.text, "truncated": out.truncated, "error": err.text, "exitCode": Int(r.status)]
}

private func listShortcuts() throws -> [String] {
    let r = try runChild("/usr/bin/shortcuts", ["list"], input: nil, timeoutMs: 20_000, runId: nil)
    if r.status != 0 { throw HelperError(21, "shortcuts_failed", clippedOutput(r.stderr, limit: 500).text) }
    return shortcutNames(r.stdout)
}

private func runShortcut(_ params: [String: Any]) throws -> Any {
    guard let name = params["name"] as? String, validShortcutName(name) else { throw HelperError.invalidParams("name") }
    // only a Shortcut the user has: a name that isn't one is refused, not guessed at
    guard try listShortcuts().contains(name) else { throw HelperError(22, "no_shortcut", "no Shortcut named \"\(name)\"") }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("mopilot-shortcut-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    var inputPath: String?
    if let input = params["input"] as? String {
        let f = dir.appendingPathComponent("input.txt")
        try Data(input.utf8).write(to: f)
        inputPath = f.path
    }
    let outFile = dir.appendingPathComponent("output.txt")
    var r = try runChild("/usr/bin/shortcuts", shortcutRunArguments(name, inputPath: inputPath, outputPath: outFile.path), input: nil,
                         timeoutMs: scriptTimeoutMs(params["timeoutMs"] as? Double), runId: params["runId"] as? String)
    if let data = try? Data(contentsOf: outFile) { r.stdout = String(decoding: data, as: UTF8.self) }
    return try scriptResult(r, what: "Shortcut")
}

/// Runs one script or Shortcuts request off the socket's and the work queue, replying with its result or HelperError.
func dispatchScript(_ method: String, _ params: [String: Any], _ reply: @escaping (Result<Any, HelperError>) -> Void) {
    scriptQueue.async {
        do {
            switch method {
            case "app.script": reply(.success(try runScript(params)))
            case "app.scriptable":
                let id = try scriptTarget(params)
                reply(.success(["scriptable": appIsScriptable(id)]))
            case "shortcuts.list": reply(.success(["shortcuts": try listShortcuts()]))
            case "shortcuts.run": reply(.success(try runShortcut(params)))
            case "app.marks": reply(.success(try markWindow(params)))
            default: throw HelperError.methodNotFound(method)
            }
        } catch let e as HelperError {
            reply(.failure(e))
        } catch {
            reply(.failure(HelperError(-32603, "internal", error.localizedDescription)))
        }
    }
}
