//! Tests of the registry, calls and handles together, as routes use them; the pool's own are in pool.rs. Not named
//! tests.rs: cargo llvm-cov leaves a file of that name out of its report, and the changed-line check would find it missing.

use super::*;
use std::panic::catch_unwind;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Barrier, Mutex};
use std::thread;
use std::time::Duration;

fn echo(payload: &[u8]) -> Reply {
    Ok(payload.to_vec())
}
fn refuse(_: &[u8]) -> Reply {
    Err("refused".into())
}
fn panics(_: &[u8]) -> Reply {
    panic!("a core bug")
}
/// Echoes who called, for a route that takes its call.
fn owner_of(_: &[u8], call: &Call) -> Reply {
    Ok(call.owner.to_string().into_bytes())
}
/// Panics, for a route that takes its call.
fn call_panics(_: &[u8], _: &Call) -> Reply {
    panic!("a core bug")
}
/// Runs until cancelled, as a long route does.
fn until_cancelled(_: &[u8], call: &Call) -> Reply {
    loop {
        call.cancel.check()?;
        thread::sleep(Duration::from_millis(1));
    }
}
/// Whether each of the two routes below, each used by one test, has begun.
static STOPPING_BEGAN: AtomicBool = AtomicBool::new(false);
static IGNORING_BEGAN: AtomicBool = AtomicBool::new(false);

/// Whether the plain route below ran.
static NOTED: AtomicBool = AtomicBool::new(false);

/// A plain route with an effect, as `proc.kill` has.
fn notes(_: &[u8]) -> Reply {
    NOTED.store(true, Ordering::SeqCst);
    Ok(Vec::new())
}

/// Says it began, then runs until cancelled.
fn stops_midway(_: &[u8], call: &Call) -> Reply {
    STOPPING_BEGAN.store(true, Ordering::SeqCst);
    until_cancelled(&[], call)
}
/// A route that sees the cancel and answers anyway, as one that finished first does.
fn ignores_cancel(_: &[u8], call: &Call) -> Reply {
    IGNORING_BEGAN.store(true, Ordering::SeqCst);
    while !call.cancel.is_cancelled() {
        thread::sleep(Duration::from_millis(1));
    }
    Ok(b"finished".to_vec())
}
inventory::submit! { Route { name: "test.echo", handler: echo } }
inventory::submit! { Route { name: "test.refuse", handler: refuse } }
inventory::submit! { Route { name: "test.panics", handler: panics } }
inventory::submit! { Route { name: "test.notes", handler: notes } }
inventory::submit! { CallRoute { name: "test.owner", handler: owner_of } }
inventory::submit! { CallRoute { name: "test.callPanics", handler: call_panics } }
inventory::submit! { CallRoute { name: "test.untilCancelled", handler: until_cancelled } }
inventory::submit! { CallRoute { name: "test.stopsMidway", handler: stops_midway } }
inventory::submit! { CallRoute { name: "test.ignoresCancel", handler: ignores_cancel } }

fn wait_for(flag: &AtomicBool) {
    while !flag.load(Ordering::SeqCst) {
        thread::yield_now();
    }
}

/// A call on the core's threads, and where its reply comes.
fn spawned(name: &str) -> (u64, Receiver<Reply>) {
    let (done, reply) = channel();
    let id = spawn(0, name.into(), Vec::new(), move |r| done.send(r).expect("the test waits"));
    (id, reply)
}

/// A pool of one thread, held until the returned gate is passed.
fn held_pool() -> (&'static pool::Pool, Arc<Barrier>) {
    let pool: &'static pool::Pool = Box::leak(Box::new(pool::Pool::new(1)));
    let gate = Arc::new(Barrier::new(2));
    let wait = gate.clone();
    pool.submit(Box::new(move || {
        wait.wait();
    }));
    (pool, gate)
}

#[test]
fn a_route_is_found_by_name_and_its_reply_or_error_comes_back() {
    assert_eq!(dispatch("test.echo", b"hi"), Ok(b"hi".to_vec()));
    assert_eq!(dispatch("test.refuse", b""), Err("refused".into()));
    assert_eq!(dispatch("test.nowhere", b""), Err("no core route test.nowhere".into()));
}

#[test]
fn a_route_that_takes_its_call_is_found_too_and_told_who_called() {
    assert_eq!(dispatch_call("test.owner", b"", &Call::of(7)), Ok(b"7".to_vec()));
    assert_eq!(dispatch("test.owner", b""), Ok(b"0".to_vec()), "nobody's");
}

#[test]
fn a_panicking_route_is_an_error_reply() {
    assert_eq!(dispatch("test.panics", b""), Err("core route test.panics panicked".into()));
    assert_eq!(dispatch("test.callPanics", b""), Err("core route test.callPanics panicked".into()));
}

#[test]
fn a_panicking_route_on_the_core_threads_is_an_error_reply_too() {
    let (_, reply) = spawned("test.panics");
    assert_eq!(reply.recv(), Ok(Err("core route test.panics panicked".into())));
}

#[test]
fn the_routes_are_listed_sorted() {
    assert_eq!(
        routes(),
        vec![
            "test.callPanics",
            "test.echo",
            "test.emitsOne",
            "test.ignoresCancel",
            "test.notes",
            "test.owner",
            "test.panics",
            "test.refuse",
            "test.stopsMidway",
            "test.untilCancelled"
        ]
    );
}

#[test]
fn a_cancelled_route_replies_with_the_distinct_error() {
    let (id, reply) = spawned("test.stopsMidway");
    wait_for(&STOPPING_BEGAN);
    assert!(cancel(id), "it was running");
    assert_eq!(reply.recv(), Ok(Err(CANCELLED.into())));
    assert!(!cancel(id), "and is no longer");
}

#[test]
fn a_route_that_finished_first_keeps_its_reply() {
    let (id, reply) = spawned("test.echo");
    assert_eq!(reply.recv(), Ok(Ok(Vec::new())));
    assert!(!cancel(id), "there is nothing to cancel by the time the reply is out");
}

#[test]
fn a_cancel_that_loses_the_race_to_the_end_of_the_route_changes_nothing() {
    let (id, reply) = spawned("test.ignoresCancel");
    wait_for(&IGNORING_BEGAN);
    assert!(cancel(id));
    assert_eq!(reply.recv(), Ok(Ok(b"finished".to_vec())), "the work was done: the reply says so");
}

#[test]
fn a_call_cancelled_before_a_thread_reached_it_never_runs() {
    let (pool, gate) = held_pool();
    let (done, reply) = channel();
    let id = calls::spawn_on(pool, 0, "test.panics".into(), Vec::new(), move |r| done.send(r).expect("the test waits"));
    assert!(cancel(id));
    gate.wait();
    assert_eq!(reply.recv(), Ok(Err(CANCELLED.into())), "not a panic: the route never ran");
}

#[test]
fn an_unknown_id_cancels_nothing() {
    assert!(!cancel(u64::MAX));
}

#[test]
fn an_owners_going_waits_for_a_plain_route_it_cannot_stop_and_lets_it_run() {
    let owner = new_owner();
    let (pool, gate) = held_pool();
    let (done, reply) = channel();
    calls::spawn_on(pool, owner, "test.notes".into(), Vec::new(), move |r| done.send(r).expect("the test waits"));
    let (tell, went) = channel();
    let release = thread::spawn(move || {
        release(owner);
        tell.send(()).expect("the test waits");
    });
    assert!(went.recv_timeout(Duration::from_millis(20)).is_err(), "it waits while the route has no thread");
    gate.wait();
    assert_eq!(reply.recv(), Ok(Ok(Vec::new())), "the route ran, and was not cancelled");
    release.join().expect("no panic");
    assert!(NOTED.load(Ordering::SeqCst));
}

#[test]
fn a_call_that_ran_is_cancelled_with_its_owner_and_others_are_not() {
    let (gone, kept) = (new_owner(), new_owner());
    let start = |owner: Owner| {
        let (done, reply): (Sender<Reply>, _) = channel();
        (spawn(owner, "test.untilCancelled".into(), Vec::new(), move |r| done.send(r).expect("the test waits")), reply)
    };
    let (_, stopped) = start(gone);
    let (other, running) = start(kept);
    release(gone);
    assert_eq!(stopped.recv(), Ok(Err(CANCELLED.into())));
    assert!(cancel(other), "the other owner's call was still running");
    assert_eq!(running.recv(), Ok(Err(CANCELLED.into())));
}

/// Records when a value is dropped, as a handle's cleanup would.
struct Tracked(Arc<Mutex<Vec<&'static str>>>, &'static str);

impl Drop for Tracked {
    fn drop(&mut self) {
        self.0.lock().expect("unpoisoned").push(self.1);
    }
}

#[test]
fn a_handle_opens_is_used_and_closes_with_its_cleanup() {
    static FAMILY: Handles<Tracked> = Handles::new("widget", 4);
    let log = Arc::new(Mutex::new(Vec::new()));
    let id = FAMILY.open(&Call::default(), Tracked(log.clone(), "a")).expect("room");
    assert_eq!(FAMILY.with(id, |t| t.1), Ok("a"));
    assert!(FAMILY.close(id));
    assert_eq!(*log.lock().expect("unpoisoned"), ["a"], "cleaned up by the time close returns");
    assert!(!FAMILY.close(id), "closing twice is no error");
    assert_eq!(FAMILY.with(id, |_| ()), Err(format!("no widget {id}")));
}

/// Says which thread dropped it.
struct Dropped(Sender<thread::ThreadId>);

impl Drop for Dropped {
    fn drop(&mut self) {
        self.0.send(thread::current().id()).expect("a listener");
    }
}

#[test]
fn a_big_familys_values_go_on_the_pool_however_they_are_let_go() {
    // made as the program runs: a static's is made as it compiles, which nothing can see run
    let family: &'static Handles<Dropped> = Box::leak(Box::new(Handles::big("boulder", 4)));
    let (told, dropped) = channel();
    let here = thread::current().id();
    let id = family.open(&Call::default(), Dropped(told.clone())).expect("room");
    assert!(family.close(id));
    assert_ne!(dropped.recv(), Ok(here));
    assert!(!family.close(id), "closing twice is no error");
    let owner = new_owner();
    family.open(&Call::of(owner), Dropped(told)).expect("room");
    release(owner);
    assert_ne!(dropped.recv(), Ok(here));
}

#[test]
fn an_open_past_the_limit_is_refused_and_closing_makes_room() {
    // made as the program runs, not as a static: a family needs no more than to last
    let family: &'static Handles<u8> = Box::leak(Box::new(Handles::new("gadget", 2)));
    let call = Call::default();
    let first = family.open(&call, 1).expect("room");
    let second = family.open(&call, 2).expect("room");
    assert_eq!(family.open(&call, 3), Err("too many gadgets open (2)".into()));
    assert_eq!((family.with(first, |v| *v), family.with(second, |v| *v)), (Ok(1), Ok(2)), "nothing open was taken");
    assert!(family.close(first));
    assert!(family.open(&call, 3).is_ok());
}

#[test]
fn an_owners_going_closes_its_handles_in_every_family_and_no_other() {
    static NUMBERS: Handles<u8> = Handles::new("number", 8);
    static NAMES: Handles<&str> = Handles::new("name", 8);
    let (gone, kept) = (new_owner(), new_owner());
    let number = NUMBERS.open(&Call::of(gone), 1).expect("room");
    let name = NAMES.open(&Call::of(gone), "x").expect("room");
    let other = NUMBERS.open(&Call::of(kept), 2).expect("room");
    release(gone);
    assert!(NUMBERS.with(number, |_| ()).is_err());
    assert!(NAMES.with(name, |_| ()).is_err());
    assert_eq!(NUMBERS.with(other, |v| *v), Ok(2));
}

#[test]
fn a_cancelled_call_opens_nothing() {
    static FAMILY: Handles<u8> = Handles::new("late", 8);
    let call = Call::of(new_owner());
    call.cancel.cancel();
    assert_eq!(FAMILY.open(&call, 1), Err(CANCELLED.into()));
    assert_eq!(FAMILY.slots().len(), 0);
}

#[test]
fn a_close_during_a_use_waits_for_nothing_and_the_value_goes_when_the_use_ends() {
    static FAMILY: Handles<Tracked> = Handles::new("busy", 4);
    let log = Arc::new(Mutex::new(Vec::new()));
    let id = FAMILY.open(&Call::default(), Tracked(log.clone(), "value")).expect("room");
    let (inside, entered) = channel();
    let (leave, gate) = channel::<()>();
    let (trace, using) = (
        log.clone(),
        thread::spawn(move || {
            FAMILY.with(id, |_| {
                inside.send(()).expect("the test waits");
                gate.recv().expect("the test releases it");
            })
        }),
    );
    entered.recv().expect("the use began");
    assert!(FAMILY.close(id), "close returned with the use still running");
    assert!(log.lock().expect("unpoisoned").is_empty(), "the value is still in use");
    assert_eq!(FAMILY.with(id, |_| ()), Err(format!("no busy {id}")), "no use starts after close");
    leave.send(()).expect("the use waits");
    assert_eq!(using.join().expect("no panic"), Ok(()));
    assert_eq!(*trace.lock().expect("unpoisoned"), ["value"]);
}

#[test]
fn a_use_queued_behind_a_close_finds_the_handle_gone() {
    static FAMILY: Handles<u8> = Handles::new("queued", 4);
    let id = FAMILY.open(&Call::default(), 1).expect("room");
    let (inside, entered) = channel();
    let (leave, gate) = channel::<()>();
    let holder = thread::spawn(move || {
        FAMILY.with(id, |_| {
            inside.send(()).expect("the test waits");
            gate.recv().expect("the test releases it");
        })
    });
    entered.recv().expect("the use began");
    let waiter = thread::spawn(move || FAMILY.with(id, |_| ()));
    // the map, the use and the waiter: the waiter holds the slot, and waits behind the use
    while FAMILY.slots().get(&id).map_or(0, Arc::strong_count) < 3 {
        thread::yield_now();
    }
    assert!(FAMILY.close(id));
    leave.send(()).expect("the use waits");
    assert_eq!(holder.join().expect("no panic"), Ok(()));
    assert_eq!(waiter.join().expect("no panic"), Err(format!("no queued {id}")));
}

#[test]
fn a_use_that_panics_closes_the_handle() {
    static FAMILY: Handles<u8> = Handles::new("fragile", 4);
    let id = FAMILY.open(&Call::default(), 1).expect("room");
    assert!(catch_unwind(|| FAMILY.with(id, |_| panic!("a core bug"))).is_err());
    assert_eq!(FAMILY.with(id, |_| ()), Err(format!("fragile {id} broke and was closed")));
    assert_eq!(FAMILY.with(id, |_| ()), Err(format!("no fragile {id}")));
}

#[test]
fn handles_of_one_family_do_not_wait_on_each_other() {
    static FAMILY: Handles<u8> = Handles::new("parallel", 4);
    let (one, two) = (FAMILY.open(&Call::default(), 1).expect("room"), FAMILY.open(&Call::default(), 2).expect("room"));
    let result = FAMILY.with(one, |_| FAMILY.with(two, |v| *v));
    assert_eq!(result, Ok(Ok(2)));
}
