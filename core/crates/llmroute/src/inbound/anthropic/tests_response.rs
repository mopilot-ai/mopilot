//! The IR's whole reply rendered as an Anthropic message: blocks, ids, stop reasons and usage.
//!
//! Ported from the tests of Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: the usage that is always there and every stop reason are tested.

use super::{anthropic_usage, message_id, render_chat_response, stop_reason};
use crate::ir::{ChatResponse, Usage};
use serde_json::{json, Value};

fn reply(value: Value) -> Value {
    render_chat_response(serde_json::from_value::<ChatResponse>(value).unwrap())
}

#[test]
fn a_text_reply_renders_as_one_text_block_with_its_usage() {
    let v = reply(json!({
        "id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-4o-mini-2024-07-18",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": "Here is the translation." }, "finish_reason": "stop" }],
        "usage": { "prompt_tokens": 531, "completion_tokens": 42, "total_tokens": 573 }
    }));
    assert_eq!(
        v,
        json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "gpt-4o-mini-2024-07-18",
            "content": [{ "type": "text", "text": "Here is the translation." }],
            "stop_reason": "end_turn", "stop_sequence": null,
            "usage": { "input_tokens": 531, "output_tokens": 42 }
        })
    );
}

#[test]
fn a_tool_call_reply_renders_as_tool_use_under_the_providers_call_id() {
    let v = reply(json!({
        "id": "chatcmpl-2", "model": "m",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": null, "tool_calls": [
            { "id": "call_9", "type": "function", "function": { "name": "translate_text", "arguments": "{\"text\":\"hi\",\"target_language\":\"hi\"}" } },
            { "id": "call_10", "type": "function", "function": { "name": "broken", "arguments": "{\"text\":" } }
        ]}, "finish_reason": "tool_calls" }]
    }));
    assert_eq!(v["stop_reason"], "tool_use");
    assert_eq!(
        v["content"][0],
        json!({ "type": "tool_use", "id": "call_9", "name": "translate_text", "input": { "text": "hi", "target_language": "hi" } })
    );
    assert_eq!(v["content"][1]["input"], json!({}), "arguments that are not JSON go out as no input");
    assert_eq!(v["usage"], json!({ "input_tokens": 0, "output_tokens": 0 }), "the SDK reads both counts from every message");
}

#[test]
fn a_reply_without_choices_or_text_has_no_blocks_and_ends_its_turn() {
    assert_eq!(reply(json!({ "choices": [] }))["content"], json!([]));
    let empty = reply(json!({ "choices": [{ "message": { "role": "assistant", "content": "" } }] }));
    assert_eq!((empty["content"].clone(), empty["stop_reason"].clone()), (json!([]), json!("end_turn")));
}

#[test]
fn every_finish_reason_has_its_stop_reason() {
    for (finish, stop) in [
        ("stop", "end_turn"),
        ("tool_calls", "tool_use"),
        ("function_call", "tool_use"),
        ("length", "max_tokens"),
        ("content_filter", "refusal"),
        ("something_new", "end_turn"),
    ] {
        assert_eq!(stop_reason(finish), stop, "{finish}");
    }
}

#[test]
fn a_reply_id_carries_the_msg_prefix_exactly_once() {
    for (id, expected) in [
        ("chatcmpl-msg_011CghUGgzcD", "msg_011CghUGgzcD"),
        ("msg_011CghUGgzcD", "msg_011CghUGgzcD"),
        ("chatcmpl-abc123", "msg_abc123"),
        ("abc123", "msg_abc123"),
    ] {
        assert_eq!(message_id(id), expected, "{id}");
    }
}

#[test]
fn usage_normalizes_openais_nested_cache_and_keeps_only_what_was_reported() {
    let usage: Usage = serde_json::from_value(json!({ "prompt_tokens": 110, "completion_tokens": 5,
        "prompt_tokens_details": { "cached_tokens": 100 } }))
    .unwrap();
    assert_eq!(anthropic_usage(usage), json!({ "input_tokens": 10, "output_tokens": 5, "cache_read_input_tokens": 100 }));
    assert_eq!(anthropic_usage(Usage::default()), json!({}));
    let written: Usage = serde_json::from_value(json!({ "cache_creation_input_tokens": 300,
        "cache_creation": { "ephemeral_1h_input_tokens": 300 } }))
    .unwrap();
    assert_eq!(
        anthropic_usage(written),
        json!({ "cache_creation_input_tokens": 300, "cache_creation": { "ephemeral_1h_input_tokens": 300 } })
    );
}
