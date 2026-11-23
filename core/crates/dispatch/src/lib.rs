//! The core's route registry (docs/architecture/rust-core.md §3): each crate submits the routes it serves with
//! `inventory::submit!`, and `dispatch` finds one by name, so no central match grows as crates are added. What a call
//! needs beyond its route lives beside it: the threads (`pool`), a call's id and cancellation (`calls`), state kept
//! between calls (`handles`), and what a call says to JS as it runs (`stream`).

use std::panic::{catch_unwind, AssertUnwindSafe};

mod calls;
mod handles;
pub mod pool;
pub mod stream;

pub use calls::{cancel, new_owner, Call, CancelToken, Owner, CANCELLED};
pub use handles::{release, Handles};

/// A route's answer: its reply bytes, or its error.
pub type Reply = Result<Vec<u8>, String>;

/// One route: its name (`<crate>.<call>`) and the handler that turns a payload into a reply.
pub struct Route {
    pub name: &'static str,
    pub handler: fn(&[u8]) -> Reply,
}

/// A route that also takes its call: to stop when cancelled, or to open handles for its owner.
pub struct CallRoute {
    pub name: &'static str,
    pub handler: fn(&[u8], &Call) -> Reply,
}

inventory::collect!(Route);
inventory::collect!(CallRoute);

/// The reply of route `name` to `payload`, for a call that nobody owns or can cancel.
pub fn dispatch(name: &str, payload: &[u8]) -> Reply {
    dispatch_call(name, payload, &Call::default())
}

/// The reply of route `name` to `payload` in `call`, on this thread. An unknown route is an error, and so is a handler
/// that panics: a core bug never takes down the process that loaded it.
pub fn dispatch_call(name: &str, payload: &[u8], call: &Call) -> Reply {
    let answer = if let Some(route) = inventory::iter::<Route>.into_iter().find(|r| r.name == name) {
        catch_unwind(AssertUnwindSafe(|| (route.handler)(payload)))
    } else if let Some(route) = inventory::iter::<CallRoute>.into_iter().find(|r| r.name == name) {
        catch_unwind(AssertUnwindSafe(|| (route.handler)(payload, call)))
    } else {
        return Err(format!("no core route {name}"));
    };
    answer.unwrap_or_else(|_| Err(format!("core route {name} panicked")))
}

/// Whether route `name` takes its call.
fn takes_call(name: &str) -> bool {
    inventory::iter::<CallRoute>.into_iter().any(|r| r.name == name)
}

/// Run route `name` on the core's threads for `owner`; `done` gets the reply there. Returns the call's id, for `cancel`.
pub fn spawn(owner: Owner, name: String, payload: Vec<u8>, done: impl FnOnce(Reply) + Send + 'static) -> u64 {
    calls::spawn_on(&pool::POOL, owner, name, payload, done)
}

/// Run route `name` on the core's threads for `owner`, its reply going down `owner`'s stream with `ticket`, behind every
/// event the call emitted. Returns the call's id, for `cancel`.
pub fn spawn_ordered(owner: Owner, name: String, payload: Vec<u8>, ticket: usize) -> u64 {
    spawn(owner, name, payload, move |reply| {
        stream::send(owner, stream::Message::Reply { ticket, reply });
    })
}

/// Every route's name, sorted: what the binding's tests check against.
pub fn routes() -> Vec<&'static str> {
    let plain = inventory::iter::<Route>.into_iter().map(|r| r.name);
    let mut names: Vec<_> = plain.chain(inventory::iter::<CallRoute>.into_iter().map(|r| r.name)).collect();
    names.sort_unstable();
    names
}

#[cfg(test)]
mod scenarios;
