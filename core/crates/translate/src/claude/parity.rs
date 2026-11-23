//! The JS's output, compared here byte for byte. `claude-scenarios` is what the app's tests fed the JS translator, `claude-edges`
//! each trap of JS and JSON semantics and `claude-fuzz` random odd sessions and transcripts (folders of parts in
//! tests/fixtures/core/translate/, made by the translator before it was deleted). `claude-helpers` is what the helpers that
//! still have a JS side answer: tests/claudeHelpers.parity.test.ts reads the same files, so a change on either side alone fails.

use crate::claude::agent_transcript::AgentTranscript;
use crate::claude::history::{read, Asked};
use crate::claude::routes::{reply, step};
use crate::claude::signals::{goal_note, result_errors, result_failed, review_card, token_usage};
use crate::claude::translator::Translator;
use crate::Thrown;
use dispatch::CancelToken;
use jsvalue::json::{parse, write, Numbers};
use jsvalue::value::{Object, Value};
use serde_json::Value as Json;
use std::path::Path;

const NOW: f64 = 1_800_000_000_000.0;

fn value(text: &str) -> Value {
    parse(text).expect("JSON")
}

fn object(text: &str) -> Object {
    value(text).as_object().expect("an object").clone()
}

fn string(case: &Json, key: &str) -> String {
    case[key].as_str().expect("a string").to_string()
}

fn list<'a>(case: &'a Json, key: &str) -> &'a [Json] {
    case[key].as_array().map_or(&[], Vec::as_slice)
}

fn number(input: &Object) -> f64 {
    crate::claude::common::num(input.get("now")).unwrap_or(0.0)
}

/// A reply as the JS wrote it, each sub-agent transcript where the reply's head says it is.
fn inline(reply: Vec<u8>) -> String {
    const AT: &str = r#""itemsAt":["#;
    let text = String::from_utf8(reply).expect("UTF-8");
    let (mut head, tail) = text.split_once('\n').expect("a head");
    let mut out = String::new();
    while let Some((before, after)) = head.split_once(AT) {
        let (place, rest) = after.split_once(']').expect("a place");
        let (from, to) = place.split_once(',').expect("two ends");
        out.push_str(before);
        out.push_str(r#""items":"#);
        out.push_str(&tail[from.parse::<usize>().expect("a start")..to.parse::<usize>().expect("an end")]);
        head = rest;
    }
    out + head
}

fn live_as_the_js(case: &Json) {
    let name = string(case, "name");
    let mut translator = Translator::new(&object(&string(case, "header")));
    for (at, expected) in list(case, "steps").iter().enumerate() {
        let input = object(&string(expected, "input"));
        let message = expected["message"].as_str().map(str::as_bytes);
        let thrown = translator.run(number(&input), |translator| step(translator, &input, message));
        let got = inline(reply(&mut translator, None));
        assert_eq!(got, string(expected, "output"), "{name}, step {at}");
        assert_eq!(thrown.is_some(), expected["thrown"] == true, "{name}, step {at}: {thrown:?}");
    }
}

/// What `asked` says of a page.
fn asked_of(text: &str) -> Asked {
    let input = object(text);
    let flag = |key| input.get(key) == Some(&Value::Bool(true));
    let limit = match input.get("limit") {
        Some(Value::Number(limit)) => *limit as usize,
        _ => 0,
    };
    Asked { live_tail: flag("liveTail"), closed_tail: flag("closedTail"), open: flag("open"), limit, before: None, now: NOW, live: None }
}

/// A cursor of a repeated id with its mark taken off: the JS's named no one of them.
fn without_repeat(page: String) -> String {
    let cut = page.find(r#"\u0000"#).and_then(|at| Some((at, at + page[at..].find('"')?)));
    cut.map_or_else(|| page.clone(), |(at, end)| format!("{}{}", &page[..at], &page[end..]))
}

fn read_as_the_js(case: &Json) {
    let name = string(case, "name");
    let mut header = object(&string(case, "header"));
    header.set("now", Value::Number(NOW));
    let lines: Vec<String> = list(case, "lines").iter().map(|line| line.as_str().expect("a line").to_string()).collect();
    let (held, unread) = read(&header, lines.iter().map(String::as_bytes), &CancelToken::default()).expect("a read");
    for page in list(case, "pages") {
        let Some(expected) = page["page"].as_str() else {
            assert!(unread > 0, "{name}: the JS threw");
            continue;
        };
        let reply = held.page(&asked_of(&string(page, "asked")));
        let body = &reply[reply.iter().position(|byte| *byte == b'\n').expect("a line of ids") + 1..];
        assert_eq!(without_repeat(String::from_utf8_lossy(body).into_owned()), expected, "{name}");
    }
}

fn agent_as_the_js(case: &Json) {
    let name = string(case, "name");
    let header = object(&string(case, "header"));
    let mut child = AgentTranscript::new(
        None,
        header.get("threadId").cloned().unwrap_or(Value::Null),
        header.get("cwd").cloned().unwrap_or(Value::Null),
    );
    let mut failed = false;
    for line in list(case, "lines") {
        failed |= child.add(&value(line.as_str().expect("a line")), NOW).is_err();
    }
    if case["settled"] == true {
        child.cut_off();
    }
    let items: Vec<String> = child.items.iter().map(|item| String::from_utf8(item.json.clone()).expect("UTF-8")).collect();
    let items = format!("[{}]", items.join(","));
    assert_eq!(failed, !case["items"].is_string(), "{name}: what threw");
    assert_eq!(case["items"].as_str().unwrap_or(&items), items, "{name}");
}

/// The parts of a fixture, in order: a folder, because the linter reads no file past 1 MiB.
fn parts(fixture: &str) -> Vec<Json> {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/core/translate").join(fixture);
    let mut parts: Vec<_> = std::fs::read_dir(folder).expect("the fixture").map(|part| part.expect("a part").path()).collect();
    parts.sort();
    parts.iter().map(|part| serde_json::from_slice(&std::fs::read(part).expect("a part")).expect("JSON")).collect()
}

fn reads_as_the_js(fixture: &str, at_least: usize) {
    let mut sessions = 0;
    for part in parts(fixture) {
        sessions += list(&part, "live").len();
        list(&part, "live").iter().for_each(live_as_the_js);
        list(&part, "reads").iter().for_each(read_as_the_js);
        list(&part, "agents").iter().for_each(agent_as_the_js);
    }
    assert!(sessions >= at_least, "{sessions} sessions");
}

#[test]
fn the_apps_tests_read_as_the_js_read_them() {
    reads_as_the_js("claude-scenarios", 100);
}

#[test]
fn each_trap_reads_as_the_js_read_it() {
    reads_as_the_js("claude-edges", 15);
}

#[test]
fn random_sessions_read_as_the_js_read_them() {
    reads_as_the_js("claude-fuzz", 100);
}

/// A helper's answer as JSON, `"threw"` for what JS threw on.
fn spelled(answer: Result<Value, Thrown>) -> String {
    let mut out = Vec::new();
    write(&mut out, &answer.unwrap_or(Value::text("threw")), Numbers::Stringified);
    String::from_utf8(out).expect("UTF-8")
}

#[test]
fn the_helpers_left_in_js_answer_as_rust_does() {
    let cases: Vec<Json> = parts("claude-helpers").iter().flat_map(|part| part.as_array().expect("a list").clone()).collect();
    assert!(cases.len() >= 1000, "{} cases", cases.len());
    for case in cases {
        let message = value(&string(&case, "message"));
        let input = value(&string(&case, "input"));
        let errors = result_errors(&message).map(|errors| Value::Array(errors.into_iter().map(Value::String).collect()));
        assert_eq!(spelled(errors), string(&case, "errors"), "{message:?}");
        assert_eq!(spelled(result_failed(&message).map(Value::Bool)), string(&case, "failed"), "{message:?}");
        assert_eq!(spelled(token_usage(&message, None).map(Value::Object)), string(&case, "usage"), "{message:?}");
        assert_eq!(spelled(goal_note(&message).map(|note| note.map_or(Value::Null, Value::String))), string(&case, "goal"), "{message:?}");
        let card = review_card(None, Some(&input)).map(|mut card| {
            card.remove("type");
            Value::Object(card)
        });
        assert_eq!(spelled(card), string(&case, "review"), "{input:?}");
    }
}
