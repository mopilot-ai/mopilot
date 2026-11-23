//! The core's ordered stream (docs/architecture/rust-core.md §4): what a route says to JS while it runs, and every call's
//! reply, which must not overtake it. Each JS environment has at most one stream, and a message comes out in the order it went
//! in, so a call's reply follows every event that call emitted before it ended. Events of calls running at once
//! interleave. Sending never blocks and never waits on JS, which `end_calls` relies on, and the lock is held for the
//! send so that a stream's end can't free what a core thread is calling into.

use crate::calls::Owner;
use crate::Reply;
use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// One message of a stream. `ticket` says, to whoever attached the stream, which caller a reply is for.
#[derive(Debug, PartialEq)]
pub enum Message {
    Event(Vec<u8>),
    Reply { ticket: usize, reply: Reply },
}

/// Where a stream's messages go. It must not block: it runs under the lock of every stream.
type Sink = Box<dyn Fn(Message) + Send>;

static STREAMS: Mutex<BTreeMap<Owner, Sink>> = Mutex::new(BTreeMap::new());

fn streams() -> MutexGuard<'static, BTreeMap<Owner, Sink>> {
    STREAMS.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Give `owner` its stream: false, changing nothing, when it has one.
pub fn attach(owner: Owner, sink: impl Fn(Message) + Send + 'static) -> bool {
    let mut streams = streams();
    if streams.contains_key(&owner) {
        return false;
    }
    streams.insert(owner, Box::new(sink));
    true
}

/// `owner`'s stream ends. Once this returns no thread is inside its sink, or will be.
pub fn detach(owner: Owner) {
    streams().remove(&owner);
}

/// Send `message` on `owner`'s stream: false when it has none, and the message is dropped.
pub(crate) fn send(owner: Owner, message: Message) -> bool {
    streams().get(&owner).map(|sink| sink(message)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{dispatch_call, new_owner, release, spawn_ordered, Call};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::channel;
    use std::sync::Arc;
    use std::thread;

    /// A sink that counts what reaches it.
    fn counted(count: &Arc<AtomicUsize>) -> impl Fn(Message) + Send + 'static {
        let count = count.clone();
        move |_| {
            count.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn an_owner_has_one_stream_until_it_detaches() {
        let owner = new_owner();
        let (first, second) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        assert!(attach(owner, counted(&first)));
        assert!(!attach(owner, counted(&second)));
        assert!(send(owner, Message::Event(Vec::new())));
        assert_eq!((first.load(Ordering::SeqCst), second.load(Ordering::SeqCst)), (1, 0));
        detach(owner);
        assert!(!send(owner, Message::Event(Vec::new())));
        assert!(attach(owner, counted(&second)));
        assert!(send(owner, Message::Event(Vec::new())));
        assert_eq!(second.load(Ordering::SeqCst), 1);
        detach(owner);
    }

    #[test]
    fn an_event_with_nobody_listening_is_dropped_and_says_so() {
        assert!(!Call::default().emit(b"to nobody".to_vec()));
        assert!(!Call::of(new_owner()).emit(b"to no stream".to_vec()));
    }

    #[test]
    fn messages_keep_the_order_they_went_in() {
        let owner = new_owner();
        let (out, messages) = channel();
        attach(owner, move |message| out.send(message).unwrap());
        let call = Call::of(owner);
        for i in 0..3u8 {
            assert!(call.emit(vec![i]));
        }
        send(owner, Message::Reply { ticket: 7, reply: Ok(vec![9]) });
        detach(owner);
        let got: Vec<_> = messages.iter().collect();
        let events = (0..3u8).map(|i| Message::Event(vec![i]));
        assert_eq!(got, events.chain([Message::Reply { ticket: 7, reply: Ok(vec![9]) }]).collect::<Vec<_>>());
    }

    #[test]
    fn an_owners_going_ends_its_stream() {
        let owner = new_owner();
        attach(owner, counted(&Arc::new(AtomicUsize::new(0))));
        release(owner);
        assert!(!Call::of(owner).emit(Vec::new()));
    }

    #[test]
    fn nothing_is_inside_a_sink_once_detach_returns() {
        let owner = new_owner();
        let inside = Arc::new(AtomicUsize::new(0));
        let entered = Arc::new(AtomicUsize::new(0));
        let (sink_inside, sink_entered) = (inside.clone(), entered.clone());
        attach(owner, move |_| {
            sink_inside.fetch_add(1, Ordering::SeqCst);
            sink_entered.fetch_add(1, Ordering::SeqCst);
            thread::yield_now();
            sink_inside.fetch_sub(1, Ordering::SeqCst);
        });
        let senders: Vec<_> = (0..4)
            .map(|_| {
                thread::spawn(move || {
                    let call = Call::of(owner);
                    while call.emit(Vec::new()) {}
                })
            })
            .collect();
        // only once the senders are in and out of the sink does this say anything
        while entered.load(Ordering::SeqCst) < 100 {
            thread::yield_now();
        }
        detach(owner);
        assert_eq!(inside.load(Ordering::SeqCst), 0);
        senders.into_iter().for_each(|sender| sender.join().unwrap());
    }

    #[test]
    fn a_panic_in_a_sink_leaves_other_streams_working() {
        let (bad, good) = (new_owner(), new_owner());
        attach(bad, |_| panic!("a sink bug"));
        attach(good, counted(&Arc::new(AtomicUsize::new(0))));
        assert!(thread::spawn(move || send(bad, Message::Event(Vec::new()))).join().is_err());
        assert!(send(good, Message::Event(Vec::new())));
        detach(bad);
        detach(good);
    }

    fn emits_one(_: &[u8], call: &Call) -> Reply {
        call.emit(b"event".to_vec());
        Ok(b"reply".to_vec())
    }
    inventory::submit! { crate::CallRoute { name: "test.emitsOne", handler: emits_one } }

    #[test]
    fn a_route_called_in_order_puts_its_reply_behind_its_events() {
        let owner = new_owner();
        let (out, messages) = channel();
        attach(owner, move |message| out.send(message).unwrap());
        spawn_ordered(owner, "test.emitsOne".into(), Vec::new(), 5);
        assert_eq!(messages.recv().unwrap(), Message::Event(b"event".to_vec()));
        assert_eq!(messages.recv().unwrap(), Message::Reply { ticket: 5, reply: Ok(b"reply".to_vec()) });
        // the same route on the calling thread only emits: its reply is the caller's, at once
        assert_eq!(dispatch_call("test.emitsOne", &[], &Call::of(owner)), Ok(b"reply".to_vec()));
        assert_eq!(messages.recv().unwrap(), Message::Event(b"event".to_vec()));
        detach(owner);
    }
}
