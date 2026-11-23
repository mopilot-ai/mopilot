import XCTest
@testable import HelperCore

/// Scripting-addition commands (StandardAdditions.osax) that AppleScript resolves inside `tell application id …`
/// (HelperCore/ScriptPolicy.swift, #3780): the ones that reach the file system, speakers or system volume outside the
/// named app are refused; the pure helpers (`path to`, `current date`, `delay`, …) stay allowed.
final class ScriptPolicyAdditionsTests: XCTestCase {
    /// A dictionary like Music's or Notes' (no `read`, `write`, `say` or `beep` of its own).
    private let plain = AppDictionary(properties: ["name", "volume"], commands: ["get", "count", "exists", "open"])

    private func outcome(_ s: String, _ dictionary: AppDictionary?) -> String {
        switch checkScript(s, language: .applescript, dictionary: { dictionary }) {
        case .success(let c): return "writes=\(c.writes)"
        case .failure(let r): return r.reason
        }
    }

    func testFileAndDiskCommandsAreRefused() {
        let file = "file access outside the app (read, write, open for access, info for, list folder)"
        for s in ["read POSIX file \"/etc/hosts\"", "read file \"Macintosh HD:etc:hosts\" as «class utf8»".replacingOccurrences(of: " as «class utf8»", with: ""),
                  "write \"x\" to POSIX file \"/tmp/x\"", "open for access POSIX file \"/tmp/x\" with write permission",
                  "close access 1", "get eof 1", "set eof 1 to 0", "info for POSIX file \"/etc/hosts\"", "list folder POSIX file \"/\"",
                  "list disks", "mount volume \"smb://host/share\"", "READ file \"x\"", "|read| file \"x\"", "|open for access| file \"x\"",
                  "set f to open for access file \"x\"", "tell x to read file \"y\"", "Info For file \"x\"", "|info for| file \"x\""] {
            XCTAssertEqual(outcome(s, plain), file, s)
        }
    }

    func testSpeechSoundsAndVolumeAreRefused() {
        let sound = "speech, sounds and the system volume (say, beep, set volume)"
        for s in ["say \"hi\"", "beep", "beep 3", "set volume 3", "set volume output volume 50", "set volume with output muted",
                  "set volume", "get volume settings", "SAY \"x\"", "|set volume| 3", "|get volume settings|"] {
            XCTAssertEqual(outcome(s, plain), sound, s)
        }
    }

    func testPureAdditionsAndTheAppsOwnWordsStayAllowed() {
        for s in ["delay 1", "get path to desktop", "path to resource \"x\"", "current date", "random number from 1 to 5", "round 1.5",
                  "ASCII character 65", "offset of \"a\" in \"banana\"", "time to GMT", "localized string \"x\"",
                  "get volume of document 1", "get name of every file of (path to desktop)",
                  "get \"read the file\" -- say beep", "set total to 0\nreturn total"] {
            XCTAssertEqual(outcome(s, plain), "writes=false", s)
        }
        // `set volume of …`/`set volume to …` is the app's own property (a write, not a refusal)
        XCTAssertEqual(outcome("set volume of document 1 to 3", plain), "writes=true")
        XCTAssertEqual(outcome("set volume to 3", plain), "writes=true")
    }

    func testAnAppThatDefinesTheTermKeepsItsOwn() {
        let iterm = AppDictionary(properties: [], commands: ["write", "get"], names: ["write"])
        XCTAssertEqual(outcome("write text \"ls\"", iterm), "writes=true")
        let speaker = AppDictionary(properties: [], commands: ["say", "beep", "read", "get"], names: ["say", "beep", "read"])
        XCTAssertEqual(outcome("say \"hi\"", speaker), "writes=true")
        XCTAssertEqual(outcome("read file 1", speaker), "writes=true")
        // the app defines `read` only: `write` still goes to the addition
        let reader = AppDictionary(properties: [], commands: ["read"], names: ["read"])
        XCTAssertEqual(outcome("write \"x\" to file 1", reader), "file access outside the app (read, write, open for access, info for, list folder)")
        // phrases are the addition's whatever the app defines
        XCTAssertEqual(outcome("info for file 1", AppDictionary(properties: [], commands: ["info"], names: ["info"])),
                       "file access outside the app (read, write, open for access, info for, list folder)")
    }

    /// Mail's property `read status` and Finder's enumerators `read only` / `read write` / `write only` begin with an
    /// addition's word: a script that spells the whole term is the app's, one that spells only the word is not.
    func testATermThatStartsWithTheWordIsTheApps() {
        let mail = AppDictionary(properties: ["read status"], commands: ["get", "count"], names: ["read status", "message"])
        let file = "file access outside the app (read, write, open for access, info for, list folder)"
        XCTAssertEqual(outcome("get read status of every message of inbox", mail), "writes=false")
        XCTAssertEqual(outcome("get every message whose read status is false", mail), "writes=false")
        XCTAssertEqual(outcome("set read status of message 1 to true", mail), "writes=true")
        XCTAssertEqual(outcome("read file 1", mail), file)
        XCTAssertEqual(outcome("get read status of message 1\nread file 1", mail), file)
        XCTAssertEqual(outcome("read status", AppDictionary(properties: [], commands: [], names: ["read status"])), "writes=false")
        XCTAssertEqual(outcome("get read", mail), file)
        let finder = AppDictionary(properties: ["privileges"], commands: ["get"], names: ["read only", "read write", "write only", "privileges"])
        XCTAssertEqual(outcome("get every file whose owner privileges is read only", finder), "writes=false")
        XCTAssertEqual(outcome("get every file whose group privileges is |read write|", finder), "writes=false")
        // (`write` is in the write-verb list, so naming that value makes the script a write: a fail-closed false positive)
        XCTAssertEqual(outcome("get every file whose group privileges is write only", finder), "writes=true")
        XCTAssertEqual(outcome("get every file whose group privileges is read write or read only", finder), "writes=true")
        // only the first word of a longer command is no claim on the addition's word (`write document`)
        let doc = AppDictionary(properties: [], commands: ["write", "get"], names: ["write document"])
        XCTAssertEqual(outcome("write \"x\" to POSIX file \"/tmp/x\"", doc), file)
        XCTAssertEqual(outcome("write document 1", doc), "writes=true")
        // a name that runs past the end of the script doesn't match
        XCTAssertEqual(outcome("write", doc), file)
    }

    func testWithoutADictionaryTheWordsAreRefused() {
        XCTAssertEqual(outcome("read file 1", nil), "file access outside the app (read, write, open for access, info for, list folder)")
        XCTAssertEqual(outcome("write \"x\" to file 1", nil), "file access outside the app (read, write, open for access, info for, list folder)")
        XCTAssertEqual(outcome("say \"x\"", nil), "speech, sounds and the system volume (say, beep, set volume)")
        XCTAssertEqual(outcome("beep", nil), "speech, sounds and the system volume (say, beep, set volume)")
    }

    func testTheDictionaryIsReadOnlyForTheBareWords() {
        var reads = 0
        let counted = { () -> AppDictionary? in reads += 1; return AppDictionary(properties: [], commands: ["get"]) }
        _ = checkScript("info for file 1", language: .applescript, dictionary: counted)
        _ = checkScript("set volume 3", language: .applescript, dictionary: counted)
        XCTAssertEqual(reads, 0)
        _ = checkScript("read file 1", language: .applescript, dictionary: counted)
        XCTAssertEqual(reads, 1)
        // JXA has no scripting additions without includeStandardAdditions, which is refused
        XCTAssertEqual(outcome("app.includeStandardAdditions = true; app.say('x');", plain).isEmpty, false)
        switch checkScript("app.includeStandardAdditions = true; app.say('x');", language: .javascript, dictionary: { self.plain }) {
        case .failure(let r): XCTAssertEqual(r.reason, "standard additions (the shell, dialogs, the clipboard)")
        case .success: XCTFail("includeStandardAdditions must stay refused")
        }
    }
}
