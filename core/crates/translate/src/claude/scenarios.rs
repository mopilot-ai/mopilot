//! What the parity fixtures can't hold: the routes themselves, what a failure or a panic leaves, ids nothing in JS can predict,
//! a read's pages, and the places this leaves the JS on purpose.

use crate::claude::common::date_parse;
use crate::claude::fold::{apply, apply_to};
use crate::claude::translator::Translator;
use crate::claude::{write_said, Said};
use crate::emit::{Emit, Item};
use crate::turns::Turns;
use dispatch::{dispatch, dispatch_call, Call};
use jsvalue::value::{Object, Value};
use serde_json::{json, Value as Json};

pub(super) fn open() -> u64 {
    let header = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed" }).to_string();
    let id = dispatch_call("translate.claudeOpen", header.as_bytes(), &Call::default()).expect("an id");
    String::from_utf8(id).expect("UTF-8").parse().expect("a number")
}

pub(super) fn event(id: u64, op: &str, fields: Json, message: Option<Json>) -> Json {
    let mut head = fields;
    head["id"] = json!(id);
    head["now"] = json!(1_700_000_000_123u64);
    head["op"] = json!(op);
    let mut payload = head.to_string();
    if let Some(message) = message {
        payload.push('\n');
        payload.push_str(&message.to_string());
    }
    let reply = dispatch("translate.claudeEvent", payload.as_bytes()).expect("a reply");
    serde_json::from_slice(reply.split(|byte| *byte == b'\n').next().expect("a head")).expect("JSON")
}

pub(super) fn message(id: u64, message: Json) -> Json {
    event(id, "message", json!({}), Some(message))
}

fn methods(reply: &Json) -> Vec<&str> {
    reply["emits"].as_array().expect("emits").iter().map(|emit| emit[0].as_str().expect("a method")).collect()
}

pub(super) fn close(id: u64) -> Vec<u8> {
    dispatch("translate.claudeClose", id.to_string().as_bytes()).expect("a reply")
}

fn prompt(uuid: &str) -> Json {
    json!({ "type": "user", "uuid": uuid, "timestamp": "2026-01-01T00:00:00Z", "message": { "content": uuid } })
}

fn reply_to(uuid: &str) -> Json {
    json!({ "type": "assistant", "uuid": format!("a{uuid}"), "timestamp": "2026-01-01T00:00:01Z", "message": { "id": format!("m{uuid}"), "content": [{ "type": "text", "text": "ok" }] } })
}

/// A read of `messages`: its id and how many it left out.
fn read(messages: &[Json]) -> (u64, u64) {
    let mut payload = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed", "now": 1_800_000_000_000u64 }).to_string();
    for line in messages {
        payload.push('\n');
        payload.push_str(&line.to_string());
    }
    let reply: Json = serde_json::from_slice(&dispatch_call("translate.claudeRead", payload.as_bytes(), &Call::default()).expect("a read"))
        .expect("JSON");
    (reply["id"].as_u64().expect("an id"), reply["unread"].as_u64().expect("a count"))
}

/// A page: whether it says there are older turns, its ids and its JSON.
fn page(id: u64, asked: Json) -> (bool, Json, Json) {
    let mut asked = asked;
    asked["id"] = json!(id);
    asked["now"] = json!(1_800_000_000_000u64);
    let reply = dispatch("translate.claudeSettle", asked.to_string().as_bytes()).expect("a page");
    let end = reply.iter().position(|byte| *byte == b'\n').expect("a line of ids");
    let ids = serde_json::from_slice(&reply[1..end]).expect("ids");
    (reply[0] == b'1', ids, serde_json::from_slice(&reply[end + 1..]).expect("JSON"))
}

fn release(id: u64) -> Vec<u8> {
    dispatch("translate.claudeRelease", id.to_string().as_bytes()).expect("a reply")
}

#[test]
fn a_translator_opens_translates_and_closes_through_the_routes() {
    let id = open();
    let begun = event(id, "begin", json!({ "turnId": "t", "user": { "id": "u", "content": [] } }), None);
    assert_eq!(begun["turnId"], "t");
    assert_eq!(methods(&begun), ["turn/started", "item/completed"]);
    assert_eq!(begun["emits"][0][1]["turn"]["startedAt"], 1_700_000_000.123);
    assert_eq!(event(id, "steer", json!({}), None)["emits"], json!([]));
    assert_eq!(event(id, "dropSteer", json!({}), None)["turnId"], "t");
    assert_eq!(event(id, "interrupt", json!({}), None)["interrupted"], true);
    assert_eq!(event(id, "cwd", json!({ "cwd": "/late" }), None)["emits"], json!([]));
    let tool = json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [{ "type": "tool_use", "id": "c", "name": "Bash", "input": {} }] } });
    assert_eq!(message(id, tool)["emits"][0][1]["item"]["cwd"], "/late");
    let ended = event(id, "end", json!({ "status": "failed", "error": "broke" }), None);
    assert_eq!(ended["turnId"], Json::Null);
    assert_eq!(ended["emits"][1][1]["turn"]["error"]["message"], "broke");
    assert_eq!(close(id), b"true");
    assert_eq!(close(id), b"false");
    let gone = json!({ "id": id, "op": "end" }).to_string();
    assert!(dispatch("translate.claudeEvent", gone.as_bytes()).expect_err("closed").starts_with("no Claude translator"));
}

#[test]
fn a_bad_payload_is_refused_and_costs_nothing() {
    for route in ["translate.claudeOpen", "translate.claudeEvent", "translate.claudeSettle", "translate.claudeWalk"] {
        assert!(dispatch(route, b"nope").is_err(), "{route}");
        assert!(dispatch(route, &[0xff]).is_err(), "{route}");
    }
    assert!(dispatch("translate.claudeRead", b"nope").is_err());
    assert!(dispatch("translate.claudeAgentItems", b"nope").is_err());
    assert!(dispatch("translate.claudeClose", b"nope").expect_err("no id").starts_with("translate.claudeClose"));
    assert!(dispatch("translate.claudeRelease", &[0xff]).expect_err("no id").starts_with("translate.claudeRelease"));
    let id = open();
    assert_eq!(event(id, "other", json!({}), None)["thrown"], "translate.claudeEvent takes an op");
    assert_eq!(event(id, "message", json!({}), None)["thrown"], "a message is missing");
    assert_eq!(close(id), b"true");
}

#[test]
fn what_the_js_threw_on_keeps_what_came_before_it_and_the_session() {
    let id = open();
    message(id, json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [{ "type": "text", "text": "before" }] } }));
    let bad = message(
        id,
        json!({ "type": "assistant", "uuid": "b", "message": { "id": "n", "content": [{ "type": "text", "text": "said" }, { "type": "tool_use", "id": "t", "name": 7 }] } }),
    );
    assert_eq!(bad["thrown"], "a tool has no name");
    assert_eq!(methods(&bad), ["item/completed"]);
    assert_eq!(bad["turnId"].as_str().map(|turn| turn.starts_with("auto-seed-")), Some(true));
    assert_eq!(message(id, json!({ "type": "result", "subtype": "success" })).get("thrown"), None);
    assert_eq!(close(id), b"true");
}

#[test]
fn a_panic_costs_an_event_and_not_the_session() {
    let mut translator = Translator::new(&Object::of([("threadId", Value::text("chat"))]));
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let thrown = translator.run(5.0, |translator| {
        translator.begin_turn(Some(Value::text("t")), None);
        panic!("a bug")
    });
    std::panic::set_hook(quiet);
    assert_eq!(thrown.as_deref(), Some("the translator panicked"));
    assert_eq!(translator.out.len(), 1);
    assert_eq!(translator.turn_id, Some(Value::text("t")));
}

#[test]
fn a_message_as_deep_as_a_transcript_may_hold_is_read_live_as_it_is_from_a_file() {
    // the event's own fields are a line apart from the message's, so no envelope takes from its depth
    let nested = |depth: usize| format!(r#"{{"type":"other","deep":{}1{}}}"#, "[".repeat(depth), "]".repeat(depth));
    let id = open();
    let line = |text: String| {
        let payload = format!("{}\n{text}", json!({ "id": id, "now": 1, "op": "message" }));
        serde_json::from_slice::<Json>(&dispatch("translate.claudeEvent", payload.as_bytes()).expect("a reply")).expect("JSON")
    };
    assert_eq!(line(nested(990)).get("thrown"), None);
    // past that it is refused whole, with a note, and the session goes on
    assert_eq!(line(nested(5000))["thrown"], "a message can't be read");
    assert_eq!(close(id), b"true");
    let mut payload = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed", "now": 1 }).to_string();
    payload.push_str(&format!("\n{}\n{}", nested(990), nested(5000)));
    let reply: Json = serde_json::from_slice(&dispatch_call("translate.claudeRead", payload.as_bytes(), &Call::default()).expect("a read"))
        .expect("JSON");
    assert_eq!(reply["unread"], 1);
    assert_eq!(release(reply["id"].as_u64().expect("an id")), b"true");
}

#[test]
fn a_read_takes_each_line_alone_and_a_turn_id_keeps_its_place() {
    let bad =
        json!({ "type": "assistant", "uuid": "x", "message": { "id": "x", "content": [{ "type": "tool_use", "id": "t", "name": 7 }] } });
    let (id, unread) = read(&[prompt("p1"), reply_to("1"), bad, json!(5), prompt("p2")]);
    assert_eq!(unread, 2);
    let (older, ids, body) = page(id, json!({}));
    assert!(!older);
    // the call it stopped at had said what it said: a prompt after it is one sent mid-turn
    assert_eq!(ids, json!(["h-p1"]));
    assert_eq!(body["turns"][0]["items"].as_array().expect("items").len(), 3);
    assert_eq!(body["turns"][0]["status"], "completed");
    assert_eq!(body["closedTail"], Json::Null);
    assert_eq!(release(id), b"true");
    assert_eq!(release(id), b"false");
    assert!(dispatch("translate.claudeSettle", json!({ "id": id }).to_string().as_bytes())
        .expect_err("gone")
        .starts_with("no Claude history"));
}

#[test]
fn a_turn_left_open_reads_either_way_from_one_read() {
    let fresh = json!({ "type": "user", "uuid": "p", "timestamp": "2027-01-15T07:00:00Z", "message": { "content": "go" } });
    let tool = json!({ "type": "assistant", "uuid": "a", "timestamp": "2027-01-15T07:00:00Z", "message": { "id": "m", "content": [{ "type": "tool_use", "id": "c", "name": "Bash", "input": {} }] } });
    let (id, _) = read(&[fresh, tool]);
    // nothing says it still runs: its call ended with it
    let (_, _, closed) = page(id, json!({}));
    assert_eq!(closed["turns"][0]["status"], "completed");
    assert_eq!(closed["turns"][0]["items"][1]["status"], "completed");
    // main runs it: left open, under the id main's items name it by
    let (_, ids, open) = page(id, json!({ "open": true, "live": "ct-1", "closedTail": true }));
    assert_eq!(ids, json!(["ct-1"]));
    assert_eq!(open["turns"][0]["status"], "inProgress");
    assert_eq!(open["turns"][0]["items"][1]["status"], "inProgress");
    assert_eq!(open["closedTail"], Json::Null);
    // another app wrote it a moment ago: open, with what it reads as if no one is writing, for one who learns that later
    let mut asked = json!({ "liveTail": true, "closedTail": true, "id": id, "now": 1_800_000_000_000u64 });
    asked["now"] = json!(date_parse(b"2027-01-15T07:00:10Z"));
    let reply = dispatch("translate.claudeSettle", asked.to_string().as_bytes()).expect("a page");
    let end = reply.iter().position(|byte| *byte == b'\n').expect("ids");
    let body: Json = serde_json::from_slice(&reply[end + 1..]).expect("JSON");
    assert_eq!(body["turns"][0]["status"], "inProgress");
    assert_eq!(body["closedTail"]["status"], "completed");
    assert_eq!(serde_json::from_slice::<Json>(&reply[1..end]).expect("ids"), json!(["h-p", "h-p"]));
    // past the live window it reads closed; a live id says nothing to a turn that ended
    let (_, ids, late) = page(id, json!({ "liveTail": true, "live": "ct-1" }));
    assert_eq!(ids, json!(["h-p"]));
    assert_eq!(late["turns"][0]["status"], "completed");
    assert_eq!(release(id), b"true");
}

#[test]
fn a_cursor_always_goes_back_however_often_an_id_repeats() {
    let same = prompt("same");
    let mut messages = Vec::new();
    for _ in 0..5 {
        messages.push(same.clone());
    }
    messages.push(prompt("last"));
    let (id, _) = read(&messages);
    let mut pages = 0;
    let mut before = Json::Null;
    let mut seen = Vec::new();
    loop {
        let (older, ids, body) = page(id, json!({ "limit": 1, "before": before }));
        pages += 1;
        assert!(pages <= 6, "a cursor that does not go back");
        assert_eq!(older, !body["olderCursor"].is_null());
        seen.extend(ids.as_array().expect("ids").iter().cloned());
        before = body["olderCursor"].clone();
        if before.is_null() {
            break;
        }
    }
    assert_eq!(pages, 6);
    assert_eq!(seen, [json!("h-last"), json!("h-same"), json!("h-same"), json!("h-same"), json!("h-same"), json!("h-same")]);
    // a cursor no longer in the history pages from the end, and so does one that names a repeat there isn't
    assert_eq!(page(id, json!({ "limit": 1, "before": "h-gone" })).1, json!(["h-last"]));
    assert_eq!(page(id, json!({ "limit": 1, "before": "h-same\u{0}9" })).1, json!(["h-last"]));
    assert_eq!(page(id, json!({ "limit": 1, "before": "nothing\u{0}x" })).1, json!(["h-last"]));
    // a cursor that needs no mark is the id, as the window has always had it
    assert_eq!(page(id, json!({ "limit": 1, "before": "h-last" })).1, json!(["h-same"]));
    assert_eq!(release(id), b"true");
}

#[test]
fn a_page_of_long_turns_stops_at_a_whole_turn() {
    let long = "x".repeat(5 << 20);
    let turn =
        |uuid: &str| json!({ "type": "assistant", "uuid": uuid, "message": { "id": uuid, "content": [{ "type": "text", "text": long }] } });
    let (id, _) = read(&[prompt("p1"), turn("a1"), prompt("p2"), turn("a2"), prompt("p3"), turn("a3")]);
    let (older, ids, body) = page(id, json!({ "limit": 3 }));
    assert!(older);
    assert_eq!(ids, json!(["h-p3"]));
    assert_eq!(body["olderCursor"], "h-p3");
    // with no limit, nothing stops it
    assert_eq!(page(id, json!({})).1.as_array().expect("ids").len(), 3);
    assert_eq!(release(id), b"true");
}

#[test]
fn a_walk_goes_through_a_long_turn_a_little_at_a_time() {
    let tool = |at: usize| json!({ "type": "assistant", "uuid": format!("a{at}"), "message": { "id": format!("m{at}"), "content": [{ "type": "text", "text": "y".repeat(100) }] } });
    let mut messages = vec![prompt("p1")];
    messages.extend((0..20).map(tool));
    messages.push(prompt("p2"));
    messages.push(json!({ "type": "user", "uuid": "p3", "message": { "content": "" } }));
    let (id, _) = read(&messages);
    let walk = |turn: u64, item: u64| -> Json {
        let asked = json!({ "id": id, "turn": turn, "item": item, "bytes": 500 });
        serde_json::from_slice(&dispatch("translate.claudeWalk", asked.to_string().as_bytes()).expect("a step")).expect("JSON")
    };
    let first = walk(0, 0);
    assert_eq!(first["continues"], false);
    let mut items = first["turns"][0]["items"].as_array().expect("items").clone();
    let mut at = first["rest"].clone();
    assert_eq!(at[0], 0);
    let mut steps = 1;
    let mut last_turns = Vec::new();
    while !at.is_null() {
        let step = walk(at[0].as_u64().expect("a turn"), at[1].as_u64().expect("an item"));
        steps += 1;
        let turns = step["turns"].as_array().expect("turns");
        if step["continues"] == true {
            items.extend(turns[0]["items"].as_array().expect("items").iter().cloned());
            last_turns.extend(turns[1..].iter().cloned());
        } else {
            last_turns.extend(turns.iter().cloned());
        }
        at = step["rest"].clone();
    }
    assert!(steps > 3, "{steps} steps");
    assert_eq!(items.len(), 21);
    assert_eq!(last_turns.last().expect("a turn")["id"], "h-p2");
    // a walk past the end has nothing more to say, and one item bigger than a step still goes
    assert_eq!(walk(9, 0), json!({ "continues": false, "turns": [], "rest": null }));
    // an item past a turn's end, which no reader asks, is the turn's end
    assert_eq!(walk(0, 9999)["turns"][0], json!({ "items": [] }));
    // short turns go together, as far as a step goes, and one that won't fit waits for the next
    let (several, _) = read(&[prompt("p1"), prompt("p2"), prompt("p3")]);
    let step = |bytes: u64, turn: u64| -> Json {
        let asked = json!({ "id": several, "turn": turn, "bytes": bytes, "open": true });
        serde_json::from_slice(&dispatch("translate.claudeWalk", asked.to_string().as_bytes()).expect("a step")).expect("JSON")
    };
    assert_eq!(step(1 << 20, 0)["turns"].as_array().expect("turns").len(), 3);
    assert_eq!(step(1 << 20, 0)["rest"], Json::Null);
    let cut = step(300, 0);
    assert_eq!(cut["turns"].as_array().expect("turns").len(), 1);
    assert_eq!(cut["rest"], json!([1, 0]));
    assert_eq!(step(0, 0)["rest"], json!([0, 0]));
    assert_eq!(release(several), b"true");
    // a turn with nothing in it yet is a turn all the same
    let started = json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "id": "m" } } });
    let (empty, _) = read(&[started]);
    let asked = json!({ "id": empty, "bytes": 1 << 20 }).to_string();
    let whole: Json = serde_json::from_slice(&dispatch("translate.claudeWalk", asked.as_bytes()).expect("a step")).expect("JSON");
    assert_eq!(whole["turns"][0]["items"], json!([]));
    assert_eq!(release(empty), b"true");
    let big = serde_json::from_slice::<Json>(
        &dispatch("translate.claudeWalk", json!({ "id": id, "bytes": 1 }).to_string().as_bytes()).expect("a step"),
    )
    .expect("JSON");
    assert_eq!(big["turns"][0]["items"].as_array().expect("items").len(), 1);
    assert_eq!(release(id), b"true");
}

#[test]
fn a_sub_agents_stored_transcript_comes_with_its_model_and_its_open_tools_cut_off() {
    let call = json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "model": "sonnet", "content": [{ "type": "tool_use", "id": "c", "name": "Bash", "input": { "command": "x" } }] } });
    let items = |settled: bool, lines: &[String]| -> Json {
        let mut payload = json!({ "threadId": "chat", "cwd": "/w", "settled": settled, "now": 1 }).to_string();
        for line in lines {
            payload.push('\n');
            payload.push_str(line);
        }
        serde_json::from_slice(&dispatch("translate.claudeAgentItems", payload.as_bytes()).expect("items")).expect("JSON")
    };
    let lines = [
        call.to_string(),
        reply_to("x").to_string(),
        "not json".into(),
        "5".into(),
        json!({ "type": "assistant", "uuid": "b", "message": { "content": [{ "type": "tool_use", "id": "d", "name": 7 }] } }).to_string(),
    ];
    let open = items(false, &lines);
    assert_eq!(open["items"][0]["status"], "inProgress");
    assert_eq!(open["model"], "sonnet");
    assert_eq!(open["unread"], 3);
    assert_eq!(items(true, &lines)["items"][0]["status"], "failed");
    assert_eq!(items(true, &[])["model"], Json::Null);
}

#[test]
fn turns_nobody_named_take_their_ids_from_the_seed() {
    let id = open();
    let first = message(id, json!({ "type": "assistant", "message": { "id": "m", "content": [{ "type": "text", "text": "hi" }] } }));
    assert_eq!(first["turnId"], "auto-seed-0");
    let note = message(id, json!({ "type": "user", "origin": { "kind": "peer" }, "message": { "content": "hello" } }));
    assert_eq!(note["emits"][0][1]["item"]["id"], "note-seed-1");
    assert_eq!(close(id), b"true");
}

#[test]
fn a_time_is_read_by_ecmascripts_format_and_nothing_else() {
    for (text, time) in [
        ("2026-01-02T03:04:05.678Z", 1_767_323_045_678.0),
        ("2026-01-02T03:04:05.6789Z", 1_767_323_045_678.0),
        ("2026-01-02T03:04:05.6Z", 1_767_323_045_600.0),
        ("2026-01-02T03:04:05Z", 1_767_323_045_000.0),
        ("2026-01-02T03:04Z", 1_767_323_040_000.0),
        ("2026-01-02", 1_767_312_000_000.0),
        ("2026-01", 1_767_225_600_000.0),
        ("2026", 1_767_225_600_000.0),
        ("+002026-01-02T00:00:00Z", 1_767_312_000_000.0),
        ("-000001-01-01", -62_198_755_200_000.0),
        ("2026-01-02T03:04:05+05:30", 1_767_303_245_000.0),
        ("2026-01-02T03:04:05-05:30", 1_767_342_845_000.0),
        ("2026-02-31", 1_772_496_000_000.0),
        ("2026-01-01T24:00:00Z", 1_767_312_000_000.0),
        ("1970-01-01T00:00:00Z", 0.0),
    ] {
        assert_eq!(date_parse(text.as_bytes()), time, "{text}");
    }
    for text in [
        "",
        "nope",
        "20",
        "-000000-01-01",
        "2026-13-01",
        "2026-00-01",
        "2026-01-32",
        "2026-01-00",
        "2026-1-1",
        "2026-01-02 03:04:05Z",
        "2026-01-02T03:04:05",
        "2026-01-02T03",
        "2026-01-02T24:00:01Z",
        "2026-01-02T25:00:00Z",
        "2026-01-02T03:60:00Z",
        "2026-01-02T03:04:60Z",
        "2026-01-02T03:04:05.Z",
        "2026-01-02T03:04:05+24:00",
        "2026-01-02T03:04:05+05:60",
        "2026-01-02T03:04:05+0530",
        "2026-01-02T03:04:05Zx",
        "+275760-09-13T00:00:00.001Z",
    ] {
        assert!(date_parse(text.as_bytes()).is_nan(), "{text}");
    }
}

#[test]
fn what_a_turns_end_says_of_nothing_in_it_leaves_its_copy_alone() {
    let mut turns = Turns::default();
    let id = Some(Value::text("t"));
    turns.add(id.clone());
    let turn = turns.turn(&id).expect("the turn");
    apply_to(turn, Said::Usage(Object::default()));
    assert!(turn.in_progress());
    assert_eq!(turn.item_count(), 0);
}

#[test]
fn what_names_no_turn_folds_to_nothing_or_fails_its_line() {
    let mut turns = Turns::default();
    let turn = || Some(Value::text("gone"));
    assert_eq!(apply(&mut turns, Said::Plain(Emit::TurnCompleted { id: turn(), status: "failed", error: Value::Null, at: 0.0 })), Ok(()));
    assert_eq!(apply(&mut turns, Said::Plain(Emit::Plan { turn: turn(), plan: Value::Null })), Ok(()));
    assert_eq!(apply(&mut turns, Said::Usage(Object::default())), Ok(()));
    let item = Said::Plain(Emit::Item { started: false, turn: turn(), item: Item::Plain(Object::default()) });
    assert_eq!(apply(&mut turns, item), Err("an item for no turn".to_string()));
    assert_eq!(apply(&mut turns, Said::Updated { turn: turn(), item: Object::default() }), Err("an item for no turn".to_string()));
}

#[test]
fn an_undefined_turn_or_agent_is_left_out() {
    let written = |said: &Said| {
        let mut out = Vec::new();
        write_said(&mut out, &mut Vec::new(), &Value::text("c"), said);
        String::from_utf8(out).expect("UTF-8")
    };
    assert_eq!(written(&Said::Updated { turn: None, item: Object::default() }), r#"["item/updated",{"threadId":"c","item":{}}]"#);
    assert_eq!(
        written(&Said::Retry { turn: None, message: "m".into() }),
        r#"["error",{"threadId":"c","willRetry":true,"error":{"message":"m"}}]"#
    );
    assert_eq!(written(&Said::Children { key: None, items: Vec::new() }), r#"["agent/items",{"threadId":"c","itemsAt":[0,2]}]"#);
    assert_eq!(written(&Said::Usage(Object::default())), r#"["thread/tokenUsage/updated",{"threadId":"c","tokenUsage":{}}]"#);
}

#[test]
fn a_read_with_no_time_given_reads_at_none() {
    let payload = format!("{}\n{}", json!({ "threadId": "chat" }), prompt("p"));
    let reply: Json = serde_json::from_slice(&dispatch_call("translate.claudeRead", payload.as_bytes(), &Call::default()).expect("a read"))
        .expect("JSON");
    assert_eq!(release(reply["id"].as_u64().expect("an id")), b"true");
}

#[test]
fn a_closed_tail_is_asked_of_a_page_that_ends_in_an_open_turn_only() {
    let late = json!({ "type": "user", "uuid": "p", "message": { "content": "go" } });
    let (id, _) = read(&[prompt("o"), reply_to("o"), late]);
    // an older page has no tail to speak of
    let (_, _, older) = page(id, json!({ "liveTail": true, "closedTail": true, "before": "h-p" }));
    assert_eq!(older["closedTail"], Json::Null);
    // a page that holds no turns has none either
    let (_, ids, none) = page(id, json!({ "open": true, "liveTail": true, "closedTail": true, "before": "h-o" }));
    assert_eq!(ids, json!([]));
    assert_eq!(none["closedTail"], Json::Null);
    assert_eq!(page(id, json!({ "open": true, "liveTail": true, "closedTail": true, "limit": 1 })).2["closedTail"]["status"], "completed");
    assert_eq!(release(id), b"true");
}
