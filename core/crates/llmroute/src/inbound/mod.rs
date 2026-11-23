//! Inbound parsing, the front of the hub: a request in the wire an SDK speaks read into the IR, and the IR's reply,
//! whole or streamed, rendered back in that wire.
//!
//! Ported from Nasiko's llm-router (`llm-router/src/inbound/mod.rs`, commit 0ed4b3d, Apache-2.0;
//! build/THIRD_PARTY_NOTICES.md) and modified: one wire so far, named by the caller, and an unknown name is refused
//! rather than read as OpenAI's.

use crate::Result;

pub mod anthropic;

/// The wire a caller speaks: how its SDK calls a model, whatever provider answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Inbound {
    /// Anthropic Messages (`/v1/messages`), as Claude Code speaks it.
    Anthropic,
}

impl Inbound {
    pub fn from_label(label: &str) -> Result<Self> {
        match label {
            "anthropic" => Ok(Self::Anthropic),
            other => Err(format!("no inbound wire '{other}' (the router reads: anthropic)")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Inbound;

    #[test]
    fn a_wire_is_named_exactly_and_an_unknown_one_is_refused() {
        assert_eq!(Inbound::from_label("anthropic"), Ok(Inbound::Anthropic));
        assert_eq!(Inbound::from_label("gemini"), Err("no inbound wire 'gemini' (the router reads: anthropic)".to_string()));
    }
}
