//! The OpenAI Chat Completions spoke: the body it sends, the media it fixes or refuses, the cache key, and the reply it
//! reads back.
//!
//! Ported from the tests of Nasiko's llm-router (`llm-router/src/providers/openai.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: the bodies are checked as they are built instead of at a mock server,
//! and a reply keeps the model the provider named.

use super::openai::{chunk, request_body, response, routes_by_cache_key, stream_error};
use crate::config::Config;
use crate::inbound::anthropic::parse_chat;
use crate::ir::ChatRequest;
use base64::Engine;
use serde_json::{json, Value};

fn config(extra: Value) -> Config {
    let mut value = json!({ "provider": "openai", "model": "gpt-4o-mini" });
    value.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    Config::from_value(value).unwrap()
}

fn request(value: Value) -> ChatRequest {
    serde_json::from_value(value).unwrap()
}

fn body(req: &ChatRequest, cfg: &Config, stream: bool) -> Value {
    serde_json::from_slice(&request_body(req, cfg, stream).unwrap()).unwrap()
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn ask_with(part: Value) -> ChatRequest {
    request(json!({ "messages": [{ "role": "user", "content": [{ "type": "text", "text": "what does it say?" }, part] }] }))
}

#[test]
fn the_configs_model_and_caps_win_and_a_request_without_them_keeps_its_own() {
    let req = request(
        json!({ "model": "claude-sonnet-5-5", "messages": [{ "role": "user", "content": "hi" }], "temperature": 0.9, "max_tokens": 256 }),
    );
    assert_eq!(
        body(&req, &config(json!({ "temperature": 0.2, "maxTokens": 128 })), false),
        json!({ "model": "gpt-4o-mini", "messages": [{ "role": "user", "content": "hi" }], "temperature": 0.2, "stream": false, "max_completion_tokens": 128 })
    );
    assert_eq!(body(&req, &config(json!({})), false)["max_completion_tokens"], 256);
    assert_eq!(body(&req, &config(json!({})), false)["temperature"], 0.9);
    let bare = body(&request(json!({ "messages": [] })), &config(json!({})), false);
    assert_eq!((bare.get("max_completion_tokens"), bare.get("temperature")), (None, None));
}

#[test]
fn a_stream_asks_for_usage_and_the_body_keeps_the_callers_key_order() {
    let req = request(json!({ "messages": [{ "role": "user", "content": "hi" }], "top_p": 0.5,
        "tools": [{ "type": "function", "function": { "name": "f", "parameters": { "type": "object",
            "properties": { "zeta": { "type": "string" }, "alpha": { "type": "string" } } } } }],
        "tool_choice": "auto" }));
    let sent = String::from_utf8(request_body(&req, &config(json!({})), true).unwrap()).unwrap();
    assert_eq!(
        sent,
        concat!(
            r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"f","#,
            r#""parameters":{"type":"object","properties":{"zeta":{"type":"string"},"alpha":{"type":"string"}}}}}],"tool_choice":"auto","#,
            r#""stream":true,"top_p":0.5,"stream_options":{"include_usage":true}}"#
        )
    );
}

#[test]
fn an_anthropic_agents_cache_markers_never_reach_openai() {
    let ephemeral = json!({ "type": "ephemeral" });
    let req = parse_chat(json!({
        "model": "claude-sonnet-4-5", "max_tokens": 1024,
        "system": [{ "type": "text", "text": "You are a coding agent.", "cache_control": ephemeral }],
        "tools": [{ "name": "read", "input_schema": { "type": "object" }, "cache_control": ephemeral }, { "name": "plain" }],
        "messages": [
            { "role": "user", "content": "Fix the test." },
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_1", "name": "read", "input": {}, "cache_control": ephemeral }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "fn main() {}", "cache_control": ephemeral }] }
        ]
    }))
    .unwrap();
    for strict in [true, false] {
        let sent = String::from_utf8(request_body(&req, &config(json!({ "strictMedia": strict })), false).unwrap()).unwrap();
        assert!(!sent.contains("cache_control"), "{sent}");
        assert!(sent.contains("You are a coding agent."), "{sent}");
    }
}

#[test]
fn a_text_document_reaches_openai_as_a_text_part_and_a_pdf_as_its_file() {
    let req = ask_with(
        json!({ "type": "file", "file": { "file_data": format!("data:text/csv;base64,{}", b64(b"region,q2\nEMEA,913")), "filename": "data.csv" } }),
    );
    assert_eq!(
        body(&req, &config(json!({})), false)["messages"][0]["content"][1],
        json!({ "type": "text", "text": "File: data.csv\n\nregion,q2\nEMEA,913" })
    );
    let pdf = json!({ "type": "file", "file": { "file_data": "data:application/pdf;base64,JVBERi0xLjQK", "filename": "q3.pdf" } });
    assert_eq!(body(&ask_with(pdf.clone()), &config(json!({})), false)["messages"][0]["content"][1], pdf);
    let anthropic = parse_chat(json!({ "messages": [{ "role": "user", "content": [
        { "type": "document", "title": "sales.csv", "source": { "type": "text", "data": "region,q2\nEMEA,913" } }] }] }))
    .unwrap();
    let sent = body(&anthropic, &config(json!({})), false);
    assert_eq!(sent["messages"][0]["content"], json!([{ "type": "text", "text": "File: sales.csv\n\nregion,q2\nEMEA,913" }]));
}

#[test]
fn a_file_or_image_openai_cannot_read_is_refused_by_name_before_sending() {
    for (part, named) in [
        (
            json!({ "type": "file", "file": { "file_data": "data:application/msword;base64,0M8R4A==", "filename": "r.doc" } }),
            "'application/msword' files",
        ),
        (json!({ "type": "image_url", "image_url": { "url": "data:image/tiff;base64,SUkqAA==" } }), "'image/tiff' images"),
        (json!({ "type": "file", "file": { "file_data": format!("data:text/plain;base64,{}", b64(&[0xff])) } }), "not UTF-8"),
    ] {
        let refusal = request_body(&ask_with(part), &config(json!({})), false).unwrap_err();
        assert!(refusal.starts_with("OpenAI does not accept this input"), "{refusal}");
        assert!(refusal.contains(named), "{refusal}");
    }
    let big = format!("data:application/pdf;base64,{}", "A".repeat(68_000_000));
    let refusal = request_body(&ask_with(json!({ "type": "file", "file": { "file_data": big } })), &config(json!({})), false).unwrap_err();
    assert_eq!(refusal, "OpenAI does not accept this input: more than 50 MB of files in one request");
}

#[test]
fn an_image_openai_reads_goes_as_it_is_or_with_its_media_type_normalized() {
    for (url, sent) in [
        ("data:image/png;base64,AAAA", "data:image/png;base64,AAAA"),
        ("data:Image/PNG;base64,AAAA", "data:image/png;base64,AAAA"),
        ("https://e.com/c.tiff", "https://e.com/c.tiff"),
    ] {
        let req = ask_with(json!({ "type": "image_url", "image_url": { "url": url, "detail": "low" } }));
        assert_eq!(
            body(&req, &config(json!({})), false)["messages"][0]["content"][1]["image_url"],
            json!({ "url": sent, "detail": "low" })
        );
    }
    // a part the grammar can't read and a file by URL pass through: the provider decides
    let odd = json!({ "type": "hologram" });
    assert_eq!(body(&ask_with(odd.clone()), &config(json!({})), false)["messages"][0]["content"][1], odd);
}

#[test]
fn a_document_given_by_url_is_refused_unless_the_endpoint_takes_one() {
    for url in ["https://e.com/q3.pdf", "http://e.com/q3.pdf"] {
        let req = ask_with(json!({ "type": "file", "file": { "file_data": url, "filename": "q3.pdf" } }));
        let refusal = request_body(&req, &config(json!({})), false).unwrap_err();
        assert!(refusal.contains("a document given by URL"), "{refusal}");
        let lenient = body(&req, &config(json!({ "refuseDocumentUrls": false })), false);
        assert_eq!(lenient["messages"][0]["content"][1]["file"]["file_data"], url);
    }
    let inline = ask_with(json!({ "type": "file", "file": { "file_data": "data:application/pdf;base64,JVBE" } }));
    assert!(request_body(&inline, &config(json!({})), false).is_ok());
}

fn tool_call(id: &str) -> Value {
    json!({ "id": id, "type": "function", "function": { "name": "read_file", "arguments": "{}" } })
}

fn image(data: &str) -> Value {
    json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{data}") } })
}

#[test]
fn images_in_tool_results_follow_the_tool_run_as_one_user_message() {
    let req = request(json!({ "messages": [
        { "role": "user", "content": "compare the two files" },
        { "role": "assistant", "tool_calls": [tool_call("c1"), tool_call("c2")] },
        { "role": "tool", "tool_call_id": "c1", "content": [{ "type": "text", "text": "first" }, image("AAAA")] },
        { "role": "tool", "tool_call_id": "c2", "content": [image("BBBB"), image("CCCC")] },
        { "role": "tool", "tool_call_id": "c3", "content": "plain" },
        { "role": "user", "content": "go on" }
    ]}));
    assert_eq!(
        body(&req, &config(json!({})), false)["messages"],
        json!([
            { "role": "user", "content": "compare the two files" },
            { "role": "assistant", "tool_calls": [tool_call("c1"), tool_call("c2")] },
            { "role": "tool", "tool_call_id": "c1", "content": [{ "type": "text", "text": "first" }] },
            { "role": "tool", "tool_call_id": "c2", "content": [{ "type": "text", "text": "The tool returned images or files; they are in the next message." }] },
            { "role": "tool", "tool_call_id": "c3", "content": "plain" },
            { "role": "user", "content": [{ "type": "text", "text": "Images and files from the tool results above:" }, image("AAAA"), image("BBBB"), image("CCCC")] },
            { "role": "user", "content": "go on" }
        ])
    );
}

#[test]
fn a_tool_run_without_images_and_any_media_on_a_lenient_endpoint_are_sent_unchanged() {
    let messages = json!([
        { "role": "user", "content": "hi" },
        { "role": "assistant", "tool_calls": [tool_call("c1")] },
        { "role": "tool", "tool_call_id": "c1", "content": [{ "type": "text", "text": "plain result" }] }
    ]);
    assert_eq!(body(&request(json!({ "messages": messages })), &config(json!({})), false)["messages"], messages);
    let media = json!([{ "role": "tool", "tool_call_id": "c1", "content": [image("AAAA")] },
        { "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/tiff;base64,SUkqAA==" } }] }]);
    assert_eq!(body(&request(json!({ "messages": media })), &config(json!({ "strictMedia": false })), false)["messages"], media);
}

#[test]
fn openai_models_before_gpt_5_6_route_by_the_cache_key() {
    for model in [
        "gpt-4o",
        "gpt-4o-mini",
        "chatgpt-4o-latest",
        "gpt-4.1-mini",
        "gpt-5",
        "gpt-5.5",
        "gpt-5.5-pro",
        "o3",
        "o4-mini",
        "ft:gpt-4.1-mini:acme::abc123",
    ] {
        assert!(routes_by_cache_key(model), "{model}");
    }
    for model in ["gpt-5.6", "gpt-5.10", "gpt-6", "gpt-x", "omni-moderation-latest", "text-embedding-3-small"] {
        assert!(!routes_by_cache_key(model), "{model}");
    }
}

#[test]
fn the_configs_cache_key_goes_to_a_model_that_routes_by_one_unless_the_caller_set_its_own() {
    let req = request(json!({ "messages": [] }));
    let key = |cfg: Value| body(&req, &config(cfg), false).get("prompt_cache_key").cloned();
    assert_eq!(key(json!({ "cacheKey": "chat-7" })), Some(json!("chat-7")));
    assert_eq!(key(json!({ "cacheKey": "chat-7", "model": "gpt-5.6" })), None);
    assert_eq!(key(json!({ "cacheKey": "" })), None);
    assert_eq!(key(json!({})), None);
    let own = request(json!({ "messages": [], "prompt_cache_key": "user-7" }));
    assert_eq!(body(&own, &config(json!({ "cacheKey": "chat-7" })), false)["prompt_cache_key"], "user-7");
}

#[test]
fn a_reply_keeps_the_model_the_provider_named_or_takes_the_configs() {
    let cfg = config(json!({}));
    let named = response(br#"{"id":"c","model":"gpt-4o-mini-2024-07-18","choices":[]}"#, &cfg).unwrap();
    assert_eq!(named.model, "gpt-4o-mini-2024-07-18");
    assert_eq!(response(br#"{"choices":[]}"#, &cfg).unwrap().model, "gpt-4o-mini");
    assert!(response(b"<html>bad gateway</html>", &cfg).unwrap_err().starts_with("the provider's reply is not a chat completion"));
}

#[test]
fn a_chunk_is_read_or_skipped_and_a_streamed_error_says_what_failed() {
    assert_eq!(chunk(r#"{"id":"x","choices":[{"delta":{"content":"Hel"}}]}"#).unwrap().choices[0].delta.content.as_deref(), Some("Hel"));
    assert!(chunk("keep-alive").is_none());
    assert_eq!(stream_error(r#"{"error":{"message":"Rate limited","code":429}}"#).as_deref(), Some("Rate limited"));
    assert_eq!(stream_error(r#"{"error":"boom"}"#).as_deref(), Some("\"boom\""));
    assert_eq!(stream_error(r#"{"choices":[]}"#), None);
    assert_eq!(stream_error(r#"{"choices":[],"error":null}"#), None);
    let bare = chunk(r#"{"choices":[{"index":0,"finish_reason":"tool_calls"}]}"#).unwrap();
    assert_eq!(bare.choices[0].finish_reason.as_deref(), Some("tool_calls"), "a choice without a delta still says why it stopped");
    assert!(chunk("{}").unwrap().choices.is_empty());
    assert_eq!(stream_error("not json"), None);
}

#[test]
fn an_opaque_tool_id_with_quotes_and_newlines_reaches_openai_exactly_as_the_caller_named_it() {
    let id = "toolu_\"q\"\n\\x/é";
    let req = parse_chat(json!({ "messages": [
        { "role": "assistant", "content": [{ "type": "tool_use", "id": id, "name": "f", "input": { "k": "\"v\"" } }] },
        { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "content": "done" }] }
    ]}))
    .unwrap();
    let sent = body(&req, &config(json!({})), false);
    assert_eq!(sent["messages"][0]["tool_calls"][0]["id"], id);
    assert_eq!(sent["messages"][0]["tool_calls"][0]["function"]["arguments"], r#"{"k":"\"v\""}"#);
    assert_eq!(sent["messages"][1]["tool_call_id"], id);
}
