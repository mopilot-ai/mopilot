//! A chat's history read off the JS thread, however long it is, and handed over a page at a time (`electron/harness/items/acp.cjs`
//! is its caller). `translate.read` reads the transcript's file and replays it on a core thread, and what it holds is
//! the fold of the file as it stood. The session goes on meanwhile, so nothing of that can be final: `translate.settle`, a
//! blocking call, takes what the session said since the read began and the page the window will show, in one step on the JS
//! thread. Its cost is that of what was said during the read and of one page, never of the transcript.
//!
//! - `translate.read` (payload: JSON `{ threadId, cwd, auto, file, extra, findCwd }`, `extra` being records main has that the
//!   file may lack, and `findCwd` asking for the folder the transcript itself names, over `cwd`, and `upTo` where to stop in the file; reply: JSON
//!   `{ id, unread, cwd }`, `unread` how many lines couldn't be read or replayed, each left out, and `cwd` the folder used).
//! - `translate.settle` (payload: a line of JSON `{ id, live, stream, limit, before }`, then a line of JSON `[method, params]`
//!   for each thing the session said meanwhile, `stream` being its translator, for its open message; reply: a page, `1` or
//!   `0` for whether there are older turns, a line of its turn ids as JSON, and then JSON `{ turns, olderCursor }`, which JS
//!   passes on unread). What was said has lines of its own because an item nests deeper than the event it came from: one
//!   past what a line may nest is left out of this page, and the transcript has it for the next, where a list would have
//!   failed the read for good.
//! - `translate.page` (payload: JSON `{ id, limit, before }`; reply: a page), for an older page of what is held.
//! - `translate.turns` (payload: JSON `{ id, live, turn, item }`; reply: a slice of every turn, `Turns::chunk`), for a reader in
//!   main that wants them all and gives way between slices. `live`, on the first, settles as `translate.settle` does.
//! - `translate.keep` (payload: JSON `{ id, live }`; reply: JSON `{ id, turnId }` for a translator going on from where the
//!   transcript ends, or null when that turn is over): a read used up, for a turn followed from its transcript.
//! - `translate.release` (payload: the id; reply: `true` or `false`).

use crate::replay::{record_of, Held};
use crate::routes::object_of;
use crate::{Thrown, TRANSLATORS};
use dispatch::{Call, CallRoute, CancelToken, Handles, Reply, Route};
use jsvalue::js::truthy;
use jsvalue::json::{write, Numbers};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::Path;

/// Read chats held for their next page: a few at a time, kept only while a window pages them.
static HISTORIES: Handles<Held> = Handles::big("history", 64);

/// A record main adds is left out if the transcript has its kind for its turn already.
fn seen_as(record: &Value) -> Option<(Text, Option<Value>)> {
    match record.field("t") {
        Some(Value::String(kind)) if kind.is("user") || kind.is("end") => Some((kind.clone(), record.field("turnId").cloned())),
        _ => None,
    }
}

/// The turn id's spelling, for the set of what the transcript has.
fn seen_key((kind, turn): &(Text, Option<Value>)) -> Vec<u8> {
    let mut key = kind.as_bytes().to_vec();
    key.push(b':');
    key.extend_from_slice(&crate::turns::key_of(turn));
    key
}

/// What a transcript's bytes and main's own records replay to, and how many lines of it could not be read. Lines are what
/// `readAsync` took: blank ones are nothing, anything but an object is a torn line, and what JS threw on is left out alone,
/// so one record the language can't read doesn't cost the chat its history. A last line with no newline may be one being
/// written now, whose whole the session has said since the read began, so it is no failure to read.
fn replayed(bytes: &[u8], extra: &[Value], header: &Object, cancel: &CancelToken) -> Result<(Held, usize), Thrown> {
    let mut held = Held::new(header);
    let mut seen = HashSet::new();
    let mut unread = 0;
    let (ended, last) = bytes.split_at(bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1));
    let lines = ended.split(|byte| *byte == b'\n').map(|line| (line, true)).chain([(last, false)]);
    for (line, whole) in lines.filter(|(line, _)| !trim(line).is_empty()) {
        cancel.check()?;
        match record_of(line).filter(|record| matches!(record, Value::Object(_))) {
            Some(record) => {
                if let Some(mark) = seen_as(&record) {
                    seen.insert(seen_key(&mark));
                }
                unread += usize::from(held.take(record).is_err());
            }
            None => unread += usize::from(whole),
        }
    }
    for record in extra {
        if seen_as(record).is_none_or(|mark| seen.insert(seen_key(&mark))) {
            held.take(record.clone())?;
        }
    }
    Ok((held, unread))
}

/// Whether nothing is at `path`, nor could be yet. Windows says a file is not found for a path under a file, and for a folder
/// named with a separator after it, where Unix says why it can't be read: those are no empty chat.
pub(crate) fn absent(path: &str) -> bool {
    let path = Path::new(path);
    !path.exists() && path.ancestors().skip(1).find(|up| up.exists()).is_none_or(Path::is_dir)
}

/// What a read of `path` came to: a chat with no transcript yet has no bytes.
pub(crate) fn bytes_of(read: std::io::Result<Vec<u8>>, path: &str) -> Result<Vec<u8>, String> {
    let failed = |error: std::io::Error| format!("read an ACP transcript: {error}");
    match read {
        Err(error) if error.kind() == ErrorKind::NotFound && absent(path) => Ok(Vec::new()),
        // the file came after the read looked: a chat's first record
        Err(error) if error.kind() == ErrorKind::NotFound && Path::new(path).is_file() => std::fs::read(path).map_err(failed),
        read => read.map_err(failed),
    }
}

fn file_bytes(path: &str) -> Result<Vec<u8>, String> {
    bytes_of(std::fs::read(path), path)
}

/// The folder the transcript's own `session` record names: a line this build wrote starts with its kind.
fn session_cwd(bytes: &[u8], extra: &[Value]) -> Option<Value> {
    let lines = bytes.split(|byte| *byte == b'\n').filter(|line| line.starts_with(br#"{"t":"session""#)).filter_map(record_of);
    let session = lines.chain(extra.iter().cloned()).find(|record| crate::reads::is(record.field("t"), "session"))?;
    session.field("cwd").filter(|cwd| truthy(cwd)).cloned()
}

fn read(payload: &[u8], call: &Call) -> Reply {
    let mut header = object_of(payload, "read")?;
    let path = crate::reads::string(header.get("file")).map(Text::lossy).unwrap_or_default();
    let mut bytes = file_bytes(&path)?;
    if let Some(Value::Number(end)) = header.get("upTo") {
        bytes.truncate(*end as usize);
    }
    let extra = header.get("extra").and_then(Value::as_array).unwrap_or_default().to_vec();
    if header.get("findCwd") == Some(&Value::Bool(true)) {
        if let Some(cwd) = session_cwd(&bytes, &extra) {
            header.set("cwd", cwd);
        }
    }
    let (mut held, unread) = replayed(&bytes, &extra, &header, &call.cancel)?;
    held.finish();
    let mut reply = format!(r#"{{"id":{},"unread":{unread},"cwd":"#, HISTORIES.open(call, held)?).into_bytes();
    write(&mut reply, header.get("cwd").unwrap_or(&Value::Null), Numbers::Stringified);
    reply.push(b'}');
    Ok(reply)
}

/// A whole number `input` gives, 0 for none.
fn number_of(input: &Object, key: &str) -> usize {
    match input.get(key) {
        Some(Value::Number(number)) => *number as usize,
        _ => 0,
    }
}

fn id_of(input: &Object) -> u64 {
    number_of(input, "id") as u64
}

/// `limit` and `before`, as the page's reader takes them.
fn page_of(held: &Held, input: &Object) -> Vec<u8> {
    held.page(number_of(input, "limit"), input.get("before").filter(|before| truthy(before)))
}

fn settle(payload: &[u8]) -> Reply {
    let mut lines = payload.split(|byte| *byte == b'\n');
    let input = object_of(lines.next().unwrap_or_default(), "settle")?;
    // a session whose translator went has no open message
    let open = match input.get("stream") {
        Some(Value::Number(stream)) => TRANSLATORS.with(*stream as u64, |live| live.open_text()).unwrap_or_default(),
        _ => None,
    };
    HISTORIES.with(id_of(&input), |held| {
        // a call that can't be read is left out of its turn's end, which ends all the same
        let _ = held.settle(input.get("live"));
        for said in lines.filter_map(record_of) {
            held.said(&said);
        }
        if let Some(open) = open {
            held.stream(open);
        }
        page_of(held, &input)
    })
}

fn page(payload: &[u8]) -> Reply {
    let input = object_of(payload, "page")?;
    HISTORIES.with(id_of(&input), |held| page_of(held, &input))
}

fn turns(payload: &[u8]) -> Reply {
    let input = object_of(payload, "turns")?;
    HISTORIES.with(id_of(&input), |held| {
        if input.get("live").is_some() {
            // a call that can't be read is left out of its turn's end, which ends all the same
            let _ = held.settle(input.get("live"));
        }
        held.chunk(number_of(&input, "turn"), number_of(&input, "item"))
    })
}

fn keep(payload: &[u8], call: &Call) -> Reply {
    let input = object_of(payload, "keep")?;
    let id = id_of(&input);
    let kept = HISTORIES.with(id, |held| held.kept(input.get("live")))?;
    HISTORIES.close(id);
    let Some(translator) = kept else { return Ok(b"null".to_vec()) };
    let turn = translator.turn_id.clone().unwrap_or(Value::Null);
    let mut reply = format!(r#"{{"id":{},"turnId":"#, TRANSLATORS.open(call, translator)?).into_bytes();
    write(&mut reply, &turn, Numbers::Stringified);
    reply.push(b'}');
    Ok(reply)
}

fn release(payload: &[u8]) -> Reply {
    let id = std::str::from_utf8(payload).ok().and_then(|id| id.parse().ok()).ok_or_else(|| "translate.release takes an id".to_string())?;
    Ok(HISTORIES.close(id).to_string().into_bytes())
}

inventory::submit! { CallRoute { name: "translate.read", handler: read } }
inventory::submit! { Route { name: "translate.settle", handler: settle } }
inventory::submit! { Route { name: "translate.page", handler: page } }
inventory::submit! { Route { name: "translate.turns", handler: turns } }
inventory::submit! { CallRoute { name: "translate.keep", handler: keep } }
inventory::submit! { Route { name: "translate.release", handler: release } }
