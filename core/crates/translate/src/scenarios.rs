//! What the parity fixtures can't hold (`history` has a chat's history): the routes themselves, what a handle does when its owner or session goes, what a panic
//! leaves, ids nothing in JS can predict, and the places this leaves the JS on purpose.

use crate::translator::Translator;
use dispatch::{dispatch, dispatch_call, new_owner, release, Call};
use jsvalue::value::{Object, Value};
use serde_json::{json, Value as Json};

fn open() -> u64 {
    open_as(&Call::default())
}

fn open_as(call: &Call) -> u64 {
    let header = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed" }).to_string();
    let id = dispatch_call("translate.open", header.as_bytes(), call).expect("an id");
    String::from_utf8(id).expect("UTF-8").parse().expect("a number")
}

fn event(id: u64, mut event: Json) -> Json {
    event["id"] = json!(id);
    event["now"] = json!(1_700_000_000_123u64);
    serde_json::from_slice(&dispatch("translate.event", event.to_string().as_bytes()).expect("a reply")).expect("JSON")
}

fn update(id: u64, update: Json) -> Json {
    event(id, json!({ "op": "update", "update": update, "turnId": "t" }))
}

fn methods(reply: &Json) -> Vec<&str> {
    reply["emits"].as_array().expect("emits").iter().map(|emit| emit[0].as_str().expect("a method")).collect()
}

fn text(text: &str) -> Json {
    json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } })
}

fn close(id: u64) -> Vec<u8> {
    dispatch("translate.close", id.to_string().as_bytes()).expect("a reply")
}

#[test]
fn a_translator_opens_translates_and_closes_through_the_routes() {
    let id = open();
    let begun = event(id, json!({ "op": "begin", "turnId": "t", "user": { "id": "u" } }));
    assert_eq!(begun["turnId"], "t");
    assert_eq!(methods(&begun), ["turn/started", "item/completed"]);
    assert_eq!(begun["emits"][0][1]["turn"]["startedAt"], 1_700_000_000.123);
    let replied = update(id, text("hi"));
    assert_eq!(methods(&replied), ["item/started", "item/agentMessage/delta"]);
    assert_eq!(replied["emits"][1][1]["itemId"], "t:m0");
    let ended = event(id, json!({ "op": "end", "stopReason": "end_turn" }));
    assert_eq!(ended["turnId"], Json::Null);
    assert_eq!(methods(&ended), ["item/completed", "turn/completed"]);
    assert_eq!(ended.get("thrown"), None);
    assert_eq!(close(id), b"true");
    assert_eq!(close(id), b"false");
    let gone = json!({ "id": id, "op": "end" }).to_string();
    assert!(dispatch("translate.event", gone.as_bytes()).expect_err("closed").starts_with("no translator"));
}

#[test]
fn a_bad_payload_is_refused_and_costs_nothing() {
    assert!(dispatch("translate.open", b"nope").expect_err("no header").starts_with("translate.open"));
    assert!(dispatch("translate.open", &[0xff]).is_err());
    assert!(dispatch("translate.open", b"[]").is_err());
    assert!(dispatch("translate.event", b"nope").expect_err("no event").starts_with("translate.event"));
    assert!(dispatch("translate.close", b"nope").expect_err("no id").starts_with("translate.close"));
    assert!(dispatch("translate.close", &[0xff]).is_err());
    assert!(dispatch("translate.replay", b"nope").expect_err("no header").starts_with("translate.replay"));
    let id = open();
    let unknown = event(id, json!({ "op": "other" }));
    assert_eq!(unknown["thrown"], "translate.event takes an op");
    assert_eq!(event(id, json!({ "now": "later", "op": 7 }))["thrown"], "translate.event takes an op");
    assert_eq!(close(id), b"true");
}

#[test]
fn what_the_js_threw_on_keeps_what_came_before_it_and_the_session() {
    let id = open();
    event(id, json!({ "op": "begin", "turnId": "t" }));
    update(id, text("before"));
    let bad = update(id, json!({ "sessionUpdate": "tool_call", "toolCallId": "c", "title": { "toString": 1 } }));
    assert_eq!(bad["thrown"], "an object has no string");
    // the message it closed went out, as the JS's emit had by the time it threw
    assert_eq!(methods(&bad), ["item/completed"]);
    assert_eq!(bad["emits"][0][1]["item"]["text"], "before");
    assert_eq!(bad["turnId"], "t");
    let fixed = update(id, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c", "title": "fine", "status": "completed" }));
    assert_eq!(fixed.get("thrown"), None);
    assert_eq!(methods(&fixed), ["item/completed"]);
    assert_eq!(close(id), b"true");
}

#[test]
fn a_panic_costs_an_event_and_not_the_session() {
    let mut translator = Translator::new(&Object::of([("threadId", Value::text("chat"))]));
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let thrown = translator.run(5.0, |translator| translator.begin_turn(Some(Value::text("t")), None).map(|()| panic!("a bug")));
    std::panic::set_hook(quiet);
    assert_eq!(thrown.as_deref(), Some("the translator panicked"));
    // what it said before goes out, and the turn it opened is still there to end
    assert_eq!(translator.out.len(), 1);
    assert_eq!(translator.turn_id, Some(Value::text("t")));
    translator.out.clear();
    assert_eq!(translator.run(6.0, |translator| translator.end_turn(Some(&Value::text("end_turn")), None, None)), None);
    assert_eq!(translator.out.len(), 1);
}

#[test]
fn a_turn_ends_whatever_it_holds() {
    let id = open();
    event(id, json!({ "op": "begin", "turnId": { "toString": 1 } }));
    let ended = event(id, json!({ "op": "end", "stopReason": "max_tokens" }));
    assert_eq!(ended["thrown"], "an object has no string");
    assert_eq!(methods(&ended), ["turn/completed"]);
    event(id, json!({ "op": "begin", "turnId": "t" }));
    update(id, json!({ "sessionUpdate": "tool_call", "toolCallId": "c", "title": { "toString": 1 } }));
    update(id, json!({ "sessionUpdate": "tool_call", "toolCallId": "d", "kind": "execute" }));
    let ended = event(id, json!({ "op": "end", "stopReason": { "toString": 1 } }));
    assert_eq!(ended["thrown"], "an object has no string");
    assert_eq!(methods(&ended), ["item/completed", "turn/completed"]);
    assert_eq!(ended["emits"][1][1]["turn"]["status"], "failed");
    // the call that couldn't be read went with its turn, and no later turn's end trips on it
    event(id, json!({ "op": "begin", "turnId": "t2" }));
    assert_eq!(event(id, json!({ "op": "end", "stopReason": "end_turn" })).get("thrown"), None);
    assert_eq!(close(id), b"true");
}

#[test]
fn a_prompt_that_cant_be_read_still_starts_its_turn() {
    let id = open();
    let user = json!({ "id": "u", "content": [{ "type": "text", "text": { "toString": 1 } }] });
    let begun = event(id, json!({ "op": "begin", "turnId": "t", "user": user }));
    assert_eq!(begun["thrown"], "an object has no string");
    assert_eq!(methods(&begun), ["turn/started", "item/completed"]);
    assert_eq!(close(id), b"true");
}

#[test]
fn a_parent_named_by_an_update_with_no_string_throws_as_the_js_did() {
    let id = open();
    let reply = update(id, json!({ "sessionUpdate": "tool_call", "toolCallId": { "toString": 1 }, "_meta": { "parentToolCallId": "p" } }));
    assert_eq!(reply["thrown"], "an object has no string");
    assert_eq!(close(id), b"true");
}

#[test]
fn a_panic_outside_a_translator_leaves_the_handle_alone() {
    // the guard is inside the handle's use, so a route's own failure never reaches its lock
    let id = open();
    assert!(dispatch("translate.event", format!(r#"{{"id":{id},"op":"begin","user":{}}}"#, "[".repeat(3000)).as_bytes()).is_err());
    assert_eq!(event(id, json!({ "op": "begin", "turnId": "t" }))["turnId"], "t");
    assert_eq!(close(id), b"true");
}

#[test]
fn an_owners_translators_go_with_it() {
    let owner = new_owner();
    let id = open_as(&Call::of(owner));
    assert_eq!(event(id, json!({ "op": "begin", "turnId": "t" }))["turnId"], "t");
    release(owner);
    assert_eq!(close(id), b"false");
}

#[test]
fn a_replay_keeps_a_translator_only_when_asked_and_owned_by_its_caller() {
    let lines = |keep: bool| {
        let header = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed", "live": "t", "keep": keep });
        format!("{header}\n{}", json!({ "t": "user", "turnId": "t", "user": { "id": "u" } }))
    };
    let reply: Json = serde_json::from_slice(&dispatch("translate.replay", lines(false).as_bytes()).expect("a reply")).expect("JSON");
    assert_eq!(reply["turns"][0]["status"], "inProgress");
    assert_eq!(reply.get("id"), None);
    let owner = new_owner();
    let kept = dispatch_call("translate.replay", lines(true).as_bytes(), &Call::of(owner)).expect("a reply");
    let reply: Json = serde_json::from_slice(&kept).expect("JSON");
    let id = reply["id"].as_u64().expect("an id");
    assert_eq!(reply["turnId"], "t");
    assert_eq!(methods(&event(id, json!({ "op": "end", "stopReason": "end_turn" }))), ["turn/completed"]);
    release(owner);
    assert_eq!(close(id), b"false");
}

#[test]
fn a_record_too_deep_to_read_is_left_out_and_a_failed_one_fails_the_read() {
    let header = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed", "live": true });
    let deep = format!(r#"{{"t":"update","turnId":"t","update":{}{}}}"#, "[".repeat(2000), "]".repeat(2000));
    let user = json!({ "t": "user", "turnId": "t" });
    let reply = dispatch(
        "translate.replay",
        format!("{header}\n{user}\n{deep}\n\n{}", json!({ "t": "end", "turnId": "t", "stopReason": "end_turn" })).as_bytes(),
    );
    let reply: Json = serde_json::from_slice(&reply.expect("a reply")).expect("JSON");
    assert_eq!(reply["turns"][0]["status"], "completed");
    let bad = dispatch("translate.replay", format!("{header}\n{user}\nnull").as_bytes());
    assert_eq!(bad, Err("an ACP transcript's record is null".to_string()));
    let refused = json!({ "t": "end", "turnId": "t", "stopReason": { "toString": 1 } });
    assert!(dispatch("translate.replay", format!("{header}\n{user}\n{refused}").as_bytes()).is_err());
}

#[test]
fn a_cancelled_replay_stops_between_records() {
    let call = Call::default();
    call.cancel.cancel();
    let payload = format!("{}\n{}", json!({ "threadId": "chat" }), json!({ "t": "user", "turnId": "t" }));
    assert_eq!(dispatch_call("translate.replay", payload.as_bytes(), &call), Err(dispatch::CANCELLED.to_string()));
}

#[test]
fn the_deepest_update_a_route_reads_fits_the_stack_of_any_js_thread() {
    // a release build needs under 512 KB here, against JS's main thread's 8 MB in Electron and 1 MB under plain Node on Windows;
    // a test build needs up to four times that
    let deep = format!("{}1{}", r#"{"a":"#.repeat(998), "}".repeat(998));
    let reading = std::thread::Builder::new().stack_size(4 << 20).spawn(move || {
        let id = open();
        event(id, json!({ "op": "begin", "turnId": "t" }));
        let call = format!(r#"{{"id":{id},"now":1,"op":"update","turnId":"t","update":{{"sessionUpdate":"tool_call","toolCallId":"c","rawInput":{deep}}}}}"#);
        let reply = dispatch("translate.event", call.as_bytes()).expect("a reply");
        assert!(reply.len() > 998 * 5);
        assert_eq!(close(id), b"true");
    });
    reading.expect("a thread").join().expect("no failure");
}

#[test]
fn an_auto_turn_is_named_from_the_translators_seed_and_counts() {
    let id = open();
    let first = event(id, json!({ "op": "update", "update": text("x"), "turnId": null }));
    assert_eq!(first["turnId"], "auto-seed-0");
    event(id, json!({ "op": "end", "stopReason": "cancelled" }));
    let second = event(id, json!({ "op": "update", "update": text("y") }));
    assert_eq!(second["turnId"], "auto-seed-1");
    // a turn already running takes what comes, whatever turn it names
    assert_eq!(update(id, text("z"))["turnId"], "auto-seed-1");
    assert_eq!(close(id), b"true");
}

#[test]
fn a_proto_key_in_an_update_is_left_out_where_js_changed_the_objects_prototype() {
    let id = open();
    event(id, json!({ "op": "begin", "turnId": "t" }));
    let call = r#"{"id":ID,"op":"update","turnId":"t","update":{"sessionUpdate":"tool_call_update","toolCallId":"c","kind":"execute","__proto__":{"title":"from the prototype"}}}"#;
    let reply = dispatch("translate.event", call.replace("ID", &id.to_string()).as_bytes()).expect("a reply");
    let reply: Json = serde_json::from_slice(&reply).expect("JSON");
    assert_eq!(reply["emits"][0][1]["item"]["command"], "");
    assert_eq!(close(id), b"true");
}

#[test]
fn opens_past_the_limit_are_refused_and_nothing_open_is_taken_away() {
    // the family is shared with the tests running beside this: it only has to fill up
    let mut opened = Vec::new();
    let header = json!({ "threadId": "chat" }).to_string();
    let refused = loop {
        match dispatch("translate.open", header.as_bytes()) {
            Ok(id) => opened.push(String::from_utf8(id).expect("UTF-8")),
            Err(error) => break error,
        }
    };
    assert!(refused.starts_with("too many translators open"), "{refused}");
    for id in opened {
        assert_eq!(dispatch("translate.close", id.as_bytes()), Ok(b"true".to_vec()));
    }
}

mod history;
