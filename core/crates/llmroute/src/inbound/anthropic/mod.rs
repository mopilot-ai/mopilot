//! The Anthropic Messages wire as an inbound: its request read into the IR (`request`), the IR's reply rendered as an
//! Anthropic message (`response`), and flat IR chunks rendered as Anthropic's stateful event stream (`stream`).
//!
//! Ported from Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: split by direction, rewritten for Rust 2021, and the reply's usage always
//! carries the counts Anthropic's SDK requires.
//!
//! The model's thinking never crosses: a request's `thinking` setting and the thinking blocks of earlier turns are
//! dropped, and nothing in a reply is rendered as a thinking block.

mod request;
mod response;
mod stream;

pub use request::parse_chat;
pub use response::render_chat_response;
pub use stream::StreamRenderer;

use crate::ir::Usage;
use serde_json::{json, Value};

/// OpenAI's `finish_reason` as Anthropic's `stop_reason`. A provider's content filter is Anthropic's `refusal`.
fn stop_reason(finish_reason: &str) -> &'static str {
    match finish_reason {
        "tool_calls" | "function_call" => "tool_use",
        "length" => "max_tokens",
        "content_filter" => "refusal",
        _ => "end_turn",
    }
}

/// A completion id as an Anthropic-style `msg_` id, with the prefix exactly once.
fn message_id(id: &str) -> String {
    let id = id.trim_start_matches("chatcmpl-");
    if id.starts_with("msg_") {
        id.to_string()
    } else {
        format!("msg_{id}")
    }
}

/// IR usage in Anthropic's names, with only the counts the provider reported.
fn anthropic_usage(mut usage: Usage) -> Value {
    usage.normalize_openai_details();
    let mut value = json!({});
    for (key, count) in [
        ("input_tokens", usage.prompt_tokens),
        ("output_tokens", usage.completion_tokens),
        ("cache_read_input_tokens", usage.cache_read_input_tokens),
        ("cache_creation_input_tokens", usage.cache_creation_input_tokens),
    ] {
        if let Some(count) = count {
            value[key] = json!(count);
        }
    }
    if let Some(cache) = usage.cache_creation {
        value["cache_creation"] = json!(cache);
    }
    value
}

/// [`anthropic_usage`] with `input_tokens` and `output_tokens` there, zero when the provider said nothing: Anthropic's
/// SDK reads both from every message and every `message_delta`.
fn required_usage(usage: Usage) -> Value {
    let mut value = anthropic_usage(usage);
    for key in ["input_tokens", "output_tokens"] {
        if value.get(key).is_none() {
            value[key] = json!(0);
        }
    }
    value
}

#[cfg(test)]
mod tests_request;
#[cfg(test)]
mod tests_response;
#[cfg(test)]
mod tests_stream;
