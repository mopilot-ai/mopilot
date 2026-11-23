//! A child's life through the routes, with a stream as JS has one: a real process wherever the behaviour is the OS's.

use super::routes::spawn_with;
use super::threads::Job;
use super::*;
use dispatch::stream::{attach, detach, Message};
use dispatch::{dispatch, dispatch_call, new_owner, release};
use std::sync::mpsc::{channel, Receiver};
use std::sync::Weak;
use std::thread;

#[cfg(all(unix, not(target_os = "macos")))]
mod forked;
#[cfg(unix)]
mod posix;
#[cfg(windows)]
mod windows;

const LONG: Duration = Duration::from_secs(20);

/// An event, as coreChild.cjs reads it.
#[derive(Debug, PartialEq)]
struct Heard {
    kind: u8,
    id: u64,
    bytes: Vec<u8>,
}

fn decoded(event: Vec<u8>) -> Heard {
    assert_eq!(event[0], MARK);
    let mut id = [0; 8];
    id[..6].copy_from_slice(&event[2..8]);
    Heard { kind: event[1], id: u64::from_le_bytes(id), bytes: event[8..].to_vec() }
}

/// What JS would be: a stream for one owner, and every event that came down it.
/// What a test hears of a message: an event decoded, or a reply by its ticket.
fn heard_of(message: Message) -> Heard {
    match message {
        Message::Event(bytes) => decoded(bytes),
        Message::Reply { ticket, .. } => Heard { kind: ticket as u8, id: 0, bytes: Vec::new() },
    }
}

struct Listener {
    call: Call,
    events: Receiver<Heard>,
}

impl Listener {
    fn new() -> Self {
        let owner = new_owner();
        let (sink, events) = channel();
        attach(owner, move |message| {
            // a test that stopped listening leaves the rest of its child's events unread
            let _ = sink.send(heard_of(message));
        });
        Listener { call: Call::of(owner), events }
    }

    fn next(&self) -> Heard {
        self.events.recv_timeout(LONG).expect("the child's next event")
    }

    /// Events until one of `kind`, which is returned last.
    fn until(&self, kind: u8) -> Vec<Heard> {
        let mut heard = vec![self.next()];
        while heard[heard.len() - 1].kind != kind {
            heard.push(self.next());
        }
        heard
    }

    /// The same as JS's reader sees it: everything is taken as it comes.
    #[cfg(unix)]
    fn taking_until(&self, kind: u8) -> Vec<Heard> {
        let mut heard = Vec::new();
        loop {
            let next = self.next();
            if next.kind < OUTPUT_END || next.kind == LINES {
                let amount = next.bytes.len() + CHUNK_COST;
                let output = if next.kind == LINES { 0 } else { next.kind };
                dispatch("proc.ack", format!("{} {output} {amount}", next.id).as_bytes()).expect("taken");
            }
            // a framed line that fills the window is wanted, as JS's reader wants it
            if next.kind == ASK {
                let ask = u64::from_le_bytes(next.bytes[..8].try_into().expect("the ask's number"));
                dispatch("proc.want", format!("{} {ask}", next.id).as_bytes()).expect("wanted");
            }
            let done = next.kind == kind;
            heard.push(next);
            if done {
                return heard;
            }
        }
    }

    fn spawn(&self, spec: &Spec) -> Started {
        launch(spec, &self.call, start_thread).expect("it starts")
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        release(self.call.owner);
        detach(self.call.owner);
    }
}

/// `command args` with nothing but what a test adds.
pub(super) fn spec(command: &str, args: &[&str]) -> Spec {
    Spec {
        command: command.into(),
        args: args.iter().map(ToString::to_string).collect(),
        cwd: None,
        env: vec![("PATH".into(), std::env::var("PATH").expect("a PATH"))],
        stderr: true,
        group: true,
        hide: true,
        verbatim: false,
        lines: None,
    }
}

/// The lines of `LINES` events, in order, and whether one was too long.
fn lines_of(heard: &[Heard]) -> (Vec<Vec<u8>>, bool) {
    let mut lines = Vec::new();
    let mut too_long = false;
    for event in heard.iter().filter(|h| h.kind == LINES) {
        let mut at = 0;
        while at < event.bytes.len() {
            let len = u64::from_le_bytes(event.bytes[at..at + 8].try_into().expect("a length"));
            if len == framing::TOO_LONG {
                too_long = true;
                break;
            }
            lines.push(event.bytes[at + 8..at + 8 + len as usize].to_vec());
            at += 8 + len as usize;
        }
    }
    (lines, too_long)
}

#[cfg(unix)]
fn sh(script: &str) -> Spec {
    spec("sh", &["-c", script])
}

/// The bytes of the events of `kind`.
fn bytes_of(heard: &[Heard], kind: u8) -> Vec<u8> {
    heard.iter().filter(|h| h.kind == kind).flat_map(|h| h.bytes.clone()).collect()
}

/// Every thread of the child ended and let it go.
fn gone(child: &Weak<Child>) {
    let ended = (0..4000).any(|_| {
        thread::sleep(Duration::from_millis(5));
        child.strong_count() == 0
    });
    assert!(ended);
}

fn exit_in(heard: &[Heard]) -> serde_json::Value {
    let exit = heard.iter().find(|h| h.kind == EXIT).expect("an exit");
    serde_json::from_slice(&exit.bytes).expect("JSON")
}

#[test]
fn a_read_that_is_interrupted_goes_on_and_one_that_fails_ends_the_output() {
    struct Reads(Vec<io::Result<&'static [u8]>>);
    impl Read for Reads {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let bytes = self.0.remove(0)?;
            buffer[..bytes.len()].copy_from_slice(bytes);
            Ok(bytes.len())
        }
    }
    let listener = Listener::new();
    let child = quiet_child(&listener);
    child.lock().open = 1;
    child.read_output(
        0,
        Reads(vec![Ok(b"a"), Err(io::ErrorKind::Interrupted.into()), Ok(b"b"), Err(io::ErrorKind::ConnectionReset.into())]),
        None,
    );
    assert_eq!(listener.next().bytes, b"a");
    assert_eq!(listener.next().bytes, b"b");
    assert_eq!(listener.next().kind, OUTPUT_END);
    assert_eq!(child.lock().open, 0);

    // nobody listening: the first read is the last
    let nobody = Arc::new(Child::new(&Call::default(), quiet_stop()));
    nobody.lock().open = 1;
    nobody.read_output(1, &[1u8, 2, 3][..], None);
    assert_eq!(nobody.lock().open, 0);
}

/// Reads of exactly these bytes, one at a time.
struct Pieces(Vec<&'static [u8]>);

impl Read for Pieces {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.0.is_empty() {
            return Ok(0);
        }
        let bytes = self.0.remove(0);
        buffer[..bytes.len()].copy_from_slice(bytes);
        Ok(bytes.len())
    }
}

/// A line of `len` bytes of `x` read a chunk at a time, then its newline; what has been read is counted.
struct LongLine {
    left: usize,
    read: Arc<std::sync::atomic::AtomicUsize>,
}

impl Read for LongLine {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let n = match self.left {
            0 => 0,
            1 => {
                buffer[0] = b'\n';
                1
            }
            left => {
                let n = buffer.len().min(left - 1);
                buffer[..n].fill(b'x');
                n
            }
        };
        self.left -= n;
        self.read.fetch_add(n, Ordering::SeqCst);
        Ok(n)
    }
}

#[test]
fn a_framed_line_still_arriving_fills_the_window_until_js_wants_it_and_then_comes_whole() {
    let listener = Listener::new();
    let child = quiet_child(&listener);
    child.lock().open = 1;
    let read = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let len = 3 * WINDOW;
    let reader = thread::spawn({
        let (child, read) = (child.clone(), read.clone());
        move || child.read_output(0, LongLine { left: len + 1, read }, Some(Framer::new(None)))
    });
    // nothing was sent, so nothing can be acknowledged: the line alone filled the window, and JS is asked
    let ask = listener.next();
    assert_eq!((ask.kind, ask.bytes.as_slice()), (ASK, &1u64.to_le_bytes()[..]));
    let held = read.load(Ordering::SeqCst);
    assert!((WINDOW..WINDOW + CHUNK).contains(&held), "{held} bytes read before the reader stopped");
    // a wake that brings no want leaves it waiting, and asks nothing more; nor does stderr's output, nor a want of
    // another ask (one that came after its own line ended)
    child.ack(0, 0);
    assert!(child.output(1, b"err", None));
    assert_eq!(listener.next().kind, 1, "stderr's chunk");
    for stale in [0, 2] {
        child.want(stale);
    }
    child.ack(0, 0);
    assert!(listener.events.recv_timeout(Duration::from_millis(50)).is_err());
    assert_eq!(read.load(Ordering::SeqCst), held);
    child.want(1);
    let line = listener.next();
    assert_eq!(lines_of(std::slice::from_ref(&line)), (vec![vec![b'x'; len]], false));
    // the whole line is charged, so the reader waits for JS to take it before it reads on to the end
    child.ack(0, line.bytes.len() + CHUNK_COST);
    assert_eq!(listener.next().kind, OUTPUT_END, "asked once");
    let state = child.lock();
    assert_eq!((state.demand.wanted, state.demand.asked), (false, false), "the next long line asks again");
    drop(state);
    reader.join().expect("the reader ends");
}

#[test]
fn a_framed_stdout_js_destroyed_drops_what_comes_and_keeps_no_line() {
    let listener = Listener::new();
    let child = quiet_child(&listener);
    child.lock().open = 1;
    let read = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let len = 4 * WINDOW;
    let reader = thread::spawn({
        let (child, read) = (child.clone(), read.clone());
        move || child.read_output(0, LongLine { left: len + 1, read }, Some(Framer::new(None)))
    });
    assert_eq!(listener.next().kind, ASK);
    child.drop_lines();
    // all of it is read and none of it told: the line, newline and all, went nowhere
    assert_eq!(listener.next().kind, OUTPUT_END);
    assert_eq!(read.load(Ordering::SeqCst), len + 1);
    assert_eq!(child.lock().charged[0], 0, "nothing was sent to be taken");
    reader.join().expect("the reader ends");
    // a want of a line nobody asked about is none
    let idle = quiet_child(&listener);
    idle.want(1);
    assert!(!idle.lock().demand.wanted);
}

#[test]
fn framed_stdout_tells_the_lines_each_read_ended_charged_as_js_holds_them() {
    let listener = Listener::new();
    let child = quiet_child(&listener);
    child.lock().open = 1;
    let before = child.lock().last_read;
    child.read_output(0, Pieces(vec![b"{\"a\"", b":1}\n\n{", b"}\r\nunterminated"]), Some(Framer::new(None)));
    let heard = listener.until(OUTPUT_END);
    assert_eq!(heard.iter().map(|h| h.kind).collect::<Vec<_>>(), [LINES, LINES, OUTPUT_END], "a read that ended no line told nothing");
    assert_eq!(lines_of(&heard), (vec![b"{\"a\":1}".to_vec(), b"".to_vec(), b"{}\r".to_vec()], false));
    let charged: usize = heard.iter().filter(|h| h.kind == LINES).map(|h| h.bytes.len() + CHUNK_COST).sum();
    assert_eq!(child.lock().charged[0], charged);
    assert!(child.lock().last_read > before, "a read is a read, framed or not");

    // a line past the limit is told after the lines before it, and what comes after is read and dropped
    let listener = Listener::new();
    let child = quiet_child(&listener);
    child.lock().open = 1;
    child.read_output(0, Pieces(vec![b"ab\nabcd", b"more\nlines\n"]), Some(Framer::new(Some(3))));
    let heard = listener.until(OUTPUT_END);
    assert_eq!(heard.iter().map(|h| h.kind).collect::<Vec<_>>(), [LINES, OUTPUT_END]);
    assert_eq!(lines_of(&heard), (vec![b"ab".to_vec()], true));

    // nobody listening: the first line told is the last
    let nobody = Arc::new(Child::new(&Call::default(), quiet_stop()));
    nobody.lock().open = 1;
    nobody.read_output(0, Pieces(vec![b"a\n", b"b\n"]), Some(Framer::new(None)));
    assert_eq!(nobody.lock().open, 0);
}

#[test]
fn a_failure_with_no_system_error_is_told_as_it_is() {
    struct Refuses;
    impl Write for Refuses {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("no such thing"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let listener = Listener::new();
    let child = quiet_child(&listener);
    assert_eq!(child.write(b"x".to_vec()), Written::Queued);
    assert!(Refuses.flush().is_ok());
    child.write_input(Refuses);
    let failed = listener.next();
    assert_eq!(failed.kind, INPUT_FAILED);
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&failed.bytes).expect("JSON"), json!([null, "no such thing"]));
    // stdin was gone before the failure was told: a write made on hearing it is refused, never queued for nowhere
    assert_eq!(child.write(b"y".to_vec()), Written::Gone);
    assert_eq!(exit_of(Err(io::Error::other("no child"))), "[null,null]");
}

#[test]
fn a_write_stopped_by_our_own_close_is_no_failure_to_tell() {
    /// A write that is stuck until the test lets it fail, whatever the kernel would do first.
    struct Stuck {
        entered: std::sync::mpsc::Sender<()>,
        release: Receiver<()>,
    }
    impl Write for Stuck {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            self.entered.send(()).expect("the test waits");
            self.release.recv().expect("the test lets go");
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let listener = Listener::new();
    let child = quiet_child(&listener);
    assert_eq!(child.write(b"x".to_vec()), Written::Queued);
    let ((entered, stuck), (release, let_go)) = (channel(), channel());
    let mut to = Stuck { entered, release: let_go };
    assert!(to.flush().is_ok());
    let writer = thread::spawn({
        let child = child.clone();
        move || child.write_input(to)
    });
    stuck.recv().expect("the write started");
    child.close_input();
    release.send(()).expect("the write waits");
    writer.join().expect("the write ended");
    // a real event behind it: nothing came first, so the stopped write told nothing
    child.tell(EXIT, b"[0,null]");
    assert_eq!(listener.next().kind, EXIT);
}

/// A child with no process, for what doesn't need one.
fn quiet_child(listener: &Listener) -> Arc<Child> {
    Arc::new(Child::new(&listener.call, quiet_stop()))
}

fn quiet_stop() -> stdio::Stop {
    stdio::pipes(false).expect("pipes").2
}

thread_local! {
    /// How many threads `refuses_after` still starts, on the thread that spawns.
    static THREADS_LEFT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn refuses_after(job: Job) -> io::Result<()> {
    let left = THREADS_LEFT.get();
    if left == 0 {
        return Err(io::Error::other("no more threads"));
    }
    THREADS_LEFT.set(left - 1);
    start_thread(job)
}

#[test]
fn a_thread_that_cannot_start_leaves_nothing_started() {
    let listener = Listener::new();
    let payload = json!({ "command": "mopilot-never-run", "args": [], "cwd": null, "env": [], "stderr": true, "group": false, "hide": false, "verbatim": false });
    let bytes = payload.to_string();
    for threads in 0..4 {
        THREADS_LEFT.set(threads);
        let reply: serde_json::Value =
            serde_json::from_slice(&spawn_with(bytes.as_bytes(), &listener.call, refuses_after).expect("a reply")).expect("JSON");
        assert_eq!(reply, json!({ "errno": null, "message": "no more threads" }));
    }
}

#[test]
fn a_route_on_the_core_s_threads_answers_on_the_stream_as_any_other() {
    let listener = Listener::new();
    let ticket = 200;
    dispatch::spawn_ordered(listener.call.owner, "proc.signal".into(), b"not a child".to_vec(), ticket);
    assert_eq!(listener.next().kind, ticket as u8);
}

#[test]
fn a_call_cancelled_by_now_opens_nothing() {
    let listener = Listener::new();
    let call = Call::of(listener.call.owner);
    call.cancel.cancel();
    assert_eq!(dispatch_call("proc.spawn", &serde_json::to_vec(&json!({ "command": "x", "args": [], "cwd": null, "env": [], "stderr": false, "group": false, "hide": false, "verbatim": false })).expect("JSON"), &call), Err(dispatch::CANCELLED.to_string()));
}

#[test]
fn a_payload_that_names_nothing_is_refused_and_a_child_that_went_is_no_error() {
    assert!(dispatch("proc.spawn", b"{}").expect_err("no spec").starts_with("proc.spawn takes a spawn"));
    for (route, bad) in [
        ("proc.write", &b"7"[..]),
        ("proc.write", b"x\nbytes"),
        ("proc.endInput", b"x"),
        ("proc.closeInput", b"x"),
        ("proc.signal", b"7"),
        ("proc.ack", b"7 0"),
        ("proc.want", b"7"),
        ("proc.drop", b"x"),
    ] {
        assert!(dispatch(route, bad).is_err(), "{route} refuses {bad:?}");
    }
    assert!(dispatch("proc.endInput", &[0xff]).is_err());
    assert_eq!(dispatch("proc.ack", b"7 2 1"), Err("proc.ack takes output 0 or 1".into()));
    let none = u64::MAX;
    assert_eq!(dispatch("proc.write", format!("{none}\nbytes").as_bytes()), Ok(b"2".to_vec()));
    assert_eq!(dispatch("proc.endInput", none.to_string().as_bytes()), Ok(b"false".to_vec()));
    assert_eq!(dispatch("proc.closeInput", none.to_string().as_bytes()), Ok(Vec::new()));
    assert_eq!(dispatch("proc.signal", format!("{none} 0").as_bytes()), Ok(b"false".to_vec()));
    assert_eq!(dispatch("proc.ack", format!("{none} 1 5").as_bytes()), Ok(Vec::new()));
    assert_eq!(dispatch("proc.want", format!("{none} 1").as_bytes()), Ok(Vec::new()));
    assert_eq!(dispatch("proc.drop", none.to_string().as_bytes()), Ok(Vec::new()));
}
