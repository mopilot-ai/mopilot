//! What a named config says about where a request goes: the provider's wire, the model that replaces the request's, the
//! caps it puts on, and what the provider's endpoint accepts. The configs library (electron/routing, later) owns configs
//! and keys; this only reads the part translation needs, and a key never crosses.

use crate::Result;
use serde::Deserialize;
use serde_json::Value;

fn yes() -> bool {
    true
}

/// A config as translation reads it: `{ provider, model, maxTokens?, temperature?, cacheKey?, strictMedia?,
/// refuseDocumentUrls? }`. Fields it does not name (the config's id, base URL, fallbacks) are ignored here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The provider's wire: `openai` (OpenAI Chat Completions, and the endpoints compatible with it).
    pub provider: String,
    /// The model every request goes to, whatever model the request named: the config is authoritative.
    pub model: String,
    /// The output cap, over the request's own.
    #[serde(default)]
    pub max_tokens: Option<i64>,
    /// The temperature, over the request's own.
    #[serde(default)]
    pub temperature: Option<f64>,
    /// OpenAI's `prompt_cache_key` for the models that route their cache by one (before GPT-5.6): the same key for the
    /// same conversation keeps it on one cache.
    #[serde(default)]
    pub cache_key: Option<String>,
    /// The endpoint takes only what OpenAI's own does: files and images checked by type, text documents sent as text,
    /// and a tool result's images moved into the user message after it. On unless the provider's catalog says not.
    #[serde(default = "yes")]
    pub strict_media: bool,
    /// The endpoint refuses a document given by URL, as OpenAI's does: say so before sending rather than after.
    #[serde(default = "yes")]
    pub refuse_document_urls: bool,
}

impl Config {
    /// The config in `value`, or why it can't route a request.
    pub fn from_value(value: Value) -> Result<Self> {
        let config: Self = serde_json::from_value(value).map_err(|e| format!("invalid routing config: {e}"))?;
        crate::providers::spoke_for(&config.provider)?;
        if config.model.trim().is_empty() {
            return Err("a routing config names the model it sends to".to_string());
        }
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::Config;
    use serde_json::json;

    #[test]
    fn a_config_reads_its_fields_and_defaults_to_openais_strict_endpoint() {
        let plain = Config::from_value(json!({ "id": "c1", "provider": "openai", "model": "gpt-4o-mini", "baseUrl": "x" })).unwrap();
        assert_eq!((plain.max_tokens, plain.temperature, plain.cache_key), (None, None, None));
        assert_eq!((plain.strict_media, plain.refuse_document_urls), (true, true));
        let full = Config::from_value(json!({ "provider": "openai", "model": "m", "maxTokens": 9, "temperature": 0.2,
            "cacheKey": "k", "strictMedia": false, "refuseDocumentUrls": false }))
        .unwrap();
        assert_eq!((full.max_tokens, full.temperature, full.cache_key.as_deref()), (Some(9), Some(0.2), Some("k")));
        assert_eq!((full.strict_media, full.refuse_document_urls), (false, false));
    }

    #[test]
    fn a_config_without_a_spoke_or_a_model_is_refused_by_name() {
        let refusal = |value| Config::from_value(value).unwrap_err();
        assert_eq!(refusal(json!({ "provider": "gemini", "model": "m" })), "no provider spoke 'gemini' (the router sends to: openai)");
        assert_eq!(refusal(json!({ "provider": "openai", "model": " " })), "a routing config names the model it sends to");
        assert!(refusal(json!({ "provider": "openai" })).starts_with("invalid routing config: missing field `model`"));
    }
}
