//! The JS's output, compared here byte for byte. `scenarios/` is what the app's tests fed the JS translator, `edges/` each
//! trap of JS and JSON semantics and `fuzz/` random odd sessions and transcripts (tests/fixtures/core/translate/, made by the
//! translator before it was deleted). `helpers/` is what the helpers that still have a JS side answer:
//! tests/translateHelpers.parity.test.ts reads the same files, so a change on either side alone fails. A fixture is a folder
//! of parts because the linter reads no file past 1 MiB.

use std::path::{Path, PathBuf};

use crate::agents::parent_of;
use crate::blocks::{block_text, content_blocks, normalize, tool_output};
use crate::compaction::{compaction_item, is_compact_command};
use crate::edits::{edit_changes, patch_changes, replace_diff};
use crate::replay::replay;
use crate::routes::{reply, step};
use crate::stop::{acp_stop, is_limit_error};
use crate::tools::tool_item;
use crate::translator::Translator;
use dispatch::CancelToken;
use jsvalue::json::{parse, write, Numbers};
use jsvalue::prefix_units;
use jsvalue::value::{Object, Text, Value};
use serde_json::Value as Json;

fn value(text: &str) -> Value {
    parse(text).expect("JSON")
}

fn object(text: &str) -> Object {
    value(text).as_object().expect("an object").clone()
}

fn string(case: &Json, key: &str) -> String {
    case[key].as_str().expect("a string").to_string()
}

/// The cases of a fixture, in the order of its parts.
fn cases(fixture: &str, at_least: usize) -> Vec<Json> {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/core/translate").join(fixture);
    let mut parts: Vec<_> = std::fs::read_dir(folder).expect("the fixture").map(|part| part.expect("a part").path()).collect();
    parts.sort();
    let read = |part: &PathBuf| serde_json::from_slice::<Vec<Json>>(&std::fs::read(part).expect("a part")).expect("JSON");
    let cases: Vec<Json> = parts.iter().flat_map(read).collect();
    assert!(cases.len() >= at_least, "{} cases", cases.len());
    cases
}

/// When a step's input says it happened.
fn expected_time(input: &Object) -> f64 {
    serde_json::from_str::<Json>(&json(input.get("now").expect("a time"))).expect("JSON").as_f64().expect("a number")
}

/// Each step of a live translator, as the core's own route takes it, and what it said held to what the JS said.
fn steps_read_as_the_js(translator: &mut Translator, case: &Json) {
    let name = string(case, "name");
    for (at, expected) in case["steps"].as_array().map_or(&[][..], Vec::as_slice).iter().enumerate() {
        let input = object(&string(expected, "input"));
        let now = expected_time(&input);
        let thrown = translator.run(now, |translator| step(translator, input));
        let emits = std::mem::take(&mut translator.out);
        let got = String::from_utf8(reply(translator, &emits, None)).expect("UTF-8");
        assert_eq!(got, string(expected, "output"), "{name}, step {at}");
        assert_eq!(thrown.is_some(), expected["thrown"] == true, "{name}, step {at}: {thrown:?}");
    }
}

fn reads_as_the_js(fixture: &str, at_least: usize) {
    for case in cases(fixture, at_least) {
        let Some(payload) = case["replay"].as_str() else {
            steps_read_as_the_js(&mut Translator::new(&object(&string(&case, "header"))), &case);
            continue;
        };
        let name = string(&case, "name");
        let mut lines = payload.as_bytes().split(|byte| *byte == b'\n');
        let header = object(std::str::from_utf8(lines.next().expect("a header")).expect("UTF-8"));
        let done = replay(&header, lines, &CancelToken::default()).ok();
        let turns = done.as_ref().map(|done| String::from_utf8_lossy(&done.turns).into_owned());
        assert_eq!(turns.as_deref(), case["turns"].as_str(), "{name}");
        let kept = done.and_then(|done| done.kept);
        assert_eq!(kept.is_some(), case["kept"] == true, "{name}");
        if let Some(mut kept) = kept {
            steps_read_as_the_js(&mut kept, &case);
        }
    }
}

#[test]
fn the_apps_tests_read_as_the_js_read_them() {
    reads_as_the_js("scenarios", 100);
}

#[test]
fn each_trap_reads_as_the_js_read_it() {
    reads_as_the_js("edges", 50);
}

#[test]
fn random_sessions_read_as_the_js_read_them() {
    reads_as_the_js("fuzz", 300);
}

/// `value` as `JSON.stringify` spells it.
fn json(value: &Value) -> String {
    let mut out = Vec::new();
    write(&mut out, value, Numbers::Stringified);
    String::from_utf8(out).expect("UTF-8")
}

fn list(values: Vec<Value>) -> String {
    json(&Value::Array(values))
}

/// What a helper of the JS answers, as JSON, or that it threw.
fn answer(function: &str, args: &[Value]) -> Result<String, String> {
    let arg = |at: usize| args.get(at).filter(|value| **value != Value::Null);
    let tc = || args[0].as_object().expect("a tool call");
    let text = || crate::reads::string(args.first()).expect("a string").clone();
    Ok(match function {
        "isLimitError" => is_limit_error(arg(0)).to_string(),
        "compactCommand" => is_compact_command(text().as_bytes()).to_string(),
        "prefixUnits" => json(&Value::String(prefix_units(&text(), json(&args[1]).parse().expect("a length")))),
        "compactionItem" => {
            let options = &args[1];
            let trigger = crate::reads::string(options.field("trigger")).map(Text::lossy);
            json(&Value::Object(compaction_item(text(), trigger.as_deref(), crate::reads::string(options.field("summary")))))
        }
        "toolItem" => json(&Value::Object(tool_item(tc(), &args[1])?)),
        "editChanges" => list(edit_changes(tc())?),
        "toolOutput" => json(&Value::String(tool_output(args.first())?)),
        "blockText" => json(&Value::String(block_text(args.first())?)),
        "normalizeContentBlock" => json(&normalize(args.first()).map_or(Value::Null, |block| Value::Object(block.into_owned()))),
        "contentBlocks" => list(content_blocks(args.first()).into_iter().map(|block| Value::Object(block.into_owned())).collect()),
        "parentOf" => json(&parent_of(args.first().and_then(Value::as_object))?.map_or(Value::Null, Value::String)),
        "patchChanges" => list(patch_changes(args.first())),
        "replaceDiff" => json(&Value::String(replace_diff(args.first(), arg(1))?)),
        // the last of the helpers: the test below holds the names to the fixture's
        _ => {
            let stop = acp_stop(arg(0), arg(1), arg(2))?;
            let note =
                stop.note.map_or(Value::Null, |note| Value::Object(Object::of([("kind", Value::text(note.kind)), ("text", note.text)])));
            json(&Value::Object(Object::of([("status", Value::text(stop.status)), ("error", stop.error), ("note", note)])))
        }
    })
}

#[test]
fn the_helpers_left_in_js_answer_as_rust_does() {
    let cases = cases("helpers", 1000);
    for case in cases {
        let (function, name) = (string(&case, "fn"), string(&case, "name"));
        let args = value(&string(&case, "args"));
        let args = args.as_array().expect("a list");
        let answered = answer(&function, args);
        assert_eq!(answered.as_ref().ok().map(String::as_str), case["result"].as_str(), "{name}: {args:?}");
        assert_eq!(answered.is_err(), case["thrown"] == true, "{name}");
    }
}
