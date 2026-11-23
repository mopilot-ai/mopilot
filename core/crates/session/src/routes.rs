//! The session crate's core routes, for electron/session/state.cjs:
//! - `session.open`: payload `{"id": n, "empty": {...}, "client": [...]}`, reply empty;
//! - `session.patch`: payload `{"id": n, "chat": "...", "partial": {...}, "now": ms, "client": bool}`, reply
//!   `{"rev": n, "keys": [...], "implied": {...}}`, or `null` when nothing changed;
//! - `session.drainable`: payload `{"id": n, "chat": "..."}`, reply `true` when the first queued message could go;
//! - `session.drain`: payload `{"id": n, "chat": "...", "now": ms}`, reply as `session.patch`'s when the first queued
//!   message left the queue to be sent, else `null`;
//! - `session.step`: payload `{"id": n, "chat": "...", "step": "start" | "end" | "crash", "args": {...}, "extra": {...},
//!   "now": ms}`, reply as `session.patch`'s, the step's own values among the implied ones;
//! - `session.putBack`: payload `{"id": n, "chat": "...", "item": <its id>, "ahead": bool}`, reply the index in the queue
//!   the message goes back at;
//! - `session.sendNow`: payload `{"id": n, "chat": "...", "phase": "admit" | "route", "peer": bool, "peerSteers"?: bool,
//!   "steers"?: bool}`, reply the JSON string `"admit"`, `"refuse"`, `"start"`, `"steer"`, `"queueFirst"`, or `"ask"` for the
//!   flag it needs;
//! - `session.close`: payload the store's id, reply empty.

use dispatch::Route;
use serde_json::{json, Map, Value};

fn parsed(payload: &[u8], route: &str) -> Result<Map<String, Value>, String> {
    let value = serde_json::from_slice(payload)
        .or_else(|_| serde_json::from_slice(&well_formed(payload)))
        .or_else(|_| serde_json::from_slice(&shallow(&well_formed(payload))));
    match value {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(format!("{route} takes a JSON object")),
    }
}

/// How deep `shallow` keeps a value, within serde_json's limit of 128.
const MAX_DEPTH: usize = 100;

/// `payload` with each array or object below `MAX_DEPTH` as a string of its text: a tool's input can nest deeper than serde_json
/// reads, and JSON.parse took it. Its text stays apart from any other value's and only ever compares, as `well_formed`'s does.
fn shallow(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len());
    let (mut copied, mut depth) = (0, 0);
    for (at, byte) in structural(payload) {
        match byte {
            _ if at < copied => {}
            b'{' | b'[' if depth == MAX_DEPTH => {
                let end = at + end_of_value(&payload[at..]);
                out.extend_from_slice(&payload[copied..at]);
                out.extend_from_slice(Value::from(String::from_utf8_lossy(&payload[at..end])).to_string().as_bytes());
                copied = end;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    out.extend_from_slice(&payload[copied..]);
    out
}

/// How long the array or object `value` starts with is.
fn end_of_value(value: &[u8]) -> usize {
    let mut depth = 0;
    for (at, byte) in structural(value) {
        match byte {
            b'{' | b'[' => depth += 1,
            b'}' | b']' if depth == 1 => return at + 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
    }
    value.len()
}

/// The bytes of JSON text that aren't in a string, with their places.
fn structural(text: &[u8]) -> impl Iterator<Item = (usize, u8)> + '_ {
    let (mut quoted, mut escaped) = (false, false);
    text.iter().copied().enumerate().filter(move |&(_, byte)| {
        let outside = !quoted && byte != b'"';
        if escaped {
            escaped = false;
        } else if quoted && byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        }
        outside
    })
}

/// `payload` with each lone surrogate escape as plain text, which JSON.stringify writes for a string cut inside an emoji and
/// serde_json refuses. It stays apart from any other value, and only ever compares: the mirror keeps the value as given.
fn well_formed(payload: &[u8]) -> Vec<u8> {
    let unit_at = |at: usize| -> Option<u16> {
        let digits = payload.get(at + 2..at + 6)?;
        (payload.get(at..at + 2)? == b"\\u").then(|| u16::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()).flatten()
    };
    let mut out = Vec::with_capacity(payload.len());
    let mut at = 0;
    while at < payload.len() {
        if payload[at] != b'\\' {
            out.push(payload[at]);
            at += 1;
            continue;
        }
        let paired = matches!(unit_at(at), Some(0xd800..=0xdbff)) && matches!(unit_at(at + 6), Some(0xdc00..=0xdfff));
        if paired {
            out.extend_from_slice(&payload[at..at + 12]);
            at += 12;
        } else {
            if matches!(unit_at(at), Some(0xd800..=0xdfff)) {
                out.push(b'\\');
            }
            let end = (at + 2).min(payload.len());
            out.extend_from_slice(&payload[at..end]);
            at = end;
        }
    }
    out
}

fn id_of(m: &Map<String, Value>, route: &str) -> Result<u64, String> {
    m.get("id").and_then(Value::as_u64).ok_or_else(|| format!("{route} takes a store id"))
}

fn open(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.open")?;
    let id = id_of(&m, "session.open")?;
    let Some(Value::Object(empty)) = m.get("empty") else { return Err("session.open takes an empty session".into()) };
    let client = m.get("client").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect());
    crate::open(id, empty.clone(), client.unwrap_or_default());
    Ok(Vec::new())
}

fn patch(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.patch")?;
    let id = id_of(&m, "session.patch")?;
    let chat = m.get("chat").and_then(Value::as_str).ok_or("session.patch takes a chat id")?;
    let Some(Value::Object(partial)) = m.get("partial") else { return Err("session.patch takes a partial state".into()) };
    let now = m.get("now").cloned().unwrap_or(Value::from(0));
    let client = m.get("client").and_then(Value::as_bool).unwrap_or(false);
    let reply = match crate::patch(id, chat, partial.clone(), now, client)? {
        Some(c) => json!({ "rev": c.rev, "keys": c.keys, "implied": c.implied }),
        None => Value::Null,
    };
    Ok(reply.to_string().into_bytes())
}

fn drainable(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.drainable")?;
    let id = id_of(&m, "session.drainable")?;
    let chat = m.get("chat").and_then(Value::as_str).ok_or("session.drainable takes a chat id")?;
    Ok(crate::drainable(id, chat)?.to_string().into_bytes())
}

fn drain(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.drain")?;
    let id = id_of(&m, "session.drain")?;
    let chat = m.get("chat").and_then(Value::as_str).ok_or("session.drain takes a chat id")?;
    let now = m.get("now").cloned().unwrap_or(Value::from(0));
    let reply = match crate::drain(id, chat, now)? {
        Some(c) => json!({ "rev": c.rev, "keys": c.keys, "implied": c.implied }),
        None => Value::Null,
    };
    Ok(reply.to_string().into_bytes())
}

fn step(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.step")?;
    let id = id_of(&m, "session.step")?;
    let chat = m.get("chat").and_then(Value::as_str).ok_or("session.step takes a chat id")?;
    let name = m.get("step").and_then(Value::as_str).ok_or("session.step takes a step")?;
    let args = m.get("args").and_then(Value::as_object).cloned().unwrap_or_default();
    let extra = m.get("extra").and_then(Value::as_object).cloned().unwrap_or_default();
    let now = m.get("now").cloned().unwrap_or(Value::from(0));
    let reply = match crate::step(id, chat, name, &args, extra, now)? {
        Some(c) => json!({ "rev": c.rev, "keys": c.keys, "implied": c.implied }),
        None => Value::Null,
    };
    Ok(reply.to_string().into_bytes())
}

fn put_back(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.putBack")?;
    let id = id_of(&m, "session.putBack")?;
    let chat = m.get("chat").and_then(Value::as_str).ok_or("session.putBack takes a chat id")?;
    let item = m.get("item").cloned().ok_or("session.putBack takes the message's id")?;
    let ahead = m.get("ahead").and_then(Value::as_bool).unwrap_or(false);
    Ok(crate::put_back(id, chat, item, ahead)?.to_string().into_bytes())
}

fn send_now(payload: &[u8]) -> Result<Vec<u8>, String> {
    let m = parsed(payload, "session.sendNow")?;
    let id = id_of(&m, "session.sendNow")?;
    let chat = m.get("chat").and_then(Value::as_str).ok_or("session.sendNow takes a chat id")?;
    let phase = m.get("phase").and_then(Value::as_str).ok_or("session.sendNow takes a phase")?;
    let peer = m.get("peer").and_then(Value::as_bool).unwrap_or(false);
    let flag = |k: &str| m.get(k).and_then(Value::as_bool);
    // a JSON string, as every reply main parses
    Ok(Value::from(crate::send_now(id, chat, phase, peer, flag("peerSteers"), flag("steers"))?).to_string().into_bytes())
}

fn close(payload: &[u8]) -> Result<Vec<u8>, String> {
    let id = std::str::from_utf8(payload).ok().and_then(|s| s.trim().parse().ok()).ok_or("session.close takes a store id")?;
    crate::close(id);
    Ok(Vec::new())
}

inventory::submit! { Route { name: "session.open", handler: open } }
inventory::submit! { Route { name: "session.patch", handler: patch } }
inventory::submit! { Route { name: "session.close", handler: close } }
inventory::submit! { Route { name: "session.drain", handler: drain } }
inventory::submit! { Route { name: "session.drainable", handler: drainable } }
inventory::submit! { Route { name: "session.step", handler: step } }
inventory::submit! { Route { name: "session.putBack", handler: put_back } }
inventory::submit! { Route { name: "session.sendNow", handler: send_now } }

#[cfg(test)]
mod tests {
    use dispatch::dispatch;

    fn text(r: Result<Vec<u8>, String>) -> String {
        String::from_utf8(r.expect("a reply")).expect("utf-8")
    }

    #[test]
    fn a_store_opens_patches_and_closes_through_its_routes() {
        let open = br#"{"id": 900, "empty": {"rev": 0, "turn": "idle", "plan": false, "progressAt": null, "runningElsewhere": false, "queue": []}, "client": ["plan"]}"#;
        assert_eq!(text(dispatch("session.open", open)), "");
        let reply = text(dispatch("session.patch", br#"{"id": 900, "chat": "c", "partial": {"plan": true}, "now": 3, "client": true}"#));
        assert_eq!(reply, r#"{"rev":1,"keys":["plan"],"implied":{}}"#);
        assert_eq!(text(dispatch("session.patch", br#"{"id": 900, "chat": "c", "partial": {"plan": true}}"#)), "null");
        let queue = br#"{"id": 900, "chat": "c", "partial": {"plan": false}}"#;
        assert_eq!(text(dispatch("session.patch", queue)), r#"{"rev":2,"keys":["plan"],"implied":{}}"#);
        assert_eq!(text(dispatch("session.drainable", br#"{"id": 900, "chat": "c"}"#)), "false", "nothing queued");
        assert_eq!(text(dispatch("session.drain", br#"{"id": 900, "chat": "c", "now": 4}"#)), "null");
        let queued = br#"{"id": 900, "chat": "c", "partial": {"queue": [{"id": "q"}]}}"#;
        assert_eq!(text(dispatch("session.patch", queued)), r#"{"rev":3,"keys":["queue"],"implied":{}}"#);
        assert_eq!(text(dispatch("session.drainable", br#"{"id": 900, "chat": "c"}"#)), "true");
        assert_eq!(text(dispatch("session.drain", br#"{"id": 900, "chat": "c"}"#)), r#"{"rev":4,"keys":["queue"],"implied":{}}"#);
        let start = br#"{"id": 900, "chat": "c", "step": "start", "args": {"turnId": "t", "human": true}, "now": 5}"#;
        assert_eq!(text(dispatch("session.step", start)), r#"{"rev":5,"keys":["turn"],"implied":{"turn":"running"}}"#);
        assert_eq!(text(dispatch("session.step", start)), "null");
        assert_eq!(text(dispatch("session.putBack", br#"{"id": 900, "chat": "c", "item": "z", "ahead": true}"#)), "0");
        assert_eq!(text(dispatch("session.sendNow", br#"{"id": 900, "chat": "c", "phase": "route", "steers": true}"#)), r#""steer""#);
        assert_eq!(text(dispatch("session.close", b"900")), "");
        assert_eq!(dispatch("session.patch", br#"{"id": 900, "chat": "c", "partial": {}}"#), Err("no session store 900".into()));
    }

    #[test]
    fn malformed_payloads_are_refused_with_what_was_missing() {
        assert_eq!(dispatch("session.open", b"[]"), Err("session.open takes a JSON object".into()));
        assert_eq!(dispatch("session.open", b"{}"), Err("session.open takes a store id".into()));
        assert_eq!(dispatch("session.open", br#"{"id": 1}"#), Err("session.open takes an empty session".into()));
        assert_eq!(text(dispatch("session.open", br#"{"id": 901, "empty": {}}"#)), "", "no client keys: a window sets none");
        assert_eq!(dispatch("session.patch", br#"{"id": 1}"#), Err("session.patch takes a chat id".into()));
        assert_eq!(dispatch("session.patch", br#"{"id": 1, "chat": "c"}"#), Err("session.patch takes a partial state".into()));
        assert_eq!(dispatch("session.close", b"x"), Err("session.close takes a store id".into()));
        assert_eq!(dispatch("session.drain", br#"{"id": 1}"#), Err("session.drain takes a chat id".into()));
        assert_eq!(dispatch("session.drainable", br#"{"id": 1}"#), Err("session.drainable takes a chat id".into()));
        assert_eq!(dispatch("session.step", br#"{"id": 1}"#), Err("session.step takes a chat id".into()));
        assert_eq!(dispatch("session.step", br#"{"id": 1, "chat": "c"}"#), Err("session.step takes a step".into()));
        assert_eq!(dispatch("session.putBack", br#"{"id": 1}"#), Err("session.putBack takes a chat id".into()));
        assert_eq!(dispatch("session.putBack", br#"{"id": 1, "chat": "c"}"#), Err("session.putBack takes the message's id".into()));
        assert_eq!(dispatch("session.sendNow", br#"{"id": 1}"#), Err("session.sendNow takes a chat id".into()));
        assert_eq!(dispatch("session.sendNow", br#"{"id": 1, "chat": "c"}"#), Err("session.sendNow takes a phase".into()));
    }

    #[test]
    fn a_lone_surrogate_compares_as_text_and_a_pair_stays_a_character() {
        let read = |json: &str| super::parsed(json.as_bytes(), "t").expect("an object");
        assert_eq!(read(r#"{"a":"x\ud83dy"}"#)["a"], "x\\ud83dy");
        assert_eq!(read(r#"{"a":"\ude00"}"#)["a"], "\\ude00");
        assert_eq!(read(r#"{"a":"\ud83d\ude00"}"#)["a"], "\u{1f600}");
        assert_eq!(read(r#"{"a":"\ud83d\ude00\ud83d"}"#)["a"], "\u{1f600}\\ud83d");
        // an escaped backslash before a u is text already, and a repaired payload keeps every other escape
        assert_eq!(read(r#"{"a":"\\ud83d","b":"\ud83d\n"}"#)["b"], "\\ud83d\n");
        assert_eq!(read(r#"{"a":"\\ud83d","b":"\ud83d"}"#)["a"], "\\ud83d");
        assert_ne!(read(r#"{"a":"\ud83d"}"#)["a"], read(r#"{"a":"\ud83e"}"#)["a"]);
        assert!(super::parsed(b"{\"a\":\"\\", "t").is_err(), "cut off inside an escape");
        assert!(super::parsed(br#"{"a":"\u12"}"#, "t").is_err());
    }

    fn nested(depth: usize, inner: &str) -> String {
        format!("{{\"a\":{}{inner}{}}}", "[".repeat(depth), "]".repeat(depth))
    }

    #[test]
    fn a_value_nested_past_the_parsers_limit_compares_as_its_text() {
        let read = |json: &str| super::parsed(json.as_bytes(), "t").expect("an object");
        let deep = nested(500, "\"x]\\\"[\"");
        assert_ne!(read(&deep)["a"], read(&nested(500, "\"y\""))["a"]);
        assert_eq!(read(&deep)["a"], read(&deep)["a"]);
        // what follows a deep value is read as usual, and a shallow payload isn't touched
        let after = format!("{{\"a\":{}1{},\"b\":{{\"c\":2}}}}", "[".repeat(300), "]".repeat(300));
        assert_eq!(read(&after)["b"]["c"], 2);
        assert_eq!(read(&nested(50, "1")), read(&nested(50, "1")));
        assert_eq!(super::shallow(br#"{"a":[1,{"b":"]"}]}"#), br#"{"a":[1,{"b":"]"}]}"#.to_vec());
        // a surrogate alone in a deep value counts too, and text that isn't JSON stays refused
        assert!(super::parsed(nested(300, r#""\ud83d""#).as_bytes(), "t").is_ok());
        assert!(super::parsed(format!("{{\"a\":{}", "[".repeat(300)).as_bytes(), "t").is_err());
        assert!(super::parsed(format!("{{\"a\":{}]]", "[".repeat(300)).as_bytes(), "t").is_err());
    }

    #[test]
    fn the_end_of_a_value_is_found_past_strings_and_objects() {
        assert_eq!(super::end_of_value(br#"[{"a":"]"},[]] tail"#), 14);
        assert_eq!(super::end_of_value(b"[[1"), 3);
    }
}
