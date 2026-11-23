import XCTest
@testable import HelperCore

/// The static check app.script runs before a script reaches osascript (HelperCore/ScriptPolicy.swift, #3571 G7): what
/// is refused, what counts as a write or as something that can't be undone, and the wrapper that names one app.
final class ScriptPolicyTests: XCTestCase {
    private func refused(_ s: String, _ lang: ScriptLanguage = .applescript, file: StaticString = #filePath, line: UInt = #line) -> String? {
        if case .failure(let r) = checkScript(s, language: lang, dictionary: { AppDictionary(properties: [], commands: []) }) { return r.reason }
        XCTFail("expected a refusal: \(s)", file: file, line: line)
        return nil
    }

    private func allowed(_ s: String, _ lang: ScriptLanguage = .applescript, props: Set<String> = [],
                         file: StaticString = #filePath, line: UInt = #line) -> ScriptCheck? {
        switch checkScript(s, language: lang, dictionary: { AppDictionary(properties: props, commands: []) }) {
        case .success(let c): return c
        case .failure(let r):
            XCTFail("refused \(s): \(r.reason)", file: file, line: line)
            return nil
        }
    }

    func testLanguageParsing() {
        XCTAssertEqual(ScriptLanguage.parse(nil), .applescript)
        XCTAssertEqual(ScriptLanguage.parse(""), .applescript)
        XCTAssertEqual(ScriptLanguage.parse("AppleScript"), .applescript)
        XCTAssertEqual(ScriptLanguage.parse("as"), .applescript)
        XCTAssertEqual(ScriptLanguage.parse("JXA"), .javascript)
        XCTAssertEqual(ScriptLanguage.parse("js"), .javascript)
        XCTAssertEqual(ScriptLanguage.parse("javascript"), .javascript)
        XCTAssertNil(ScriptLanguage.parse("python"))
        XCTAssertNil(ScriptLanguage.parse(3))
        XCTAssertEqual(ScriptLanguage.applescript.osaName, "AppleScript")
        XCTAssertEqual(ScriptLanguage.javascript.osaName, "JavaScript")
    }

    func testScriptableReadsTheInfoPlist() {
        XCTAssertFalse(isScriptable(info: nil))
        XCTAssertFalse(isScriptable(info: [:]))
        XCTAssertTrue(isScriptable(info: ["OSAScriptingDefinition": "Finder.sdef"]))
        XCTAssertFalse(isScriptable(info: ["OSAScriptingDefinition": ""]))
        XCTAssertTrue(isScriptable(info: ["NSAppleScriptEnabled": true]))
        XCTAssertFalse(isScriptable(info: ["NSAppleScriptEnabled": false]))
        XCTAssertTrue(isScriptable(info: ["NSAppleScriptEnabled": "YES"]))
        XCTAssertFalse(isScriptable(info: ["NSAppleScriptEnabled": "no"]))
        XCTAssertTrue(isScriptable(info: ["NSAppleScriptEnabled": NSNumber(value: 1)]))
        XCTAssertTrue(isScriptable(info: ["NSAppleScriptEnabled": "1"]))
        XCTAssertFalse(isScriptable(info: ["NSAppleScriptEnabled": [1]]))
    }

    // MARK: AppleScript

    func testAppleScriptReadsAreAllowedAsReads() {
        let c = allowed("get name of every file of folder \"Downloads\" of home")
        XCTAssertEqual(c, ScriptCheck(writes: false, irreversible: []))
        XCTAssertEqual(c?.json["ok"] as? Bool, true)
        // a local variable, comments of every kind, and the denied words inside strings and comments
        let local = allowed("""
        -- do shell script "x"
        # tell application "System Events"
        (* nested (* do shell script *) application *)
        set total to count of windows
        return "do shell script tell application"
        """, props: ["name"])
        XCTAssertEqual(local?.writes, false)
        XCTAssertEqual(allowed("count (documents) ¬\n + 1.5")?.writes, false)
    }

    func testAppleScriptWritesNeedTheFullTier() {
        // the f2-onboarding step: copy the PDF into signed/ and rename it
        let f2 = allowed("""
        set f to duplicate file "statement.pdf" of folder "Downloads" of home to folder "signed" of home
        set name of f to "statement-signed.pdf"
        """)
        XCTAssertEqual(f2, ScriptCheck(writes: true, irreversible: []))
        XCTAssertEqual(allowed("set name of document 1 to \"x\"")?.writes, true)
        XCTAssertEqual(allowed("set")?.writes, true)
        XCTAssertEqual(allowed("set |my var| to 3", props: ["name"])?.writes, false)
        XCTAssertEqual(allowed("make new document with properties {text:\"hi\"}")?.writes, true)
    }

    func testAppleScriptIrreversibleVerbs() {
        XCTAssertEqual(allowed("delete file \"a\" of desktop"), ScriptCheck(writes: true, irreversible: ["delete"]))
        XCTAssertEqual(allowed("move file \"a\" of desktop to trash\nempty trash")?.irreversible, ["trash", "empty"])
        // a word that is only irreversible still makes the script a write
        XCTAssertEqual(allowed("get trash"), ScriptCheck(writes: true, irreversible: ["trash"]))
        XCTAssertEqual(allowed("delete a\ndelete b")?.irreversible, ["delete"])
    }

    func testAppleScriptRefusals() {
        XCTAssertEqual(refused("do shell script \"rm -rf ~\""), "do shell script")
        XCTAssertNotNil(refused("tell application \"System Events\" to keystroke \"q\""))
        XCTAssertNotNil(refused("tell app \"Mail\" to quit"))
        XCTAssertNotNil(refused("run script \"x\""))
        XCTAssertNotNil(refused("use framework \"Foundation\""))
        XCTAssertNotNil(refused("use scripting additions"))
        XCTAssertNotNil(refused("keystroke \"a\""))
        XCTAssertNotNil(refused("get system info"))
        XCTAssertNotNil(refused("set the clipboard to \"x\""))
        XCTAssertNotNil(refused("display dialog \"hi\""))
        XCTAssertNotNil(refused("choose file"))
        XCTAssertNotNil(refused("open location \"https://example.com\""))
        XCTAssertNotNil(refused("get osax"))
        XCTAssertEqual(refused("key code 12"), "synthesized key codes (System Events)")
        XCTAssertNotNil(refused("key down command"))
        XCTAssertNotNil(refused("key up command"))
        XCTAssertNotNil(refused("get |application|"))
        XCTAssertEqual(refused("«event sysoexec» \"ls\""), "raw Apple event codes («…»)")
        XCTAssertEqual(refused("get \"abc"), "an unterminated string")
        XCTAssertEqual(refused("get |abc"), "an unterminated |identifier|")
        XCTAssertEqual(refused("(* open (* *)"), "an unterminated (* comment")
        // a key that isn't followed by code/down/up is just a word
        XCTAssertEqual(allowed("get key of x")?.writes, false)
        XCTAssertEqual(allowed("get key")?.writes, false)
        // a lone "-" or "(" at the very end
        XCTAssertEqual(allowed("get x -")?.writes, false)
        XCTAssertEqual(allowed("get (")?.writes, false)
    }

    func testAppleScriptStringsWithEscapesAndCurlyQuotes() {
        let t = try? appleScriptTokens("get \"a\\\"b\" & “c”")
        XCTAssertEqual(t, [.word("get"), .string("a\"b"), .punct("&"), .string("c")])
    }

    // MARK: JXA

    func testJXAReadsAndWrites() {
        XCTAssertEqual(allowed("return app.documents.name();", .javascript), ScriptCheck(writes: false, irreversible: []))
        XCTAssertEqual(allowed("app.documents[0].name = 'x'; return 1;", .javascript)?.writes, true)
        XCTAssertEqual(allowed("const ok = app.windows.length == 1; return ok;", .javascript)?.writes, false)
        XCTAssertEqual(allowed("const f = (a) => a; if (x.y === 2) {} return f(1);", .javascript)?.writes, false)
        XCTAssertEqual(allowed("app.make({new: 'document'});", .javascript)?.writes, true)
        XCTAssertEqual(allowed("app.delete(app.files['a.txt']);", .javascript), ScriptCheck(writes: true, irreversible: ["delete"]))
        XCTAssertEqual(allowed("app.delete(a); app.delete(b);", .javascript)?.irreversible, ["delete"])
        // a verb that isn't a property name (a local variable) isn't a write
        XCTAssertEqual(allowed("const make = 1; return make;", .javascript)?.writes, false)
        // comments and strings
        XCTAssertEqual(allowed("// Application('x')\n/* ObjC */ return \"doShellScript\" + 'with';", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return [1, 2].map(n => n * 2)[0] + 1e3;", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return x[\"name\"];", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return [a][0];", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return f([a, b]);", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return a.b[1];", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return [3];", .javascript)?.writes, false)
        XCTAssertEqual(allowed("const q = 'a'; return q;", .javascript)?.writes, false)
        XCTAssertEqual(allowed("[x, y] = [1, 2];", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return 'abc'[0] + 1 /", .javascript)?.writes, false)
    }

    /// #3664: every spelling that reaches the same property of the app has the same classification as the dot spelling.
    func testJXAEquivalentSpellingsClassifyAlike() {
        let deleteCall = ScriptCheck(writes: true, irreversible: ["delete"])
        for s in [
            "app.delete(app.files[0]);",
            "app[\"delete\"](app.files[0]);",
            "app['delete'](app.files[0]);",
            "app.files[0][\"delete\"]();",
            // a reference to the verb, called later (an alias, call/apply/bind)
            "const d = app.delete; d(app.files[0]);",
            "const d = app['delete']; d(app.files[0]);",
            "app.delete.call(app, app.files[0]);",
            "app['delete'].apply(app, [app.files[0]]);",
            // destructuring the verb out of the app
            "const {delete: d} = app; d(app.files[0]);",
            "const {'delete': d} = app; d(app.files[0]);",
            "const {[\"delete\"]: d} = app; d(app.files[0]);",
            "const f = ({delete: d}) => d(app.files[0]); f(app);",
        ] {
            XCTAssertEqual(allowed(s, .javascript), deleteCall, s)
        }
        XCTAssertEqual(allowed("const {send, quit} = app; quit();", .javascript), ScriptCheck(writes: true, irreversible: ["send"]))
        XCTAssertEqual(allowed("app['make']({new: 'document'});", .javascript), ScriptCheck(writes: true, irreversible: []))
        XCTAssertEqual(allowed("const {make: m} = app; m();", .javascript)?.writes, true)
        // a multi-word command in camel case (doJavaScript, deleteMessage, emptyTrash) is its first word's verb
        XCTAssertEqual(allowed("app.doJavaScript('1', {in: app.windows[0].currentTab});", .javascript)?.writes, true)
        XCTAssertEqual(allowed("app['doJavaScript']('1');", .javascript)?.writes, true)
        XCTAssertEqual(allowed("app.emptyTrash();", .javascript), ScriptCheck(writes: true, irreversible: ["empty"]))
        XCTAssertEqual(allowed("app.deleteMessage(m);", .javascript), ScriptCheck(writes: true, irreversible: ["deletemessage"]))
        // the generic set command
        XCTAssertEqual(allowed("app.set(app.windows[0].name, {to: 'x'});", .javascript)?.writes, true)

        // property sets: dot, literal computed, compound, increments, destructuring and for-in/of targets
        for s in [
            "app.documents[0].name = 'x';",
            "app.documents[0][\"name\"] = 'x';",
            "app.documents[0]['name'] = 'x';",
            "app.documents[0] = 'x';",
            "app.windows[0].index += 1;",
            "app.windows[0]['index'] -= 1;",
            "app.windows[0].index **= 2;",
            "app.windows[0].index <<= 1;",
            "app.windows[0].index >>>= 1;",
            "app.windows[0].visible ||= true;",
            "app.windows[0].visible &&= false;",
            "app.windows[0].name ??= 'x';",
            "app.windows[0].index++;",
            "app.windows[0]['index']--;",
            "++app.windows[0].index;",
            "--app.windows[0]['index'];",
            "++(app.windows[0].index);",
            "({a: app.documents[0].name} = {a: 'x'});",
            "[app.documents[0].name] = ['x'];",
            "[app.documents[0]['name']] = ['x'];",
            "for (app.documents[0].name of ['x']) {}",
            "for (app.documents[0]['name'] in {x: 1}) {}",
            "for ([app.documents[0].name] of [['x']]) {}",
            "for (app.documents[0].name of [('a' in x) ? 1 : 2]) {}",
            "delete app.documents[0].name;",
            "delete app.documents[0]['name'];",
            "delete (app.documents[0].name);",
            "let a = [0]; [a[0]] = [1];",
        ] {
            XCTAssertEqual(allowed(s, .javascript), ScriptCheck(writes: true, irreversible: []), s)
        }

        // reads stay reads in every spelling
        for s in [
            "return app.documents[0].name();",
            "return app.documents[0]['name']();",
            "return app['documents'][0].name();",
            "const {name} = app.documents[0]; return name();",
            "const {name: n, ['index']: i} = app.windows[0]; return n() + i();",
            "return app.windows[0].index == 1 || app.windows[0]['index'] === 2;",
            "return app.windows[0].index <= 1 && app.windows[0]['index'] >= 0 && x.y != 3 && x['y'] !== 4;",
            "return app.windows[0].index < -1 ? 'a' : 'b';",
            "const f = (w) => w.name(); return app.windows().map(f);",
            "let n = 0; n++; --n; n += 1; return n;",
            "const [a, b] = [1, 2]; let {c} = {c: 3}; var [d] = [app.name()]; return a + b + c + d;",
            "for (const w of app.windows()) { w.name(); }",
            "for (let i = 0; i < 2; i++) {} for (var k in {a: 1}) {} for (w of app.windows()) {}",
            "for (i = f(x.y in o); i < 2; i++) {} for (;;) { break; } for ([a] of [[1]]) {}",
            "return x[0] - 1 > 0 && (x.y) && f(-(1));",
            "return x ? 'delete' : 'send';",
            "const sending = 1; return {sending, label: 'send'};",
            "return \"delete\" in app;",
            "[[a]] = [[1]]; for () {} let n = 0; n++",
            "a } = 1",
        ] {
            XCTAssertEqual(allowed(s, .javascript), ScriptCheck(writes: false, irreversible: []), s)
        }
    }

    /// #3664 review: the tokenizer reads a script as JavaScript does, so an escape, a regular expression or a number
    /// can't hide a name from the check.
    func testJXATokensReadAsJavaScriptDoes() {
        let deleteCall = ScriptCheck(writes: true, irreversible: ["delete"])
        for s in [
            #"app["delete"](x);"#,
            #"app["\x64elete"](x);"#,
            #"app["\u{64}elete"](x);"#,
            #"app['\u{0064}el\ete'](x);"#,
            "app[\"del\\\nete\"](x);",
            #"var {"delete": d} = app; d(x);"#,
            #"var r = /"/; app.delete(x); /"/;"#,
            #"var r = /[//]/; app.delete(x);"#,
            #"var r = /[/*]/g; app.delete(x); /[*/]/;"#,
            #"var r = /a\/b/i; app.delete(x);"#,
            #"return [/x/.test(a), 4 / 2 / 1, (a) / 2, a[0] / 2, app.delete(x)];"#,
        ] {
            XCTAssertEqual(allowed(s, .javascript), deleteCall, s)
        }
        XCTAssertEqual(try? jxaTokens(#"'\n\t\r\b\f\v\0\'\q'"#), [.string("\n\t\r\u{8}\u{C}\u{B}\u{0}'q")])
        XCTAssertEqual(try? jxaTokens("x = /a[/]b/gi + 1n + 0x1F + 0b1_0 + 1.5e-3 + 2E+2 + 1..y"),
                       [.word("x"), .punct("="), .regex, .punct("+"), .number, .punct("+"), .number, .punct("+"), .number,
                        .punct("+"), .number, .punct("+"), .number, .punct("+"), .number, .punct("."), .word("y")])
        // escapes that build a refused name are refused
        XCTAssertNotNil(refused(#"[]["constructor"]["constructor"]("return 1")();"#, .javascript))
        XCTAssertNotNil(refused(#"x['\x5f_proto__'];"#, .javascript))
        XCTAssertNotNil(refused("1..constructor.constructor('return 1')();", .javascript))
        XCTAssertEqual(refused("1.constructor", .javascript), "a number run into a name")
        XCTAssertEqual(refused("return 1x;", .javascript), "a number run into a name")
        XCTAssertEqual(refused("var r = /abc", .javascript), "an unterminated regular expression")
        XCTAssertEqual(refused("var r = /a\nb/;", .javascript), "an unterminated regular expression")
        XCTAssertEqual(refused("var r = /a\\", .javascript), "an unterminated regular expression")
        for bad in [#"'\u00'"#, #"'\xZ1'"#, #"'\u{}'"#, #"'\u{64'"#, #"'\uD800'"#, "'\\"] {
            XCTAssertNotNil(refused(bad, .javascript), bad)
        }
        // `of` is a keyword only in a for head; async functions are refused
        XCTAssertEqual(refused("var of = app.documents[0]; of['name'] = 'x';", .javascript), "`of` as a name")
        XCTAssertEqual(refused("const f = (of) => 1;", .javascript), "`of` as a name")
        XCTAssertNotNil(refused("async function f() { for await (app.name of [1]) {} }", .javascript))
        XCTAssertNotNil(refused("var await = 1;", .javascript))
        XCTAssertEqual(allowed("for (const [a, b] of [[1, 2]]) {} for (const x of [1]) {} return 1;", .javascript)?.writes, false)

        // parenthesized and optional-chained targets
        for s in [
            "(app.name) = 'x';",
            "(app['name']) = 'x';",
            "(app.name)++;",
            "delete (app).name;",
            "delete app?.name;",
            "delete app?.['name'];",
            "delete f(x);",
            "delete a[0];",
            "++app?.windows[0].index;",
        ] {
            XCTAssertEqual(allowed(s, .javascript), ScriptCheck(writes: true, irreversible: []), s)
        }
        XCTAssertEqual(allowed("return app?.['delete'];", .javascript), deleteCall)
        XCTAssertNotNil(refused("x?.['constr' + 'uctor']", .javascript))
        // a class of the app's dictionary makes a new element (app.documents.push(app.Document(…)))
        XCTAssertEqual(allowed("app.documents.push(app.Document({name: 'x'}));", .javascript)?.writes, true)
        XCTAssertEqual(allowed("const {Document: D} = app; app.documents.push(D());", .javascript)?.writes, true)
        XCTAssertEqual(allowed("return app['Document'];", .javascript)?.writes, true)
        // reads stay reads
        for s in ["return (a) + (b.c) == 1;", "delete x; delete ++n; ++i; --j + 1;", "return f(a.b) => 1;", "return [a.b] == c;", "return {a: x.y} === z;", "/a/.test('a');", "delete (a"] {
            XCTAssertEqual(allowed(s, .javascript), ScriptCheck(writes: false, irreversible: []), s)
        }
    }

    /// #3664 second review: where a `/` starts a regular expression, HTML-like comments and combining marks.
    func testJXASlashesCommentsAndScalars() {
        let deleteCall = ScriptCheck(writes: true, irreversible: ["delete"])
        for s in [
            #"if (1) /"/.test(1); app.delete(1); if (1) /"/.test(2);"#,
            #"while (0) /"/; app.delete(1); for (;0;) /"/;"#,
            #"a.return / 2; app.delete(1); b = 1 / 3;"#,
            #"a?.in / 2; app.delete(1); b = 1 / 3;"#,
            #"f(1) / 2; app.delete(1); b = 1 / 3;"#,
            #"x = (1) / 2; app.delete(1); b = 1 / 3;"#,
            "x = typeof /\"/; app.delete(1); /\"/;",
            "\"\u{301}\"; app.delete(1); \"a\"; // \"",
            "app.delete(1); /* a\u{2028}b */ x",
        ] {
            XCTAssertEqual(allowed(s, .javascript), deleteCall, s)
        }
        XCTAssertEqual(refused("a = {} / 2; app.delete(1); b = 1 / 3;", .javascript), "a / right after } or ++/-- (add parentheses)")
        XCTAssertEqual(refused("n++ / 2; app.delete(1); b = 1 / 3;", .javascript), "a / right after } or ++/-- (add parentheses)")
        XCTAssertEqual(allowed("n + /a/.lastIndex; n - /b/.lastIndex; return n;", .javascript)?.writes, false)
        XCTAssertEqual(allowed("return (1 / 2) + ((x)) / 3 + a / b;", .javascript)?.writes, false)
        XCTAssertEqual(allowed(") / 2", .javascript)?.writes, false)
        for s in ["var x=1; <!-- /*\napp.delete(1)\nx = 1 // */", "x = 1;\n  --> /*\napp.delete(1) // */", "--> x", "/* a\n */ --> x"] {
            XCTAssertEqual(refused(s, .javascript), "HTML-like comments (<!-- and -->)", s)
        }
        // `-->` in the middle of a line is x-- > 0; after a one-line comment it is not at a line start
        XCTAssertEqual(allowed("let x = 2; while (x-->0) {} /* a */ x-->0; return x;", .javascript)?.writes, false)
        XCTAssertEqual(allowed("let x = 2; /* a */ x-->0; return x;", .javascript)?.writes, false)
        // escapes: a surrogate pair is one character; a lone or unpaired surrogate, or a non-hex digit, is refused
        XCTAssertEqual(try? jxaTokens(#"''"# + "'c" + "\\"), nil)
        XCTAssertEqual(try? jxaTokens(#"'\uD83D\uDE00' "\u{1F600}" '\"# + "\r\n" + "'"), [.string("\u{1F600}"), .string("\u{1F600}"), .string("")])
        for bad in [#"'\uD83D\u0041'"#, #"'\uD83D'"#, #"'\u{+41}'"#, #"'\x+4'"#, #"'\u{110000}'"#] {
            XCTAssertNotNil(refused(bad, .javascript), bad)
        }
        XCTAssertEqual(try? jxaTokens("x\u{200D}y"), [.word("x\u{200D}y")])
        XCTAssertNil(try? jxaTokens("x = ٣"))
    }

    /// #3664 third review (differential against JavaScriptCore): U+FEFF, `instanceof` and keyword-named methods.
    func testJXAThirdReviewCases() {
        XCTAssertEqual(allowed("app.\u{FEFF}make({});", .javascript)?.writes, true)
        XCTAssertEqual(allowed("app.name\u{FEFF}= 1;", .javascript)?.writes, true)
        XCTAssertEqual(allowed("var {make\u{FEFF}} = app; make({});", .javascript)?.writes, true)
        XCTAssertNotNil(refused("var x = 4\u{FEFF}/ 2; ObjC.import('Foundation'); var y = 1 / 2;", .javascript))
        XCTAssertNotNil(refused("1 || 0 instanceof /'/; ObjC.import('x'); 1 || 0 instanceof /'/;", .javascript))
        XCTAssertEqual(allowed("1 || 0 instanceof /'/; app.make(1); 1 || 0 instanceof /'/;", .javascript)?.writes, true)
        XCTAssertEqual(allowed("const a = {if() { return 1; }}; a.if(1) /1; app.make(1)/ 1;", .javascript)?.writes, true)
        XCTAssertEqual(allowed("const a = {if() { return 1; }}; a?.while(1) /1; app.make(1)/ 1;", .javascript)?.writes, true)
        XCTAssertNotNil(refused("a.if(1) /1; ObjC.import('x'); /1/;", .javascript))
        XCTAssertEqual(refused("x = 1 \u{2022} 2;", .javascript), "a character outside strings that isn't part of a name (U+2022)")
        XCTAssertEqual(allowed("x = \u{A0}1\u{3000}+ 2; return '<!--' + /<!--/.source;", .javascript)?.writes, false)
    }

    func testJXARefusals() {
        XCTAssertNotNil(refused("Application('System Events').keystroke('q')", .javascript))
        XCTAssertNotNil(refused("ObjC.import('Foundation')", .javascript))
        XCTAssertNotNil(refused("$.NSTask.alloc", .javascript))
        XCTAssertNotNil(refused("app.includeStandardAdditions = true", .javascript))
        XCTAssertNotNil(refused("app.doShellScript('ls')", .javascript))
        XCTAssertNotNil(refused("(() => 1).constructor('return 1')()", .javascript))
        XCTAssertNotNil(refused("eval('1')", .javascript))
        XCTAssertNotNil(refused("x.__proto__", .javascript))
        XCTAssertNotNil(refused("app.systemInfo()", .javascript))
        XCTAssertNotNil(refused("return `a${b}`", .javascript))
        XCTAssertNotNil(refused("var \\u0061 = 1", .javascript))
        XCTAssertNotNil(refused("x['constr' + 'uctor']", .javascript))
        XCTAssertNotNil(refused("x[k]", .javascript))
        XCTAssertNotNil(refused("x['constructor']", .javascript))
        XCTAssertNotNil(refused("x[0 + 1]", .javascript))
        XCTAssertNotNil(refused("x[", .javascript))
        XCTAssertNotNil(refused("const {['con' + 'structor']: f} = x", .javascript))
        XCTAssertNotNil(refused("const o = {[k]() {}}", .javascript))
        XCTAssertNotNil(refused("x[[0]]", .javascript))
        XCTAssertEqual(refused("return 'abc", .javascript), "an unterminated string")
        XCTAssertEqual(refused("return 'abc\n'", .javascript), "an unterminated string")
        XCTAssertEqual(refused("/* open", .javascript), "an unterminated /* comment")
        XCTAssertEqual(allowed("return 'a\\'b';", .javascript)?.writes, false)
    }

    // MARK: Both

    func testEmptyLongAndNULScriptsAreRefused() {
        XCTAssertEqual(refused("  \n"), "an empty script")
        XCTAssertEqual(refused(String(repeating: "a", count: maxScriptLength + 1)), "a script over 20000 characters")
        XCTAssertEqual(refused("get x\u{0}"), "a NUL character")
    }

    func testBundleIdsAndTheWrapper() {
        XCTAssertTrue(validBundleId("com.apple.finder"))
        XCTAssertTrue(validBundleId("com.my-app.x_1"))
        XCTAssertFalse(validBundleId(""))
        XCTAssertFalse(validBundleId("a\"b"))
        XCTAssertFalse(validBundleId(String(repeating: "a", count: 256)))
        XCTAssertEqual(wrappedScript("get name", language: .applescript, bundleId: "com.apple.finder"),
                       "tell application id \"com.apple.finder\"\nget name\nend tell\n")
        XCTAssertEqual(wrappedScript("return 1;", language: .javascript, bundleId: "com.apple.TextEdit"),
                       "(function () {\n'use strict';\nconst app = Application(\"com.apple.TextEdit\");\nreturn 1;\n})()\n")
    }

    func testRunningLimits() {
        XCTAssertEqual(scriptTimeoutMs(nil), 30_000)
        XCTAssertEqual(scriptTimeoutMs(.nan), 30_000)
        XCTAssertEqual(scriptTimeoutMs(10), 1_000)
        XCTAssertEqual(scriptTimeoutMs(5_000), 5_000)
        XCTAssertEqual(scriptTimeoutMs(1e9), 120_000)
        XCTAssertEqual(clippedOutput("abc", limit: 5).truncated, false)
        XCTAssertEqual(clippedOutput("abcdef", limit: 3).text, "abc")
        XCTAssertEqual(clippedOutput("abcdef", limit: 3).truncated, true)
        XCTAssertEqual(clippedOutput("x").text, "x")
        XCTAssertEqual(automationStatus(0), "granted")
        XCTAssertEqual(automationStatus(-1743), "denied")
        XCTAssertEqual(automationStatus(-1744), "ask")
        XCTAssertEqual(automationStatus(-600), "not_running")
        XCTAssertEqual(automationStatus(-50), "error")
    }

    func testShortcuts() {
        XCTAssertTrue(validShortcutName("Sign PDF"))
        XCTAssertFalse(validShortcutName("  "))
        XCTAssertFalse(validShortcutName("-h"))
        XCTAssertFalse(validShortcutName("a\nb"))
        XCTAssertFalse(validShortcutName(String(repeating: "a", count: 256)))
        XCTAssertEqual(shortcutNames("A\n  B \n\nC\r\n"), ["A", "B", "C"])
        XCTAssertEqual(shortcutRunArguments("A", inputPath: nil, outputPath: nil), ["run", "A"])
        XCTAssertEqual(shortcutRunArguments("A", inputPath: "/i", outputPath: "/o"),
                       ["run", "A", "--input-path", "/i", "--output-path", "/o", "--output-type", "public.plain-text"])
    }
}
