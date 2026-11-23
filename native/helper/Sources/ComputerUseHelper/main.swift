// MoPilot.app. Launched by main through LaunchServices (`open -n -g -a … --args
// --launch <config>`) so it is its own responsible process and the TCC grants are recorded for it, not
// for MoPilot or a terminal. It lives as long as the main process that launched it.
import AppKit
import HelperCore
import Security

signal(SIGPIPE, SIG_IGN)
let args = CommandLine.arguments
// `--eventkit-status` and `--permissions-status`, each with `--out <file>`: main launches the helper through
// LaunchServices to read the grants once and write them to the file, so System Settings has no running helper to
// ask to "Quit & Reopen" when the user turns a switch on, and a grant made since is seen by a new process, never by
// a running one (it keeps the answer it first read) (#2528).
if let o = args.firstIndex(of: "--out"), o + 1 < args.count {
    let answer: [String: Any]? =
        args.contains("--eventkit-status") ? eventKitStatus() : args.contains("--permissions-status") ? permissionStatus() : nil
    if let answer, let data = try? JSONSerialization.data(withJSONObject: answer) {
        exit((try? data.write(to: URL(fileURLWithPath: args[o + 1]), options: .atomic)) == nil ? 74 : 0)
    }
}
guard let i = args.firstIndex(of: "--launch"), i + 1 < args.count else {
    log("usage: --launch <config.json> (started by MoPilot)")
    exit(64)
}

let config: LaunchConfig
do {
    config = try LaunchConfig.load(path: args[i + 1])
} catch {
    log("bad launch config: \(error)")
    exit(65)
}

/// Team id of this helper's own signature; nil for ad-hoc builds.
func ownTeamId() -> String? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess else { return nil }
    return (info as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String
}

// A release build (signed with a team) must name who may connect; scripts/build-helper.mjs writes it
// into the signed Info.plist, so a launch config can't override it.
let requirement = Bundle.main.object(forInfoDictionaryKey: "MPCPeerRequirement") as? String
// A dev build signed with a local development certificate carries MPCDevBuild instead (see build-helper.mjs).
let devBuild = Bundle.main.object(forInfoDictionaryKey: "MPCDevBuild") as? Bool ?? false
if ownTeamId() != nil && !devBuild && (requirement ?? "").isEmpty {
    log("signed helper without MPCPeerRequirement; refusing to start")
    exit(78)
}

let mainPid = config.mainPid
guard kill(mainPid, 0) == 0 || errno == EPERM else {
    log("main process \(mainPid) is not running")
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let helper = Helper(config: config, peerRequirement: requirement)
do {
    try helper.start()
} catch {
    log("cannot listen on \(config.socket): \(error)")
    exit(71)
}

// Exit with the main process, and if main never connects.
let mainExit = DispatchSource.makeProcessSource(identifier: mainPid, eventMask: .exit, queue: .main)
mainExit.setEventHandler { helper.quit("main process exited") }
mainExit.resume()
var authenticated = false
helper.server.onAuthenticated = { authenticated = true }
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    if !authenticated { helper.quit("main never connected") }
}

app.run()
