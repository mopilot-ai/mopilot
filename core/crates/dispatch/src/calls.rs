//! A dispatched call's lifetime (docs/architecture/rust-core.md §3): what a route is told about its call, the calls still
//! running by id, and how one is cancelled. Cancelling asks, and the reply decides: a call not started yet never runs, a
//! route that reads its token stops with `CANCELLED`, and a route that finished first keeps its reply. An owner's going
//! cancels only routes that read their token: a plain route can't be told to stop, and may be one the app relies on to
//! finish, such as `proc.kill` as it quits, so the owner waits for it.

use crate::pool::Pool;
use crate::Reply;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

/// The error of a call that stopped because it was cancelled: the binding tells it from any other by this text.
pub const CANCELLED: &str = "the core call was cancelled";

/// Who a call came from, so what it leaves behind goes when they do. Each JS environment is one; 0 is nobody.
pub type Owner = u64;

/// A new owner.
pub fn new_owner() -> Owner {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// A call's cancellation, shared with whoever may cancel it. A route may clone it for threads of its own.
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `CANCELLED` once cancelled: for a long route to `?` between steps.
    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(CANCELLED.into())
        } else {
            Ok(())
        }
    }
}

/// What a route that takes its call (`CallRoute`) is told. A synchronous call's token is never cancelled.
#[derive(Clone, Debug, Default)]
pub struct Call {
    pub cancel: CancelToken,
    pub owner: Owner,
}

impl Call {
    pub fn of(owner: Owner) -> Self {
        Call { owner, ..Call::default() }
    }

    /// Send `bytes` to JS on this call's owner's stream, ahead of the call's reply. False
    /// when the owner has no stream, or is nobody: nobody is listening, and the event is dropped.
    pub fn emit(&self, bytes: Vec<u8>) -> bool {
        crate::stream::send(self.owner, crate::stream::Message::Event(bytes))
    }
}

/// A call running or waiting for a thread.
struct Running {
    call: Call,
    /// its route takes its call, so it can be told to stop
    stoppable: bool,
}

/// The calls running or waiting for a thread, by id, and the signal that one ended.
static CALLS: Mutex<BTreeMap<u64, Running>> = Mutex::new(BTreeMap::new());
static ENDED: Condvar = Condvar::new();

fn calls() -> MutexGuard<'static, BTreeMap<u64, Running>> {
    CALLS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Run route `name` on `pool` for `owner`; `done` gets its reply on that thread. Returns the call's id, which leaves the
/// running calls before `done` is called, so a cancel that comes after the reply finds nothing.
pub(crate) fn spawn_on(
    pool: &'static Pool,
    owner: Owner,
    name: String,
    payload: Vec<u8>,
    done: impl FnOnce(Reply) + Send + 'static,
) -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let call = Call::of(owner);
    calls().insert(id, Running { call: call.clone(), stoppable: crate::takes_call(&name) });
    pool.submit(Box::new(move || {
        let reply = call.cancel.check().and_then(|()| crate::dispatch_call(&name, &payload, &call));
        calls().remove(&id);
        ENDED.notify_all();
        done(reply);
    }));
    id
}

/// Ask call `id` to stop: whether it was still running. Its reply says how it ended.
pub fn cancel(id: u64) -> bool {
    calls().get(&id).map(|running| running.call.cancel.cancel()).is_some()
}

/// `owner` is going: stop its calls that can be stopped, and wait for those that can't. Nothing a core thread runs waits
/// on JS, so this ends once a thread has reached each of them.
pub(crate) fn end_calls(owner: Owner) {
    let mut running = calls();
    running.values().filter(|r| r.call.owner == owner && r.stoppable).for_each(|r| r.call.cancel.cancel());
    while running.values().any(|r| r.call.owner == owner && !r.stoppable) {
        running = ENDED.wait(running).unwrap_or_else(PoisonError::into_inner);
    }
}
