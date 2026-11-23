//! Outbound provider spokes: the IR rendered in a provider's wire, and the provider's reply read back into the IR. OpenAI
//! Chat Completions so far, which also serves the endpoints compatible with it.

use crate::Result;

mod media;
pub mod openai;
pub mod sse;

/// Whether a spoke speaks `provider`'s wire, or why not.
pub(crate) fn spoke_for(provider: &str) -> Result<()> {
    match provider {
        "openai" => Ok(()),
        other => Err(format!("no provider spoke '{other}' (the router sends to: openai)")),
    }
}

#[cfg(test)]
mod tests_openai;
