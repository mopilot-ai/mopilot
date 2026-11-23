//! JSON-lines logs written off the JS thread (`electron/platform/transcriptWriter.cjs`): chat transcripts, the operation
//! log and the access log. A writer is held by id; what it reports comes back on the owner's stream.

use dispatch::Handles;
use std::sync::Arc;

mod disk;
mod read;
mod routes;
mod scan;
mod writer;

pub use disk::{Disk, RealDisk};
pub use read::{audio_names, checkpoints, contains, head};
pub use scan::{scan, Scan};
pub use writer::{Event, Meta, Options, Why, Writer};

#[cfg(test)]
mod tests_disk;
#[cfg(test)]
mod tests_waits;

/// The most writers open at once: the app makes a few, and every ItemsLog a test makes is one until it is collected.
const MAX_WRITERS: usize = 1024;

static WRITERS: Handles<Arc<Writer>> = Handles::new("writer", MAX_WRITERS);

/// The writer `id`, out of its handle: a use must not hold the handle, as a read on the pool would keep the JS thread's next
/// `append` waiting for the disk.
fn writer(id: u64) -> Result<Arc<Writer>, String> {
    WRITERS.with(id, |writer| writer.clone())
}
