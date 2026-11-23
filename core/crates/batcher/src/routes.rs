//! The batcher's core routes, every one on the JS thread (`dispatchSync`) for electron/harness/coreBatcher.cjs; none
//! waits on JS, and each holds its batcher's lock only while it changes the queues. Every payload but `batcher.open`'s
//! and `batcher.families`' starts with the batcher's id and a newline:
//! - `batcher.open` (payload: the bound on a chat's pending text in UTF-16 units, or nothing for `MAX_PENDING`; reply: the id);
//! - `batcher.families` (reply: `{family: {"delta": gate, "waits": gate | null}}`, each gate a list of `[path, strings]`, or
//!   `[path, null]` for an object that is no array);
//! - `batcher.push` (then the event's number, its family, `1` when a window open does not show its chat, its chat as a
//!   JSON string, each on a line, and the event's JSON, or nothing for an event a wait gate admits);
//! - `batcher.flush` and `batcher.drop` (then a JSON list of chats), `batcher.flushAll`, `batcher.tick`,
//!   `batcher.backgroundTick` and `batcher.cancel` (nothing more);
//! - `batcher.close` (reply: `true` or `false`).
//!
//! Every reply but `open`'s, `families`' and `close`'s is a JSON list on one line: flags (`QUEUED`, `MALFORMED`,
//! `SCHEDULE`, `SCHEDULE_BACKGROUND`), how many entries the pushed event leads, how many chats have something pending, then
//! for each chat a flush sends its id and a flat list of (number, lane, the byte length of its joined event or 0). After the
//! line come the joined events' JSON, in that order, which JS keeps as text for the windows (electron/harness/eventJson.cjs).
//! `drop`'s lists what it dropped.

use crate::contracts::{Family, Is, Kind, Test};
use crate::{Batcher, Group, Pushed, Said, MAX_PENDING};
use dispatch::{Call, CallRoute, Handles, Route};
use jsvalue::json::{parse, write, write_text, Numbers};
use jsvalue::value::{Text, Value};

const QUEUED: u8 = 1;
const MALFORMED: u8 = 2;
const SCHEDULE: u8 = 4;
const SCHEDULE_BACKGROUND: u8 = 8;

/// The app has one batcher and the remote item feed one; a test makes many.
static BATCHERS: Handles<Batcher> = Handles::new("stream batcher", 1024);

fn open(payload: &[u8], call: &Call) -> Result<Vec<u8>, String> {
    let bound = std::str::from_utf8(payload).ok().map(str::trim).ok_or_else(|| "batcher.open takes a bound".to_string())?;
    let max = if bound.is_empty() { MAX_PENDING } else { bound.parse().map_err(|_| "batcher.open takes a bound".to_string())? };
    Ok(BATCHERS.open(call, Batcher::new(max))?.to_string().into_bytes())
}

fn families(_: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = b"{".to_vec();
    for (at, family) in Family::ALL.into_iter().enumerate() {
        if at > 0 {
            out.push(b',');
        }
        out.extend_from_slice(format!("\"{}\":{{\"delta\":", family.name()).as_bytes());
        gate(&mut out, family.delta_gate());
        out.extend_from_slice(b",\"waits\":");
        match family.wait_gate() {
            Some(waits) => gate(&mut out, waits),
            None => out.extend_from_slice(b"null"),
        }
        out.push(b'}');
    }
    out.push(b'}');
    Ok(out)
}

/// A gate as the JS reads it.
fn gate(out: &mut Vec<u8>, tests: &[Test]) {
    let strings = |list: &[&str]| Value::Array(list.iter().map(|s| Value::text(s)).collect());
    let tests = tests.iter().map(|test| {
        let is = match test.is {
            Is::OneOf(values) => strings(values),
            Is::Record => Value::Null,
        };
        Value::Array(vec![strings(test.path), is])
    });
    write(out, &Value::Array(tests.collect()), Numbers::Stringified);
}

/// The batcher a payload names, and the rest of the payload.
fn split(payload: &[u8]) -> Result<(u64, &[u8]), String> {
    let at = payload.iter().position(|&b| b == b'\n').unwrap_or(payload.len());
    let id = std::str::from_utf8(&payload[..at]).ok().and_then(|s| s.trim().parse().ok());
    Ok((id.ok_or_else(|| "batcher routes take a batcher id".to_string())?, payload.get(at + 1..).unwrap_or_default()))
}

/// The next line of `rest`, and what follows it.
fn line<'a>(rest: &mut &'a [u8]) -> Result<&'a [u8], String> {
    let at = rest.iter().position(|&b| b == b'\n').ok_or_else(|| "batcher.push takes an event's lines".to_string())?;
    let found = &rest[..at];
    *rest = &rest[at + 1..];
    Ok(found)
}

/// JSON text read as `JSON.parse` reads it.
fn json(bytes: &[u8]) -> Option<Value> {
    parse(std::str::from_utf8(bytes).ok()?)
}

fn push(payload: &[u8]) -> Result<Vec<u8>, String> {
    let (id, mut rest) = split(payload)?;
    let seq = std::str::from_utf8(line(&mut rest)?).ok().and_then(|s| s.parse().ok()).ok_or("batcher.push takes a number")?;
    let family = Family::of(line(&mut rest)?).ok_or("batcher.push takes a family")?;
    let background = line(&mut rest)? == b"1";
    let Some(Value::String(chat)) = json(line(&mut rest)?) else { return Err("batcher.push takes a chat".into()) };
    // read before the lock: the queues wait only on what changes them
    let (kind, event) = if rest.is_empty() {
        family.wait_gate().ok_or("batcher.push takes a delta's JSON")?;
        (Kind::Waits, Value::Null)
    } else {
        json(rest).map_or((Kind::Malformed, Value::Null), |event| (family.classify(&event), event))
    };
    let (pushed, said, pending) = BATCHERS.with(id, |b| {
        let (pushed, said) = b.push(seq, family, chat, background, kind, event);
        (pushed, said, b.pending())
    })?;
    let (flags, refs) = match pushed {
        Pushed::Queued { refs } => (QUEUED, refs),
        Pushed::Alone => (0, 0),
        Pushed::Malformed => (MALFORMED, 0),
    };
    Ok(reply(flags, refs, pending, said))
}

/// The chats a payload names: the strings of a JSON list.
fn chats(rest: &[u8]) -> Result<Vec<Text>, String> {
    let Some(Value::Array(list)) = json(rest) else { return Err("batcher routes take a list of chats".into()) };
    Ok(list.into_iter().filter_map(|chat| if let Value::String(chat) = chat { Some(chat) } else { None }).collect())
}

/// Run `f` on the batcher a payload names, and reply with what it said.
fn said(payload: &[u8], f: impl FnOnce(&mut Batcher, &[u8]) -> Result<Said, String>) -> Result<Vec<u8>, String> {
    let (id, rest) = split(payload)?;
    let (said, pending) = BATCHERS.with(id, |b| f(b, rest).map(|said| (said, b.pending())))??;
    Ok(reply(0, 0, pending, said))
}

fn flush(payload: &[u8]) -> Result<Vec<u8>, String> {
    said(payload, |b, rest| Ok(Said { groups: chats(rest)?.iter().filter_map(|chat| b.flush_chat(chat)).collect(), ..Said::default() }))
}

fn flush_all(payload: &[u8]) -> Result<Vec<u8>, String> {
    said(payload, |b, _| Ok(Said { groups: b.flush_all(), ..Said::default() }))
}

fn tick(payload: &[u8]) -> Result<Vec<u8>, String> {
    said(payload, |b, _| Ok(b.tick()))
}

fn background_tick(payload: &[u8]) -> Result<Vec<u8>, String> {
    said(payload, |b, _| Ok(b.background_tick()))
}

fn cancel(payload: &[u8]) -> Result<Vec<u8>, String> {
    said(payload, |b, _| {
        b.cancel();
        Ok(Said::default())
    })
}

/// A chat that is gone: what it had pending is dropped, unsent, and listed so JS lets the events go.
fn drop_chats(payload: &[u8]) -> Result<Vec<u8>, String> {
    flush(payload)
}

fn close(payload: &[u8]) -> Result<Vec<u8>, String> {
    Ok(BATCHERS.close(split(payload)?.0).to_string().into_bytes())
}

/// A reply as the module's header lays it out: the list on one line, then each joined event's JSON, one after another.
fn reply(flags: u8, refs: u8, pending: usize, said: Said) -> Vec<u8> {
    let flags = flags | if said.schedule { SCHEDULE } else { 0 } | if said.schedule_background { SCHEDULE_BACKGROUND } else { 0 };
    let mut out = format!("[{flags},{refs},{pending}").into_bytes();
    let mut joined = Vec::new();
    for Group { chat, out: sent } in said.groups {
        out.push(b',');
        write_text(&mut out, &chat);
        out.extend_from_slice(b",[");
        for (at, sent) in sent.into_iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            let start = joined.len();
            if let Some(event) = sent.joined {
                write(&mut joined, &event, Numbers::Stringified);
            }
            out.extend_from_slice(format!("{},{},{}", sent.seq, u8::from(sent.background), joined.len() - start).as_bytes());
        }
        out.push(b']');
    }
    out.extend_from_slice(b"]\n");
    out.extend_from_slice(&joined);
    out
}

inventory::submit! { CallRoute { name: "batcher.open", handler: open } }
inventory::submit! { Route { name: "batcher.families", handler: families } }
inventory::submit! { Route { name: "batcher.push", handler: push } }
inventory::submit! { Route { name: "batcher.flush", handler: flush } }
inventory::submit! { Route { name: "batcher.flushAll", handler: flush_all } }
inventory::submit! { Route { name: "batcher.tick", handler: tick } }
inventory::submit! { Route { name: "batcher.backgroundTick", handler: background_tick } }
inventory::submit! { Route { name: "batcher.cancel", handler: cancel } }
inventory::submit! { Route { name: "batcher.drop", handler: drop_chats } }
inventory::submit! { Route { name: "batcher.close", handler: close } }
