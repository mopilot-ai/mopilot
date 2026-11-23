//! An Anthropic request read into the IR: system, tools, tool ids, cache markers, media, documents and refusals.
//!
//! Ported from the tests of Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: errors are messages, and thinking, every `tool_choice` and every content
//! shape this port reads are tested.

use super::parse_chat;
use crate::ir::{ChatRequest, CACHE_CONTROL};
use base64::Engine;
use serde_json::{json, Value};

fn user_turn(blocks: Value) -> Result<ChatRequest, String> {
    parse_chat(json!({ "model": "claude-haiku-5-5", "max_tokens": 64, "messages": [{ "role": "user", "content": blocks }] }))
}

fn parts_of(req: &ChatRequest, index: usize) -> Vec<Value> {
    req.messages[index].content.as_ref().unwrap().as_array().unwrap().clone()
}

fn ir(req: &ChatRequest) -> Value {
    serde_json::to_value(req).unwrap()
}

#[test]
fn parse_extracts_system_and_translates_tools() {
    let req = parse_chat(json!({
        "model": "claude-3-5-sonnet-20241022", "max_tokens": 1024, "temperature": 0.1, "stream": true,
        "system": "You are a Translation agent.",
        "messages": [{ "role": "user", "content": "translate to hindi: my name is csg" }],
        "tools": [{ "name": "translate_text", "description": "Translate plain text",
            "input_schema": { "type": "object", "properties": { "text": { "type": "string" } } } }],
        "tool_choice": { "type": "auto" }
    }))
    .unwrap();
    assert_eq!(req.messages.len(), 2);
    assert_eq!((req.messages[0].role.as_str(), req.messages[0].text().as_deref()), ("system", Some("You are a Translation agent.")));
    assert_eq!(req.messages[1].role, "user");
    assert_eq!((req.max_tokens, req.temperature, req.is_streaming()), (Some(1024), Some(0.1), true));
    let tool = &req.tools.as_ref().unwrap()[0];
    assert_eq!(tool.function.name, "translate_text");
    assert_eq!(tool.function.parameters.as_ref().unwrap()["properties"]["text"]["type"], "string");
    assert_eq!(req.tool_choice, Some(json!("auto")));
}

#[test]
fn tool_use_and_tool_result_keep_their_ids_as_tool_calls_and_tool_messages() {
    let req = parse_chat(json!({ "model": "m", "max_tokens": 1024, "messages": [
        { "role": "user", "content": "translate to hindi: my name is csg" },
        { "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_01", "name": "translate_text",
            "input": { "text": "my name is csg", "target_language": "hi" } }] },
        { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_01", "content": "मेरा नाम csg है" }] }
    ]}))
    .unwrap();
    assert_eq!(req.messages.len(), 3);
    let assistant = &req.messages[1];
    assert!(assistant.text().is_none(), "a turn that only calls tools has no text");
    let call = &assistant.tool_calls.as_ref().unwrap()[0];
    assert_eq!((call.id.as_str(), call.function.name.as_str()), ("toolu_01", "translate_text"));
    let args: Value = serde_json::from_str(&call.function.arguments).unwrap();
    assert_eq!(args["target_language"], "hi");
    assert_eq!(req.messages[2].role, "tool");
    assert_eq!(req.messages[2].tool_call_id.as_deref(), Some("toolu_01"));
    assert_eq!(req.messages[2].text().as_deref(), Some("मेरा नाम csg है"));
}

#[test]
fn an_assistant_turn_with_text_and_a_call_keeps_both_and_a_call_without_input_has_empty_arguments() {
    let req = parse_chat(json!({ "messages": [{ "role": "assistant", "content": [
        { "type": "text", "text": "Reading it." }, { "type": "tool_use", "id": "t", "name": "read" }
    ]}]}))
    .unwrap();
    assert_eq!(req.messages[0].text().as_deref(), Some("Reading it."));
    assert_eq!(req.messages[0].tool_calls.as_ref().unwrap()[0].function.arguments, "{}");
    let shapes = parse_chat(json!({ "messages": [
        { "role": "assistant", "content": "plain" }, { "role": "assistant" }, { "role": "assistant", "content": [] },
        { "role": "developer", "content": [{ "type": "text", "text": "a" }, { "type": "text", "text": "b" }] },
        { "content": "no role is a user" }
    ]}))
    .unwrap();
    let texts: Vec<_> = shapes.messages.iter().map(|m| (m.role.as_str(), m.text())).collect();
    assert_eq!(
        texts,
        [
            ("assistant", Some("plain".into())),
            ("assistant", Some(String::new())),
            ("assistant", Some(String::new())),
            ("developer", Some("a\nb".into())),
            ("user", Some("no role is a user".into()))
        ]
    );
}

#[test]
fn thinking_is_dropped_from_the_request_and_from_earlier_turns_never_made_into_text() {
    let req = parse_chat(json!({
        "model": "m", "max_tokens": 64, "thinking": { "type": "enabled", "budget_tokens": 1024 },
        "messages": [
            { "role": "user", "content": "why?" },
            { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "the user wants a reason", "signature": "sig" },
                { "type": "redacted_thinking", "data": "opaque" },
                { "type": "text", "text": "Because." }
            ]}
        ]
    }))
    .unwrap();
    let ir = ir(&req);
    assert_eq!(ir["messages"][1], json!({ "role": "assistant", "content": "Because." }));
    assert_eq!(ir.get("thinking"), None);
    assert!(!ir.to_string().contains("the user wants a reason"));
}

#[test]
fn every_tool_choice_maps_to_openais_and_an_unknown_one_is_left_out() {
    let choice = |tool_choice: Value| parse_chat(json!({ "messages": [], "tool_choice": tool_choice })).unwrap().tool_choice;
    assert_eq!(choice(json!({ "type": "auto" })), Some(json!("auto")));
    assert_eq!(choice(json!({ "type": "any" })), Some(json!("required")));
    assert_eq!(choice(json!({ "type": "none" })), Some(json!("none")));
    assert_eq!(choice(json!({ "type": "tool", "name": "f" })), Some(json!({ "type": "function", "function": { "name": "f" } })));
    assert_eq!(choice(json!({ "type": "tool" })), None);
    assert_eq!(choice(json!({ "type": "later" })), None);
}

#[test]
fn a_tool_without_a_description_or_schema_is_still_a_function() {
    let req = parse_chat(json!({ "messages": [], "tools": [{ "name": "ping" }, {}] })).unwrap();
    let tools = ir(&req)["tools"].clone();
    assert_eq!(tools, json!([{ "type": "function", "function": { "name": "ping" } }, { "type": "function", "function": { "name": "" } }]));
}

#[test]
fn cache_markers_stay_on_content_parts_where_openrouter_reads_them() {
    let ephemeral = json!({ "type": "ephemeral" });
    let req = parse_chat(json!({
        "model": "claude-sonnet-4-5", "max_tokens": 1024,
        "system": [{ "type": "text", "text": "You are a coding agent." }, { "type": "text", "text": "Repository map.", "cache_control": ephemeral }],
        "tools": [{ "name": "read", "input_schema": { "type": "object" }, "cache_control": ephemeral }],
        "messages": [
            { "role": "user", "content": "Fix the test." },
            { "role": "assistant", "content": [{ "type": "tool_use", "id": "toolu_1", "name": "read", "input": {}, "cache_control": ephemeral }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "fn main() {}", "cache_control": ephemeral }] },
            { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_2", "content": [
                { "type": "text", "text": "one", "cache_control": ephemeral }, { "type": "text", "text": "two" }] }] },
            { "role": "assistant", "content": [{ "type": "text", "text": "Done.", "cache_control": ephemeral }] },
            { "role": "user", "content": [{ "type": "text", "text": "Thanks.", "cache_control": ephemeral }] }
        ]
    }))
    .unwrap();
    let ir = ir(&req);
    assert_eq!(
        ir["messages"][0]["content"],
        json!([
            { "type": "text", "text": "You are a coding agent." }, { "type": "text", "text": "Repository map.", "cache_control": ephemeral }
        ])
    );
    assert_eq!(ir["tools"][0][CACHE_CONTROL], ephemeral);
    assert_eq!(ir["messages"][2]["tool_calls"][0][CACHE_CONTROL], ephemeral);
    assert_eq!(ir["messages"][3]["content"], json!([{ "type": "text", "text": "fn main() {}", "cache_control": ephemeral }]));
    // a result keeps one marker, the last inside it, at its end
    assert_eq!(
        ir["messages"][4]["content"],
        json!([
            { "type": "text", "text": "one" }, { "type": "text", "text": "two", "cache_control": ephemeral }
        ])
    );
    assert_eq!(ir["messages"][5]["content"], json!([{ "type": "text", "text": "Done.", "cache_control": ephemeral }]));
    assert_eq!(ir["messages"][6]["content"], json!([{ "type": "text", "text": "Thanks.", "cache_control": ephemeral }]));
}

#[test]
fn without_cache_markers_content_still_flattens_to_strings() {
    let req = parse_chat(json!({ "model": "m", "max_tokens": 1024,
        "system": [{ "type": "text", "text": "You are a coding agent. " }, { "type": "text", "text": "Repository map." }],
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "Fix the test. " }, { "type": "text", "text": "Then stop." }] }]
    }))
    .unwrap();
    let ir = ir(&req);
    assert_eq!(ir["messages"][0]["content"], "You are a coding agent. \nRepository map.");
    assert_eq!(ir["messages"][1]["content"], "Fix the test. \nThen stop.");
}

#[test]
fn a_blank_system_prompt_adds_no_message() {
    for system in [json!(""), json!([]), json!(null), json!([{ "type": "text", "text": "" }])] {
        let req = parse_chat(json!({ "system": system, "messages": [{ "role": "user", "content": "hi" }] })).unwrap();
        assert_eq!(req.messages.len(), 1, "{system}");
    }
}

#[test]
fn images_by_url_and_by_bytes_become_image_parts_with_normalized_media_types() {
    let req = user_turn(json!([
        { "type": "text", "text": "What is this?" },
        { "type": "image", "source": { "type": "url", "url": "https://example.com/cat.png" } },
        { "type": "image", "source": { "type": "base64", "media_type": "Image/PNG", "data": "iVBORw0KGgo=" } },
        { "type": "image", "source": { "type": "base64", "data": "AAAA" } },
        { "type": "document", "source": { "type": "base64", "media_type": "application/pdf;name=q3.pdf", "data": "JVBERi0xLjQK" } }
    ]))
    .unwrap();
    let parts = parts_of(&req, 0);
    assert_eq!(parts[0], json!({ "type": "text", "text": "What is this?" }));
    assert_eq!(parts[1]["image_url"]["url"], "https://example.com/cat.png");
    assert_eq!(parts[2]["image_url"]["url"], "data:image/png;base64,iVBORw0KGgo=");
    assert_eq!(parts[3]["image_url"]["url"], "data:image/jpeg;base64,AAAA", "Anthropic's default image type");
    assert_eq!(parts[4]["file"]["file_data"], "data:application/pdf;base64,JVBERi0xLjQK");
}

#[test]
fn a_pdf_document_is_a_file_part_named_by_its_title_or_its_type() {
    let pdf = |extra: Value| {
        let mut block =
            json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "JVBERi0xLjQK" } });
        block.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        parts_of(&user_turn(json!([block])).unwrap(), 0)[0].clone()
    };
    assert_eq!(pdf(json!({}))["file"]["filename"], "document.pdf", "OpenAI refuses a file part with no name");
    assert_eq!(pdf(json!({ "title": "q3-earnings.pdf" }))["file"]["filename"], "q3-earnings.pdf");
    let untyped = user_turn(json!([{ "type": "document", "source": { "type": "base64", "data": "JVBE" } }])).unwrap();
    assert_eq!(parts_of(&untyped, 0)[0]["file"]["file_data"], "data:application/pdf;base64,JVBE", "Anthropic's default document type");
}

#[test]
fn a_tool_result_carrying_an_image_keeps_both_parts() {
    let req = user_turn(json!([{ "type": "tool_result", "tool_use_id": "toolu_chart_01", "content": [
        { "type": "text", "text": "Generated chart:" },
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=" } }
    ]}]))
    .unwrap();
    assert_eq!((req.messages[0].role.as_str(), req.messages[0].tool_call_id.as_deref()), ("tool", Some("toolu_chart_01")));
    let parts = parts_of(&req, 0);
    assert_eq!((parts[0]["type"].as_str(), parts[1]["type"].as_str()), (Some("text"), Some("image_url")));
}

#[test]
fn tool_results_and_text_in_one_turn_become_tool_messages_then_a_user_message() {
    let req = user_turn(json!([
        { "type": "tool_result", "tool_use_id": "a", "content": [{ "type": "text", "text": "one" }] },
        { "type": "tool_result", "tool_use_id": "b" },
        { "type": "tool_result", "content": 7 },
        { "type": "text", "text": "and continue" }
    ]))
    .unwrap();
    let ir = ir(&req);
    assert_eq!(
        ir["messages"],
        json!([
            { "role": "tool", "content": "one", "tool_call_id": "a" },
            { "role": "tool", "content": "", "tool_call_id": "b" },
            { "role": "tool", "content": "", "tool_call_id": "" },
            { "role": "user", "content": "and continue" }
        ])
    );
}

#[test]
fn an_empty_result_is_an_empty_string_marked_or_not_and_a_result_nested_in_one_adds_nothing() {
    // OpenAI refuses a content array with no parts
    let ephemeral = json!({ "type": "ephemeral" });
    let req = user_turn(json!([
        { "type": "tool_result", "tool_use_id": "a", "content": [], "cache_control": ephemeral },
        { "type": "tool_result", "tool_use_id": "b", "content": [{ "type": "text", "text": "" }] },
        { "type": "tool_result", "tool_use_id": "c", "content": [
            { "type": "tool_result", "tool_use_id": "inner", "content": "lost" }, { "type": "text", "text": "kept" }] }
    ]))
    .unwrap();
    assert_eq!(
        ir(&req)["messages"],
        json!([
            { "role": "tool", "content": [{ "type": "text", "text": "", "cache_control": ephemeral }], "tool_call_id": "a" },
            { "role": "tool", "content": "", "tool_call_id": "b" },
            { "role": "tool", "content": "kept", "tool_call_id": "c" }
        ])
    );
}

#[test]
fn a_tool_choice_that_disables_parallel_calls_asks_openai_for_one_call_at_a_time() {
    let one = parse_chat(json!({ "messages": [], "tool_choice": { "type": "auto", "disable_parallel_tool_use": true } })).unwrap();
    assert_eq!(ir(&one)["parallel_tool_calls"], false);
    let many = parse_chat(json!({ "messages": [], "tool_choice": { "type": "auto", "disable_parallel_tool_use": false } })).unwrap();
    assert!(ir(&many).get("parallel_tool_calls").is_none());
}

#[test]
fn an_empty_turn_is_forwarded_and_unconvertible_content_is_refused() {
    // emptiness is the destination's call; losing a turn would break the alternation
    for content in [json!(""), json!([]), json!(null), json!([{ "type": "text", "text": "" }])] {
        let req = user_turn(content.clone()).unwrap();
        assert_eq!((req.messages.len(), req.messages[0].content.clone()), (1, Some(json!(""))), "{content}");
    }
    assert!(user_turn(json!([{ "type": "unknown_future_block", "foo": "bar" }])).unwrap_err().contains("unknown_future_block"));
    let in_result = user_turn(json!([{ "type": "tool_result", "tool_use_id": "t", "content": [{ "type": "hologram" }] }]));
    assert!(in_result.unwrap_err().contains("'hologram'"));
}

fn decoded_file_text(part: &Value) -> String {
    let encoded = part["file"]["file_data"].as_str().unwrap().strip_prefix("data:text/plain;base64,").unwrap();
    String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).unwrap()).unwrap()
}

#[test]
fn a_text_document_becomes_a_text_file_with_its_title() {
    let req = user_turn(json!([
        { "type": "text", "text": "What was EMEA in Q2?" },
        { "type": "document", "title": "sales.csv", "source": { "type": "text", "media_type": "text/plain", "data": "region,q2\nEMEA,913" } }
    ]))
    .unwrap();
    let parts = parts_of(&req, 0);
    assert_eq!((parts[1]["type"].as_str(), parts[1]["file"]["filename"].as_str()), (Some("file"), Some("sales.csv")));
    assert_eq!(decoded_file_text(&parts[1]), "region,q2\nEMEA,913");
    let untitled = user_turn(json!([{ "type": "document", "source": { "type": "text", "data": "ünïcode ✓" } }])).unwrap();
    assert_eq!(decoded_file_text(&parts_of(&untitled, 0)[0]), "ünïcode ✓");
}

#[test]
fn a_content_document_becomes_its_own_blocks_with_the_marker_on_the_last() {
    let req = user_turn(json!([{ "type": "document", "title": "brief", "cache_control": { "type": "ephemeral" },
        "source": { "type": "content", "content": [
            { "type": "text", "text": "Page one." },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo=" } }
        ] } }]))
    .unwrap();
    let parts = parts_of(&req, 0);
    assert_eq!(parts[0], json!({ "type": "text", "text": "Page one." }));
    assert_eq!(parts[1][CACHE_CONTROL], json!({ "type": "ephemeral" }));
    let plain = user_turn(json!([{ "type": "document", "source": { "type": "content", "content": "Just words." } }])).unwrap();
    assert_eq!(plain.messages[0].content, Some(json!("Just words.")));
}

#[test]
fn a_document_or_search_result_inside_a_tool_result_is_kept() {
    let req = user_turn(json!([{ "type": "tool_result", "tool_use_id": "toolu_1", "content": [
        { "type": "document", "title": "out.txt", "source": { "type": "text", "data": "done: 7781" } }
    ] }]))
    .unwrap();
    assert_eq!(req.messages[0].role, "tool");
    assert_eq!(decoded_file_text(&parts_of(&req, 0)[0]), "done: 7781");
    let searched = user_turn(json!([{ "type": "tool_result", "tool_use_id": "t", "content": [search_result()] }])).unwrap();
    assert_eq!(searched.messages[0].content, Some(json!(RENDERED)));
}

fn search_result() -> Value {
    json!({ "type": "search_result", "source": "https://docs.example.com/api", "title": "API Reference",
        "content": [{ "type": "text", "text": "Timeouts default to 30 s." }, { "type": "text", "text": "Set `timeout_ms` to change it." }],
        "citations": { "enabled": true } })
}

const RENDERED: &str = "\n\nSearch result: API Reference\nSource: https://docs.example.com/api\n\nTimeouts default to 30 s.\n\nSet `timeout_ms` to change it.\n\n";

#[test]
fn a_search_result_reaches_the_model_as_text_with_its_title_and_source() {
    let req = user_turn(json!([{ "type": "text", "text": "What is the timeout?" }, search_result()])).unwrap();
    assert_eq!(req.messages[0].content, Some(json!(format!("What is the timeout?\n{RENDERED}"))));
}

#[test]
fn a_malformed_block_is_refused_by_name() {
    let document = |source: Value| json!({ "type": "document", "source": source });
    let cases = [
        (document(json!({ "type": "text" })), "text document missing data"),
        (document(json!({ "type": "text", "data": 42 })), "text document missing data"),
        (document(json!({ "type": "content" })), "content document missing content"),
        (
            document(json!({ "type": "content", "content": [{ "type": "document", "source": { "type": "text", "data": "x" } }] })),
            "content document cannot hold a 'document' block",
        ),
        (document(json!({ "type": "file", "file_id": "file_1" })), "unsupported document source type: 'file'"),
        (document(json!({ "type": "base64" })), "base64 document missing data"),
        (json!({ "type": "image" }), "image block missing source"),
        (json!({ "type": "image", "source": { "type": "url" } }), "url image missing url"),
        (json!({ "type": "search_result", "title": "t", "content": [] }), "search_result block missing 'source'"),
        (json!({ "type": "search_result", "source": "s", "content": [] }), "search_result block missing 'title'"),
        (json!({ "type": "search_result", "source": "s", "title": "t" }), "search_result block missing 'content'"),
        (json!({ "type": "search_result", "source": "s", "title": "t", "content": "words" }), "search_result block missing 'content'"),
        (
            json!({ "type": "search_result", "source": "s", "title": "t", "content": [{ "type": "image" }] }),
            "a search_result can hold only text blocks, not 'image'",
        ),
        (
            json!({ "type": "container_upload", "file_id": "file_011" }),
            "'container_upload' blocks hand a file to Anthropic's code \
             execution sandbox, which the router does not run; send the file as a document or image block instead",
        ),
        (
            json!({ "type": "hologram", "data": "?" }),
            "unsupported content block type: 'hologram' (the router reads text, image, \
             document, search_result and tool_result blocks)",
        ),
    ];
    for (block, expected) in cases {
        let refusal = user_turn(json!([block])).unwrap_err();
        assert!(refusal.contains(expected), "{refusal} should name {expected}");
    }
}

#[test]
fn a_request_the_ir_cannot_hold_is_refused() {
    let refusal = parse_chat(json!({ "messages": [], "max_tokens": "lots" })).unwrap_err();
    assert!(refusal.starts_with("invalid anthropic request: invalid type: string \"lots\""), "{refusal}");
}
