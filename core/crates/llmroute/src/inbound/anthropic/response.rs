//! The IR's whole reply rendered as an Anthropic message: text and `tool_use` blocks under the provider's call ids,
//! `finish_reason` as `stop_reason`, the model the provider named, and the usage it reported.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: usage is always there, with zeros for the counts a provider left out.

use super::{message_id, required_usage, stop_reason};
use crate::ir::ChatResponse;
use serde_json::{json, Value};

pub fn render_chat_response(resp: ChatResponse) -> Value {
    let choice = resp.choices.into_iter().next();
    let mut blocks: Vec<Value> = Vec::new();
    if let Some(c) = &choice {
        if let Some(text) = c.message.text().filter(|text| !text.is_empty()) {
            blocks.push(json!({ "type": "text", "text": text }));
        }
        for call in c.message.tool_calls.iter().flatten() {
            // arguments that are not JSON can't be an `input`: the call goes out with none rather than not at all
            let input: Value = serde_json::from_str(&call.function.arguments).unwrap_or_else(|_| json!({}));
            blocks.push(json!({ "type": "tool_use", "id": call.id, "name": call.function.name, "input": input }));
        }
    }
    json!({
        "id": message_id(&resp.id),
        "type": "message",
        "role": "assistant",
        "model": resp.model,
        "content": blocks,
        "stop_reason": stop_reason(choice.as_ref().and_then(|c| c.finish_reason.as_deref()).unwrap_or("stop")),
        "stop_sequence": Value::Null,
        "usage": required_usage(resp.usage.unwrap_or_default()),
    })
}
