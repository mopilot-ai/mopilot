//! The canonical chat IR in OpenAI Chat Completions' shape: requests, replies, streamed chunks and usage.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/ir/chat.rs`, commit 0ed4b3d, Apache-2.0; build/THIRD_PARTY_NOTICES.md)
//! and modified: rewritten for Rust 2021, the cache-marker queries and cache-inclusive usage that only Nasiko's other
//! wires read are left out, and a reply or chunk may leave out its `id`, `model` and choice `index`, as some
//! OpenAI-compatible servers do.
//!
//! Types are permissive: every struct keeps an `extra` map (`#[serde(flatten)]`) so unknown OpenAI fields pass through
//! untouched. The fields acted on are named; everything else round-trips.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The key a prompt-cache breakpoint travels under: Anthropic's own, and the one OpenRouter reads on OpenAI-shaped content
/// parts. The IR keeps a marker where the agent put it: on a text content part, on a tool call or on a tool definition
/// (the last two in their `extra`).
pub const CACHE_CONTROL: &str = "cache_control";

fn function_kind() -> String {
    "function".to_string()
}

/// A chat request (OpenAI shape). `model` is accepted but a config's model replaces it on the way out.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDef>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_choice: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<bool>,
    /// OpenAI parameters not enumerated here (top_p, frequency_penalty, ...).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ChatRequest {
    /// Whether the caller asked for a streamed reply (`stream: true`).
    pub fn is_streaming(&self) -> bool {
        self.stream.unwrap_or(false)
    }
}

/// An OpenAI chat message (`system` | `user` | `assistant` | `tool`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    /// A string, an array of content parts, or null: kept as raw JSON.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// On an assistant message that called tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    /// On a `tool` message: the id of the call this result answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Message {
    pub fn has_cache_markers(&self) -> bool {
        let in_parts = matches!(&self.content, Some(Value::Array(parts)) if parts.iter().any(|part| part.get(CACHE_CONTROL).is_some()));
        in_parts || self.tool_calls.iter().flatten().any(|call| call.extra.contains_key(CACHE_CONTROL))
    }

    pub fn strip_cache_markers(&mut self) {
        if let Some(Value::Array(parts)) = &mut self.content {
            for part in parts.iter_mut().filter_map(Value::as_object_mut) {
                part.remove(CACHE_CONTROL);
            }
        }
        for call in self.tool_calls.iter_mut().flatten() {
            call.extra.remove(CACHE_CONTROL);
        }
    }

    /// The content's plain text: a string as it is, or the `text` parts of an array joined; `None` for null, other
    /// shapes and an array with no text.
    pub fn text(&self) -> Option<String> {
        match &self.content {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Array(parts)) => {
                let joined: String = parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect();
                (!joined.is_empty()).then_some(joined)
            }
            _ => None,
        }
    }
}

/// An OpenAI function-tool definition.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolDef {
    #[serde(rename = "type", default = "function_kind")]
    pub kind: String,
    pub function: FunctionDef,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FunctionDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// JSON Schema for the tool's arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
    /// OpenAI structured outputs: the arguments must match `parameters` exactly. Kept so an agent that relies on it
    /// still gets it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strict: Option<bool>,
}

/// An assistant tool call (OpenAI shape). `function.arguments` is a JSON **string**.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "function_kind")]
    pub kind: String,
    pub function: FunctionCall,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FunctionCall {
    pub name: String,
    /// The arguments serialized as a JSON string (OpenAI's contract).
    pub arguments: String,
}

/// A whole chat completion (OpenAI shape).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatResponse {
    #[serde(default)]
    pub id: String,
    /// The model that answered, as the provider names it.
    #[serde(default)]
    pub model: String,
    pub choices: Vec<Choice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Choice {
    #[serde(default)]
    pub index: i64,
    pub message: Message,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_tokens: Option<i64>,
    /// Prompt tokens served from the provider's cache. Anthropic reports `cache_read_input_tokens`; OpenAI reports
    /// `prompt_tokens_details.cached_tokens` (lifted into this flat field by [`Usage::normalize_openai_details`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<i64>,
    /// Prompt tokens written into the provider's cache (Anthropic `cache_creation_input_tokens`; OpenAI has no count).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<i64>,
    /// Cache writes subdivided by their time to live; never more prompt tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_creation: Option<CacheCreationUsage>,
    /// Where OpenAI nests its cache count; lifted into the flat field after parsing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct CacheCreationUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral_5m_input_tokens: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ephemeral_1h_input_tokens: Option<i64>,
}

/// OpenAI's `usage.prompt_tokens_details`: the only place OpenAI reports cache reads.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PromptTokensDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_tokens: Option<i64>,
}

impl Usage {
    /// Lift OpenAI's nested `prompt_tokens_details.cached_tokens` into the flat `cache_read_input_tokens`, and make
    /// `prompt_tokens` count only uncached input, as Anthropic's `input_tokens` does: OpenAI's `prompt_tokens` includes
    /// the cached tokens, so a cost that charges input at the full rate and cache reads at the cache rate would bill
    /// them twice.
    ///
    /// The subtraction is keyed on the nested block being the source of the cache-read count, so an explicit flat value
    /// wins and is never counted twice. The block is consumed, so a second call changes nothing; a count that would go
    /// below zero stops at zero.
    pub fn normalize_openai_details(&mut self) {
        let Some(nested) = self.prompt_tokens_details.take() else {
            return;
        };
        if self.cache_read_input_tokens.is_some() {
            return;
        }
        self.cache_read_input_tokens = nested.cached_tokens;
        if let (Some(cached), Some(prompt)) = (nested.cached_tokens, self.prompt_tokens) {
            self.prompt_tokens = Some((prompt - cached).max(0));
        }
    }
}

/// A streamed chunk (`chat.completion.chunk`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatChunk {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub choices: Vec<ChunkChoice>,
    /// The usage of the whole reply, in a last chunk (OpenAI's `stream_options.include_usage`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChunkChoice {
    #[serde(default)]
    pub index: i64,
    #[serde(default)]
    pub delta: Delta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}

/// What a chunk adds. Anything else a provider streams (a reasoning model's `reasoning_content`, say) is not read, so
/// the model's thinking never reaches the caller as text.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Delta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallDelta>>,
}

/// A streamed tool-call fragment. `index` ties fragments to the same call; `id` and `name` usually arrive once, and
/// `arguments` accumulates as partial JSON.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolCallDelta {
    #[serde(default)]
    pub index: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub function: Option<FunctionCallDelta>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct FunctionCallDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
}
