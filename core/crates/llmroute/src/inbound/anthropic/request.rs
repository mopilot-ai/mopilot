//! An Anthropic Messages request read into the IR: the system prompt as a `system` message, `tool_use` and `tool_result`
//! blocks as an assistant's `tool_calls` and `tool` messages under the same ids, media as image and file parts, and
//! `input_schema` as a tool's `parameters`.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/inbound/anthropic.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: rewritten for Rust 2021 with its errors as messages.
//!
//! Text is flattened to strings, except where the agent set a `cache_control` marker: that content stays as text parts,
//! each keeping its marker, so the cached prefix the agent chose ends where it put it. The IR is built as OpenAI-shaped
//! JSON and deserialized, which keeps this in step with the IR's own serde rules.

use crate::ir::{parts_to_content_value, ChatRequest, ContentPart, DataSource, CACHE_CONTROL};
use crate::Result;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

/// An Anthropic `/v1/messages` body as the IR. What the IR has no field for (`thinking`, `metadata`, `stop_sequences`,
/// `top_p`, `top_k`) is dropped, as Nasiko drops it.
pub fn parse_chat(body: Value) -> Result<ChatRequest> {
    let mut messages: Vec<Value> = Vec::new();
    // the system prompt travels at the top level, as a string or a block array
    if let Some(system) = body.get("system") {
        let content = text_content(system);
        if !is_blank(&content) {
            messages.push(json!({ "role": "system", "content": content }));
        }
    }
    for m in body.get("messages").and_then(Value::as_array).into_iter().flatten() {
        let content = m.get("content").unwrap_or(&Value::Null);
        match m.get("role").and_then(Value::as_str).unwrap_or("user") {
            "assistant" => messages.push(assistant_message(content)),
            "user" => append_user(content, &mut messages)?,
            other => messages.push(json!({ "role": other, "content": anthropic_text(content) })),
        }
    }
    let mut ir = json!({ "messages": messages });
    for key in ["model", "temperature", "max_tokens", "stream"] {
        if let Some(v) = body.get(key) {
            ir[key] = v.clone();
        }
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        ir["tools"] = json!(tools.iter().map(tool).collect::<Vec<_>>());
    }
    if let Some(choice) = body.get("tool_choice").and_then(tool_choice) {
        ir["tool_choice"] = choice;
    }
    if body["tool_choice"]["disable_parallel_tool_use"] == true {
        ir["parallel_tool_calls"] = json!(false);
    }
    serde_json::from_value(ir).map_err(|e| format!("invalid anthropic request: {e}"))
}

/// The plain text of an Anthropic content value: a string as it is, or the `text` of each block on its own line, so two
/// blocks (a `<system-reminder>` and the user's words) never run together.
fn anthropic_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// Text content as IR content: the joined text, unless a text block carries a cache marker; then one text part per
/// block, each keeping its marker.
fn text_content(v: &Value) -> Value {
    let Value::Array(blocks) = v else {
        return json!(anthropic_text(v));
    };
    let text_blocks: Vec<&Value> = blocks.iter().filter(|b| b.get("text").and_then(Value::as_str).is_some()).collect();
    if !text_blocks.iter().any(|b| b.get(CACHE_CONTROL).is_some()) {
        return json!(anthropic_text(v));
    }
    json!(text_blocks.into_iter().map(|b| with_marker_of(b, json!({ "type": "text", "text": b["text"] }))).collect::<Vec<_>>())
}

/// Whether text content (a string, or the marked parts [`text_content`] keeps, never none) says nothing.
fn is_blank(content: &Value) -> bool {
    content.as_str() == Some("")
}

/// `target` with `source`'s cache marker copied onto it, if it has one.
fn with_marker_of(source: &Value, mut target: Value) -> Value {
    if let Some(marker) = source.get(CACHE_CONTROL) {
        target[CACHE_CONTROL] = marker.clone();
    }
    target
}

/// A `tool_result` keeps one marker, on its whole result: the block's own, else the last one on a block inside it.
fn tool_result_marker(b: &Value) -> Option<&Value> {
    b.get(CACHE_CONTROL).or_else(|| b.get("content")?.as_array()?.iter().rev().find_map(|inner| inner.get(CACHE_CONTROL)))
}

/// Tool-result content (a string, or an array of at least one part) with `marker` on its last part; a string becomes the
/// text part it stands for, since only a part can hold a marker.
fn marked_at_end(content: Value, marker: &Value) -> Value {
    let mut parts = match content {
        Value::Array(parts) => parts,
        text => vec![json!({ "type": "text", "text": text })],
    };
    let last = parts.len() - 1;
    parts[last][CACHE_CONTROL] = marker.clone();
    Value::Array(parts)
}

/// A user turn's content: unmarked text parts join into one string, so an unmarked request reaches every provider as it
/// did before markers and media were kept; a marker or a media part keeps the array, each in its place.
fn user_content(parts: Vec<Value>) -> Value {
    if parts.iter().all(|p| p["type"] == "text" && p.get(CACHE_CONTROL).is_none()) {
        return json!(anthropic_text(&Value::Array(parts)));
    }
    Value::Array(parts)
}

/// An Anthropic assistant turn as an OpenAI assistant message: `text` blocks join into `content` and `tool_use` blocks
/// become `tool_calls` (arguments as a JSON string), each keeping its id. Thinking blocks are dropped.
fn assistant_message(content: &Value) -> Value {
    match content {
        Value::String(s) => json!({ "role": "assistant", "content": s }),
        Value::Array(blocks) => {
            let tool_calls: Vec<Value> = blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                .map(|b| {
                    let call = json!({
                        "id": b.get("id").and_then(Value::as_str).unwrap_or_default(),
                        "type": "function",
                        "function": {
                            "name": b.get("name").and_then(Value::as_str).unwrap_or_default(),
                            "arguments": b.get("input").map_or_else(|| "{}".to_string(), Value::to_string),
                        }
                    });
                    with_marker_of(b, call)
                })
                .collect();
            let text = text_content(content);
            if tool_calls.is_empty() {
                return json!({ "role": "assistant", "content": text });
            }
            // OpenAI's content is null on a turn that only calls tools
            let text = if is_blank(&text) { Value::Null } else { text };
            json!({ "role": "assistant", "content": text, "tool_calls": tool_calls })
        }
        _ => json!({ "role": "assistant", "content": "" }),
    }
}

/// An Anthropic `source` as the IR's; `kind` (image or document) only shapes the error.
fn anthropic_source(b: &Value, kind: &str, default_media_type: &str) -> Result<DataSource> {
    let source = b.get("source").ok_or_else(|| format!("{kind} block missing source"))?;
    let field = |name: &str| source.get(name).and_then(Value::as_str);
    match field("type").unwrap_or_default() {
        "base64" => {
            let data = field("data").ok_or_else(|| format!("base64 {kind} missing data"))?;
            Ok(DataSource::from_inline(field("media_type").unwrap_or(default_media_type), data))
        }
        "url" => Ok(DataSource::Url(field("url").ok_or_else(|| format!("url {kind} missing url"))?.to_string())),
        other => Err(format!("unsupported {kind} source type: '{other}'")),
    }
}

/// A content block as the parts it stands for: none for an empty text block or a `tool_result`, which the caller lifts
/// into its own `tool` message.
fn block_parts(b: &Value) -> Result<Vec<ContentPart>> {
    match b.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => Ok(text_part(b.get("text").and_then(Value::as_str).unwrap_or_default()).into_iter().collect()),
        "image" => Ok(vec![ContentPart::Image { source: anthropic_source(b, "image", "image/jpeg")?, detail: None }]),
        "document" => document_parts(b),
        "search_result" => search_result_parts(b),
        "tool_result" => Ok(Vec::new()),
        "container_upload" => Err("'container_upload' blocks hand a file to Anthropic's code execution sandbox, which \
             the router does not run; send the file as a document or image block instead"
            .to_string()),
        other => Err(format!(
            "unsupported content block type: '{other}' (the router reads text, image, document, search_result and \
             tool_result blocks)"
        )),
    }
}

fn search_result_parts(b: &Value) -> Result<Vec<ContentPart>> {
    let field = |name: &str| b.get(name).ok_or_else(|| format!("search_result block missing '{name}'"));
    let source = field("source")?.as_str().unwrap_or_default();
    let title = field("title")?.as_str().unwrap_or_default();
    let Value::Array(blocks) = field("content")? else {
        return Err("search_result block missing 'content'".to_string());
    };
    let mut texts = Vec::with_capacity(blocks.len());
    for block in blocks {
        match block.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => texts.push(block.get("text").and_then(Value::as_str).unwrap_or_default()),
            other => return Err(format!("a search_result can hold only text blocks, not '{other}'")),
        }
    }
    Ok(vec![ContentPart::Text(format!("\n\nSearch result: {title}\nSource: {source}\n\n{}\n\n", texts.join("\n\n")))])
}

fn text_part(text: &str) -> Option<ContentPart> {
    (!text.is_empty()).then(|| ContentPart::Text(text.to_string()))
}

/// A document block as a file part: its `title` is its filename (when there is none, the OpenAI part makes one from the
/// media type), a text source becomes a text file, and a content source becomes its own blocks.
fn document_parts(b: &Value) -> Result<Vec<ContentPart>> {
    let filename = b.get("title").and_then(Value::as_str).map(str::to_string);
    let source = b.get("source");
    match source.and_then(|s| s.get("type")).and_then(Value::as_str) {
        Some("text") => {
            let text =
                source.and_then(|s| s.get("data")).and_then(Value::as_str).ok_or_else(|| "text document missing data".to_string())?;
            Ok(vec![ContentPart::File { source: DataSource::from_inline("text/plain", &STANDARD.encode(text)), filename }])
        }
        Some("content") => content_document_parts(source.and_then(|s| s.get("content"))),
        _ => Ok(vec![ContentPart::File { source: anthropic_source(b, "document", "application/pdf")?, filename }]),
    }
}

fn content_document_parts(content: Option<&Value>) -> Result<Vec<ContentPart>> {
    match content {
        Some(Value::String(text)) => Ok(text_part(text).into_iter().collect()),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "text" | "image" => parts.extend(block_parts(block)?),
                    other => return Err(format!("content document cannot hold a '{other}' block")),
                }
            }
            Ok(parts)
        }
        _ => Err("content document missing content".to_string()),
    }
}

/// A `tool_result` block's content as a `tool` message's.
fn tool_result_content(b: &Value) -> Result<Value> {
    let content = match b.get("content") {
        Some(Value::String(s)) => Value::String(s.clone()),
        Some(Value::Array(blocks)) => {
            let mut parts = Vec::new();
            for block in blocks {
                parts.extend(block_parts(block)?);
            }
            // a result with nothing in it is an empty string: OpenAI refuses an empty content array
            if parts.is_empty() {
                Value::String(String::new())
            } else {
                parts_to_content_value(&parts)
            }
        }
        _ => Value::String(String::new()),
    };
    Ok(match tool_result_marker(b) {
        Some(marker) => marked_at_end(content, marker),
        None => content,
    })
}

/// An Anthropic user turn as one or more OpenAI messages: each `tool_result` a `tool` message under its `tool_use_id`,
/// and the rest one user message.
///
/// Empty content is forwarded, not refused: there is nothing to convert and nothing to lose, and each provider has its
/// own rule about an empty turn. Content that can't be converted is refused, since forwarding it would drop data.
fn append_user(content: &Value, out: &mut Vec<Value>) -> Result<()> {
    let Value::Array(blocks) = content else {
        out.push(json!({ "role": "user", "content": content.as_str().unwrap_or_default() }));
        return Ok(());
    };
    let mut user_parts: Vec<Value> = Vec::new();
    let mut had_tool_result = false;
    for b in blocks {
        if b.get("type").and_then(Value::as_str) == Some("tool_result") {
            had_tool_result = true;
            let id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or_default();
            out.push(json!({ "role": "tool", "tool_call_id": id, "content": tool_result_content(b)? }));
            continue;
        }
        let parts = block_parts(b)?;
        let last = parts.len().saturating_sub(1);
        for (i, part) in parts.into_iter().enumerate() {
            let rendered = part.to_openai_part();
            user_parts.push(if i == last { with_marker_of(b, rendered) } else { rendered });
        }
    }
    if !user_parts.is_empty() {
        out.push(json!({ "role": "user", "content": user_content(user_parts) }));
    } else if !had_tool_result {
        // blocks that carried nothing, and no tool result to stand for the turn: keep it, since a turn dropped silently
        // breaks the user and assistant alternation downstream
        out.push(json!({ "role": "user", "content": "" }));
    }
    Ok(())
}

/// An Anthropic tool definition as an OpenAI function tool (`input_schema` as `parameters`).
fn tool(t: &Value) -> Value {
    let mut function = json!({ "name": t.get("name").and_then(Value::as_str).unwrap_or_default() });
    if let Some(d) = t.get("description") {
        function["description"] = d.clone();
    }
    if let Some(s) = t.get("input_schema") {
        function["parameters"] = s.clone();
    }
    with_marker_of(t, json!({ "type": "function", "function": function }))
}

/// Anthropic's `tool_choice` as OpenAI's.
fn tool_choice(v: &Value) -> Option<Value> {
    match v.get("type").and_then(Value::as_str) {
        Some("auto") => Some(json!("auto")),
        Some("any") => Some(json!("required")),
        Some("none") => Some(json!("none")),
        Some("tool") => v.get("name").and_then(Value::as_str).map(|name| json!({ "type": "function", "function": { "name": name } })),
        _ => None,
    }
}
