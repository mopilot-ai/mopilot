import XCTest
@testable import HelperCore

/// Commands of an app's scripting dictionary that no verb list knows (HelperCore/ScriptPolicy.swift, #3772): a script
/// that runs one is a write unless the dictionary says it only reads, and with no dictionary every script is a write.
final class ScriptPolicyCommandsTests: XCTestCase {
    /// Dictionaries as `sdef` reports them for Music, Messages and Safari (command first words, lowercased).
    private let music = AppDictionary(
        properties: ["name", "player state", "sound volume"],
        commands: ["next", "previous", "playpause", "resume", "rewind", "fast", "back", "search", "get", "count", "exists", "open"])

    private func check(_ s: String, _ lang: ScriptLanguage, _ dictionary: AppDictionary?,
                       file: StaticString = #filePath, line: UInt = #line) -> ScriptCheck? {
        switch checkScript(s, language: lang, dictionary: { dictionary }) {
        case .success(let c): return c
        case .failure(let r):
            XCTFail("refused \(s): \(r.reason)", file: file, line: line)
            return nil
        }
    }

    func testAppleScriptCommandsOutsideTheVerbListAreWrites() {
        for s in ["next track", "previous track", "playpause", "resume", "rewind", "fast forward", "back track", "search library playlist 1 for \"x\"",
                  "tell window 1 to next", "NEXT TRACK", "|next| track"] {
            XCTAssertEqual(check(s, .applescript, music)?.writes, true, s)
        }
        // commands that only read, and everything that isn't a command
        for s in ["get name of every track", "count tracks", "exists track 1", "return player state", "get sound volume",
                  "repeat with t in tracks\nget name of t\nend repeat", "set n to count of tracks\nreturn n",
                  "get \"next track\" -- next", "if (count of tracks) > 0 then get name of track 1"] {
            XCTAssertEqual(check(s, .applescript, music)?.writes, false, s)
        }
        // a verb the lists know stays a write without asking the dictionary
        XCTAssertEqual(check("delete track 1", .applescript, music), ScriptCheck(writes: true, irreversible: ["delete"]))
    }

    func testAppleScriptWithoutADictionaryIsAWrite() {
        for s in ["get name of every track", "count tracks", "return 1"] {
            XCTAssertEqual(check(s, .applescript, nil), ScriptCheck(writes: true, irreversible: []), s)
        }
    }

    func testJXACommandsOutsideTheVerbListAreWrites() {
        for s in ["app.next();", "app.playpause();", "app['playpause']();", "app.fastForward();", "app.backTrack();", "app.search(app.libraryPlaylists[0], {for: 'x'});",
                  "const n = app.next; n();", "const {resume} = app; resume();", "app?.rewind();", "app.Next();"] {
            XCTAssertEqual(check(s, .javascript, music)?.writes, true, s)
        }
        XCTAssertEqual(check("app.GetURL('x');", .javascript, AppDictionary(properties: [], commands: ["geturl"]))?.writes, true)
        for s in ["return app.tracks.name();", "return app.playerState();", "return app.tracks().length;", "return app.exists(app.tracks[0]);",
                  "return app.count(app.tracks);", "const t = app.tracks[0]; return [t.name(), t.artist()];", "return 'next'"] {
            XCTAssertEqual(check(s, .javascript, music)?.writes, false, s)
        }
        XCTAssertEqual(check("return app.name();", .javascript, nil), ScriptCheck(writes: true, irreversible: []))
        XCTAssertEqual(check("app.delete(app.tracks[0]);", .javascript, music), ScriptCheck(writes: true, irreversible: ["delete"]))
    }

    /// Terminal's dictionary defines `get URL` (opens a window): a command that merely starts with a read verb is a write,
    /// the bare read verbs are not, and `sdef` leaves the Cocoa standard suite out for apps like Notes.
    func testCommandsLedByAReadVerbAndPipedNames() {
        let xml = """
        <dictionary><suite name="Terminal Suite" code="trmx">
        <command name="get URL" code="GURLGURL"/><command name="do script" code="coredosc"/>
        <command name="get" code="coregetd"/><command name="exists" code="coredoex"/><command name="fast forward" code="hookFast"/>
        <command name="extract address from" code="emalxadr"/><command name="count" code="corecnte"/>
        </suite></dictionary>
        """
        let terminal = sdefDictionary(Data(xml.utf8))
        XCTAssertEqual(terminal?.readLedCommands, ["geturl"])
        for s in ["get URL \"ssh://host\"", "get url \"x\"", "GET |URL| \"x\"", "|get url| \"x\""] {
            XCTAssertEqual(check(s, .applescript, terminal)?.writes, true, s)
        }
        for s in ["app.getURL('ssh://host');", "app['getURL']('x');"] {
            XCTAssertEqual(check(s, .javascript, terminal)?.writes, true, s)
        }
        for s in ["get name of window 1", "get contents of tab 1 of window 1", "count windows", "exists window 1", "get",
                  "extract address from \"a <b@c.d>\"", "get a\\nURL"] {
            XCTAssertEqual(check(s, .applescript, terminal)?.writes, false, s)
        }
        XCTAssertEqual(check("|fast forward|", .applescript, terminal)?.writes, true)
        XCTAssertEqual(check("app.fastForward();", .javascript, terminal)?.writes, true)
        // the read verb alone, or followed by words that don't make a command, is a read (`extract` is a read in every form)
        XCTAssertEqual(check("get one two three four five", .applescript, terminal)?.writes, false)
        XCTAssertEqual(check("return app.get;", .javascript, terminal)?.writes, false)
        // `reopen` is in no dictionary (the required suite) but is a write
        XCTAssertEqual(check("reopen", .applescript, AppDictionary(properties: [], commands: []))?.writes, true)
        XCTAssertEqual(check("app.reopen();", .javascript, AppDictionary(properties: [], commands: []))?.writes, true)
    }
}
