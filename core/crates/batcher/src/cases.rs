//! The batcher's tests: each family's contract, the queues and lanes, the ticks' decisions and the routes' layout.

use crate::contracts::{at, field_mut, passes, string, text_mut, Family, Is, Kind, Test};
use crate::{Batcher, Group, Out, Pushed, Said};
use dispatch::dispatch;
use jsvalue::json::{parse, write, Numbers};
use jsvalue::value::{Text, Value};

fn value(text: &str) -> Value {
    parse(text).expect("JSON")
}

fn kind(family: Family, text: &str) -> Kind {
    family.classify(&value(text))
}

/// A delta's key; none for an event that is no delta.
fn keyed(family: Family, text: &str) -> Vec<u8> {
    match kind(family, text) {
        Kind::Delta { key, .. } => key,
        _ => Vec::new(),
    }
}

fn codex(params: &str) -> String {
    format!(r#"{{"kind":"notification","method":"item/agentMessage/delta","params":{params}}}"#)
}

fn codex_method(method: &str, params: &str) -> String {
    format!(r#"{{"kind":"notification","method":"{method}","params":{params}}}"#)
}

fn claude(extra: &str, delta: &str) -> String {
    format!(
        r#"{{"kind":"message","key":"s"{extra},"msg":{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{delta}}}}}}}"#
    )
}

fn acp(extra: &str, update: &str) -> String {
    format!(r#"{{"kind":"update","key":"s","turnId":"t"{extra},"update":{{"sessionUpdate":"agent_message_chunk"{update}}}}}"#)
}

const TEXT: &str = r#","content":{"type":"text","text":"x"}"#;

#[test]
fn families_are_named_and_found_by_name() {
    for family in Family::ALL {
        assert_eq!(Family::of(family.name().as_bytes()), Some(family));
    }
    assert_eq!(Family::of(b"other"), None);
    assert!(keyed(Family::Codex, r#"{"kind":"turnStarted"}"#).is_empty(), "no delta, no key");
    assert!(Family::Acp.wait_gate().is_some());
    assert!(Family::Codex.wait_gate().is_none());
}

#[test]
fn a_gate_reads_strings_and_records_as_js_reads_fields() {
    let gate = [Test { path: &["a", "b"], is: Is::OneOf(&["x", "y"]) }, Test { path: &["c"], is: Is::Record }];
    assert!(passes(&gate, &value(r#"{"a":{"b":"y"},"c":{}}"#)));
    for odd in [r#"{"a":{"b":"z"},"c":{}}"#, r#"{"a":{"b":1},"c":{}}"#, r#"{"a":"b","c":{}}"#, r#"{"a":{"b":"x"},"c":[]}"#] {
        assert!(!passes(&gate, &value(odd)), "{odd}");
    }
    assert_eq!(at(&value(r#"{"a":[1]}"#), &["a", "0"]), None, "an array has no field");
    assert_eq!(string(Some(&Value::Null)), None);
}

#[test]
fn codex_deltas_are_keyed_by_thread_turn_item_method_and_part() {
    let base = keyed(Family::Codex, &codex(r#"{"threadId":"c","turnId":"t","itemId":"m","delta":"x"}"#));
    // a numeric id is its spelling, as String() makes it; the index defaults to 0, as either index of 0 is
    let same = [
        codex(r#"{"threadId":"c","turnId":"t","itemId":"m","delta":"y","contentIndex":0}"#),
        codex(r#"{"threadId":"c","turnId":"t","itemId":"m","delta":"y","summaryIndex":null,"contentIndex":0}"#),
        codex(r#"{"threadId":"c","turnId":"t","itemId":"m","delta":"y","summaryIndex":"0"}"#),
    ];
    for text in same {
        assert_eq!(keyed(Family::Codex, &text), base, "{text}");
    }
    let numeric = keyed(Family::Codex, &codex(r#"{"threadId":"c","turnId":"t","itemId":7,"delta":"x"}"#));
    assert_eq!(numeric, keyed(Family::Codex, &codex(r#"{"threadId":"c","turnId":"t","itemId":"7","delta":"x"}"#)));
    assert_ne!(numeric, base);
    let summary = |index: &str| {
        codex_method("item/reasoning/summaryTextDelta", &format!(r#"{{"threadId":"c","turnId":"t","itemId":"r","delta":"x"{index}}}"#))
    };
    let raw = |index: &str| {
        codex_method("item/reasoning/textDelta", &format!(r#"{{"threadId":"c","turnId":"t","itemId":"r","delta":"x"{index}}}"#))
    };
    assert_ne!(keyed(Family::Codex, &summary(r#","summaryIndex":0"#)), keyed(Family::Codex, &summary(r#","summaryIndex":1"#)));
    assert_eq!(keyed(Family::Codex, &raw("")), keyed(Family::Codex, &raw(r#","contentIndex":0"#)));
    // what isInvalidStreamNotification refuses, and parts that are no string or number, go out alone
    for alone in [
        codex(r#"{"threadId":"c","turnId":"t","itemId":"m","delta":42}"#),
        codex(r#"{"threadId":"c","turnId":"t","itemId":{"id":7},"delta":"x"}"#),
        codex(r#""params""#),
        summary(""),
        summary(r#","summaryIndex":-1"#),
        summary(r#","summaryIndex":4096"#),
        summary(r#","summaryIndex":1.5"#),
        raw(r#","contentIndex":"0""#),
        codex_method("item/fileChange/patchUpdated", r#"{"threadId":"c","turnId":"t","itemId":"m","delta":"x"}"#),
        r#"{"kind":"turnStarted","chatId":"c"}"#.to_string(),
    ] {
        assert_eq!(kind(Family::Codex, &alone), Kind::Alone, "{alone}");
    }
}

#[test]
fn claude_deltas_are_keyed_by_session_block_type_account_and_login() {
    let text = keyed(Family::Claude, &claude("", r#"{"type":"text_delta","text":"x"}"#));
    let thinking = keyed(Family::Claude, &claude("", r#"{"type":"thinking_delta","thinking":"x"}"#));
    assert_ne!(text, thinking);
    let other = keyed(Family::Claude, &claude(r#","account":"a""#, r#"{"type":"text_delta","text":"x"}"#));
    assert_ne!(other, text);
    // `?? ''`: null is no account, and false is "false"
    assert_eq!(keyed(Family::Claude, &claude(r#","account":null"#, r#"{"type":"text_delta","text":"x"}"#)), text);
    assert_ne!(keyed(Family::Claude, &claude(r#","login":false"#, r#"{"type":"text_delta","text":"x"}"#)), text);
    let sub = r#"{"kind":"message","key":"s","msg":{"type":"stream_event","parent_tool_use_id":"tool","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}}}"#;
    let unowned = sub.replace(r#""tool""#, "0");
    assert_eq!(kind(Family::Claude, sub), Kind::Alone, "a sub-agent's delta");
    assert!(matches!(kind(Family::Claude, &unowned), Kind::Delta { .. }), "a falsy parent is none");
    for alone in [
        claude("", r#"{"type":"text_delta","text":42}"#),
        claude("", r#"{"type":"input_json_delta","partial_json":"{"}"#),
        claude("", r#"{"text":"x"}"#),
        claude("", r#""x""#),
        claude("", r#"{"type":"text_delta","text":"x"}"#).replace(r#""index":0"#, r#""index":1.5"#),
        claude("", r#"{"type":"text_delta","text":"x"}"#).replace(r#""index":0"#, r#""index":1e999"#),
        claude("", r#"{"type":"text_delta","text":"x"}"#).replace(r#""key":"s""#, r#""key":{}"#),
        r#"{"kind":"message","key":"s","msg":{"type":"stream_event","event":{"type":"content_block_start","index":0}}}"#.into(),
        r#"{"kind":"permission","key":"s"}"#.into(),
    ] {
        assert_eq!(kind(Family::Claude, &alone), Kind::Alone, "{alone}");
    }
    assert_eq!(kind(Family::Claude, &claude("", r#"{"type":"thinking_delta","thinking":7}"#)), Kind::Alone);
    // String() of an object with its own toString throws in JS, so its key could not be read
    for odd in [r#","account":{"toString":1}"#, r#","login":{"toString":1}"#] {
        assert_eq!(kind(Family::Claude, &claude(odd, r#"{"type":"text_delta","text":"x"}"#)), Kind::Malformed, "{odd}");
    }
}

#[test]
fn acp_chunks_are_keyed_by_session_turn_kind_parent_and_call_and_other_updates_wait() {
    let base = keyed(Family::Acp, &acp("", TEXT));
    assert_eq!(keyed(Family::Acp, &acp(r#","turnId":null"#, TEXT)), keyed(Family::Acp, &acp(r#","turnId":"""#, TEXT)));
    let parented = |meta: &str| keyed(Family::Acp, &acp("", &format!(r#"{TEXT},"_meta":{meta}"#)));
    let agent = parented(r#"{"claudeCode":{"parentToolUseId":"agent-1"}}"#);
    assert_ne!(agent, base);
    assert_eq!(parented(r#"{"parentToolCallId":"agent-1"}"#), agent);
    assert_eq!(parented(r#"{"parentToolUseId":"agent-1"}"#), agent);
    assert_eq!(parented(r#"{"parentToolUseId":""}"#), base);
    // a parent that is the update's own call is none
    let own = keyed(Family::Acp, &acp("", &format!(r#"{TEXT},"toolCallId":"agent-1","_meta":{{"parentToolCallId":"agent-1"}}"#)));
    assert_eq!(own, keyed(Family::Acp, &acp("", &format!(r#"{TEXT},"toolCallId":"agent-1""#))));
    assert_ne!(own, base);
    for waits in [
        acp(r#","replaces":"y""#, TEXT),
        acp(r#","replaces":null"#, TEXT),
        acp("", r#","content":{"type":"image","data":""}"#),
        acp("", r#","content":{"type":"text","text":7}"#),
        acp("", r#","content":[]"#),
        acp(r#","turnId":{"odd":true}"#, TEXT),
        r#"{"kind":"update","key":"s","update":{"sessionUpdate":"tool_call","toolCallId":"x"}}"#.into(),
    ] {
        assert_eq!(kind(Family::Acp, &waits), Kind::Waits, "{waits}");
    }
    for alone in [r#"{"kind":"update","key":"s","update":null}"#, r#"{"kind":"turnEnd","key":"s"}"#] {
        assert_eq!(kind(Family::Acp, alone), Kind::Alone, "{alone}");
    }
    let throws = acp("", &format!(r#"{TEXT},"toolCallId":{{"toString":1}},"_meta":{{"parentToolCallId":"p"}}"#));
    assert_eq!(kind(Family::Acp, &throws), Kind::Malformed);
}

#[test]
fn feed_deltas_are_keyed_by_their_stringified_place() {
    let delta = |extra: &str| format!(r#"{{"ev":"items.delta","chatId":"c","turnId":null,"itemId":"i","field":"text"{extra},"text":"x"}}"#);
    let base = keyed(Family::Feed, &delta(""));
    assert_eq!(keyed(Family::Feed, &delta(r#","index":null"#)), base, "undefined is null in a list");
    assert_ne!(keyed(Family::Feed, &delta(r#","index":1"#)), base);
    assert_eq!(kind(Family::Feed, r#"{"ev":"items.delta","chatId":"c"}"#), Kind::Alone);
    assert_eq!(kind(Family::Feed, r#"{"ev":"items.append","chatId":"c"}"#), Kind::Alone);
}

#[test]
fn a_delta_text_is_found_to_join_onto() {
    let mut event = value(r#"{"a":{"b":"x","n":1},"s":"t"}"#);
    text_mut(&mut event, &["a", "b"]).expect("text").push_str("y");
    assert_eq!(at(&event, &["a", "b"]), Some(&Value::text("xy")));
    assert!(text_mut(&mut event, &["a", "n"]).is_none());
    assert!(text_mut(&mut event, &["s", "x"]).is_none());
    assert!(text_mut(&mut event, &["missing"]).is_none());
    assert!(field_mut(&mut Value::Null, "a").is_none());
}

/// A batcher's push of `text` as event `seq` of `family`, into `chat`.
fn push(b: &mut Batcher, seq: u64, family: Family, chat: &str, background: bool, text: &str) -> (Pushed, Said) {
    let event = value(text);
    let kind = family.classify(&event);
    b.push(seq, family, Text::from(chat), background, kind, event)
}

fn feed(chat: &str, item: &str, text: &str) -> String {
    format!(r#"{{"ev":"items.delta","chatId":"{chat}","itemId":"{item}","text":"{text}"}}"#)
}

/// What a group says, as `seq:lane` or `seq:lane:text` for a joined delta.
fn shape(groups: &[Group]) -> Vec<String> {
    let one = |out: &Out| {
        let lane = if out.background { "bg" } else { "fg" };
        match &out.joined {
            Some(event) => format!("{}:{lane}:{}", out.seq, string(event.field("text")).expect("text").lossy()),
            None => format!("{}:{lane}", out.seq),
        }
    };
    groups.iter().flat_map(|g| g.out.iter().map(one).map(|s| format!("{}={s}", g.chat.lossy())).collect::<Vec<_>>()).collect()
}

#[test]
fn the_first_delta_leads_out_and_starts_the_tick_and_the_rest_join_until_it_ends() {
    let mut b = Batcher::new(crate::MAX_PENDING);
    let (pushed, said) = push(&mut b, 1, Family::Feed, "c", false, &feed("c", "i", "a"));
    assert_eq!(pushed, Pushed::Queued { refs: 1 });
    assert!(said.schedule);
    assert!(!said.schedule_background);
    assert_eq!(shape(&said.groups), ["c=1:fg"]);
    assert_eq!(b.pending(), 0);
    assert_eq!(push(&mut b, 2, Family::Feed, "c", false, &feed("c", "i", "b")).0, Pushed::Queued { refs: 1 });
    assert_eq!(push(&mut b, 3, Family::Feed, "c", false, &feed("c", "i", "c")).0, Pushed::Queued { refs: 0 }, "joined");
    assert_eq!(push(&mut b, 4, Family::Feed, "c", false, &feed("c", "j", "d")).0, Pushed::Queued { refs: 1 }, "another key");
    assert_eq!(push(&mut b, 5, Family::Feed, "d", false, &feed("d", "i", "e")).1, Said::default(), "a tick runs");
    assert_eq!(b.pending(), 2);
    let said = b.tick();
    assert!(said.schedule, "a tick that sent starts the next");
    assert_eq!(shape(&said.groups), ["c=2:fg:bc", "c=4:fg", "d=5:fg"]);
    assert_eq!(b.pending(), 0);
    let quiet = b.tick();
    assert_eq!(quiet, Said::default(), "a quiet tick ends the cooldown");
    assert!(push(&mut b, 6, Family::Feed, "c", false, &feed("c", "i", "f")).1.schedule, "so the next delta leads again");
}

#[test]
fn a_delta_of_another_family_or_behind_a_wait_never_joins() {
    let mut b = Batcher::new(crate::MAX_PENDING);
    push(&mut b, 1, Family::Feed, "lead", false, &feed("lead", "i", "a"));
    push(&mut b, 2, Family::Acp, "c", false, &acp("", TEXT));
    push(&mut b, 3, Family::Feed, "c", false, &feed("c", "i", "b"));
    let tool = r#"{"kind":"update","key":"s","update":{"sessionUpdate":"tool_call"}}"#;
    assert_eq!(push(&mut b, 4, Family::Acp, "c", false, tool).0, Pushed::Queued { refs: 1 });
    push(&mut b, 5, Family::Acp, "c", false, &acp("", TEXT));
    push(&mut b, 6, Family::Acp, "c", false, &acp("", TEXT));
    let group = b.flush_chat(&Text::from("c")).expect("pending");
    assert_eq!(group.out.iter().map(|o| (o.seq, o.joined.is_some())).collect::<Vec<_>>(), [(2, false), (3, false), (4, false), (5, true)]);
    let joined = group.out[3].joined.as_ref().expect("joined");
    assert_eq!(at(joined, &["update", "content", "text"]), Some(&Value::text("xx")));
    assert!(b.flush_chat(&Text::from("c")).is_none());
}

#[test]
fn a_chat_shown_nowhere_gets_a_second_lane_on_the_background_tick() {
    let mut b = Batcher::new(crate::MAX_PENDING);
    let (pushed, said) = push(&mut b, 1, Family::Feed, "c", true, &feed("c", "i", "a"));
    assert_eq!(pushed, Pushed::Queued { refs: 2 });
    assert!(said.schedule);
    assert!(said.schedule_background);
    assert_eq!(shape(&said.groups), ["c=1:fg", "c=1:bg"]);
    assert_eq!(push(&mut b, 2, Family::Feed, "c", true, &feed("c", "i", "b")).1, Said::default(), "both ticks run");
    push(&mut b, 3, Family::Feed, "c", true, &feed("c", "i", "c"));
    let tool = r#"{"kind":"update","key":"s","update":{"sessionUpdate":"tool_call"}}"#;
    assert_eq!(push(&mut b, 4, Family::Acp, "c", true, tool).0, Pushed::Queued { refs: 2 });
    push(&mut b, 5, Family::Feed, "plain", false, &feed("plain", "i", "x"));
    assert_eq!(shape(&b.tick().groups), ["c=2:fg:bc", "c=4:fg", "plain=5:fg"]);
    assert_eq!(b.pending(), 1, "the slow share waits");
    assert_eq!(shape(&b.tick().groups), Vec::<String>::new());
    assert_eq!(shape(&b.background_tick().groups), ["c=2:bg:bc", "c=4:bg"]);
    assert_eq!(b.pending(), 0);
    // a quiet tick ended the cooldown; then a background tick keeps a chat's foreground entries for the frame tick
    assert_eq!(shape(&push(&mut b, 6, Family::Feed, "c", true, &feed("c", "i", "d")).1.groups), ["c=6:fg", "c=6:bg"]);
    push(&mut b, 7, Family::Feed, "c", true, &feed("c", "i", "e"));
    assert_eq!(shape(&b.background_tick().groups), ["c=7:bg"]);
    assert_eq!(b.pending(), 1);
    push(&mut b, 8, Family::Feed, "fg", false, &feed("fg", "i", "f"));
    assert_eq!(shape(&b.background_tick().groups), Vec::<String>::new(), "a chat with nothing for the slow lane is passed over");
    assert_eq!(shape(&b.flush_all()), ["c=7:fg", "fg=8:fg"]);
}

#[test]
fn past_the_bound_a_chat_goes_out_at_once_and_flushes_keep_the_tick() {
    let mut b = Batcher::new(4);
    push(&mut b, 1, Family::Feed, "lead", false, &feed("lead", "i", "x"));
    assert!(push(&mut b, 2, Family::Feed, "c", false, &feed("c", "i", "12")).1.groups.is_empty());
    // units, not bytes: an astral character is two
    let (_, said) = push(&mut b, 3, Family::Feed, "c", false, &feed("c", "i", "\u{1f600}"));
    assert_eq!(shape(&said.groups), ["c=2:fg:12\u{1f600}"]);
    assert!(!said.schedule, "the tick still runs");
    push(&mut b, 4, Family::Feed, "c", false, &feed("c", "i", "z"));
    b.cancel();
    let (_, said) = push(&mut b, 5, Family::Feed, "c", false, &feed("c", "i", "w"));
    assert!(said.schedule, "a cancelled tick runs no more");
    assert_eq!(shape(&said.groups), ["c=4:fg:zw"]);
}

#[test]
fn an_event_alone_flushes_its_chat_and_one_malformed_every_chat() {
    let mut b = Batcher::new(crate::MAX_PENDING);
    push(&mut b, 1, Family::Feed, "lead", false, &feed("lead", "i", "x"));
    push(&mut b, 2, Family::Feed, "a", false, &feed("a", "i", "x"));
    push(&mut b, 3, Family::Feed, "b", false, &feed("b", "i", "y"));
    let (pushed, said) = push(&mut b, 4, Family::Feed, "a", false, r#"{"ev":"turn.state"}"#);
    assert_eq!((pushed, shape(&said.groups)), (Pushed::Alone, vec!["a=2:fg".to_string()]));
    push(&mut b, 5, Family::Feed, "a", false, &feed("a", "i", "z"));
    let (pushed, said) = b.push(6, Family::Claude, Text::from("x"), false, Kind::Malformed, Value::Null);
    assert_eq!((pushed, shape(&said.groups)), (Pushed::Malformed, vec!["b=3:fg".to_string(), "a=5:fg".to_string()]));
    assert_eq!(b.pending(), 0);
}

/// A route's reply, as text.
fn call(route: &str, payload: &[u8]) -> String {
    String::from_utf8(dispatch(route, payload).expect(route)).expect("UTF-8")
}

/// A reply that joined nothing: its list, and the end of its line.
fn json(line: &str) -> String {
    format!("{line}\n")
}

#[test]
fn a_batcher_opens_queues_ticks_and_closes_through_the_routes() {
    let id = String::from_utf8(dispatch("batcher.open", b"").expect("an id")).expect("UTF-8");
    let with = |rest: &str| format!("{id}\n{rest}").into_bytes();
    let push =
        |seq: u64, family: &str, chat: &str, event: &str| call("batcher.push", &with(&format!("{seq}\n{family}\n0\n{chat}\n{event}")));
    let lead = push(1, "feed", r#""c\"1""#, &feed("c", "i", "a"));
    assert_eq!(lead, json(r#"[5,1,0,"c\"1",[1,0,0]]"#), "queued, the tick to start, and the leading edge's flush");
    assert_eq!(push(2, "feed", r#""c\"1""#, &feed("c", "i", "b")), json("[1,1,1]"));
    assert_eq!(push(3, "feed", r#""c\"1""#, &feed("c", "i", "c")), json("[1,0,1]"));
    let joined = r#"[4,0,0,"c\"1",[2,0,58]]
{"ev":"items.delta","chatId":"c","itemId":"i","text":"bc"}"#;
    assert_eq!(call("batcher.tick", &with("")), joined, "the joined event's JSON after the line");
    assert_eq!(call("batcher.tick", &with("")), json("[0,0,0]"));
    // a tool update a wait gate admitted comes without its JSON
    let lead = push(4, "acp", r#""k""#, "");
    assert_eq!(lead, json(r#"[5,1,0,"k",[4,0,0]]"#));
    assert_eq!(push(5, "acp", r#""k""#, ""), json("[1,1,1]"));
    assert_eq!(push(6, "acp", r#""k""#, r#"{"kind":"turnEnd"}"#), json(r#"[0,0,0,"k",[5,0,0]]"#), "alone, after its chat");
    assert_eq!(push(7, "acp", r#""k""#, "not JSON"), json("[2,0,0]"), "malformed");
    let bg = call("batcher.push", &with(&format!("8\nfeed\n1\n\"b\"\n{}", feed("b", "i", "x"))));
    assert_eq!(bg, json("[9,2,1]"), "both lanes; the background tick to start");
    assert_eq!(call("batcher.flush", &with(r#"["nobody",7,"b"]"#)), json(r#"[0,0,0,"b",[8,0,0,8,1,0]]"#));
    push(9, "feed", r#""d""#, &feed("d", "i", "x"));
    push(10, "feed", r#""e""#, &feed("e", "i", "x"));
    assert_eq!(call("batcher.drop", &with(r#"["d"]"#)), json(r#"[0,0,1,"d",[9,0,0]]"#));
    assert_eq!(call("batcher.flushAll", &with("")), json(r#"[0,0,0,"e",[10,0,0]]"#));
    assert_eq!(call("batcher.backgroundTick", &with("")), json("[0,0,0]"));
    assert_eq!(call("batcher.cancel", &with("")), json("[0,0,0]"));
    assert_eq!(dispatch("batcher.close", id.as_bytes()), Ok(b"true".to_vec()));
    assert_eq!(dispatch("batcher.close", id.as_bytes()), Ok(b"false".to_vec()));
    assert_eq!(dispatch("batcher.tick", id.as_bytes()), Err(format!("no stream batcher {id}")));
    let bounded = String::from_utf8(dispatch("batcher.open", b" 2 ").expect("an id")).expect("UTF-8");
    let over = call("batcher.push", format!("{bounded}\n1\nfeed\n0\n\"c\"\n{}", feed("c", "i", "abc")).as_bytes());
    assert!(over.starts_with(r#"[5,1,0,"c",[1,0,0]]"#), "{over}");
    assert_eq!(dispatch("batcher.close", bounded.as_bytes()), Ok(b"true".to_vec()));
}

#[test]
fn the_families_route_gives_each_gate_as_js_reads_it() {
    let families = value(&call("batcher.families", b""));
    let mut out = Vec::new();
    write(&mut out, families.field("acp").expect("acp"), Numbers::Stringified);
    let acp = r#"{"delta":[[["kind"],["update"]],[["update","sessionUpdate"],["agent_message_chunk","agent_thought_chunk"]]],"waits":[[["kind"],["update"]],[["update"],null]]}"#;
    assert_eq!(String::from_utf8(out).expect("UTF-8"), acp);
    for family in Family::ALL {
        assert!(families.field(family.name()).is_some(), "{}", family.name());
    }
    assert_eq!(at(&families, &["codex", "waits"]), Some(&Value::Null));
}

#[test]
fn a_payload_that_names_nothing_is_refused() {
    for bad in [&b"x"[..], &[0xff][..]] {
        assert_eq!(dispatch("batcher.open", bad), Err("batcher.open takes a bound".into()));
    }
    let id = String::from_utf8(dispatch("batcher.open", b"").expect("an id")).expect("UTF-8");
    let push = |rest: &str| dispatch("batcher.push", format!("{id}\n{rest}").as_bytes());
    assert_eq!(dispatch("batcher.push", b"x\n1"), Err("batcher routes take a batcher id".into()));
    assert_eq!(dispatch("batcher.tick", &[0xff]), Err("batcher routes take a batcher id".into()));
    assert_eq!(push("1"), Err("batcher.push takes an event's lines".into()));
    assert_eq!(push("x\nfeed\n0\n\"c\"\n{}"), Err("batcher.push takes a number".into()));
    assert_eq!(push("1\nnope\n0\n\"c\"\n{}"), Err("batcher.push takes a family".into()));
    assert_eq!(push("1\nfeed\n0\n7\n{}"), Err("batcher.push takes a chat".into()));
    assert_eq!(push("1\nfeed\n0\n\"c\"\n"), Err("batcher.push takes a delta's JSON".into()));
    assert_eq!(dispatch("batcher.flush", format!("{id}\n{{}}").as_bytes()), Err("batcher routes take a list of chats".into()));
    assert_eq!(dispatch("batcher.flush", format!("{id}\n[1").as_bytes()), Err("batcher routes take a list of chats".into()));
    assert!(dispatch("batcher.flush", format!("{id}\n[\"\u{0}").as_bytes()).is_err());
    assert_eq!(dispatch("batcher.close", format!("{id}\n").as_bytes()), Ok(b"true".to_vec()));
}
