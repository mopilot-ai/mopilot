//! The chat IR's own rules: what it parses, keeps and normalizes.
//!
//! Ported from the tests of Nasiko's llm-router (`llm-router/src/ir/chat.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: the cache-inclusive cases are left out with the code they tested, and the
//! permissive fields this port added are tested.

use super::chat::*;
use serde_json::{json, Value};

fn usage(value: Value) -> Usage {
    serde_json::from_value(value).unwrap()
}

/// Nasiko's BUG-15: an agent's `"strict": true` reached OpenAI stripped, on every request.
#[test]
fn a_tools_strict_flag_survives_the_round_trip() {
    let tool = json!({"type": "function", "function": {"name": "read_log", "parameters": {"type": "object"}, "strict": true}});
    let parsed: ToolDef = serde_json::from_value(tool).unwrap();
    assert_eq!(parsed.function.strict, Some(true));
    assert_eq!(serde_json::to_value(&parsed).unwrap()["function"]["strict"], json!(true));
}

#[test]
fn a_tool_without_strict_or_a_type_gains_no_strict_field_and_is_a_function() {
    let parsed: ToolDef = serde_json::from_value(json!({"function": {"name": "read_log"}})).unwrap();
    let back = serde_json::to_value(&parsed).unwrap();
    assert!(back["function"].get("strict").is_none());
    assert_eq!(back["type"], "function");
}

#[test]
fn openai_usage_lifts_nested_cached_tokens_into_flat_cache_read() {
    let mut usage = usage(json!({
        "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110,
        "prompt_tokens_details": { "cached_tokens": 64 }
    }));
    assert_eq!(usage.cache_read_input_tokens, None, "nested until normalized");
    usage.normalize_openai_details();
    assert_eq!(usage.cache_read_input_tokens, Some(64));
    assert_eq!(usage.cache_creation_input_tokens, None);
}

#[test]
fn openai_prompt_tokens_become_uncached_only() {
    // A cost that charges input at the full rate and cache reads at the cache rate bills a cache-inclusive prompt count
    // twice: 10k prompt with 8k cached is 2k + 8k, not 10k + 8k.
    let mut usage = usage(json!({
        "prompt_tokens": 10000, "completion_tokens": 500, "total_tokens": 10500,
        "prompt_tokens_details": { "cached_tokens": 8000 }
    }));
    usage.normalize_openai_details();
    assert_eq!(usage.cache_read_input_tokens, Some(8000));
    assert_eq!(usage.prompt_tokens, Some(2000), "prompt_tokens must exclude the cached portion");
}

#[test]
fn normalize_is_idempotent_and_cannot_subtract_twice() {
    let mut usage = usage(json!({ "prompt_tokens": 10000, "prompt_tokens_details": { "cached_tokens": 8000 } }));
    usage.normalize_openai_details();
    usage.normalize_openai_details();
    assert_eq!(usage.prompt_tokens, Some(2000));
    assert_eq!(usage.cache_read_input_tokens, Some(8000));
}

#[test]
fn anthropic_shape_prompt_tokens_are_left_alone() {
    // Anthropic's `input_tokens` already excludes cache reads, and it never sends the nested block.
    let mut usage = Usage { prompt_tokens: Some(2000), cache_read_input_tokens: Some(8000), ..Default::default() };
    usage.normalize_openai_details();
    assert_eq!(usage.prompt_tokens, Some(2000));
    assert_eq!(usage.cache_read_input_tokens, Some(8000));
}

#[test]
fn cached_larger_than_prompt_clamps_to_zero() {
    // a negative count would read as a credit against the bill
    let mut usage = usage(json!({ "prompt_tokens": 100, "prompt_tokens_details": { "cached_tokens": 640 } }));
    usage.normalize_openai_details();
    assert_eq!(usage.prompt_tokens, Some(0));
}

#[test]
fn a_nested_block_without_a_count_or_without_a_prompt_count_lifts_what_there_is() {
    let mut empty = usage(json!({ "prompt_tokens": 100, "prompt_tokens_details": {} }));
    empty.normalize_openai_details();
    assert_eq!((empty.prompt_tokens, empty.cache_read_input_tokens), (Some(100), None));
    let mut no_prompt = usage(json!({ "prompt_tokens_details": { "cached_tokens": 5 } }));
    no_prompt.normalize_openai_details();
    assert_eq!((no_prompt.prompt_tokens, no_prompt.cache_read_input_tokens), (None, Some(5)));
}

#[test]
fn normalize_keeps_explicit_flat_cache_read_over_nested() {
    let mut usage = Usage {
        cache_read_input_tokens: Some(42),
        prompt_tokens_details: Some(PromptTokensDetails { cached_tokens: Some(999) }),
        ..Default::default()
    };
    usage.normalize_openai_details();
    assert_eq!(usage.cache_read_input_tokens, Some(42));
}

#[test]
fn parses_openai_request_with_tools_and_preserves_unknown_fields() {
    let req: ChatRequest = serde_json::from_value(json!({
        "model": "gpt-4o",
        "messages": [{ "role": "system", "content": "You are helpful." }, { "role": "user", "content": "hi" }],
        "tools": [{ "type": "function", "function": { "name": "translate_text", "description": "Translate text",
            "parameters": { "type": "object", "properties": { "text": { "type": "string" } } } } }],
        "tool_choice": "auto", "temperature": 0.1, "max_tokens": 4000, "top_p": 0.9, "frequency_penalty": 0.5
    }))
    .unwrap();
    assert_eq!(req.model.as_deref(), Some("gpt-4o"));
    assert_eq!(req.messages.len(), 2);
    assert_eq!(req.tools.as_ref().unwrap()[0].function.name, "translate_text");
    assert_eq!(req.temperature, Some(0.1));
    assert!(!req.is_streaming());
    let back = serde_json::to_value(&req).unwrap();
    assert_eq!(back["top_p"], json!(0.9));
    assert_eq!(back["frequency_penalty"], json!(0.5));
}

#[test]
fn parses_tool_result_and_assistant_tool_calls() {
    let req: ChatRequest = serde_json::from_value(json!({
        "messages": [
            { "role": "user", "content": "translate" },
            { "role": "assistant", "content": null, "tool_calls": [{ "id": "call_abc", "type": "function",
                "function": { "name": "translate_text", "arguments": "{\"text\":\"hi\"}" } }] },
            { "role": "tool", "tool_call_id": "call_abc", "content": "नमस्ते" }
        ],
        "stream": true
    }))
    .unwrap();
    assert!(req.is_streaming());
    let call = &req.messages[1].tool_calls.as_ref().unwrap()[0];
    assert_eq!((call.id.as_str(), call.function.name.as_str()), ("call_abc", "translate_text"));
    assert_eq!(call.function.arguments, "{\"text\":\"hi\"}");
    assert_eq!(req.messages[2].tool_call_id.as_deref(), Some("call_abc"));
    assert_eq!(req.messages[2].text().as_deref(), Some("नमस्ते"));
}

#[test]
fn message_text_handles_string_array_and_null() {
    let message = |content: Value| -> Message { serde_json::from_value(json!({ "role": "user", "content": content })).unwrap() };
    assert_eq!(message(json!("hello")).text().as_deref(), Some("hello"));
    assert_eq!(message(json!([{"type":"text","text":"foo"},{"type":"text","text":"bar"}])).text().as_deref(), Some("foobar"));
    assert_eq!(message(json!([{"type":"image_url","image_url":{"url":"https://e.com/c.png"}}])).text(), None);
    assert_eq!(message(json!(null)).text(), None);
}

#[test]
fn cache_markers_on_parts_and_tool_calls_are_found_and_stripped() {
    let mut message: Message = serde_json::from_value(json!({
        "role": "assistant",
        "content": [{ "type": "text", "text": "a", "cache_control": { "type": "ephemeral" } }, "not an object"],
        "tool_calls": [{ "id": "c", "function": { "name": "f", "arguments": "{}" }, "cache_control": { "type": "ephemeral" } }]
    }))
    .unwrap();
    assert!(message.has_cache_markers());
    message.strip_cache_markers();
    assert!(!message.has_cache_markers());
    assert_eq!(message.content, Some(json!([{ "type": "text", "text": "a" }, "not an object"])));

    let call_only: Message = serde_json::from_value(json!({ "role": "assistant", "content": "x",
        "tool_calls": [{ "id": "c", "function": { "name": "f", "arguments": "{}" }, "cache_control": {} }] }))
    .unwrap();
    assert!(call_only.has_cache_markers());
    let mut plain: Message = serde_json::from_value(json!({ "role": "user", "content": "x" })).unwrap();
    assert!(!plain.has_cache_markers());
    plain.strip_cache_markers();
    assert_eq!(plain.content, Some(json!("x")));
}

#[test]
fn a_reply_or_chunk_without_an_id_model_or_index_still_parses() {
    let reply: ChatResponse =
        serde_json::from_value(json!({ "choices": [{ "message": { "role": "assistant", "content": "hi" } }] })).unwrap();
    assert_eq!((reply.id.as_str(), reply.model.as_str(), reply.choices[0].index), ("", "", 0));
    let chunk: ChatChunk = serde_json::from_value(json!({ "choices": [{ "delta": { "tool_calls": [{ "function": {} }] } }],
        "object": "chat.completion.chunk" }))
    .unwrap();
    assert_eq!((chunk.id.as_str(), chunk.choices[0].index), ("", 0));
    assert_eq!(chunk.choices[0].delta.tool_calls.as_ref().unwrap()[0].index, 0);
    assert_eq!(chunk.extra["object"], "chat.completion.chunk");
}
