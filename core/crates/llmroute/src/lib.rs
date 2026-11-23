//! A model request translated from the wire its SDK speaks to a provider's, and the reply back, for the model router
//! (docs/architecture/rust-core.md; the HTTP side comes later, in electron/routing).
//!
//! The design is Nasiko's llm-router (https://github.com/Nasiko-Labs/nasiko, `llm-router/src`, commit 0ed4b3d,
//! Apache-2.0; build/THIRD_PARTY_NOTICES.md), whose translation core this crate ports without its server (no HTTP,
//! database, keys, payer, retries or fallbacks): a hub-and-spoke translator with one canonical IR in OpenAI Chat's shape
//! (`ir`), an inbound parser per SDK wire (`inbound`, Anthropic Messages so far) and a spoke per provider wire
//! (`providers`, OpenAI Chat Completions so far), with a stateful translator for a streamed reply (`stream`).
//!
//! What goes out is a pure function of what came in, byte for byte: no clock, no randomness and no hash order, so the
//! same conversation reaches a provider as the same prefix and its prompt cache keeps hitting.

pub mod config;
pub mod inbound;
pub mod ir;
pub mod providers;
mod routes;
pub mod stream;

#[cfg(test)]
mod journey;
#[cfg(test)]
mod tests_routes;

/// Why a translation could not be made: the message says what, in words a caller can show.
pub type Result<T> = std::result::Result<T, String>;

use config::Config;
use inbound::{anthropic, Inbound};
use providers::openai;

/// The provider's request for `body`, a request in wire `inbound`: whether it streams, and its body. It goes to
/// [`openai::CHAT_PATH`] under the provider's base URL, to `config.model`.
pub fn translate_request(inbound: Inbound, body: &[u8], config: &Config) -> Result<(bool, Vec<u8>)> {
    let Inbound::Anthropic = inbound;
    let body = serde_json::from_slice(body).map_err(|e| format!("the request body is not JSON: {e}"))?;
    let request = anthropic::parse_chat(body)?;
    let stream = request.is_streaming();
    Ok((stream, openai::request_body(&request, config, stream)?))
}

/// The caller's reply, in wire `inbound`, for the provider's whole reply `body`.
pub fn translate_response(inbound: Inbound, body: &[u8], config: &Config) -> Result<Vec<u8>> {
    let Inbound::Anthropic = inbound;
    Ok(anthropic::render_chat_response(openai::response(body, config)?).to_string().into_bytes())
}
