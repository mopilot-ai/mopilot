//! Stateful handles (docs/architecture/rust-core.md §3): state a route keeps between calls, opened, used by id and closed.
//!
//! - A family is one `static Handles<T>`, bounded: an open past its limit is refused, and nothing open is taken away.
//! - Dropping the value is the cleanup. `close` and the owner's going never wait on a use in progress: the value goes when
//!   that use ends, and no use starts after.
//! - A family of `big` values drops them on the pool: `close` may be on the JS thread, and a drop of a chat's worth of small
//!   allocations costs that thread what parsing them would. A family whose drop is a cleanup someone waits on stays `new`.
//! - A handle belongs to the owner that opened it, and goes with them, so a JS environment that ends without closing
//!   (a terminated worker) leaves nothing behind.
//! - Uses of one handle run one at a time; uses of different handles do not wait on each other. A use that panics
//!   leaves its handle broken, and the next use closes it and says so.

use crate::calls::{Call, Owner};
use crate::pool::POOL;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Once, PoisonError};

pub(crate) struct Slot<T> {
    owner: Owner,
    closed: AtomicBool,
    value: Mutex<T>,
}

/// One family of handles, as a `static`: `kind` names one in errors, and `limit` is how many may be open at once.
pub struct Handles<T> {
    kind: &'static str,
    limit: usize,
    big: bool,
    next: AtomicU64,
    slots: Mutex<BTreeMap<u64, Arc<Slot<T>>>>,
    listed: Once,
}

/// A family, whatever its type, as an owner's going reaches it.
trait Family: Sync {
    fn release(&self, owner: Owner);
}

/// The families with anything ever opened: each lists itself, so one can't be forgotten.
static FAMILIES: Mutex<Vec<&'static dyn Family>> = Mutex::new(Vec::new());

fn families() -> MutexGuard<'static, Vec<&'static dyn Family>> {
    FAMILIES.lock().unwrap_or_else(PoisonError::into_inner)
}

impl<T: Send + 'static> Handles<T> {
    pub const fn new(kind: &'static str, limit: usize) -> Self {
        Handles { kind, limit, big: false, next: AtomicU64::new(1), slots: Mutex::new(BTreeMap::new()), listed: Once::new() }
    }

    /// A family whose values take time to drop, and nothing depends on when: they go on the pool.
    pub const fn big(kind: &'static str, limit: usize) -> Self {
        Handles { kind, limit, big: true, next: AtomicU64::new(1), slots: Mutex::new(BTreeMap::new()), listed: Once::new() }
    }

    pub(crate) fn slots(&self) -> MutexGuard<'_, BTreeMap<u64, Arc<Slot<T>>>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn missing(&self, id: u64) -> String {
        format!("no {} {id}", self.kind)
    }

    /// Hold `value` for `call`'s owner: its id, or why not. A call cancelled by now is refused: its owner may have gone
    /// already, and would never close what this opened.
    pub fn open(&'static self, call: &Call, value: T) -> Result<u64, String> {
        self.listed.call_once(|| families().push(self));
        let mut slots = self.slots();
        call.cancel.check()?;
        if slots.len() >= self.limit {
            return Err(format!("too many {}s open ({})", self.kind, self.limit));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        slots.insert(id, Arc::new(Slot { owner: call.owner, closed: AtomicBool::new(false), value: Mutex::new(value) }));
        Ok(id)
    }

    /// `f`'s result on handle `id`, or why it can't be used. A panic in `f` goes on up (the route's `catch_unwind` makes
    /// it an error reply), and the handle is closed by the next use to find it so.
    pub fn with<R>(&self, id: u64, f: impl FnOnce(&mut T) -> R) -> Result<R, String> {
        let slot = self.slots().get(&id).cloned().ok_or_else(|| self.missing(id))?;
        let Ok(mut value) = slot.value.lock() else {
            self.close(id);
            return Err(format!("{} {id} broke and was closed", self.kind));
        };
        if slot.closed.load(Ordering::SeqCst) {
            return Err(self.missing(id));
        }
        Ok(f(&mut value))
    }

    /// Let handle `id` go; whether it was open.
    pub fn close(&self, id: u64) -> bool {
        // out of the map first: a value's drop may take time, and no other handle waits on it
        let Some(slot) = self.slots().remove(&id) else { return false };
        slot.closed.store(true, Ordering::SeqCst);
        if self.big {
            POOL.submit(Box::new(move || drop(slot)));
        }
        true
    }
}

impl<T: Send + 'static> Family for Handles<T> {
    fn release(&self, owner: Owner) {
        let ids: Vec<u64> = self.slots().iter().filter(|(_, slot)| slot.owner == owner).map(|(id, _)| *id).collect();
        for id in ids {
            self.close(id);
        }
    }
}

/// `owner` is going: its calls stop or finish, and its handles go. Calls first: `open` checks its token holding the
/// family's lock, so one call either opens before this reaches that family, and is released, or is refused.
pub fn release(owner: Owner) {
    crate::calls::end_calls(owner);
    let all = families().clone();
    all.iter().for_each(|family| family.release(owner));
    crate::stream::detach(owner);
}
