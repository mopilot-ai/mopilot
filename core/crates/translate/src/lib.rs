//! ACP session updates translated into a thread's turns and items, for every window and for history (the one implementation:
//! electron/harness/items/acpTranslator.cjs only calls it). `translator` is the state a native session keeps, held by id;
//! `replay` runs a transcript through one and folds what it says into finished turns. An adapter is a third party, so
//! nothing here assumes the shape of what it sends: `jsvalue` reads it as `JSON.parse` did, each helper reads it as the JS
//! did, and what the JS threw on is a `Result`'s `Err`, with what the event said so far still going out.
//!
//! The item helpers `tools`, `edits`, `blocks`, `stop` and `compaction` still have a JS side, for the window's approval
//! cards and main's own reading of a stop: `tests/fixtures/core/translate/helpers/` holds the two to one answer (`parity`,
//! and tests/translateHelpers.parity.test.ts). `agents`' `parent_of` is the stream batcher's too (core/crates/batcher).

use dispatch::{Call, Handles};
use jsvalue::value::Object;

mod agents;
pub use agents::parent_of;
mod blocks;
mod claude;
mod compaction;
mod edits;
mod emit;
mod history;
mod ordered;
mod reads;
mod replay;
mod routes;
mod stop;
mod stream;
mod tools;
mod translator;
mod turns;

use translator::Translator;

/// One a native session and a few a remote client's: this bounds what a leak can hold.
static TRANSLATORS: Handles<Translator> = Handles::big("translator", 4096);

/// What JS threw: the message of an input the language would not take.
type Thrown = String;

/// Hold a new translator for `call`'s owner: its id.
fn open(call: &Call, header: &Object) -> Result<u64, String> {
    TRANSLATORS.open(call, Translator::new(header))
}

fn close(id: u64) -> bool {
    TRANSLATORS.close(id)
}

#[cfg(test)]
mod parity;

#[cfg(test)]
mod scenarios;
