// Prepares a signed update while MoPilot is open and activates it after the parent exits.
import AppKit
import Darwin
import Foundation
import Security

struct InstallError: LocalizedError {
    let errorDescription: String?

    init(_ message: String) { errorDescription = message }
}

func check(_ status: OSStatus, _ message: String) throws {
    guard status == errSecSuccess else { throw InstallError("\(message) (\(status)).") }
}

func team(_ code: SecStaticCode) throws -> String {
    var signed: CFDictionary?
    try check(SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &signed), "Could not read the updater's signer")
    guard let team = (signed as? [String: Any])?[kSecCodeInfoTeamIdentifier as String] as? String, !team.isEmpty else {
        throw InstallError("MoPilot and its updater must be signed.")
    }
    return team
}

func parentRequirement(_ pid: pid_t) throws -> SecRequirement {
    let attributes = [kSecGuestAttributePid: NSNumber(value: pid)] as CFDictionary
    var parent: SecCode?
    try check(SecCodeCopyGuestWithAttributes(nil, attributes, [], &parent), "Could not identify the running app")
    guard let parent else { throw InstallError("The running app has no code identity.") }
    var code: SecStaticCode?
    try check(SecCodeCopyStaticCode(parent, [], &code), "Could not read the running app's code")
    guard let code else { throw InstallError("The running app has no static code.") }
    var helper: SecCode?
    var helperStatic: SecStaticCode?
    try check(SecCodeCopySelf([], &helper), "Could not identify the updater")
    guard let helper else { throw InstallError("The updater has no code identity.") }
    try check(SecCodeCopyStaticCode(helper, [], &helperStatic), "Could not read the updater's code")
    guard let helperStatic, try team(code) == team(helperStatic) else { throw InstallError("The updater is not owned by the running app.") }
    var requirement: SecRequirement?
    try check(SecCodeCopyDesignatedRequirement(code, [], &requirement), "Could not read the running app's signature")
    guard let requirement else { throw InstallError("The running app has no designated requirement.") }
    return requirement
}

/// Checks the sealed resources and all nested code against the running app's signing requirement.
func verify(_ bundle: URL, _ requirement: SecRequirement) throws -> Data {
    var code: SecStaticCode?
    try check(SecStaticCodeCreateWithPath(bundle as CFURL, [], &code), "Could not read the update's signature")
    guard let code else { throw InstallError("The update has no code signature.") }
    let flags = SecCSFlags(rawValue: kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures)
    try check(SecStaticCodeCheckValidity(code, flags, requirement), "The update does not match MoPilot's signature")
    var signed: CFDictionary?
    try check(SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &signed), "Could not read the verified signature")
    guard let hash = (signed as? [String: Any])?[kSecCodeInfoUnique as String] as? Data else {
        throw InstallError("The update has no code directory hash.")
    }
    return hash
}

final class ParentExit {
    private let queue: Int32

    init(_ pid: pid_t) throws {
        let fd = kqueue()
        guard fd >= 0 else { throw InstallError("Could not watch MoPilot exit.") }
        var event = kevent(ident: UInt(pid), filter: Int16(EVFILT_PROC), flags: UInt16(EV_ADD | EV_ONESHOT), fflags: UInt32(NOTE_EXIT), data: 0, udata: nil)
        guard kevent(fd, &event, 1, nil, 0, nil) == 0 else {
            close(fd)
            throw InstallError("Could not watch MoPilot exit.")
        }
        queue = fd
    }

    deinit { close(queue) }

    func wait() throws {
        var event = kevent()
        var timeout = timespec(tv_sec: 60, tv_nsec: 0)
        guard kevent(queue, nil, 0, &event, 1, &timeout) == 1, event.fflags & UInt32(NOTE_EXIT) != 0 else {
            throw InstallError("MoPilot did not exit in time to activate the update.")
        }
    }
}

struct DirectoryIdentity: Equatable {
    let device: dev_t
    let inode: ino_t

    init(_ url: URL) throws {
        var info = stat()
        guard lstat(url.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR else {
            throw InstallError("An update directory disappeared or was replaced.")
        }
        device = info.st_dev
        inode = info.st_ino
    }
}

func relaunch(_ bundle: URL) -> Bool {
    // A fresh system process asks LaunchServices to reopen the installed path even though this helper moved.
    do {
        try run("/usr/bin/open", ["-a", bundle.path])
        return true
    } catch {
        return false
    }
}

func swap(_ first: URL, _ second: URL) throws {
    let firstDir = open(first.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    defer { if firstDir >= 0 { close(firstDir) } }
    let secondDir = open(second.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    defer { if secondDir >= 0 { close(secondDir) } }
    guard firstDir >= 0, secondDir >= 0,
          renameatx_np(firstDir, first.lastPathComponent, secondDir, second.lastPathComponent, UInt32(RENAME_SWAP)) == 0 else {
        throw InstallError("macOS could not swap the update into Applications (\(errno)).")
    }
}

func send(_ line: String) -> Bool {
    let data = Data("\(line)\n".utf8)
    return data.withUnsafeBytes { write(STDOUT_FILENO, $0.baseAddress, $0.count) } == data.count
}

/// A failed launch restores the previous bundle. If restoration fails, leave the backup on disk.
func activate(
    target: URL, candidate: URL, restart: Bool, keepBackup: inout Bool, launch: (URL) -> Bool = relaunch
) throws {
    try swap(target, candidate)
    if restart, !launch(target) {
        keepBackup = true
        try swap(target, candidate)
        keepBackup = false
        throw InstallError("macOS could not launch the update. The previous version was restored.")
    }
}

func prepareAndInstall(zip: URL, version: String, target: URL, parent: pid_t) throws {
    let fm = FileManager.default
    let exit = try ParentExit(parent)
    let requirement = try parentRequirement(parent)
    let original = try DirectoryIdentity(target)
    _ = try verify(target, requirement)
    let input = InstallerInput()
    let root = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: target, create: true)
    var keepBackup = false
    defer { if !keepBackup { try? fm.removeItem(at: root) } }
    guard try DirectoryIdentity(root).device == original.device else { throw InstallError("The update is on a different volume.") }
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
    try run("/usr/bin/ditto", ["--noqtn", "-xk", zip.path, root.path], environment: ["DITTOABORT": "1"], input: input)
    let apps = try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).filter { $0.pathExtension == "app" }
    guard apps.count == 1, let candidate = apps.first else { throw InstallError("The download must contain one app bundle.") }
    let staged = try DirectoryIdentity(candidate)
    let hash = try verify(candidate, requirement)
    guard let bundle = Bundle(url: candidate), let identifier = bundle.bundleIdentifier,
          identifier == Bundle(url: target)?.bundleIdentifier,
          bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version else {
        throw InstallError("The signed app does not match the offered update.")
    }
    // Run Gatekeeper's assessment before showing Restart to Update, while the original app is usable.
    try run("/usr/sbin/spctl", ["--assess", "--type", "execute", candidate.path], input: input)
    guard send("ready"), let action = input.decision(), send("accepted") else { return }
    try exit.wait()
    do {
        // Verify the owned copy immediately before activation so edits during staging or shutdown cannot carry over.
        guard try verify(candidate, requirement) == hash else { throw InstallError("The prepared update changed.") }
        guard try DirectoryIdentity(target) == original, try DirectoryIdentity(candidate) == staged else {
            throw InstallError("The installed app or prepared update changed before the swap.")
        }
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains(where: {
            $0.processIdentifier != parent && !$0.isTerminated && $0.bundleURL?.standardizedFileURL == target.standardizedFileURL
        }) else {
            throw InstallError("MoPilot was reopened before the update could be installed.")
        }
        try activate(target: target, candidate: candidate, restart: action == "restart", keepBackup: &keepBackup)
    } catch {
        if action == "restart", !keepBackup { _ = relaunch(target) }
        throw error
    }
}

do {
    signal(SIGPIPE, SIG_IGN)
    let args = CommandLine.arguments
    let parent = getppid()
    let target = URL(fileURLWithPath: args[0]).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    guard args.count == 3, geteuid() == getuid(), geteuid() != 0, parent > 1,
          target.pathExtension == "app", target.deletingLastPathComponent().path == "/Applications" else {
        throw InstallError("The updater must run from its installed app in Applications.")
    }
    try prepareAndInstall(zip: URL(fileURLWithPath: args[1]), version: args[2], target: target, parent: parent)
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    Darwin.exit(1)
}
