//! The core routes for Claude Code's translation, for electron/harness/items/claudeTranslator.cjs. An event's are called with
//! `dispatchSync`: a window's items go out before what the event goes on to do. A message comes as a line of its own after the
//! event's, read apart from it, so that no envelope takes from the nesting a message may have; a transcript's lines the same.
//! A handle's value drops on the pool (`Handles::big`): a long chat's history takes tens of milliseconds to drop.
//!
//! - `translate.claudeOpen` (payload: JSON `{ threadId, cwd, auto, children }`; reply: its id).
//! - `translate.claudeEvent` (payload: JSON `{ id, now, op, ... }`, then for `message` a line of the message; `op` being `message`,
//!   `begin` with `turnId` and `user`, `end` with `status` and `error`, `steer`, `dropSteer`, `interrupt` or `cwd` with `cwd`;
//!   reply: a line of JSON `{ turnId, interrupted, emits, thrown }`, then the sub-agent transcripts its `itemsAt` place).
//! - `translate.claudeClose` (payload: the id; reply: `true` or `false`).
//! - `translate.claudeRead` (payload: JSON `{ threadId, cwd, auto, now }`, then each transcript message, each a line of JSON;
//!   reply: JSON `{ id, unread }`, `unread` how many lines couldn't be read or replayed, each left out).
//! - `translate.claudeSettle` (payload: JSON `{ id, liveTail, closedTail, open, limit, before, now, live }`; reply: a page, as
//!   `Held::page` has it).
//! - `translate.claudeWalk` (payload: JSON `{ id, open, turn, item, bytes }`; reply: JSON, as `Held::walk` has it).
//! - `translate.claudeRelease` (payload: the id; reply: `true` or `false`).
//! - `translate.claudeAgentItems` (payload: JSON `{ threadId, cwd, settled, now }`, then each message of a sub-agent's stored
//!   transcript, each a line of JSON; reply: JSON `{ items, model, unread }`).

use crate::claude::agent_transcript::AgentTranscript;
use crate::claude::history::{read as read_lines, Asked, Held};
use crate::claude::translator::Translator;
use crate::claude::write_said;
use crate::reads::{at, is, string};
use crate::routes::object_of;
use crate::Thrown;
use dispatch::{Call, CallRoute, Handles, Reply, Route};
use jsvalue::json::{parse, write, Numbers};
use jsvalue::value::{Object, Value};

/// One a native session and a few a remote client's: this bounds what a leak can hold.
static TRANSLATORS: Handles<Translator> = Handles::big("Claude translator", 4096);
/// Read chats, kept by the reader that made each while its file stands as it was.
static HISTORIES: Handles<Held> = Handles::big("Claude history", 64);

fn number(input: &Object, key: &str) -> f64 {
    match input.get(key) {
        Some(Value::Number(number)) => *number,
        _ => 0.0,
    }
}

fn open(payload: &[u8], call: &Call) -> Reply {
    Ok(TRANSLATORS.open(call, Translator::new(&object_of(payload, "claudeOpen")?))?.to_string().into_bytes())
}

/// The reply to one event: the translator's state and what it said, then why it stopped short, as a line of JSON small enough to
/// parse at once; after it, the sub-agent transcripts it places.
pub fn reply(translator: &mut Translator, thrown: Option<&Thrown>) -> Vec<u8> {
    let mut out = vec![b'{'];
    let mut tail = Vec::new();
    if let Some(turn) = &translator.turn_id {
        out.extend_from_slice(br#""turnId":"#);
        write(&mut out, turn, Numbers::Stringified);
        out.push(b',');
    }
    out.extend_from_slice(format!(r#""interrupted":{},"emits":["#, translator.interrupted).as_bytes());
    for (at, said) in std::mem::take(&mut translator.out).iter().enumerate() {
        if at > 0 {
            out.push(b',');
        }
        write_said(&mut out, &mut tail, &translator.thread, said);
    }
    out.push(b']');
    if let Some(thrown) = thrown {
        out.extend_from_slice(br#","thrown":"#);
        write(&mut out, &Value::text(thrown), Numbers::Stringified);
    }
    out.push(b'}');
    out.push(b'\n');
    out.append(&mut tail);
    out
}

/// The status `endTurn` was told.
fn status_of(input: &Object) -> &'static str {
    match input.get("status") {
        status if is(status, "failed") => "failed",
        status if is(status, "interrupted") => "interrupted",
        _ => "completed",
    }
}

/// The step `input` asks of a translator; `message` is the line after it.
pub fn step(translator: &mut Translator, input: &Object, message: Option<&[u8]>) -> Result<(), Thrown> {
    match string(input.get("op")).map(|op| op.as_bytes()) {
        Some(b"message") => {
            let Some(line) = message else { return translator.on_message(None) };
            let read = std::str::from_utf8(line).ok().and_then(parse).ok_or("a message can't be read")?;
            translator.on_message(Some(&read))
        }
        Some(b"begin") => {
            translator.begin_turn(input.get("turnId").cloned(), input.get("user").and_then(Value::as_object));
            Ok(())
        }
        Some(b"end") => {
            translator.end_turn(status_of(input), input.get("error").cloned().unwrap_or(Value::Null));
            Ok(())
        }
        Some(b"steer") => {
            translator.add_steer();
            Ok(())
        }
        Some(b"dropSteer") => {
            translator.drop_steer();
            Ok(())
        }
        Some(b"interrupt") => {
            translator.mark_interrupted();
            Ok(())
        }
        Some(b"cwd") => {
            translator.cwd = input.get("cwd").cloned().unwrap_or(Value::Null);
            Ok(())
        }
        _ => Err("translate.claudeEvent takes an op".into()),
    }
}

fn event(payload: &[u8]) -> Reply {
    let (head, message) = match memchr::memchr(b'\n', payload) {
        Some(end) => (&payload[..end], Some(&payload[end + 1..])),
        None => (payload, None),
    };
    let input = object_of(head, "claudeEvent")?;
    TRANSLATORS.with(number(&input, "id") as u64, |translator| {
        let now = number(&input, "now");
        let thrown = translator.run(now, |translator| step(translator, &input, message));
        reply(translator, thrown.as_ref())
    })
}

fn id_of(payload: &[u8], route: &str) -> Result<u64, String> {
    std::str::from_utf8(payload).ok().and_then(|id| id.parse().ok()).ok_or_else(|| format!("translate.{route} takes an id"))
}

fn close(payload: &[u8]) -> Reply {
    Ok(TRANSLATORS.close(id_of(payload, "claudeClose")?).to_string().into_bytes())
}

fn read(payload: &[u8], call: &Call) -> Reply {
    let mut lines = payload.split(|byte| *byte == b'\n');
    let header = object_of(lines.next().unwrap_or_default(), "claudeRead")?;
    let (held, unread) = read_lines(&header, lines.filter(|line| !line.is_empty()), &call.cancel)?;
    Ok(format!(r#"{{"id":{},"unread":{unread}}}"#, HISTORIES.open(call, held)?).into_bytes())
}

fn settle(payload: &[u8]) -> Reply {
    let input = object_of(payload, "claudeSettle")?;
    let flag = |key| input.get(key) == Some(&Value::Bool(true));
    let asked = Asked {
        live_tail: flag("liveTail"),
        closed_tail: flag("closedTail"),
        open: flag("open"),
        limit: number(&input, "limit") as usize,
        before: string(input.get("before")).filter(|before| !before.is_empty()).cloned(),
        now: number(&input, "now"),
        live: input.get("live").filter(|live| **live != Value::Null).cloned(),
    };
    HISTORIES.with(number(&input, "id") as u64, |held| held.page(&asked))
}

fn walk(payload: &[u8]) -> Reply {
    let input = object_of(payload, "claudeWalk")?;
    let closed = input.get("open") != Some(&Value::Bool(true));
    let (turn, item, bytes) = (number(&input, "turn") as usize, number(&input, "item") as usize, number(&input, "bytes") as usize);
    HISTORIES.with(number(&input, "id") as u64, |held| held.walk(closed, turn, item, bytes))
}

fn release(payload: &[u8]) -> Reply {
    Ok(HISTORIES.close(id_of(payload, "claudeRelease")?).to_string().into_bytes())
}

/// A stored sub-agent transcript as agent page items, and its model: a replayed run has no heartbeat to name it. A settled
/// run's open tools were cut off.
fn agent_items(payload: &[u8]) -> Reply {
    let mut lines = payload.split(|byte| *byte == b'\n');
    let header = object_of(lines.next().unwrap_or_default(), "claudeAgentItems")?;
    let mut child = AgentTranscript::new(
        None,
        header.get("threadId").cloned().unwrap_or(Value::Null),
        header.get("cwd").cloned().unwrap_or(Value::Null),
    );
    let now = number(&header, "now");
    let (mut unread, mut model) = (0, None);
    for line in lines.filter(|line| !line.is_empty()) {
        let record = std::str::from_utf8(line).ok().and_then(parse);
        let Some(record) = record.filter(|record| matches!(record, Value::Object(_))) else {
            unread += 1;
            continue;
        };
        if model.is_none() {
            model = string(at(record.field("message"), "model")).cloned();
        }
        unread += usize::from(child.add(&record, now).is_err());
    }
    if header.get("settled") == Some(&Value::Bool(true)) {
        child.cut_off();
    }
    let mut out = br#"{"items":["#.to_vec();
    for (at, item) in child.items.iter().enumerate() {
        if at > 0 {
            out.push(b',');
        }
        out.extend_from_slice(&item.json);
    }
    out.extend_from_slice(br#"],"model":"#);
    write(&mut out, &model.map_or(Value::Null, Value::String), Numbers::Stringified);
    out.extend_from_slice(format!(r#","unread":{unread}}}"#).as_bytes());
    Ok(out)
}

inventory::submit! { CallRoute { name: "translate.claudeOpen", handler: open } }
inventory::submit! { Route { name: "translate.claudeEvent", handler: event } }
inventory::submit! { Route { name: "translate.claudeClose", handler: close } }
inventory::submit! { CallRoute { name: "translate.claudeRead", handler: read } }
inventory::submit! { Route { name: "translate.claudeSettle", handler: settle } }
inventory::submit! { Route { name: "translate.claudeWalk", handler: walk } }
inventory::submit! { Route { name: "translate.claudeRelease", handler: release } }
inventory::submit! { Route { name: "translate.claudeAgentItems", handler: agent_items } }
