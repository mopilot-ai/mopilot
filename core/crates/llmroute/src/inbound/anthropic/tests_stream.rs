//! Flat IR chunks rendered as Anthropic's event stream: block order and indices, tool fragments, stop reasons and usage.
//!
//! Ported from the tests of Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: events are compared as whole bytes, and the fragments a provider repeats,
//! the model's fallback and the error event are tested.

use super::StreamRenderer;
use crate::ir::ChatChunk;
use serde_json::{json, Value};

fn chunk(value: Value) -> ChatChunk {
    serde_json::from_value(value).unwrap()
}

fn text(text: &str) -> ChatChunk {
    chunk(json!({ "id": "chatcmpl-s", "model": "gpt-4o-2024-08-06", "choices": [{ "index": 0, "delta": { "content": text } }] }))
}

fn tool(index: i64, id: Option<&str>, name: Option<&str>, args: &str) -> ChatChunk {
    let mut call = json!({ "index": index, "function": { "arguments": args } });
    if let Some(id) = id {
        call["id"] = json!(id);
    }
    if let Some(name) = name {
        call["function"]["name"] = json!(name);
    }
    chunk(json!({ "id": "chatcmpl-s", "choices": [{ "delta": { "tool_calls": [call] } }] }))
}

fn finish_reason(reason: &str) -> ChatChunk {
    chunk(json!({ "id": "chatcmpl-s", "choices": [{ "delta": {}, "finish_reason": reason }] }))
}

/// Each event's name and data, in order.
fn events(bytes: &[u8]) -> Vec<(String, Value)> {
    let text = String::from_utf8(bytes.to_vec()).unwrap();
    text.split_terminator("\n\n")
        .map(|frame| {
            let (name, data) = frame.split_once('\n').unwrap();
            (name.strip_prefix("event: ").unwrap().to_string(), serde_json::from_str(data.strip_prefix("data: ").unwrap()).unwrap())
        })
        .collect()
}

fn names(bytes: &[u8]) -> Vec<String> {
    events(bytes).into_iter().map(|(name, _)| name).collect()
}

#[test]
fn text_streams_as_message_start_one_block_and_the_end_with_type_first_in_each_event() {
    let mut r = StreamRenderer::new("gpt-4o");
    let mut out = Vec::new();
    r.render(text("Hel"), &mut out);
    r.render(text("lo"), &mut out);
    r.render(finish_reason("stop"), &mut out);
    r.finish(&mut out);
    let expected = concat!(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_s\",\"type\":\"message\",\"role\":\"assistant\",",
        "\"model\":\"gpt-4o-2024-08-06\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n\n",
        "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel\"}}\n\n",
        "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"lo\"}}\n\n",
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
        "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},",
        "\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}\n\n",
        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    );
    assert_eq!(String::from_utf8(out).unwrap(), expected);
    assert!(r.finished());
}

#[test]
fn a_tool_call_reassembles_into_tool_use_events_after_the_text_before_it() {
    let mut r = StreamRenderer::new("m");
    let mut out = Vec::new();
    r.render(text("Reading."), &mut out);
    r.render(tool(0, Some("call_1"), Some("translate_text"), ""), &mut out);
    r.render(tool(0, None, None, "{\"text\":"), &mut out);
    r.render(tool(0, None, None, "\"hi\"}"), &mut out);
    r.render(finish_reason("tool_calls"), &mut out);
    r.finish(&mut out);
    let events = events(&out);
    let names: Vec<&str> = events.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(
        names,
        [
            "message_start",
            "content_block_start",
            "content_block_delta",
            "content_block_stop",
            "content_block_start",
            "content_block_delta",
            "content_block_delta",
            "content_block_stop",
            "message_delta",
            "message_stop"
        ]
    );
    assert_eq!(
        events[4].1,
        json!({ "type": "content_block_start", "index": 1,
        "content_block": { "type": "tool_use", "id": "call_1", "name": "translate_text", "input": {} } })
    );
    assert_eq!(events[6].1["delta"], json!({ "type": "input_json_delta", "partial_json": "\"hi\"}" }));
    assert_eq!(events[7].1["index"], 1);
    assert_eq!(events[8].1["delta"]["stop_reason"], "tool_use");
}

#[test]
fn a_provider_that_repeats_a_calls_id_stays_on_one_block_and_a_new_id_opens_another() {
    let mut r = StreamRenderer::new("m");
    let mut out = Vec::new();
    r.render(tool(0, Some("call_a"), Some("read"), "{\"p\":"), &mut out);
    r.render(tool(0, Some("call_a"), Some("read"), "1}"), &mut out);
    r.render(tool(0, None, Some("read"), ""), &mut out);
    // two calls a provider streams under one index, each with its own id
    r.render(tool(0, Some("call_b"), Some("write"), "{}"), &mut out);
    r.render(tool(1, None, None, "{\"lost\":1}"), &mut out);
    r.finish(&mut out);
    let events = events(&out);
    let starts: Vec<&Value> =
        events.iter().filter(|(name, _)| name == "content_block_start").map(|(_, data)| &data["content_block"]).collect();
    assert_eq!(starts.iter().map(|block| block["id"].as_str().unwrap()).collect::<Vec<_>>(), ["call_a", "call_b"]);
    let args: Vec<&str> = events.iter().filter_map(|(_, data)| data["delta"]["partial_json"].as_str()).collect();
    assert_eq!(args, ["{\"p\":", "1}", "{}"], "a fragment for a call never opened has no block to go to");
}

#[test]
fn usage_arriving_after_the_text_goes_out_in_message_delta_without_holding_the_text() {
    let mut r = StreamRenderer::new("m");
    let mut out = Vec::new();
    r.render(text("hello"), &mut out);
    assert!(String::from_utf8_lossy(&out).contains("text_delta"), "the text is not held for the usage");
    let usage = json!({ "prompt_tokens": 2, "completion_tokens": 10, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 300,
        "cache_creation": { "ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200 } });
    let last = || chunk(json!({ "id": "x", "choices": [], "usage": usage }));
    r.render(last(), &mut out);
    r.render(last(), &mut out);
    r.render(chunk(json!({ "choices": [], "usage": { "completion_tokens": 0, "cache_creation": {} } })), &mut out);
    let mut end = Vec::new();
    r.finish(&mut end);
    let delta = events(&end).into_iter().find(|(name, _)| name == "message_delta").unwrap().1;
    assert_eq!(
        delta["usage"],
        json!({ "input_tokens": 2, "output_tokens": 0, "cache_read_input_tokens": 1000,
        "cache_creation_input_tokens": 300, "cache_creation": { "ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200 } })
    );
}

#[test]
fn usage_in_the_first_chunk_reaches_message_start_and_openais_cached_tokens_are_uncached_input() {
    let mut r = StreamRenderer::new("m");
    let mut out = Vec::new();
    r.render(chunk(json!({ "id": "chatcmpl-u", "choices": [], "usage": { "prompt_tokens": 110, "prompt_tokens_details": { "cached_tokens": 100 } } })), &mut out);
    let start = events(&out)[0].1["message"]["usage"].clone();
    assert_eq!(start, json!({ "input_tokens": 10, "output_tokens": 0, "cache_read_input_tokens": 100 }));
}

#[test]
fn a_provider_that_names_no_model_or_sends_nothing_is_reported_as_the_configs_model() {
    let mut r = StreamRenderer::new("deepseek-chat");
    let mut out = Vec::new();
    r.render(chunk(json!({ "choices": [{ "delta": { "content": "" } }] })), &mut out);
    assert_eq!(events(&out)[0].1["message"]["model"], "deepseek-chat");
    let mut silent = StreamRenderer::new("deepseek-chat");
    let mut end = Vec::new();
    silent.finish(&mut end);
    assert_eq!(names(&end), ["message_start", "message_delta", "message_stop"]);
    assert!(!silent.finished());
    assert_eq!(events(&end)[1].1["delta"]["stop_reason"], "end_turn");
}

#[test]
fn an_error_event_says_what_failed_in_anthropics_shape() {
    let mut out = Vec::new();
    StreamRenderer::error(&mut out, "overloaded");
    assert_eq!(
        String::from_utf8(out).unwrap(),
        "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"overloaded\"}}\n\n"
    );
}

#[test]
fn an_empty_opening_chunk_waits_for_one_that_names_the_reply_and_its_model() {
    let mut r = StreamRenderer::new("cfg-model");
    let mut out = Vec::new();
    r.render(chunk(json!({ "id": "", "model": "", "choices": [], "prompt_filter_results": [] })), &mut out);
    assert!(out.is_empty(), "nothing to say yet");
    r.render(chunk(json!({ "id": "chatcmpl-az", "model": "gpt-4o-2024-11-20", "choices": [{ "delta": { "content": "Hi" } }] })), &mut out);
    let start = &events(&out)[0].1["message"];
    assert_eq!((start["id"].as_str(), start["model"].as_str()), (Some("msg_az"), Some("gpt-4o-2024-11-20")));
    let mut anonymous = StreamRenderer::new("cfg-model");
    let mut nameless = Vec::new();
    anonymous.render(chunk(json!({ "choices": [{ "delta": { "content": "Hi" } }] })), &mut nameless);
    assert_eq!(events(&nameless)[0].1["message"]["id"], "msg_");
}

#[test]
fn an_empty_id_on_a_later_fragment_is_no_id_and_keeps_the_call_on_its_block() {
    let mut r = StreamRenderer::new("m");
    let mut out = Vec::new();
    r.render(tool(0, Some("call_a"), Some("read"), "{\"p\":"), &mut out);
    r.render(tool(0, Some(""), None, "1}"), &mut out);
    r.finish(&mut out);
    let starts = names(&out).iter().filter(|name| *name == "content_block_start").count();
    assert_eq!(starts, 1);
}
