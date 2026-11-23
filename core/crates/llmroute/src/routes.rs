//! The llmroute crate's core routes, for the model router's JS (electron/platform/llmRoute.cjs). A payload starts with a
//! line of JSON saying what to translate, and the bytes to translate follow it as they are, so a body is never escaped
//! into a string; a reply that has a header puts it first the same way.
//!
//! - `llmroute.translateRequest` (payload: `{ inbound, config }`, a newline, the caller's request body; reply: a line of
//!   JSON `{ path, headers, stream, model }`, a newline, the provider's request body).
//! - `llmroute.translateResponse` (payload: `{ inbound, config }`, a newline, the provider's whole reply; reply: the
//!   caller's reply body).
//! - `llmroute.streamOpen` (payload: JSON `{ inbound, config }`; reply: the translator's id).
//! - `llmroute.streamPush` (payload: the id, a newline, the provider's next bytes; reply: the caller's bytes).
//! - `llmroute.streamFinish` (payload: the id; reply: the caller's last bytes), which closes the translator.
//! - `llmroute.streamClose` (payload: the id; reply: `true` or `false`), for a reply given up part way.
//!
//! A failed request translation is the caller's request's fault, and a failed reply translation the provider's.

use crate::config::Config;
use crate::inbound::Inbound;
use crate::providers::openai;
use crate::stream::StreamTranslator;
use crate::Result;
use dispatch::{Call, CallRoute, Handles, Reply, Route};
use serde_json::{json, Value};

/// A reply's translator per stream a router has open: this bounds what a leak can hold.
static STREAMS: Handles<StreamTranslator> = Handles::new("stream translator", 1024);

/// What a payload's header line asks.
struct Ask {
    inbound: Inbound,
    config: Config,
}

fn ask(line: &[u8], route: &str) -> Result<Ask> {
    let value: Value = serde_json::from_slice(line).map_err(|_| format!("llmroute.{route} takes a line of JSON first"))?;
    let inbound = Inbound::from_label(value.get("inbound").and_then(Value::as_str).unwrap_or_default())?;
    let config = Config::from_value(value.get("config").cloned().unwrap_or_default())?;
    Ok(Ask { inbound, config })
}

/// The payload's first line, and the bytes after it.
fn split(payload: &[u8]) -> (&[u8], &[u8]) {
    match payload.iter().position(|byte| *byte == b'\n') {
        Some(at) => (&payload[..at], &payload[at + 1..]),
        None => (payload, &[]),
    }
}

fn id_of(line: &[u8], route: &str) -> Result<u64> {
    std::str::from_utf8(line).ok().and_then(|id| id.parse().ok()).ok_or_else(|| format!("llmroute.{route} takes an id"))
}

/// `header` as a line of JSON, then `body`.
fn with_header(header: &Value, body: Vec<u8>) -> Vec<u8> {
    let mut out = header.to_string().into_bytes();
    out.push(b'\n');
    out.extend(body);
    out
}

fn translate_request(payload: &[u8]) -> Reply {
    let (line, body) = split(payload);
    let Ask { inbound, config } = ask(line, "translateRequest")?;
    let (stream, out) = crate::translate_request(inbound, body, &config)?;
    let accept = if stream { "text/event-stream" } else { "application/json" };
    let header = json!({
        "path": openai::CHAT_PATH,
        "headers": { "content-type": "application/json", "accept": accept },
        "stream": stream,
        "model": config.model,
    });
    Ok(with_header(&header, out))
}

fn translate_response(payload: &[u8]) -> Reply {
    let (line, body) = split(payload);
    let Ask { inbound, config } = ask(line, "translateResponse")?;
    crate::translate_response(inbound, body, &config)
}

fn stream_open(payload: &[u8], call: &Call) -> Reply {
    let Ask { inbound, config } = ask(payload, "streamOpen")?;
    Ok(STREAMS.open(call, StreamTranslator::new(inbound, &config))?.to_string().into_bytes())
}

fn stream_push(payload: &[u8]) -> Reply {
    let (line, bytes) = split(payload);
    STREAMS.with(id_of(line, "streamPush")?, |translator| translator.push(bytes))?
}

fn stream_finish(payload: &[u8]) -> Reply {
    let id = id_of(payload, "streamFinish")?;
    let out = STREAMS.with(id, StreamTranslator::finish)?;
    STREAMS.close(id);
    Ok(out)
}

fn stream_close(payload: &[u8]) -> Reply {
    Ok(STREAMS.close(id_of(payload, "streamClose")?).to_string().into_bytes())
}

inventory::submit! { Route { name: "llmroute.translateRequest", handler: translate_request } }
inventory::submit! { Route { name: "llmroute.translateResponse", handler: translate_response } }
inventory::submit! { CallRoute { name: "llmroute.streamOpen", handler: stream_open } }
inventory::submit! { Route { name: "llmroute.streamPush", handler: stream_push } }
inventory::submit! { Route { name: "llmroute.streamFinish", handler: stream_finish } }
inventory::submit! { Route { name: "llmroute.streamClose", handler: stream_close } }
