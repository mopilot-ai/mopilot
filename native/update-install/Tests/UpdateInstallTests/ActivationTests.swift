// Exercises the real same-volume bundle swap and its rollback with scratch directories.
import Foundation
import Security
import XCTest
@testable import update_install

final class ActivationTests: XCTestCase {
    func testTheRealSignatureCheckRejectsAnotherIdentity() throws {
        try withBundles { _, staged in
            let executable = staged.appendingPathComponent("signed-fixture")
            try FileManager.default.copyItem(at: URL(fileURLWithPath: "/bin/echo"), to: executable)
            func sign(_ name: String) throws {
                try update_install.run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", name, executable.path])
            }
            var requirement: SecRequirement?
            try check(SecRequirementCreateWithString("identifier \"example.staged\"" as CFString, [], &requirement), "Test requirement")
            let trusted = try XCTUnwrap(requirement)
            try sign("example.staged")
            XCTAssertFalse(try verify(executable, trusted).isEmpty)
            try sign("example.other")
            XCTAssertThrowsError(try verify(executable, trusted))
        }
    }

    func testParentWatcherObservesTheCapturedProcessExit() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["10"]
        try process.run()
        let exit = try ParentExit(process.processIdentifier)
        process.terminate()
        try exit.wait()
        process.waitUntilExit()
    }

    func testClosingTheCommandPipeStopsTheCurrentPreparationTool() throws {
        let cancel = DispatchSemaphore(value: 0)
        let input = InstallerInput {
            cancel.wait()
            return nil
        }
        let tool = PreparationTool(executable: "/bin/sleep", arguments: ["10"], environment: nil)
        let pid = try input.start(tool)
        let group = getpgid(pid)
        cancel.signal()
        XCTAssertNil(input.decision())
        var result = siginfo_t()
        XCTAssertEqual(waitid(P_PID, id_t(pid), &result, WEXITED | WNOWAIT), 0)
        XCTAssertEqual(group, getpgrp(), "forced cancellation must reach the extractor")
        XCTAssertEqual(result.si_status, SIGKILL)
        XCTAssertThrowsError(try input.checked())
        XCTAssertEqual(waitpid(pid, nil, 0), pid)
    }

    func testReplacesTheBundleWithOneRenameAndLaunchesTheInstalledPath() throws {
        try withBundles { old, new in
            var keepBackup = false
            var launched: URL?
            try activate(target: old, candidate: new, restart: true, keepBackup: &keepBackup) { bundle in
                launched = bundle
                XCTAssertEqual(try? self.version(bundle), "new")
                return true
            }
            XCTAssertEqual(launched, old)
            XCTAssertEqual(try version(new), "old")
            XCTAssertFalse(keepBackup)
        }
    }

    func testLaunchFailureRestoresThePreviousVersion() throws {
        try withBundles { old, new in
            var keepBackup = false
            XCTAssertThrowsError(try activate(target: old, candidate: new, restart: true, keepBackup: &keepBackup) { _ in false })
            XCTAssertEqual(try version(old), "old")
            XCTAssertEqual(try version(new), "new")
            XCTAssertFalse(keepBackup)
        }
    }

    func testOrdinaryQuitInstallsWithoutRelaunching() throws {
        try withBundles { old, new in
            var keepBackup = false
            try activate(target: old, candidate: new, restart: false, keepBackup: &keepBackup) { _ in
                XCTFail("ordinary quit does not reopen the app")
                return false
            }
            XCTAssertEqual(try version(old), "new")
        }
    }

    private func withBundles(_ body: (URL, URL) throws -> Void) throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let old = root.appendingPathComponent("installed/MoPilot.app")
        let new = root.appendingPathComponent("staged/MoPilot.app")
        defer { try? fm.removeItem(at: root) }
        for (bundle, version) in [(old, "old"), (new, "new")] {
            try fm.createDirectory(at: bundle, withIntermediateDirectories: true)
            try Data(version.utf8).write(to: bundle.appendingPathComponent("version"))
        }
        try body(old, new)
    }

    private func version(_ bundle: URL) throws -> String {
        try String(contentsOf: bundle.appendingPathComponent("version"), encoding: .utf8)
    }
}
