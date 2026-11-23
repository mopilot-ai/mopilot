//! Flat OpenAI-shaped IR chunks rendered as Anthropic's stateful event stream: `message_start`, then each content block's
//! `content_block_start`, deltas and `content_block_stop`, then `message_delta` with the stop reason and usage, and
//! `message_stop`; or an `error` event.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, `AnthropicStreamRenderer`, commit 0ed4b3d,
//! Apache-2.0; build/THIRD_PARTY_NOTICES.md) and modified: events are written as bytes with `type` first, a tool call
//! whose id or name a provider repeats on every fragment stays one block, the model falls back to the config's when a
//! provider names none, `message_delta` always carries the counts Anthropic's SDK reads, and an `error` event is
//! rendered.

use super::{anthropic_usage, message_id, required_usage, stop_reason};
use crate::ir::{ChatChunk, Usage};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[derive(Clone, Copy)]
enum OpenBlock {
    Text(i64),
    Tool(i64),
}

/// Write one Anthropic event: an `event:` line and a `data:` line whose payload carries `type` too, first, as
/// Anthropic's own do.
fn event(out: &mut Vec<u8>, kind: &str, fields: Vec<(&str, Value)>) {
    let mut payload = Map::new();
    payload.insert("type".to_string(), json!(kind));
    for (key, value) in fields {
        payload.insert(key.to_string(), value);
    }
    out.extend_from_slice(format!("event: {kind}\ndata: {}\n\n", Value::Object(payload)).as_bytes());
}

/// Anthropic's event sequence rebuilt from flat chunks, one reply at a time.
///
/// Anthropic numbers content blocks in order across text and tool blocks; the IR numbers tool fragments among tools
/// only. Block indices are given as blocks open, and each tool index maps onto its block. Usage that arrives after
/// `message_start` goes out in `message_delta`, so no text or tool fragment waits for it.
#[derive(Default)]
pub struct StreamRenderer {
    started: bool,
    id: String,
    model: String,
    usage: Usage,
    stop_reason: Option<&'static str>,
    open_block: Option<OpenBlock>,
    next_index: i64,
    /// each IR tool index's block, and the call id it opened with
    tools: HashMap<i64, (i64, Option<String>)>,
}

impl StreamRenderer {
    /// A renderer for a reply from `model`, which names it until the provider does.
    pub fn new(model: &str) -> Self {
        Self { id: message_id(""), model: model.to_string(), ..Self::default() }
    }

    /// Whether the provider said why its reply stopped: a stream that ends without saying was cut short.
    pub fn finished(&self) -> bool {
        self.stop_reason.is_some()
    }

    fn start(&mut self, out: &mut Vec<u8>) {
        if self.started {
            return;
        }
        self.started = true;
        // the start's counts are provisional; the end's replace them
        let usage = Usage { prompt_tokens: Some(self.usage.prompt_tokens.unwrap_or(0)), completion_tokens: Some(0), ..self.usage.clone() };
        let message = json!({
            "id": self.id, "type": "message", "role": "assistant", "model": self.model, "content": [],
            "stop_reason": Value::Null, "stop_sequence": Value::Null, "usage": anthropic_usage(usage),
        });
        event(out, "message_start", vec![("message", message)]);
    }

    fn open(&mut self, out: &mut Vec<u8>, block: Value) -> i64 {
        self.close_block(out);
        let index = self.next_index;
        self.next_index += 1;
        event(out, "content_block_start", vec![("index", json!(index)), ("content_block", block)]);
        index
    }

    fn close_block(&mut self, out: &mut Vec<u8>) {
        if let Some(OpenBlock::Text(index) | OpenBlock::Tool(index)) = self.open_block.take() {
            event(out, "content_block_stop", vec![("index", json!(index))]);
        }
    }

    fn merge_usage(&mut self, mut usage: Usage) {
        usage.normalize_openai_details();
        let current = &mut self.usage;
        current.prompt_tokens = usage.prompt_tokens.or(current.prompt_tokens);
        current.completion_tokens = usage.completion_tokens.or(current.completion_tokens);
        current.cache_read_input_tokens = usage.cache_read_input_tokens.or(current.cache_read_input_tokens);
        current.cache_creation_input_tokens = usage.cache_creation_input_tokens.or(current.cache_creation_input_tokens);
        if let Some(cache) = usage.cache_creation {
            let held = current.cache_creation.get_or_insert_with(Default::default);
            held.ephemeral_5m_input_tokens = cache.ephemeral_5m_input_tokens.or(held.ephemeral_5m_input_tokens);
            held.ephemeral_1h_input_tokens = cache.ephemeral_1h_input_tokens.or(held.ephemeral_1h_input_tokens);
        }
    }

    /// The events one chunk makes, written to `out`.
    pub fn render(&mut self, chunk: ChatChunk, out: &mut Vec<u8>) {
        let reports_usage = chunk.usage.is_some();
        if let Some(usage) = chunk.usage {
            self.merge_usage(usage);
        }
        if !self.started {
            if !chunk.id.is_empty() {
                self.id = message_id(&chunk.id);
            }
            if !chunk.model.is_empty() {
                self.model = chunk.model;
            }
            // an opening chunk with nothing in it (Azure's content-filter results) waits for one that says something,
            // which may name the reply and its model
            if chunk.choices.is_empty() && !reports_usage {
                return;
            }
            self.start(out);
        }
        let Some(choice) = chunk.choices.into_iter().next() else { return };
        if let Some(text) = choice.delta.content.filter(|text| !text.is_empty()) {
            let index = match self.open_block {
                Some(OpenBlock::Text(index)) => index,
                _ => self.open(out, json!({ "type": "text", "text": "" })),
            };
            self.open_block = Some(OpenBlock::Text(index));
            event(out, "content_block_delta", vec![("index", json!(index)), ("delta", json!({ "type": "text_delta", "text": text }))]);
        }
        for call in choice.delta.tool_calls.into_iter().flatten() {
            let (name, args) = call.function.map_or((None, None), |f| (f.name, f.arguments));
            // an empty id, as some servers send on each fragment after the first, is no id
            let id = call.id.filter(|id| !id.is_empty());
            let is_start = match (self.tools.get(&call.index), &id) {
                (None, id) => id.is_some() || name.is_some(),
                // a provider that repeats the call's id on each fragment is still on that call; a new id is a new call
                (Some((_, opened)), Some(id)) => opened.as_ref() != Some(id),
                (Some(_), None) => false,
            };
            if is_start {
                let block = json!({ "type": "tool_use", "id": id.clone().unwrap_or_default(),
                    "name": name.unwrap_or_default(), "input": {} });
                let index = self.open(out, block);
                self.open_block = Some(OpenBlock::Tool(index));
                self.tools.insert(call.index, (index, id));
            }
            // argument fragments (empty on the opening one) as input_json_delta
            if let (Some(args), Some((index, _))) = (args.filter(|args| !args.is_empty()), self.tools.get(&call.index)) {
                let delta = json!({ "type": "input_json_delta", "partial_json": args });
                event(out, "content_block_delta", vec![("index", json!(index)), ("delta", delta)]);
            }
        }
        if let Some(reason) = choice.finish_reason {
            self.stop_reason = Some(stop_reason(&reason));
        }
    }

    /// The events that end the reply: the open block's stop, `message_delta` and `message_stop`.
    pub fn finish(&mut self, out: &mut Vec<u8>) {
        self.start(out);
        self.close_block(out);
        let delta = json!({ "stop_reason": self.stop_reason.unwrap_or("end_turn"), "stop_sequence": Value::Null });
        event(out, "message_delta", vec![("delta", delta), ("usage", required_usage(self.usage.clone()))]);
        event(out, "message_stop", vec![]);
    }

    /// An `error` event, as Anthropic ends a stream that failed part way: nothing follows it.
    pub fn error(out: &mut Vec<u8>, message: &str) {
        event(out, "error", vec![("error", json!({ "type": "api_error", "message": message }))]);
    }
}
