//! The canonical internal representation (IR), in OpenAI Chat Completions' shape, that every inbound wire parses to and
//! every provider spoke renders from.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/ir/mod.rs`, commit 0ed4b3d, Apache-2.0; build/THIRD_PARTY_NOTICES.md)
//! and modified: embeddings are left out.

pub mod chat;
pub mod parts;

pub use chat::{
    CacheCreationUsage, ChatChunk, ChatRequest, ChatResponse, Choice, ChunkChoice, Delta, FunctionCall, FunctionCallDelta, FunctionDef,
    Message, ToolCall, ToolCallDelta, ToolDef, Usage, CACHE_CONTROL,
};
pub use parts::{split_data_url, ContentPart, DataSource, UnsupportedPart};

use serde_json::Value;

/// Parts as a `Message::content` value, a lone text part as a bare string: a caller who sent one text block sees
/// `content: "hi"`.
pub fn parts_to_content_value(parts: &[ContentPart]) -> Value {
    if let [ContentPart::Text(text)] = parts {
        return Value::String(text.clone());
    }
    Value::Array(parts.iter().map(ContentPart::to_openai_part).collect())
}

#[cfg(test)]
mod tests_chat;
#[cfg(test)]
mod tests_parts;
