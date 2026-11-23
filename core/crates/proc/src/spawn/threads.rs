//! The threads a harness child's stdio runs on (`spawn`): started with signals blocked and a small stack, each waiting to
//! be fed what it works on, so a spawn that fails leaves threads that just end.

use super::stdio;
use std::io;
use std::sync::mpsc::{channel, Sender};
use std::thread;

/// The threads hold a read buffer on the heap and do little else.
const STACK_BYTES: usize = 256 << 10;

pub(super) type Job = Box<dyn FnOnce() + Send>;
/// How a thread starts: a test's may refuse.
pub(super) type Start = fn(Job) -> io::Result<()>;

pub(super) fn start_thread(job: Job) -> io::Result<()> {
    let job = move || {
        stdio::block_signals();
        job();
    };
    thread::Builder::new().name("mopilot-child".into()).stack_size(STACK_BYTES).spawn(job).map(drop)
}

/// A thread that does `job` once it is fed, and ends if it never is.
pub(super) fn fed<T: Send + 'static>(start: Start, job: impl FnOnce(T) + Send + 'static) -> io::Result<Sender<T>> {
    let (feed, input) = channel();
    start(Box::new(move || {
        if let Ok(value) = input.recv() {
            job(value);
        }
    }))?;
    Ok(feed)
}
