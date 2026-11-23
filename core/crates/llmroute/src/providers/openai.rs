//! The OpenAI Chat Completions spoke: the IR is OpenAI's shape already, so a request goes out nearly as it is, with the
//! config's model and caps over the request's, cache markers stripped, media made fit for OpenAI, and usage asked for on
//! a stream; a reply and each streamed chunk come back as they are, naming the model that answered.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/providers/openai.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: only the translation is kept (no HTTP client, dialects, retries, param
//! repair, tool cap or embeddings); the prompt cache key is the config's rather than an agent id; and a reply keeps
//! the model id the provider sent, falling back to the config's, so its cost is priced by the model that served it.

use super::media::{decoded_len, document_kind, text_document, DocumentKind};
use crate::config::Config;
use crate::ir::{ChatChunk, ChatRequest, ChatResponse, ContentPart, Message, ToolDef, UnsupportedPart, CACHE_CONTROL};
use crate::Result;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::borrow::Cow;

/// Where a Chat Completions request goes, under the provider's base URL (which ends in its version, as `/v1`).
pub const CHAT_PATH: &str = "/chat/completions";

const OPENAI_IMAGE_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const OPENAI_FILES_MAX_BYTES: u64 = 50_000_000;
const TOOL_MEDIA_NOTE: &str = "The tool returned images or files; they are in the next message.";
const TOOL_MEDIA_HEADER: &str = "Images and files from the tool results above:";
/// The field an OpenAI request keys its prompt cache with.
const PROMPT_CACHE_KEY: &str = "prompt_cache_key";

#[derive(Serialize)]
struct Outbound<'a> {
    model: &'a str,
    messages: Vec<Cow<'a, Message>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<ToolDef>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f64>,
    stream: bool,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

/// The body of the Chat Completions request `req` makes under `cfg`, streamed or not.
pub fn request_body(req: &ChatRequest, cfg: &Config, stream: bool) -> Result<Vec<u8>> {
    if cfg.refuse_document_urls {
        check_documents(req)?;
    }
    let mut messages: Vec<Cow<'_, Message>> = req
        .messages
        .iter()
        .map(|message| {
            if !message.has_cache_markers() {
                return Cow::Borrowed(message);
            }
            let mut owned = message.clone();
            owned.strip_cache_markers();
            Cow::Owned(owned)
        })
        .collect();
    if cfg.strict_media {
        prepare_media(&mut messages)?;
    }
    let mut extra = req.extra.clone();
    if let Some(max_tokens) = cfg.max_tokens.or(req.max_tokens) {
        extra.insert("max_completion_tokens".to_string(), json!(max_tokens));
    }
    if stream {
        extra.insert("stream_options".to_string(), json!({ "include_usage": true }));
    }
    if let Some(key) = cfg.cache_key.as_ref().filter(|key| !key.is_empty() && routes_by_cache_key(&cfg.model)) {
        extra.entry(PROMPT_CACHE_KEY.to_string()).or_insert_with(|| json!(key));
    }
    // OpenAI caches on its own: a marker is not a field it takes
    let tools = req.tools.as_ref().map(|tools| {
        let mut tools = tools.clone();
        tools.iter_mut().for_each(|tool| drop(tool.extra.remove(CACHE_CONTROL)));
        tools
    });
    let out = Outbound {
        model: &cfg.model,
        messages,
        tools,
        tool_choice: req.tool_choice.as_ref(),
        temperature: cfg.temperature.or(req.temperature),
        stream,
        extra,
    };
    Ok(serde_json::to_vec(&out).expect("a request of JSON values always serializes"))
}

/// A whole reply read, naming the model that answered: the provider's own id, else the config's.
pub fn response(body: &[u8], cfg: &Config) -> Result<ChatResponse> {
    let mut reply: ChatResponse =
        serde_json::from_slice(body).map_err(|e| format!("the provider's reply is not a chat completion: {e}"))?;
    if reply.model.is_empty() {
        reply.model = cfg.model.clone();
    }
    Ok(reply)
}

/// One streamed chunk read; `None` for a payload that is not one (a provider's keep-alive or comment), which is skipped.
pub fn chunk(payload: &str) -> Option<ChatChunk> {
    serde_json::from_str(payload).ok()
}

/// What a streamed `{"error": ...}` payload says went wrong, as OpenAI-compatible servers report a failure mid-stream.
pub fn stream_error(payload: &str) -> Option<String> {
    let value: Value = serde_json::from_str(payload).ok()?;
    let error = value.get("error").filter(|error| !error.is_null())?;
    Some(error.get("message").and_then(Value::as_str).map_or_else(|| error.to_string(), str::to_string))
}

fn refused(err: UnsupportedPart) -> String {
    format!("OpenAI does not accept this input: {}", err.into_message())
}

/// A document given by URL refused by name before sending, since OpenAI would refuse it after.
fn check_documents(req: &ChatRequest) -> Result<()> {
    let by_url = req
        .messages
        .iter()
        .filter_map(|m| m.content.as_ref()?.as_array())
        .flatten()
        .filter(|part| part["type"] == "file")
        .filter_map(|part| part["file"]["file_data"].as_str())
        .any(|data| data.starts_with("http://") || data.starts_with("https://"));
    if by_url {
        return Err(
            "OpenAI does not accept this input: a document given by URL; send its bytes as a base64 data URL in file.file_data".into()
        );
    }
    Ok(())
}

/// Media made fit for OpenAI: each part checked or rewritten, then a tool result's images moved after the tool run.
fn prepare_media(messages: &mut Vec<Cow<'_, Message>>) -> Result<()> {
    let mut file_bytes = 0;
    for message in messages.iter_mut() {
        let Some(Value::Array(parts)) = message.content.as_ref() else { continue };
        let mut rewrites = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            if let Some(rewritten) = media_rewrite(part, &mut file_bytes)? {
                rewrites.push((index, rewritten));
            }
        }
        // copied only when a part changes
        if let Some(Value::Array(parts)) = (!rewrites.is_empty()).then(|| message.to_mut().content.as_mut()).flatten() {
            for (index, rewritten) in rewrites {
                parts[index] = rewritten;
            }
        }
    }
    if file_bytes > OPENAI_FILES_MAX_BYTES {
        return Err(refused(UnsupportedPart::new("more than 50 MB of files in one request")));
    }
    move_tool_media(messages);
    Ok(())
}

/// A part as OpenAI must get it, or `None` when it is fine as it is: a text document becomes a text part, a PDF counts
/// toward the files cap, and a file or image type OpenAI can't read is refused by name.
fn media_rewrite(part: &Value, file_bytes: &mut u64) -> Result<Option<Value>> {
    match ContentPart::from_openai_part(part) {
        Ok(ContentPart::File { source, filename }) => {
            let Some((media_type, data)) = source.inline() else { return Ok(None) };
            match document_kind(media_type) {
                DocumentKind::TextLike => {
                    Ok(Some(json!({ "type": "text", "text": text_document(&source, filename.as_deref()).map_err(refused)? })))
                }
                DocumentKind::Pdf => {
                    *file_bytes += decoded_len(data);
                    Ok(None)
                }
                DocumentKind::Other => {
                    Err(refused(UnsupportedPart::new(format!("'{media_type}' files (it reads PDF; text files are sent as text)"))))
                }
            }
        }
        Ok(ContentPart::Image { source, detail }) => {
            if let Some(media_type) = source.media_type().filter(|media_type| !OPENAI_IMAGE_TYPES.contains(media_type)) {
                return Err(refused(UnsupportedPart::new(format!("'{media_type}' images (it reads png, jpeg, gif and webp)"))));
            }
            // a normalized media type is a rewrite; an image already in OpenAI's form is not
            let rendered = ContentPart::Image { source, detail }.to_openai_part();
            Ok((rendered != *part).then_some(rendered))
        }
        _ => Ok(None),
    }
}

/// Whether OpenAI routes `model` to its cache by `prompt_cache_key`: the models before GPT-5.6, such as `gpt-4o`,
/// `gpt-4.1`, `gpt-5.5` and the `o` series; from GPT-5.6 it needs no key. `false` for a name it can't read.
pub(crate) fn routes_by_cache_key(model: &str) -> bool {
    let model = model.strip_prefix("ft:").unwrap_or(model);
    let model = model.strip_prefix("chat").unwrap_or(model); // `chatgpt-4o-latest`
    if let Some(rest) = model.strip_prefix('o') {
        return rest.starts_with(|c: char| c.is_ascii_digit());
    }
    let Some(version) = model.strip_prefix("gpt-") else { return false };
    let major_end = version.find(|c: char| !c.is_ascii_digit()).unwrap_or(version.len());
    let Ok(major) = version[..major_end].parse::<u32>() else { return false };
    let minor = version[major_end..]
        .strip_prefix('.')
        .and_then(|rest| rest.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u32>().ok())
        .unwrap_or(0);
    (major, minor) < (5, 6)
}

fn is_text_part(part: &Value) -> bool {
    part.get("type").and_then(Value::as_str) == Some("text")
}

/// A tool result's images, which an OpenAI `tool` message can't hold, moved into one user message after the run of tool
/// messages they came in, with a note left in each result that had nothing else.
fn move_tool_media(messages: &mut Vec<Cow<'_, Message>>) {
    let mut i = 0;
    while i < messages.len() {
        if messages[i].role != "tool" {
            i += 1;
            continue;
        }
        let start = i;
        while i < messages.len() && messages[i].role == "tool" {
            i += 1;
        }
        let mut moved = Vec::new();
        for message in &mut messages[start..i] {
            let has_media = matches!(message.content.as_ref(), Some(Value::Array(parts)) if parts.iter().any(|part| !is_text_part(part)));
            let Some(Value::Array(parts)) = has_media.then(|| message.to_mut().content.as_mut()).flatten() else { continue };
            let (text, media): (Vec<Value>, Vec<Value>) = parts.drain(..).partition(is_text_part);
            moved.extend(media);
            *parts = if text.is_empty() { vec![json!({ "type": "text", "text": TOOL_MEDIA_NOTE })] } else { text };
        }
        if moved.is_empty() {
            continue;
        }
        let mut content = vec![json!({ "type": "text", "text": TOOL_MEDIA_HEADER })];
        content.extend(moved);
        let images = Message {
            role: "user".into(),
            content: Some(Value::Array(content)),
            name: None,
            tool_calls: None,
            tool_call_id: None,
            extra: Map::new(),
        };
        messages.insert(i, Cow::Owned(images));
        i += 1;
    }
}
