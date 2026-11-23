//! A task and a sub-agent's run through a turn, as the routes have them: what a run's end leaves and where a task's name comes from.

use crate::claude::scenarios::{close, event, message, open};
use dispatch::{dispatch, dispatch_call, Call};
use serde_json::{json, Value as Json};

#[test]
fn a_task_created_with_no_subject_takes_the_one_its_structured_result_names() {
    let id = open();
    event(id, "begin", json!({ "turnId": "t", "user": { "id": "u", "content": [] } }), None);
    let create = json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [{ "type": "tool_use", "id": "n", "name": "TaskCreate", "input": {} }] } });
    message(id, create);
    let result = json!({
        "type": "user",
        "uuid": "r",
        "tool_use_result": { "task": { "id": 5, "subject": "From result" } },
        "message": { "content": [{ "type": "tool_result", "tool_use_id": "n", "content": "ok" }] },
    });
    let reply = message(id, result);
    let plan = reply["emits"].as_array().expect("emits").iter().find(|emit| emit[0] == "turn/plan/updated").expect("a plan");
    assert_eq!(plan[1]["plan"], json!([{ "step": "From result", "status": "pending" }]));
    close(id);
}

#[test]
fn a_finished_agent_is_left_alone_when_its_turn_is_stopped() {
    let id = open();
    event(id, "begin", json!({ "turnId": "t", "user": { "id": "u", "content": [] } }), None);
    let launch = json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [
        { "type": "tool_use", "id": "ag", "name": "Agent", "input": { "description": "Dig", "run_in_background": true } },
    ] } });
    message(id, launch);
    let launched = json!({ "type": "user", "uuid": "r", "message": { "content": [{ "type": "tool_result", "tool_use_id": "ag", "content": "launched" }] } });
    message(id, launched);
    let content =
        "<task-notification><tool-use-id>ag</tool-use-id><status>completed</status><usage>duration_ms: 5</usage></task-notification>";
    let settled = message(id, json!({ "type": "user", "uuid": "n", "message": { "content": content } }));
    assert!(settled.to_string().contains(r#""status":"completed""#), "the run settled: {settled}");
    let ended = event(id, "end", json!({ "status": "interrupted" }), None);
    assert!(!ended.to_string().contains("stopped"), "still finished: {ended}");
    close(id);
}

fn launched(id: u64) {
    event(id, "begin", json!({ "turnId": "t", "user": { "id": "u", "content": [] } }), None);
    let launch = json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [
        { "type": "tool_use", "id": "ag", "name": "Agent", "input": { "description": "Dig" } },
    ] } });
    message(id, launch);
}

fn said_by_the_agent(id: u64) -> Vec<u8> {
    let step = json!({ "type": "assistant", "uuid": "s", "parent_tool_use_id": "ag", "message": { "id": "c", "content": [{ "type": "text", "text": "line\none" }] } });
    let payload = format!("{}\n{step}", json!({ "id": id, "now": 1, "op": "message" }));
    dispatch("translate.claudeEvent", payload.as_bytes()).expect("a reply")
}

#[test]
fn a_transcript_goes_after_the_reply_line_where_the_line_says() {
    let id = open();
    launched(id);
    let reply = said_by_the_agent(id);
    let end = reply.iter().position(|byte| *byte == b'\n').expect("a line");
    let head: Json = serde_json::from_slice(&reply[..end]).expect("JSON");
    let said = head["emits"].as_array().expect("emits").iter().find(|emit| emit[0] == "agent/items").expect("the transcript");
    assert_eq!(said[1].get("items"), None, "none of it in the line, which is all that is parsed at once");
    let at = |n: usize| said[1]["itemsAt"][n].as_u64().expect("a place") as usize;
    let items: Json = serde_json::from_slice(&reply[end + 1..][at(0)..at(1)]).expect("JSON");
    assert_eq!(items[0]["text"], "line\none");
    close(id);
}

#[test]
fn a_translator_that_shows_no_transcript_says_none_and_keeps_the_row_going() {
    let header = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed", "children": false }).to_string();
    let opened = dispatch_call("translate.claudeOpen", header.as_bytes(), &Call::default()).expect("an id");
    let id: u64 = String::from_utf8(opened).expect("UTF-8").parse().expect("a number");
    launched(id);
    let reply = String::from_utf8(said_by_the_agent(id)).expect("UTF-8");
    assert!(!reply.contains("agent/items"), "{reply}");
    assert!(reply.ends_with('\n'), "nothing after the line: {reply}");
    let ended = event(id, "end", json!({ "status": "interrupted" }), None);
    assert!(!ended.to_string().contains("agent/items"), "nor when it is cut off: {ended}");
    close(id);
}

/// Phone consumers opt into native block identity without changing the window's existing item ids.
#[test]
fn phone_block_identity_survives_stream_completion_without_changing_default_output() {
    for enabled in [false, true] {
        let header = json!({ "threadId": "chat", "auto": "seed", "sourceIds": enabled }).to_string();
        let opened = dispatch_call("translate.claudeOpen", header.as_bytes(), &Call::default()).expect("an id");
        let id = String::from_utf8(opened).expect("UTF-8").parse().expect("a number");
        event(id, "begin", json!({ "turnId": "ct-p" }), None);
        message(id, json!({ "type": "stream_event", "event": { "type": "message_start", "message": { "id": "m" } } }));
        for (index, kind) in [(0, "thinking"), (2, "text")] {
            let started = message(
                id,
                json!({ "type": "stream_event", "event": {
                "type": "content_block_start", "index": index, "content_block": { "type": kind }
            } }),
            );
            let item = &started["emits"][0][1]["item"];
            let native = format!("m:{index}");
            assert_eq!(item["id"], native);
            assert_eq!(item.get("sourceId"), enabled.then_some(&json!(native)));
        }
        let completed = message(
            id,
            json!({ "type": "assistant", "message": { "id": "m", "content": [
            { "type": "thinking", "thinking": "Plan" },
            { "type": "tool_use", "id": "tool", "name": "Bash", "input": { "command": "pwd" } },
            { "type": "text", "text": "Reply" }
        ] } }),
        );
        let items: Vec<_> = completed["emits"].as_array().expect("emits").iter().filter_map(|emit| emit[1].get("item")).collect();
        assert_eq!(items.len(), 3);
        for (at, native) in [(0, "m:0"), (2, "m:2")] {
            assert_eq!(items[at]["id"], native, "completion retains the streamed item id");
            assert_eq!(items[at].get("sourceId"), enabled.then_some(&json!(native)));
        }
        assert!(items[1].get("sourceId").is_none(), "a tool already has a native call id");
        close(id);
    }
}

#[test]
fn replayed_phone_blocks_use_message_offsets_instead_of_translator_counters() {
    let header = json!({ "threadId": "chat", "auto": "seed", "sourceIds": true, "now": 1_800_000_000_000u64 });
    let mut payload = header.to_string();
    for record in [
        json!({ "type": "user", "uuid": "prior", "message": { "content": "Earlier" } }),
        json!({ "type": "assistant", "message": { "id": "older", "content": [{ "type": "text", "text": "Earlier reply" }] } }),
        json!({ "type": "user", "uuid": "p", "message": { "content": "Now" } }),
        json!({ "type": "assistant", "message": { "id": "m", "content": [
            { "type": "thinking", "thinking": "Plan" },
            { "type": "text", "text": "Reply" }
        ] } }),
    ] {
        payload.push('\n');
        payload.push_str(&record.to_string());
    }
    let opened = dispatch_call("translate.claudeRead", payload.as_bytes(), &Call::default()).expect("a read");
    let opened: Json = serde_json::from_slice(&opened).expect("JSON");
    assert_eq!(opened["unread"], 0);
    let id = opened["id"].as_u64().expect("an id");
    let page = dispatch("translate.claudeSettle", json!({ "id": id }).to_string().as_bytes()).expect("a page");
    let end = page.iter().position(|byte| *byte == b'\n').expect("a line of ids");
    let page: Json = serde_json::from_slice(&page[end + 1..]).expect("JSON");
    let items = page["turns"][1]["items"].as_array().expect("second turn items");
    assert_eq!(items[1]["sourceId"], "m:0");
    assert_eq!(items[2]["sourceId"], "m:1");
    assert_ne!(items[2]["id"], items[2]["sourceId"], "replay's legacy id can differ without changing phone identity");
    dispatch("translate.claudeRelease", id.to_string().as_bytes()).expect("released");
}

/// Every way the login fails is one failed turn carrying the failure's own sentence, or the default one when it said none; an ordinary reply is neither.
#[test]
fn a_login_failure_ends_the_turn_with_its_sentence_or_the_default_one() {
    let failure = |error: Option<&str>, text: &str| {
        let id = open();
        event(id, "begin", json!({ "turnId": "t", "user": { "id": "u", "content": [] } }), None);
        let mut said = json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [{ "type": "text", "text": text }] } });
        if let Some(error) = error {
            said["error"] = json!(error);
        }
        message(id, said);
        let ended = message(id, json!({ "type": "result", "subtype": "success", "is_error": true, "usage": {} }));
        close(id);
        ended.to_string()
    };
    for error in ["authentication_failed", "oauth_org_not_allowed"] {
        assert!(failure(Some(error), "Please sign in again").contains("Please sign in again"), "{error} with its sentence");
        assert!(failure(Some(error), "  ").contains("Failed to authenticate"), "{error} with none");
    }
    assert!(!failure(None, "An ordinary reply").contains("Failed to authenticate"), "no error word, no login failure");
}
