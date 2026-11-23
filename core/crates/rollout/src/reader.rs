//! A thread's history built from its rollout a line at a time, in the shape thread/turns/list answers with: each item is
//! written out as it completes, so what is held is the JSON a page sends and not a tree of its values, which would cost
//! what the JS's did.

use crate::items::{item_from_rollout, turn_error};
use crate::js::{given, truthy};
use crate::json::{parse, write, Numbers};
use crate::value::{Object, Text, Value};
use memchr::memmem::find;
use std::collections::HashMap;

/// A thread's history: the folder it ran in, as JSON, and each turn. A turn with nothing in it (only what the model was
/// told) shows nothing, and is not here; the app-server leaves it out too.
#[derive(Debug, Default, PartialEq)]
pub struct History {
    pub cwd: Vec<u8>,
    pub turns: Vec<HeldTurn>,
}

/// A turn as JSON: what comes before its items, each item, and what comes after. The items stay as they were written, since
/// joining them up would hold the whole file twice over at the end of its read.
#[derive(Debug, Default, PartialEq)]
pub struct HeldTurn {
    pub before: Box<[u8]>,
    pub items: Vec<Box<[u8]>>,
    pub after: Box<[u8]>,
}

impl HeldTurn {
    /// How many bytes of JSON this is.
    pub fn size(&self) -> usize {
        self.before.len() + self.items.iter().map(|item| item.len() + 1).sum::<usize>() + self.after.len()
    }

    /// This turn's JSON, onto `out`.
    pub fn write_to(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.before);
        for (at, item) in self.items.iter().enumerate() {
            if at > 0 {
                out.push(b',');
            }
            out.extend_from_slice(item);
        }
        out.extend_from_slice(&self.after);
    }
}

/// A value as a JS `Map` key. Objects are compared by identity, so each one read from a line is its own key.
#[derive(Eq, Hash, PartialEq)]
enum Key {
    Absent,
    Null,
    Bool(bool),
    Number(u64),
    Text(Text),
    Unique(u64),
}

struct Turn {
    id: Value,
    /// each item as JSON, and where each item id's is
    items: Vec<Box<[u8]>>,
    places: HashMap<Key, usize>,
    /// the messages of a build that records no items
    legacy: Vec<Box<[u8]>>,
    status: &'static str,
    error: Value,
    started_at: Value,
    completed_at: Value,
    duration_ms: Value,
}

impl Turn {
    /// This turn as a page shows it: its own items, or its messages when it has none. A turn with neither shows nothing, and
    /// is no turn.
    fn finish(self) -> Option<HeldTurn> {
        let items = if self.items.is_empty() { self.legacy } else { self.items };
        if items.is_empty() {
            return None;
        }
        let mut before = br#"{"id":"#.to_vec();
        write(&mut before, &self.id, Numbers::Exact);
        before.extend_from_slice(br#","items":["#);
        let mut after = br#"],"itemsView":"full","status":""#.to_vec();
        after.extend_from_slice(self.status.as_bytes());
        after.extend_from_slice(br#"","error":"#);
        write(&mut after, &self.error, Numbers::Exact);
        after.extend_from_slice(br#","startedAt":"#);
        write(&mut after, &self.started_at, Numbers::Exact);
        after.extend_from_slice(br#","completedAt":"#);
        write(&mut after, &self.completed_at, Numbers::Exact);
        after.extend_from_slice(br#","durationMs":"#);
        write(&mut after, &self.duration_ms, Numbers::Exact);
        after.push(b'}');
        Some(HeldTurn { before: before.into_boxed_slice(), items, after: after.into_boxed_slice() })
    }
}

/// Only the session's and events' lines are parsed: the model's own records are most of a file.
fn wanted(line: &[u8]) -> bool {
    find(line, b"\"event_msg\"").is_some() || find(line, b"\"session_meta\"").is_some()
}

fn written(value: &Value, numbers: Numbers) -> Box<[u8]> {
    let mut json = Vec::new();
    write(&mut json, value, numbers);
    json.into_boxed_slice()
}

/// The history so far.
#[derive(Default)]
pub struct Reader {
    turns: Vec<Turn>,
    at: HashMap<Key, usize>,
    cwd: Option<Value>,
    /// the turn messages with no turn of their own go to: the oldest builds' events have none, and each user message
    /// starts one
    legacy_turn: Option<Value>,
    legacy_count: u64,
    identities: u64,
}

impl Reader {
    fn key(&mut self, value: Option<&Value>) -> Key {
        match value {
            None => Key::Absent,
            Some(Value::Null) => Key::Null,
            Some(Value::Bool(flag)) => Key::Bool(*flag),
            // -0 and 0 are one key
            Some(Value::Number(number)) => Key::Number((number + 0.0).to_bits()),
            Some(Value::String(text)) => Key::Text(text.clone()),
            Some(Value::Array(_) | Value::Object(_)) => {
                self.identities += 1;
                Key::Unique(self.identities)
            }
        }
    }

    /// Where the turn of this id is, made if it is new.
    fn turn(&mut self, id: &Value) -> usize {
        let key = self.key(Some(id));
        let next = self.turns.len();
        let at = *self.at.entry(key).or_insert(next);
        if at == next {
            self.turns.push(Turn {
                id: id.clone(),
                items: Vec::new(),
                places: HashMap::new(),
                legacy: Vec::new(),
                status: "inProgress",
                error: Value::Null,
                started_at: Value::Null,
                completed_at: Value::Null,
                duration_ms: Value::Null,
            });
        }
        at
    }

    fn ended(&mut self, id: &Value, p: &Value, status: &'static str, error: Value) {
        let at = self.turn(id);
        let turn = &mut self.turns[at];
        turn.status = status;
        turn.error = error;
        if let Some(started) = given(p.field("started_at")) {
            turn.started_at = started.clone();
        }
        turn.completed_at = given(p.field("completed_at")).cloned().unwrap_or(Value::Null);
        turn.duration_ms = given(p.field("duration_ms")).cloned().unwrap_or(Value::Null);
    }

    fn completed(&mut self, id: &Value, p: &Value) -> Result<(), String> {
        let Some(item) = item_from_rollout(p.field("item"))? else {
            return Ok(());
        };
        // an id went through stringifying with its item: what that made null is null here
        let item_id = match item.get("id") {
            Some(Value::Number(number)) if !number.is_finite() => Some(&Value::Null),
            id => id,
        };
        let key = self.key(item_id);
        let json = written(&Value::Object(item), Numbers::Stringified);
        let at = self.turn(id);
        let turn = &mut self.turns[at];
        // an item completed again (its later state) replaces the earlier one where it was
        match turn.places.get(&key) {
            Some(&place) => turn.items[place] = json,
            None => {
                turn.places.insert(key, turn.items.len());
                turn.items.push(json);
            }
        }
        Ok(())
    }

    /// Codex builds that record no items (no item_completed) write the conversation as message events; a turn gets those
    /// messages only when it has no items of its own, so a build that writes both never shows them twice.
    fn message(&mut self, p: &Value, user: bool) {
        let turn_id = p.field("turn_id");
        if user && !turn_id.is_some_and(truthy) {
            self.legacy_turn = Some(Value::text(&format!("legacy-turn-{}", self.legacy_count)));
        }
        let id = given(turn_id).or(self.legacy_turn.as_ref()).filter(|id| truthy(id)).cloned();
        let (Some(id), Some(Value::String(text))) = (id, p.field("message")) else {
            return;
        };
        let at = self.turn(&id);
        let item_id = Value::text(&format!("legacy-{}", self.legacy_count));
        self.legacy_count += 1;
        let item = if user { user_message(item_id, text, p) } else { agent_message(item_id, text) };
        self.turns[at].legacy.push(written(&Value::Object(item), Numbers::Exact));
    }

    /// One record (a parsed line). A shape the JS threw on fails the whole read, as it did.
    fn record(&mut self, r: &Object) -> Result<(), String> {
        let Some(p) = r.get("payload").filter(|p| matches!(p, Value::Object(_) | Value::Array(_))) else {
            return Ok(());
        };
        let of_type = |name: &str| matches!(r.get("type"), Some(Value::String(kind)) if kind.is(name));
        if of_type("session_meta") && self.cwd.as_ref().is_none_or(|cwd| *cwd == Value::Null) {
            self.cwd = p.field("cwd").cloned();
        }
        if !of_type("event_msg") {
            return Ok(());
        }
        let Some(Value::String(kind)) = p.field("type") else {
            return Ok(());
        };
        if kind.is("user_message") || kind.is("agent_message") {
            self.message(p, kind.is("user_message"));
            return Ok(());
        }
        let Some(id) = p.field("turn_id").filter(|id| truthy(id)) else {
            return Ok(());
        };
        match kind.as_bytes() {
            b"task_started" | b"turn_started" => {
                let at = self.turn(id);
                self.turns[at].started_at = given(p.field("started_at")).cloned().unwrap_or(Value::Null);
            }
            b"task_complete" | b"turn_complete" => {
                let error = p.field("error").unwrap_or(&Value::Null);
                self.ended(id, p, if truthy(error) { "failed" } else { "completed" }, turn_error(error));
            }
            b"turn_aborted" => self.ended(id, p, "interrupted", Value::Null),
            b"item_completed" => self.completed(id, p)?,
            _ => {}
        }
        Ok(())
    }

    /// One line of the file. One cut off while Codex was writing it (the file's last, usually) is skipped: the rest still
    /// reads. Bytes that aren't UTF-8 read as U+FFFD, as a JS stream decodes them.
    pub fn line(&mut self, line: &[u8]) -> Result<(), String> {
        if !wanted(line) {
            return Ok(());
        }
        match parse(&String::from_utf8_lossy(line)) {
            Some(Value::Object(record)) => self.record(&record),
            _ => Ok(()),
        }
    }

    /// One `\n`-ended run of the file. A lone CR ends a line too: `readline` splits there. So do U+2028 and U+2029 for
    /// `readline`, which cost the JS the lines that held one; they are ordinary characters in a JSON string, and Codex
    /// writes them raw, so here they stay.
    pub fn lines(&mut self, run: &[u8]) -> Result<(), String> {
        if wanted(run) {
            run.split(|&byte| byte == b'\r').try_for_each(|line| self.line(line))?;
        }
        Ok(())
    }

    /// The history: its turns, oldest first, and the folder it runs in.
    pub fn finish(self) -> History {
        let turns = self.turns.into_iter().filter_map(Turn::finish).collect();
        History { cwd: written(&self.cwd.unwrap_or(Value::Null), Numbers::Exact).into_vec(), turns }
    }
}

fn user_message(id: Value, text: &Text, p: &Value) -> Object {
    let text_part = Object::from_entries(vec![
        ("type".into(), Value::text("text")),
        ("text".into(), Value::String(text.clone())),
        ("text_elements".into(), Value::Array(vec![])),
    ]);
    let mut content = vec![Value::Object(text_part)];
    let mut attached = |list: &str, kind: &str, key: &str| {
        if let Some(Value::Array(values)) = p.field(list) {
            content.extend(values.iter().map(|value| {
                Value::Object(Object::from_entries(vec![
                    ("type".into(), Value::text(kind)),
                    ("detail".into(), Value::Null),
                    (key.into(), value.clone()),
                ]))
            }));
        }
    };
    attached("images", "image", "url");
    attached("local_images", "localImage", "path");
    Object::from_entries(vec![
        ("type".into(), Value::text("userMessage")),
        ("id".into(), id),
        ("clientId".into(), Value::Null),
        ("content".into(), Value::Array(content)),
    ])
}

fn agent_message(id: Value, text: &Text) -> Object {
    Object::from_entries(vec![
        ("type".into(), Value::text("agentMessage")),
        ("id".into(), id),
        ("text".into(), Value::String(text.clone())),
        ("phase".into(), Value::Null),
        ("memoryCitation".into(), Value::Null),
        ("delivery".into(), Value::Null),
        ("questions".into(), Value::Null),
    ])
}
