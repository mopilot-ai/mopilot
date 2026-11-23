//! A chat's history through its routes: a read, what the session says over it, its pages, and what a read leaves out.

use super::*;

fn read(extra: Json) -> u64 {
    let header = json!({ "threadId": "chat", "cwd": "/w", "auto": "seed", "file": "/no/such/transcript", "extra": extra }).to_string();
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.as_bytes()).expect("a read")).expect("JSON");
    reply["id"].as_u64().expect("an id")
}

fn settle(id: u64, input: Json) -> Json {
    let mut input = input;
    input["id"] = json!(id);
    let said = input.as_object_mut().and_then(|input| input.remove("emits")).unwrap_or(json!([]));
    let said = said.as_array().expect("a list").iter().map(Json::to_string);
    let lines: Vec<String> = std::iter::once(input.to_string()).chain(said).collect();
    page_of(&dispatch("translate.settle", lines.join("\n").as_bytes()).expect("a page")).1
}

/// A page's first byte, and its JSON once its line of ids is held to it.
fn page_of(reply: &[u8]) -> (u8, Json) {
    let end = reply.iter().position(|byte| *byte == b'\n').expect("a line of ids");
    let ids: Json = serde_json::from_slice(&reply[1..end]).expect("ids");
    let page: Json = serde_json::from_slice(&reply[end + 1..]).expect("JSON");
    let turns = page["turns"].as_array().expect("turns");
    assert_eq!(ids, Json::Array(turns.iter().map(|turn| turn["id"].clone()).collect()));
    (reply[0], page)
}

fn release(id: u64) -> Vec<u8> {
    dispatch("translate.release", id.to_string().as_bytes()).expect("a reply")
}

fn user(turn: &str) -> Json {
    json!({ "t": "user", "turnId": turn, "user": { "id": "u" } })
}

fn message(turn: &str, text: &str) -> Json {
    json!({ "t": "update", "turnId": turn, "update": super::text(text) })
}

fn file(name: &str, bytes: &[u8]) -> String {
    let dir = std::env::temp_dir().join(format!("mopilot-translate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a folder");
    let path = dir.join(name);
    std::fs::write(&path, bytes).expect("a file");
    path.to_str().expect("UTF-8").to_string()
}

#[test]
fn a_page_is_cut_as_a_turn_page_is() {
    let extra = json!([user("a"), { "t": "session" }, { "t": "end", "turnId": "a", "stopReason": "end_turn" }, { "t": "end", "turnId": "a", "stopReason": "refusal" }, user("b"), user("c"), user("d")]);
    let id = read(extra);
    let page = settle(id, json!({ "live": "d", "limit": 2 }));
    let ids = |page: &Json| {
        page["turns"].as_array().expect("turns").iter().map(|t| t["id"].as_str().expect("an id").to_string()).collect::<Vec<_>>()
    };
    assert_eq!((ids(&page), page["olderCursor"].as_str()), (vec!["c".to_string(), "d".to_string()], Some("2")));
    let ask = |before: &str, limit: u32| {
        let input = json!({ "id": id, "limit": limit, "before": before }).to_string();
        page_of(&dispatch("translate.page", input.as_bytes()).expect("a page"))
    };
    let (more, older) = ask("2", 2);
    assert_eq!((more, ids(&older), older["olderCursor"].as_str()), (b'0', vec!["a".to_string(), "b".to_string()], None));
    assert_eq!(ids(&ask("0", 2).1), Vec::<String>::new());
    let (more, latest) = ask("gone", 1);
    assert_eq!((more, ids(&latest)), (b'1', vec!["d".to_string()]));
    assert_eq!(ids(&ask("", 0).1).len(), 4);
    assert_eq!(release(id), b"true");
    assert_eq!(release(id), b"false");
    assert!(dispatch("translate.release", b"nope").is_err());
    assert!(dispatch("translate.page", b"nope").is_err());
    assert!(dispatch("translate.settle", b"nope").is_err());
    assert!(dispatch("translate.read", b"nope").is_err());
}

#[test]
fn a_page_of_long_turns_stops_early_but_never_comes_back_empty() {
    let long = "x".repeat(5 << 20);
    let id = read(json!([user("a"), message("a", &long), user("b"), message("b", &long), user("c"), message("c", &long)]));
    let page = settle(id, json!({ "live": "c", "limit": 30 }));
    assert_eq!((page["turns"].as_array().expect("turns").len(), page["olderCursor"].as_str()), (1, Some("2")));
    let every = settle(id, json!({ "live": "c" }));
    assert_eq!((every["turns"].as_array().expect("turns").len(), &every["olderCursor"]), (3, &Json::Null));
    assert_eq!(release(id), b"true");
}

/// Every turn id of a chat of these turns, as a reader paging back by `limit` gets them; a reader going round runs out of pages.
fn paged_back(name: &str, turns: &[String], limit: usize) -> Vec<String> {
    let lines: Vec<String> = turns.iter().map(|turn| user(turn).to_string()).collect();
    let header = json!({ "threadId": "chat", "file": file(name, lines.join("\n").as_bytes()) }).to_string();
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.as_bytes()).expect("a read")).expect("JSON");
    let id = reply["id"].as_u64().expect("an id");
    let ids = |page: &Json| page["turns"].as_array().expect("turns").iter().map(|turn| turn["id"].to_string()).collect::<Vec<_>>();
    let mut page = settle(id, json!({ "live": false, "limit": limit }));
    let mut seen = ids(&page);
    for _ in 0..turns.len() {
        let Some(cursor) = page["olderCursor"].as_str() else { break };
        let input = json!({ "id": id, "limit": limit, "before": cursor }).to_string();
        page = page_of(&dispatch("translate.page", input.as_bytes()).expect("a page")).1;
        seen.splice(0..0, ids(&page));
    }
    assert_eq!(page["olderCursor"], Json::Null);
    assert_eq!(release(id), b"true");
    seen
}

#[test]
fn a_turn_id_said_twice_can_not_send_a_reader_round() {
    let quoted = |turns: &[String]| turns.iter().map(|turn| format!("{turn:?}")).collect::<Vec<_>>();
    let mut apart: Vec<String> = (0..90).map(|at| format!("t{at}")).collect();
    (apart[30], apart[60]) = ("X".to_string(), "X".to_string());
    assert_eq!(paged_back("apart.jsonl", &apart, 30), quoted(&apart));
    let mut beside: Vec<String> = (0..70).map(|at| format!("t{at}")).collect();
    (beside[40], beside[41]) = ("X".to_string(), "X".to_string());
    // the second of two side by side goes on with the turn the first began, as it did in the JS, and no page repeats it
    let turns = paged_back("beside.jsonl", &beside, 30);
    beside.remove(41);
    assert_eq!(turns, quoted(&beside));
    let first: Vec<String> = ["a", "b", "a", "c"].map(str::to_string).to_vec();
    assert_eq!(paged_back("first.jsonl", &first, 1), quoted(&first));
}

#[test]
fn a_last_line_still_being_written_is_no_failure_and_turns_touched_are_written_again() {
    let path = file("partial.jsonl", format!("{}\n{{\"t\":\"up", user("at-1")).as_bytes());
    let header = json!({ "threadId": "chat", "file": path }).to_string();
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.as_bytes()).expect("a read")).expect("JSON");
    assert_eq!(reply["unread"], 0);
    let id = reply["id"].as_u64().expect("an id");
    let emits = json!([["turn/completed", { "turn": { "id": "at-1", "status": "completed", "error": null, "completedAt": 5 } }]]);
    let page = settle(id, json!({ "live": "at-1", "emits": emits }));
    assert_eq!((&page["turns"][0]["status"], &page["turns"][0]["completedAt"]), (&json!("completed"), &json!(5)));
    assert_eq!(release(id), b"true");
    assert!(dispatch("translate.page", b"{}").expect_err("no id").starts_with("no history"));
}

#[test]
fn what_a_session_said_lands_on_what_the_read_found() {
    let id = read(json!([user("a")]));
    let item = |id: &str, status: &str| json!({ "id": id, "status": status });
    let emits = json!([
        ["item/completed", { "turnId": "a", "item": item("one", "failed") }],
        ["item/started", { "turnId": "a", "item": item("one", "inProgress") }],
        ["item/started", { "turnId": "a", "item": item("two", "inProgress") }],
        ["item/completed", { "turnId": "gone", "item": item("three", "inProgress") }],
        ["item/completed", { "turnId": "a" }],
        ["turn/plan/updated", { "turnId": "a", "plan": [1] }],
        ["turn/plan/updated", { "turnId": "gone", "plan": [2] }],
        ["turn/completed", { "turn": { "id": "a", "status": "completed", "error": { "message": "x" } } }],
        ["turn/completed", { "turn": { "id": "gone", "status": "completed" } }],
        ["turn/started", { "turn": { "id": "b", "startedAt": 3 } }],
        ["turn/completed", { "turn": { "id": "b" } }],
        ["turn/started", { "turn": { "id": "b" } }],
        ["not", "a method it knows"],
        "no pair",
        [],
    ]);
    let page = settle(id, json!({ "live": "b", "emits": emits, "stream": u64::MAX >> 12 }));
    let first = &page["turns"][0];
    assert_eq!((&first["status"], &first["error"]["message"], &first["plan"]["steps"][0]), (&json!("completed"), &json!("x"), &json!(1)));
    let statuses: Vec<&Json> = first["items"].as_array().expect("items").iter().skip(1).map(|item| &item["status"]).collect();
    assert_eq!(statuses, [&json!("failed"), &json!("inProgress")]);
    assert_eq!((&page["turns"][1]["id"], &page["turns"][1]["status"]), (&json!("b"), &json!("inProgress")));
    assert_eq!(release(id), b"true");
}

#[test]
fn the_open_message_is_read_from_the_sessions_translator() {
    let live = open();
    event(live, json!({ "op": "begin", "turnId": "t" }));
    update(live, text("whole so far"));
    let id = read(json!([user("t"), message("t", "whole")]));
    let page = settle(id, json!({ "live": "t", "stream": live }));
    assert_eq!(page["turns"][0]["items"][1]["text"], "whole so far");
    assert_eq!(release(id), b"true");
    // a thought's goes in its summary, and an open message the read never found changes nothing
    event(live, json!({ "op": "end", "stopReason": "end_turn" }));
    event(live, json!({ "op": "begin", "turnId": "u" }));
    update(live, json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "hmm" } }));
    let id = read(
        json!([user("u"), { "t": "update", "turnId": "u", "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "h" } } }]),
    );
    let page = settle(id, json!({ "live": "u", "stream": live }));
    assert_eq!(page["turns"][0]["items"][1]["summary"][0], "hmm");
    assert_eq!(release(id), b"true");
    let id = read(json!([user("u")]));
    let page = settle(id, json!({ "live": "u", "stream": live }));
    assert_eq!(page["turns"][0]["items"].as_array().expect("items").len(), 1);
    assert_eq!(release(id), b"true");
    // one still held back has nothing to give
    event(live, json!({ "op": "begin", "turnId": "v" }));
    update(live, text("## Objective\n"));
    let id = read(json!([user("v")]));
    settle(id, json!({ "live": "v", "stream": live }));
    assert_eq!(release(id), b"true");
    assert_eq!(close(live), b"true");
}

#[test]
fn a_transcript_is_read_as_its_lines_with_each_bad_one_left_alone() {
    let bad =
        json!({ "t": "update", "turnId": "a", "update": { "sessionUpdate": "tool_call", "toolCallId": "c", "title": { "toString": 1 } } });
    let lines = format!("\n  \n{}\n7\nnot json\n{bad}\n{}\n", user("a"), message("a", "caf\u{e9}"));
    let mut bytes = lines.into_bytes();
    bytes.extend_from_slice(b"\xff\n");
    let path = file("lines.jsonl", &bytes);
    let header = json!({ "threadId": "chat", "file": path }).to_string();
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.as_bytes()).expect("a read")).expect("JSON");
    assert_eq!(reply["unread"], 4);
    let id = reply["id"].as_u64().expect("an id");
    let page = settle(id, json!({ "live": "a" }));
    assert_eq!(page["turns"][0]["items"].as_array().expect("items").len(), 2);
    assert_eq!(release(id), b"true");
}

#[test]
fn what_was_said_too_deep_to_read_is_left_out_of_a_page_and_the_rest_stands() {
    let id = read(json!([user("a")]));
    let deep = format!(r#"["item/completed",{}{}]"#, "[".repeat(2000), "]".repeat(2000));
    let item = json!({ "id": "m", "type": "agentMessage", "text": "kept" });
    let said = json!(["item/completed", { "turnId": "a", "item": item }]);
    let input = format!("{}\n{deep}\n{said}", json!({ "id": id, "live": "a" }));
    let page = page_of(&dispatch("translate.settle", input.as_bytes()).expect("a page")).1;
    assert_eq!(page["turns"][0]["items"][1]["text"], "kept");
    assert_eq!(release(id), b"true");
}

#[test]
fn only_what_is_not_there_yet_is_absent() {
    let transcript = file("present.jsonl", b"{}");
    let folder = std::env::temp_dir();
    assert!(crate::history::absent(folder.join("no-folder-here").join("no.jsonl").to_str().expect("UTF-8")));
    assert!(crate::history::absent(""));
    assert!(!crate::history::absent(&transcript));
    assert!(!crate::history::absent(folder.to_str().expect("UTF-8")));
    // Windows's answer for these, which no Unix read gives
    let not_found = || Err(std::io::ErrorKind::NotFound.into());
    assert!(crate::history::bytes_of(not_found(), folder.to_str().expect("UTF-8")).is_err());
    // a read that looked before a chat's first record was written reads again
    assert_eq!(crate::history::bytes_of(not_found(), &transcript), Ok(b"{}".to_vec()));
    assert_eq!(crate::history::bytes_of(not_found(), "/no/such/transcript"), Ok(Vec::new()));
    // what Windows calls not found, and Unix a file that is no folder
    let under = std::path::Path::new(&transcript).join("no.jsonl");
    assert!(!crate::history::absent(under.to_str().expect("UTF-8")));
    let header = json!({ "threadId": "chat", "file": under.to_str() }).to_string();
    assert!(dispatch("translate.read", header.as_bytes()).expect_err("a file in the way").starts_with("read an ACP transcript"));
}

#[test]
fn a_folder_where_a_transcript_should_be_fails_the_read_and_no_file_is_no_turns() {
    let path = std::env::temp_dir();
    let header = json!({ "threadId": "chat", "file": path.to_str() }).to_string();
    assert!(dispatch("translate.read", header.as_bytes()).expect_err("no file").starts_with("read an ACP transcript"));
    let id = read(json!([]));
    assert_eq!(settle(id, json!({ "before": 7, "limit": "x", "stream": "y" }))["turns"], json!([]));
    assert_eq!(release(id), b"true");
}

#[test]
fn a_record_of_mains_that_fails_fails_the_read_and_a_cancelled_read_stops() {
    let header = json!({ "threadId": "chat", "file": "/no/such/transcript", "extra": [null] }).to_string();
    assert!(dispatch("translate.read", header.as_bytes()).is_err());
    let path = file("cancelled.jsonl", user("a").to_string().as_bytes());
    let call = Call::default();
    call.cancel.cancel();
    let header = json!({ "threadId": "chat", "file": path }).to_string();
    assert_eq!(dispatch_call("translate.read", header.as_bytes(), &call), Err(dispatch::CANCELLED.to_string()));
}

#[test]
fn a_turn_the_read_left_open_ends_when_it_settles_unless_it_runs() {
    let id = read(json!([user("a")]));
    assert_eq!(settle(id, json!({ "live": false }))["turns"][0]["status"], "interrupted");
    assert_eq!(release(id), b"true");
    // a call that can't be read goes unsaid, and the turn ends
    let bad =
        json!({ "t": "update", "turnId": "a", "update": { "sessionUpdate": "tool_call", "toolCallId": "c", "title": { "toString": 1 } } });
    let path = file("bad.jsonl", format!("{}\n{bad}\n", user("a")).as_bytes());
    let header = json!({ "threadId": "chat", "file": path }).to_string();
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.as_bytes()).expect("a read")).expect("JSON");
    let id = reply["id"].as_u64().expect("an id");
    assert_eq!(settle(id, json!({ "live": false }))["turns"][0]["status"], "interrupted");
    assert_eq!(release(id), b"true");
}

fn read_of(header: Json) -> (u64, Json) {
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.to_string().as_bytes()).expect("a read")).expect("JSON");
    (reply["id"].as_u64().expect("an id"), reply["cwd"].clone())
}

/// Every part of what `id` holds, as `translate.turns` gives it, and how many replies that took.
fn all_turns(id: u64, live: Json) -> (Vec<Json>, usize) {
    let (mut turns, mut replies, mut at): (Vec<Json>, usize, Json) = (Vec::new(), 0, json!([0, 0]));
    while let Some([turn, item]) = at.as_array().map(Vec::as_slice).and_then(<[Json]>::first_chunk) {
        let mut input = json!({ "id": id, "turn": turn, "item": item });
        if replies == 0 {
            input["live"] = live.clone();
        }
        let reply: Json =
            serde_json::from_slice(&dispatch("translate.turns", input.to_string().as_bytes()).expect("a slice")).expect("JSON");
        for (index, part) in reply["parts"].as_array().expect("parts").iter().enumerate() {
            if index == 0 && item != 0 {
                let mine = turns.last_mut().expect("a turn it goes on").as_object_mut().expect("a turn");
                mine["items"].as_array_mut().expect("items").extend(part["items"].as_array().expect("items").iter().cloned());
            } else {
                turns.push(part.clone());
            }
        }
        replies += 1;
        at = reply["next"].clone();
    }
    (turns, replies)
}

#[test]
fn every_turn_comes_a_slice_at_a_time_and_a_long_turn_across_slices() {
    let long = "x".repeat(3 << 20);
    let mut records = vec![user("a")];
    for at in 0..4 {
        let call = json!({ "sessionUpdate": "tool_call", "toolCallId": format!("c{at}"), "status": "completed", "kind": "execute", "title": long });
        records.push(json!({ "t": "update", "turnId": "a", "update": call }));
    }
    records.extend([user("b"), user("c")]);
    let id = read(json!(records));
    let (turns, replies) = all_turns(id, json!("c"));
    let ids: Vec<&Json> = turns.iter().map(|turn| &turn["id"]).collect();
    assert_eq!(ids, [&json!("a"), &json!("b"), &json!("c")]);
    assert_eq!(turns[0]["items"].as_array().expect("items").len(), 5);
    assert_eq!(turns[2]["status"], "inProgress");
    assert_eq!(replies, 4);
    assert_eq!(release(id), b"true");
    // a read with nothing in it says so at once, and one slice settles a turn cut off
    let id = read(json!([]));
    assert_eq!(all_turns(id, json!(false)), (Vec::new(), 1));
    assert_eq!(release(id), b"true");
    let id = read(json!([user("a")]));
    assert_eq!(all_turns(id, json!(false)).0[0]["status"], "interrupted");
    assert_eq!(release(id), b"true");
    assert!(dispatch("translate.turns", b"nope").is_err());
}

#[test]
fn an_item_past_a_slice_comes_whole_and_a_turn_at_the_edge_waits_for_the_next() {
    let long = "x".repeat(9 << 20);
    let call = json!({ "sessionUpdate": "tool_call", "toolCallId": "c", "status": "completed", "kind": "execute", "title": long });
    let id = read(json!([user("a"), { "t": "update", "turnId": "a", "update": call }, user("b")]));
    let (turns, replies) = all_turns(id, json!("b"));
    assert_eq!((turns.len(), replies), (2, 3));
    assert_eq!(release(id), b"true");
}

#[test]
fn a_read_told_where_to_stop_leaves_what_came_after() {
    let first = format!("{}\n", user("a"));
    let path = file("bounded.jsonl", format!("{first}{}\n", user("b")).as_bytes());
    let (id, _) = read_of(json!({ "threadId": "chat", "file": path, "upTo": first.len() }));
    assert_eq!(settle(id, json!({ "live": "a" }))["turns"].as_array().expect("turns").len(), 1);
    assert_eq!(release(id), b"true");
}

#[test]
fn a_transcript_names_its_own_folder_when_asked() {
    let session = json!({ "t": "session", "cwd": "/there" });
    let path = file("named.jsonl", format!("{{\"t\":\"session\",\"cwd\":\"/there\"}}\n{}", user("a")).as_bytes());
    let (id, cwd) = read_of(json!({ "threadId": "chat", "cwd": "/here", "file": path, "findCwd": true }));
    assert_eq!(cwd, "/there");
    assert_eq!(release(id), b"true");
    let (id, cwd) = read_of(json!({ "threadId": "chat", "cwd": "/here", "file": path }));
    assert_eq!(cwd, "/here");
    assert_eq!(release(id), b"true");
    // main's own records can name it, and one that names nothing leaves the caller's
    let (id, cwd) = read_of(json!({ "threadId": "chat", "cwd": "/here", "file": "/no/such", "findCwd": true, "extra": [session] }));
    assert_eq!(cwd, "/there");
    assert_eq!(release(id), b"true");
    let (id, cwd) = read_of(
        json!({ "threadId": "chat", "cwd": "/here", "file": "/no/such", "findCwd": true, "extra": [{ "t": "session", "cwd": "" }, user("a")] }),
    );
    assert_eq!(cwd, "/here");
    assert_eq!(release(id), b"true");
    let (id, cwd) = read_of(json!({ "threadId": "chat", "file": "/no/such", "findCwd": true }));
    assert_eq!(cwd, Json::Null);
    assert_eq!(release(id), b"true");
}

#[test]
fn a_read_of_a_running_turn_becomes_its_translator() {
    let call = Call::of(new_owner());
    let keep = |id: u64, live: Json| {
        let input = json!({ "id": id, "live": live }).to_string();
        serde_json::from_slice::<Json>(&dispatch_call("translate.keep", input.as_bytes(), &call).expect("a reply")).expect("JSON")
    };
    let id = read(
        json!([user("t"), message("t", "one"), { "t": "update", "turnId": "t", "update": { "sessionUpdate": "tool_call", "toolCallId": "c", "kind": "execute", "status": "in_progress" } }]),
    );
    let kept = keep(id, json!("t"));
    assert_eq!(kept["turnId"], "t");
    assert_eq!(release(id), b"false");
    let live = kept["id"].as_u64().expect("an id");
    // its next item takes the next id, as the transcript gave out the ones before
    let next = update(live, super::text("two"));
    assert_eq!(next["emits"][0][1]["item"]["id"], "t:m1");
    assert_eq!(methods(&event(live, json!({ "op": "end", "stopReason": "end_turn" }))).last(), Some(&"turn/completed"));
    assert_eq!(close(live), b"true");
    // a turn that isn't the one running, or that ended, leaves nothing to go on with
    let id = read(json!([user("t")]));
    assert_eq!(keep(id, json!("other")), Json::Null);
    let id = read(json!([user("t"), { "t": "end", "turnId": "t", "stopReason": "end_turn" }]));
    assert_eq!(keep(id, json!("t")), Json::Null);
    assert!(dispatch("translate.keep", b"nope").is_err());
    assert!(dispatch("translate.keep", b"{}").expect_err("no id").starts_with("no history"));
}

#[test]
fn a_closed_card_replays_as_a_note_in_its_turn_and_a_kind_nobody_reads_costs_nothing() {
    let card = |turn: &str, request: &str, line: &str| json!({ "t": "card", "turnId": turn, "requestId": request, "line": line, "reason": "expired" });
    let header = json!({
        "threadId": "chat", "cwd": "/w", "auto": "seed", "file": "/no/such/transcript",
        "extra": [
            user("a"), message("a", "hi"), card("a", "r1", "Not answered"),
            { "t": "end", "turnId": "a", "stopReason": "end_turn" },
            user("b"), card("b", "r2", "Allowed on Pocket iPhone"),
            // no line, no request, a turn nobody started: nothing to show; and kinds this reader does not know
            card("b", "r3", ""), json!({ "t": "card", "turnId": "b", "line": "no id" }), json!({ "t": "card", "turnId": "b", "requestId": "r5" }),
            card("zz", "r4", "of no turn here"), { "t": "title", "name": "x" }, { "t": "somethingNew", "turnId": "b" }
        ]
    })
    .to_string();
    let reply: Json = serde_json::from_slice(&dispatch("translate.read", header.as_bytes()).expect("a read")).expect("JSON");
    // every record was read: the unknown kinds are not "unreadable"
    assert_eq!(reply["unread"], json!(0));
    let page = settle(reply["id"].as_u64().expect("an id"), json!({ "live": "b" }));
    let notes = |turn: usize| -> Vec<Json> {
        page["turns"][turn]["items"].as_array().expect("items").iter().filter(|item| item["type"] == "statusNote").cloned().collect()
    };
    assert_eq!(notes(0), vec![json!({ "type": "statusNote", "id": "card-r1", "kind": "card", "text": "Not answered" })]);
    // the note follows the turn's own items, in the order the records came
    let kinds: Vec<&str> =
        page["turns"][0]["items"].as_array().expect("items").iter().map(|item| item["type"].as_str().expect("a type")).collect();
    assert_eq!(kinds, vec!["userMessage", "agentMessage", "statusNote"]);
    assert_eq!(notes(1), vec![json!({ "type": "statusNote", "id": "card-r2", "kind": "card", "text": "Allowed on Pocket iPhone" })]);
}
