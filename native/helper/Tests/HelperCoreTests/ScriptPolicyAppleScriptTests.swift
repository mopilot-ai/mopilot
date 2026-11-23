import XCTest
@testable import HelperCore

/// How the AppleScript half of app.script's static check classifies `set <word> to …` (HelperCore/ScriptPolicy.swift,
/// #3726): the app's property (a write) or the script's own variable, and the scripting dictionary it asks.
final class ScriptPolicyAppleScriptTests: XCTestCase {
    private func allowed(_ s: String, props: Set<String>? = nil, file: StaticString = #filePath, line: UInt = #line) -> ScriptCheck? {
        switch checkScript(s, language: .applescript, dictionary: { props.map { AppDictionary(properties: $0, commands: []) } }) {
        case .success(let c): return c
        case .failure(let r):
            XCTFail("refused \(s): \(r.reason)", file: file, line: line)
            return nil
        }
    }

    /// #3726: inside the tell, `set <word> to …` sets the app's property when the app has one by that name, and is a
    /// local variable otherwise (or when the script declares it). Without the app's dictionary it is a write.
    func testAppleScriptSetOfAWordIsAPropertyOrALocal() {
        let finder: Set<String> = ["name", "frontmost", "selection", "visible", "version"]
        for s in ["set frontmost to true", "set selection to {}", "set visible to false", "SET Name TO \"x\"", "set |name| to \"x\""] {
            XCTAssertEqual(allowed(s, props: finder)?.writes, true, s)
        }
        // a name the app has no property by is a local variable, and so is any name the script declares
        XCTAssertEqual(allowed("set total to 0\nset total to total + 1\nreturn total", props: finder)?.writes, false)
        XCTAssertEqual(allowed("local frontmost\nset frontmost to true", props: finder)?.writes, false)
        XCTAssertEqual(allowed("global a, name, b\nset name to \"x\"", props: finder)?.writes, false)
        XCTAssertEqual(allowed("property selection : 1\nset selection to 2", props: finder)?.writes, false)
        XCTAssertEqual(allowed("repeat with visible from 1 to 3\nset visible to 2\nend repeat", props: finder)?.writes, false)
        XCTAssertEqual(allowed("repeat with visible in {1}\nset visible to 2\nend repeat", props: finder)?.writes, false)
        // declarations the tokens can't place are not trusted: a read of a property, `on error` (no line breaks in
        // the tokens), a repeat that isn't `with a from|in`, and handlers (a `local` in one must not hide the top level)
        for s in ["get property frontmost of it\nset frontmost to true",
                  "try\nget 1\non error\nvisible\nset visible to true\nend try",
                  "try\nget 1\non error name\nset name to 2\nend try",
                  "repeat with visible\nset visible to true",
                  "property frontmost\nset frontmost to true",
                  "on foo()\nlocal frontmost\nend foo\nset frontmost to true",
                  "to foo()\nlocal frontmost\nend foo\nset frontmost to true"] {
            XCTAssertEqual(allowed(s, props: finder)?.writes, true, s)
        }
        // `on` and `to` that are not handlers leave declarations alone
        XCTAssertEqual(allowed("tell x to count windows\nlocal visible\nset visible to 1\ntry\nget 1\non error\nend try\non", props: finder)?.writes, false)
        // the Cocoa standard suite, which `sdef` leaves out for many apps, is always a property
        for s in ["set zoomable to true", "set closeable to false", "set document to 1"] {
            XCTAssertEqual(allowed(s, props: ["name"])?.writes, true, s)
        }
        // a declaration of one name leaves the others alone
        XCTAssertEqual(allowed("local a\nset frontmost to true", props: finder)?.writes, true)
        XCTAssertEqual(allowed("local a, b\nset b to 1\nset selection to 1", props: finder)?.writes, true)
        // a base set of properties every app has applies even when its dictionary doesn't list them
        for s in ["set name to \"x\"", "set index to 1", "set bounds to {0, 0, 1, 1}", "set text to \"x\"", "set contents to \"x\""] {
            XCTAssertEqual(allowed(s, props: [])?.writes, true, s)
        }
        // no dictionary (none installed, unreadable): every undeclared name is a property, so it is a write
        XCTAssertEqual(allowed("set total to 0", props: nil)?.writes, true)
        XCTAssertEqual(allowed("local total\nset total to 0", props: nil)?.writes, true)
        // the dictionary is read at most once, and only when a bare `set <word> to` needs it
        var reads = 0
        let lazy = { () -> AppDictionary? in reads += 1; return AppDictionary(properties: ["name"], commands: []) }
        _ = checkScript("set a to 1\nset b to 2\nset name to 3", language: .applescript, dictionary: lazy)
        XCTAssertEqual(reads, 1)
        // a script a verb already marks as a write needs no dictionary unless a bare `set <word> to` asks
        _ = checkScript("set name of window 1 to \"x\"\nset {a, b} to {1, 2}\nlocal c\nset c to 1", language: .applescript, dictionary: lazy)
        XCTAssertEqual(reads, 1)
        _ = checkScript("delete window 1", language: .applescript, dictionary: lazy)
        XCTAssertEqual(reads, 1)
        // any other script reads it once, for the commands
        _ = checkScript("get name of window 1\ncount windows", language: .applescript, dictionary: lazy)
        XCTAssertEqual(reads, 2)
        // other forms of `set` stay writes
        for s in ["set the name of window 1 to \"x\"", "set x's name to \"y\"", "set {a, b} to {1, 2}", "set a, b to 1", "set a", "set"] {
            XCTAssertEqual(allowed(s, props: ["zzz"])?.writes, true, s)
        }
    }

    /// What `sdef` prints becomes the dictionary the check asks: property names and command first words, lowercased.
    func testSdefDictionary() {
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <dictionary title="Finder"><suite name="Finder Basics" code="fndr">
        <class name="application" code="capp" plural="items"><property name="Frontmost" code="pisf" type="boolean"/>
        <property name="selected text" code="stxt"/><element type="item"/></class>
        <class-extension extends="item"><property name="name" code="pnam"/></class-extension>
        <command name="open" code="aevtodoc"><direct-parameter type="specifier"/></command>
        <command name="Fast Forward" code="hookFast"/><event name="GetURL" code="GURLGURL"/>
        <enumeration name="saveable file format"><enumerator name="text"/></enumeration>
        </suite></dictionary>
        """
        XCTAssertEqual(sdefDictionary(Data(xml.utf8)),
                       AppDictionary(properties: ["frontmost", "selected text", "name"], commands: ["open", "fast", "geturl"],
                                     names: ["frontmost", "selected text", "name", "application", "text", "open", "fast forward", "geturl", "items"]))
        XCTAssertEqual(sdefDictionary(Data("<dictionary/>".utf8)), AppDictionary(properties: [], commands: []))
        XCTAssertNil(sdefDictionary(Data("<dictionary><class>".utf8)))
        XCTAssertNil(sdefDictionary(Data()))
    }
}
