//! A provider's streamed reply translated as its bytes arrive: the provider's SSE read into IR chunks by its spoke, and
//! the chunks rendered as the caller's wire, one translator per reply, held by id between pushes (`routes`).
//!
//! A stream that ends before the provider said why it stopped was cut short, and the caller hears that as an error
//! rather than a reply that looks finished; so does a failure the provider reports part way.

use crate::config::Config;
use crate::inbound::anthropic::StreamRenderer;
use crate::inbound::Inbound;
use crate::providers::{openai, sse::SseReader};
use crate::Result;

/// What the caller hears when the provider's stream ends without finishing its reply.
pub const CUT_SHORT: &str = "The provider's stream ended before its reply finished.";

/// One streamed reply's translation.
pub struct StreamTranslator {
    sse: SseReader,
    renderer: StreamRenderer,
    /// the provider sent `[DONE]`
    done: bool,
    /// the reply's end or an error went out, and nothing may follow it
    ended: bool,
}

impl StreamTranslator {
    pub fn new(inbound: Inbound, cfg: &Config) -> Self {
        let Inbound::Anthropic = inbound;
        Self { sse: SseReader::default(), renderer: StreamRenderer::new(&cfg.model), done: false, ended: false }
    }

    /// The caller's bytes for the provider's next `bytes`, cut wherever they were: empty until an event completes.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        for payload in self.sse.push(bytes)? {
            self.payload(&payload, &mut out);
        }
        Ok(out)
    }

    /// The caller's last bytes, once the provider's stream has ended: the reply's end, or an error if it was cut short.
    pub fn finish(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        if let Some(payload) = self.sse.finish() {
            self.payload(&payload, &mut out);
        }
        if self.ended {
            return out;
        }
        if self.done || self.renderer.finished() {
            self.renderer.finish(&mut out);
        } else {
            StreamRenderer::error(&mut out, CUT_SHORT);
        }
        self.ended = true;
        out
    }

    fn payload(&mut self, payload: &str, out: &mut Vec<u8>) {
        if self.done || self.ended {
            return;
        }
        if payload.trim() == "[DONE]" {
            self.done = true;
        } else if let Some(message) = openai::stream_error(payload) {
            StreamRenderer::error(out, &format!("The provider failed part way: {message}"));
            self.ended = true;
        } else if let Some(chunk) = openai::chunk(payload) {
            self.renderer.render(chunk, out);
        }
    }
}
