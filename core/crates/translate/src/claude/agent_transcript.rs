//! A Claude sub-agent's own transcript folded into the items its agent page shows, merged per completed message, with no
//! per-token streaming. Each item keeps its JSON: every message of a sub-agent says
//! its whole transcript so far, which would otherwise be written out again each time.

use crate::blocks::{content_blocks, normalize};
use crate::claude::common::{cat, is_todo_tool, is_tool, map_key, ms_time};
use crate::claude::failures::{assistant_text, Failures};
use crate::claude::fold::is_limit_home;
use crate::claude::tools::{complete_tool, tool_item};
use crate::claude::user_messages::{app_model_switch, status_note, user_content};
use crate::reads::{at, is, string, text_of};
use crate::Thrown;
use jsvalue::js::given;
use jsvalue::json::{write_object, Numbers};
use jsvalue::trim;
use jsvalue::value::{Object, Text, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// An item and its JSON.
#[derive(Debug, PartialEq)]
pub struct Written {
    pub item: Object,
    pub json: Vec<u8>,
}

impl Written {
    fn of(item: Object) -> Arc<Written> {
        let mut json = Vec::new();
        write_object(&mut json, &item, Numbers::Stringified);
        Arc::new(Written { item, json })
    }
}

pub struct AgentTranscript {
    /// its Agent call's tool_use id
    pub key: Option<Value>,
    pub items: Vec<Arc<Written>>,
    places: HashMap<Text, usize>,
    starts: HashMap<Text, f64>,
    thread: Value,
    cwd: Value,
    failures: Failures,
    limit_start: usize,
    /// agents this one launched since it was last asked, so that their messages can be routed too
    pub launched: Vec<Option<Value>>,
    dirty: bool,
}

/// The id of an item, as `Map` keys take it.
fn id_key(item: &Object) -> Text {
    map_key(item.get("id"))
}

impl AgentTranscript {
    pub fn new(key: Option<Value>, thread: Value, cwd: Value) -> Self {
        AgentTranscript {
            key,
            items: Vec::new(),
            places: HashMap::new(),
            starts: HashMap::new(),
            thread,
            cwd,
            failures: Failures::default(),
            limit_start: 0,
            launched: Vec::new(),
            dirty: false,
        }
    }

    fn put(&mut self, item: Object) {
        self.dirty = true;
        let key = id_key(&item);
        let written = Written::of(item);
        match self.places.get(&key) {
            Some(&place) => self.items[place] = written,
            None => {
                self.places.insert(key, self.items.len());
                self.items.push(written);
            }
        }
    }

    /// One block of an assistant message.
    fn assistant_block(&mut self, message: &Value, key: &Text, index: usize, block: &Object, when: f64) -> Result<(), Thrown> {
        let id = || cat!(key, ":", index.to_string().as_str());
        let kind = block.get("type");
        if is(kind, "text") {
            let text = string(block.get("text")).cloned().unwrap_or_default();
            if !trim(text.as_bytes()).is_empty() {
                self.put(assistant_text(message, id(), text));
            }
        } else if is(kind, "thinking") || is(kind, "redacted_thinking") {
            let text = string(block.get("thinking")).filter(|text| !text.is_empty());
            if let Some(text) = text {
                let summary = Value::Array(vec![Value::String(text.clone())]);
                self.put(Object::of([
                    ("type", Value::text("reasoning")),
                    ("id", Value::String(id())),
                    ("summary", summary),
                    ("content", Value::Array(Vec::new())),
                ]));
            }
        } else if is_tool(block) && !is_todo_tool(block.get("name")) {
            let Some(item) = tool_item(block, &self.cwd, &self.thread, when)? else { return Ok(()) };
            let agent = item.get("agent").is_some();
            self.starts.insert(map_key(block.get("id")), when);
            self.put(item);
            if agent {
                self.launched.push(block.get("id").cloned());
            }
        }
        Ok(())
    }

    /// Fold one of the sub-agent's messages in; true when the items changed.
    pub fn add(&mut self, message: &Value, now: f64) -> Result<bool, Thrown> {
        let when = ms_time(message, now);
        self.dirty = false;
        let content = at(message.field("message"), "content");
        if is(message.field("type"), "assistant") {
            if let Some(notice) = self.failures.limit_notice(message, Some(&Value::text("agent")))? {
                let home = self.items[self.limit_start.min(self.items.len())..].iter().rev().find_map(|held| is_limit_home(&held.item));
                self.put(match home.flatten() {
                    Some(id) => with_id(notice, id),
                    None => notice,
                });
                return Ok(self.dirty);
            }
            let key = text_of(given(message.field("uuid")).or(at(message.field("message"), "id")))?;
            if let Some(Value::Array(blocks)) = content {
                for (index, block) in blocks.iter().enumerate() {
                    if let Some(block) = normalize(Some(block)) {
                        self.assistant_block(message, &key, index, &block, when)?;
                    }
                }
            }
        } else if is(message.field("type"), "user") {
            if status_note(message).is_none() && !app_model_switch(message) && !user_content(content)?.is_empty() {
                self.limit_start = self.items.len();
            }
            let structured = given(message.field("tool_use_result")).or(message.field("toolUseResult"));
            for block in content_blocks(content) {
                if !is(block.get("type"), "tool_result") {
                    continue;
                }
                let key = map_key(block.get("tool_use_id"));
                let Some(&place) = self.places.get(&key) else { continue };
                let done = complete_tool(&self.items[place].item, &block, structured, self.starts.get(&key).copied(), when)?;
                self.put(done);
            }
        }
        Ok(self.dirty)
    }

    /// The agent stopped or failed: tools it left running were cut off. True when any were.
    pub fn cut_off(&mut self) -> bool {
        let mut changed = false;
        for held in &mut self.items {
            let running = ["commandExecution", "fileChange", "mcpToolCall"].iter().any(|kind| is(held.item.get("type"), kind));
            if running && is(held.item.get("status"), "inProgress") {
                let mut item = held.item.clone();
                item.set("status", Value::text("failed"));
                *held = Written::of(item);
                changed = true;
            }
        }
        changed
    }
}

/// `{ ...item, id }`.
fn with_id(mut item: Object, id: Value) -> Object {
    item.set("id", id);
    item
}
