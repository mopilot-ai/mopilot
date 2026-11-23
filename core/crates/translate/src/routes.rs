//! The translate crate's core routes, for electron/harness/items/acpTranslator.cjs. An event's are called with `dispatchSync`:
//! a window's items go out before what the event goes on to do. Nothing here touches a disk or waits on JS, and a translator's
//! lock is only ever held by those calls, on the JS thread that makes them; a replay on a core thread (`dispatch`, for a read
//! that may take long) has its own translator and takes no lock of one.
//!
//! - `translate.open` (payload: JSON `{ threadId, cwd, auto }`; reply: its id).
//! - `translate.event` (payload: JSON `{ id, now, op, ... }`, `op` being `begin` with `turnId` and `user`, `update` with
//!   `update`, `turnId` and `replaces`, or `end` with `stopReason`, `error` and `providerError`; reply: JSON
//!   `{ turnId, emits, thrown }`, `emits` a list of `[method, params]`, every one of them to go out, `turnId` absent when it
//!   is undefined and `thrown` absent unless the event stopped short).
//! - `translate.close` (payload: the id; reply: `true` or `false`).
//! - `translate.replay` (payload: `{ threadId, cwd, auto, live, keep }`, then each transcript record, each a line of JSON;
//!   reply: JSON `{ turns, id, turnId }`, the last two only when `keep` asked for a turn still running).

use crate::emit::{write_emit, Emit};
use crate::replay::replay as replayed;
use crate::translator::Translator;
use crate::{Thrown, TRANSLATORS};
use dispatch::{Call, CallRoute, Reply, Route};
use jsvalue::json::{parse, write, Numbers};
use jsvalue::value::{Object, Value};

pub(crate) fn object_of(payload: &[u8], route: &str) -> Result<Object, String> {
    match std::str::from_utf8(payload).ok().and_then(parse) {
        Some(Value::Object(object)) => Ok(object),
        _ => Err(format!("translate.{route} takes a JSON object")),
    }
}

fn open(payload: &[u8], call: &Call) -> Reply {
    Ok(crate::open(call, &object_of(payload, "open")?)?.to_string().into_bytes())
}

/// The field of `input` that says when it happened, or which translator it is for.
fn number(input: &Object, key: &str) -> f64 {
    match input.get(key) {
        Some(Value::Number(number)) => *number,
        _ => 0.0,
    }
}

/// The reply to one event: the translator's turn and what it said, then why it stopped short.
pub fn reply(translator: &Translator, emits: &[Emit], thrown: Option<&Thrown>) -> Vec<u8> {
    let mut out = vec![b'{'];
    if let Some(turn) = &translator.turn_id {
        out.extend_from_slice(br#""turnId":"#);
        write(&mut out, turn, Numbers::Stringified);
        out.push(b',');
    }
    out.extend_from_slice(br#""emits":["#);
    for (at, emit) in emits.iter().enumerate() {
        if at > 0 {
            out.push(b',');
        }
        write_emit(&mut out, &translator.thread, emit);
    }
    out.push(b']');
    if let Some(thrown) = thrown {
        out.extend_from_slice(br#","thrown":"#);
        write(&mut out, &Value::text(thrown), Numbers::Stringified);
    }
    out.push(b'}');
    out
}

/// The step `input` asks of a translator.
pub fn step(translator: &mut Translator, mut input: Object) -> Result<(), Thrown> {
    match input.get("op") {
        Some(Value::String(op)) if op.is("begin") => translator.begin_turn(input.get("turnId").cloned(), input.get("user")),
        Some(Value::String(op)) if op.is("update") => {
            let update = input.remove("update");
            translator.on_update(update, input.get("turnId").cloned(), input.get("replaces"))
        }
        Some(Value::String(op)) if op.is("end") => {
            translator.end_turn(input.get("stopReason"), input.get("error"), input.get("providerError"))
        }
        _ => Err("translate.event takes an op".into()),
    }
}

fn event(payload: &[u8]) -> Reply {
    let input = object_of(payload, "event")?;
    let (id, now) = (number(&input, "id") as u64, number(&input, "now"));
    TRANSLATORS.with(id, |translator| {
        let thrown = translator.run(now, |translator| step(translator, input));
        let emits = std::mem::take(&mut translator.out);
        reply(translator, &emits, thrown.as_ref())
    })
}

fn close(payload: &[u8]) -> Reply {
    let id = std::str::from_utf8(payload).ok().and_then(|id| id.parse().ok()).ok_or_else(|| "translate.close takes an id".to_string())?;
    Ok(crate::close(id).to_string().into_bytes())
}

fn replay(payload: &[u8], call: &Call) -> Reply {
    let mut lines = payload.split(|byte| *byte == b'\n');
    let header = object_of(lines.next().unwrap_or_default(), "replay")?;
    let done = replayed(&header, lines, &call.cancel)?;
    let mut out = br#"{"turns":"#.to_vec();
    out.extend_from_slice(&done.turns);
    if let Some(translator) = done.kept {
        let turn = translator.turn_id.clone().unwrap_or(Value::Null);
        out.extend_from_slice(format!(r#","id":{},"turnId":"#, TRANSLATORS.open(call, translator)?).as_bytes());
        write(&mut out, &turn, Numbers::Stringified);
    }
    out.push(b'}');
    Ok(out)
}

inventory::submit! { CallRoute { name: "translate.open", handler: open } }
inventory::submit! { Route { name: "translate.event", handler: event } }
inventory::submit! { Route { name: "translate.close", handler: close } }
inventory::submit! { CallRoute { name: "translate.replay", handler: replay } }
