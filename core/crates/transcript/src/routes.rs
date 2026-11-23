//! The transcript crate's core routes, for electron/platform/transcriptWriter.cjs. A payload is a JSON header, and for
//! `transcript.append` a newline and then the lines.
//! - `transcript.open`: `{ flushMs, soonBytes, maxPendingBytes }`, reply the writer's id;
//! - `transcript.append`: `{ id, file, mode, what, chat, timed }`, reply empty;
//! - `transcript.flush`: `{ id, file }`, reply empty once what was queued is on disk, or its write failed and was reported;
//! - `transcript.drain`: `{ id, syncMs }`, reply empty;
//! - `transcript.read`: `{ id, file }`, reply the file's bytes with its pending lines after them;
//! - `transcript.scan`: `{ id, file, kinds, needle }`, reply `{ records, torn, found }`, the records a JSON array;
//! - `transcript.audioRefs`: `{ id, files }`, reply the recordings the files name, as a JSON array of file names; a file with
//!   no transcript names none, and one that can't be read fails the call, so that no recording goes for want of a read;
//! - `transcript.contains`: `{ file, needle, limit }`, whether the first `limit` bytes of any file hold `needle`, reply `true` or `false`;
//! - `transcript.checkpoints`: `{ file, size }`, what a Claude Code transcript's first `size` bytes can be rewound to, a JSON object;
//! - `transcript.has`: `{ id, file }`, reply `true` or `false`;
//! - `transcript.pending`: `{ id, file }`, reply how many bytes are not on disk yet;
//! - `transcript.remove`: `{ id, file }`, reply empty;
//! - `transcript.close`: `{ id }`, reply `true` or `false`.
//!
//! Events on the stream: `{"transcript":<id>,"failed":{file, what, message}}` and
//! `{"transcript":<id>,"wrote":{chat, records, bytes, ms, reason}}`.

use crate::{writer, Event, Meta, Options, RealDisk, Writer, WRITERS};
use dispatch::{Call, CallRoute, Route};
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeSet;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Open {
    flush_ms: u64,
    soon_bytes: usize,
    max_pending_bytes: usize,
}

#[derive(Deserialize)]
struct AudioRefs {
    id: u64,
    files: Vec<String>,
}

#[derive(Deserialize)]
struct Contains {
    file: String,
    needle: String,
    limit: u64,
}

#[derive(Deserialize)]
struct Checkpoints {
    file: String,
    size: u64,
}

#[derive(Deserialize)]
struct Append {
    id: u64,
    file: String,
    mode: Option<u32>,
    what: String,
    chat: String,
    timed: bool,
}

#[derive(Deserialize)]
struct At {
    id: u64,
    file: String,
}

#[derive(Deserialize)]
struct ScanAsk {
    id: u64,
    file: String,
    kinds: Option<Vec<String>>,
    needle: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Drain {
    id: u64,
    sync_ms: u64,
}

#[derive(Deserialize)]
struct Close {
    id: u64,
}

fn header<'a, T: Deserialize<'a>>(payload: &'a [u8], route: &str) -> Result<T, String> {
    serde_json::from_slice(payload).map_err(|error| format!("{route}: {error}"))
}

/// What a writer's event says on the stream.
pub(crate) fn event_json(id: u64, event: Event) -> Vec<u8> {
    // written out, as what hears these knows them by how they start, and key order depends on the build's features
    let (name, body) = match event {
        Event::Failed { file, what, message } => ("failed", json!({ "file": file, "what": what, "message": message })),
        Event::Wrote { chat, records, bytes, ms, why } => {
            ("wrote", json!({ "chat": chat, "records": records, "bytes": bytes, "ms": ms, "reason": why.name() }))
        }
    };
    format!(r#"{{"transcript":{id},"{name}":{body}}}"#).into_bytes()
}

fn open(payload: &[u8], call: &Call) -> Result<Vec<u8>, String> {
    let ask: Open = header(payload, "transcript.open")?;
    let options =
        Options { flush: Duration::from_millis(ask.flush_ms), soon_bytes: ask.soon_bytes, max_pending_bytes: ask.max_pending_bytes };
    // the writer's events name its id, which exists only once it is held
    let id = Arc::new(AtomicU64::new(0));
    let (named, stream) = (id.clone(), Call::of(call.owner));
    let writer = Writer::new(RealDisk, options, move |event| {
        stream.emit(event_json(named.load(Ordering::SeqCst), event));
    });
    let held = WRITERS.open(call, Arc::new(writer))?;
    id.store(held, Ordering::SeqCst);
    Ok(held.to_string().into_bytes())
}

fn append(payload: &[u8]) -> Result<Vec<u8>, String> {
    let end = payload.iter().position(|&b| b == b'\n').ok_or("transcript.append takes a header and lines")?;
    let ask: Append = header(&payload[..end], "transcript.append")?;
    let meta = Meta { mode: ask.mode, what: ask.what, chat: ask.chat, timed: ask.timed };
    writer(ask.id)?.append(&ask.file, &payload[end + 1..], meta);
    Ok(Vec::new())
}

fn flush(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: At = header(payload, "transcript.flush")?;
    writer(ask.id)?.flush(&ask.file);
    Ok(Vec::new())
}

fn drain(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: Drain = header(payload, "transcript.drain")?;
    writer(ask.id)?.drain(Duration::from_millis(ask.sync_ms));
    Ok(Vec::new())
}

fn read(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: At = header(payload, "transcript.read")?;
    writer(ask.id)?.read(&ask.file).map_err(|error| error.to_string())
}

fn scan(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: ScanAsk = header(payload, "transcript.scan")?;
    let bytes = writer(ask.id)?.read(&ask.file).map_err(|error| error.to_string())?;
    let found = crate::scan(&bytes, ask.kinds.as_deref(), ask.needle.as_deref())?;
    // records is JSON already: it goes into the reply as it is
    let reply = format!(r#"{{"records":{},"torn":{},"found":{}}}"#, found.records, found.torn, found.found);
    Ok(reply.into_bytes())
}

fn audio_refs(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: AudioRefs = header(payload, "transcript.audioRefs")?;
    let mut names = BTreeSet::new();
    let writer = writer(ask.id)?;
    for file in &ask.files {
        match writer.read(file) {
            Ok(bytes) => crate::audio_names(&bytes, &mut names),
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(json!(names).to_string().into_bytes())
}

fn contains(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: Contains = header(payload, "transcript.contains")?;
    let bytes = crate::head(&ask.file, ask.limit).map_err(|error| error.to_string())?;
    Ok(crate::contains(&String::from_utf8_lossy(&bytes), &ask.needle).to_string().into_bytes())
}

fn checkpoints(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: Checkpoints = header(payload, "transcript.checkpoints")?;
    let bytes = crate::head(&ask.file, ask.size).map_err(|error| error.to_string())?;
    Ok(json!(crate::checkpoints(&String::from_utf8_lossy(&bytes))).to_string().into_bytes())
}

fn has(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: At = header(payload, "transcript.has")?;
    Ok(writer(ask.id)?.has(&ask.file).to_string().into_bytes())
}

fn pending(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: At = header(payload, "transcript.pending")?;
    Ok(writer(ask.id)?.pending(&ask.file).to_string().into_bytes())
}

fn remove(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: At = header(payload, "transcript.remove")?;
    writer(ask.id)?.remove(&ask.file).map_err(|error| error.to_string())?;
    Ok(Vec::new())
}

fn close(payload: &[u8]) -> Result<Vec<u8>, String> {
    let ask: Close = header(payload, "transcript.close")?;
    Ok(WRITERS.close(ask.id).to_string().into_bytes())
}

inventory::submit! { CallRoute { name: "transcript.open", handler: open } }
inventory::submit! { Route { name: "transcript.append", handler: append } }
inventory::submit! { Route { name: "transcript.flush", handler: flush } }
inventory::submit! { Route { name: "transcript.drain", handler: drain } }
inventory::submit! { Route { name: "transcript.read", handler: read } }
inventory::submit! { Route { name: "transcript.scan", handler: scan } }
inventory::submit! { Route { name: "transcript.audioRefs", handler: audio_refs } }
inventory::submit! { Route { name: "transcript.contains", handler: contains } }
inventory::submit! { Route { name: "transcript.checkpoints", handler: checkpoints } }
inventory::submit! { Route { name: "transcript.has", handler: has } }
inventory::submit! { Route { name: "transcript.pending", handler: pending } }
inventory::submit! { Route { name: "transcript.remove", handler: remove } }
inventory::submit! { Route { name: "transcript.close", handler: close } }
