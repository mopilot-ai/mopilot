//! Harness children the core owns (Stage 4.1 of the Rust migration): started as Node's spawn starts one, with their stdio
//! read and written on threads of their own, so a chatty child costs main only its events and a stuck one can't stall it.
//! electron/platform/coreChild.cjs gives JS the same child in a ChildProcess's shape; the routes are in `routes`.
//!
//! Every child has four threads, ready before it is spawned so that one that can't start leaves nothing to clean up:
//! one per output, one for stdin and one that waits for the exit. What JS hears comes down the core's ordered stream, each
//! event `[MARK, kind, id as 6 bytes LE, bytes...]`:
//!
//! - Output keeps its order, whole. A read goes out as it came, at most `CHUNK` bytes, unless stdout is framed (`lines`):
//!   then a read goes out as the complete lines it ended, and a line still arriving waits here.
//! - The exit comes behind the last byte of stdout and stderr: `settle` holds it until both ended. Two things cut that
//!   wait after `QUIET` with no byte read, since neither ends by waiting: a process that outlived the child and holds the
//!   pipe (JS ends those on hearing of the exit), and a JS reader that stopped taking bytes. `EXIT_LIMIT` cuts it whatever
//!   keeps coming, since a survivor may never go quiet, and what a dead child left is at most a socket's buffer. Late bytes
//!   follow the exit, and electron/transport/jsonReader.cjs `finishInput` seals on stdout's end, which comes after all of
//!   stdout. stderr's end is its own, in no order with it.
//! - Output is charged against `WINDOW` until JS says it took it (`ack`). A full window stops the reader, the pipe fills
//!   and the child blocks in write, as with a paused Node stream: nothing listening costs at most a window, however long
//!   the child talks. A framed stdout's line still arriving counts too, unless JS wants it (`lines`): then a line longer
//!   than the window still comes whole. `ack` and `want` are what a thread here waits on JS for; no route waits.
//! - Stdin goes through a queue, so a write never touches the pipe on main. Past `INPUT_HIGH` the write says so, and JS
//!   holds further writes in its Writable until `INPUT_LOW`, as Node's stream holds them for a full socket. A write to a
//!   child that closed its stdin fails on the thread, and is told as an event.
//! - After the exit, once both outputs ended, the last event goes out and the handle is removed; the threads have ended or
//!   are ending. A handle dropped first (its JS environment went) closes stdin and stops reading as soon as a read returns;
//!   the child keeps running, as one does whose parent exits, and is still reaped when it ends.

use dispatch::{Call, Handles};
use framing::Framer;
use serde::Deserialize;
use serde_json::json;
use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::process::ExitStatus;
use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

#[cfg(all(unix, not(target_os = "macos")))]
mod forked;
mod lines;
#[cfg(target_os = "macos")]
mod macos;
mod routes;
#[cfg(test)]
mod scenarios;
mod stdio;
mod threads;

use threads::{fed, start_thread, Start};

/// The first byte of every event here: the stream's other events are JSON.
const MARK: u8 = 1;
/// An event's header: `MARK`, its kind and the child's id.
const HEADER: usize = 8;
/// The most one read takes, as much as Node's.
const CHUNK: usize = 64 << 10;
/// How much of one output may wait for JS.
const WINDOW: usize = 1 << 20;
/// What JS may hold before it says so: well inside the window, so a reader never stops while JS keeps up.
const ACK_EVERY: usize = WINDOW / 4;
/// What a chunk costs beyond its bytes, so a child writing one byte at a time can't queue a million events in a window.
const CHUNK_COST: usize = 512;
/// Queued stdin past which JS holds back, and where it may go on.
const INPUT_HIGH: usize = 1 << 20;
const INPUT_LOW: usize = 256 << 10;
/// How long an exit waits for a byte once the child is gone and none came, and how long it waits whatever comes.
const QUIET: Duration = Duration::from_millis(100);
const EXIT_LIMIT: Duration = Duration::from_secs(1);
/// More than a machine's harnesses: a family is bounded (dispatch's `handles`).
const MOST_CHILDREN: usize = 1024;

/// What each event is. An output's bytes are its index, and its end that index past `OUTPUT_END`.
const OUTPUT_END: u8 = 2;
const EXIT: u8 = 4;
const INPUT_FAILED: u8 = 5;
const INPUT_DRAINED: u8 = 6;
const CLOSED: u8 = 7;
/// Stdout's complete lines, when it is framed.
const LINES: u8 = 8;
/// A framed stdout's line fills the window: does JS want it?
const ASK: u8 = 9;

static CHILDREN: Handles<Held> = Handles::new("child handle", MOST_CHILDREN);

/// What to start, as spawnArgs (electron/platform/winbin.cjs) ended up with: the shims and the launcher are JS's.
#[derive(Deserialize)]
struct Spec {
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    /// All of its environment, nothing inherited.
    env: Vec<(String, String)>,
    /// A pipe, or nothing (stdin and stdout are always pipes).
    stderr: bool,
    /// A session and process group of its own, as `detached` gives one: POSIX only.
    #[cfg_attr(windows, allow(dead_code))]
    group: bool,
    /// No console window (`windowsHide`): Windows only.
    #[cfg_attr(unix, allow(dead_code))]
    hide: bool,
    /// Arguments as they are (`windowsVerbatimArguments`): Windows only.
    #[cfg_attr(unix, allow(dead_code))]
    verbatim: bool,
    /// Stdout framed into lines here, or None for its bytes.
    lines: Option<lines::LineSpec>,
}

/// What a write did with its bytes.
#[derive(Debug, PartialEq)]
enum Written {
    Queued,
    /// Queued, and JS holds the next until `INPUT_DRAINED`.
    Full,
    Gone,
}

struct State {
    /// What each output has sent that JS hasn't taken.
    charged: [usize; 2],
    /// Outputs not at their end.
    open: usize,
    last_read: Instant,
    reaped: bool,
    told_exit: bool,
    /// Its JS environment went: nobody is listening.
    abandoned: bool,
    input: VecDeque<Vec<u8>>,
    queued: usize,
    /// JS waits for `INPUT_DRAINED`.
    held_back: bool,
    /// A framed stdout: what JS said of the line still arriving (`lines`).
    demand: lines::Demand,
    /// Nothing more goes in: what is queued is written (an end of input), or was dropped (an exit, a failed write).
    input_closed: bool,
    /// Dropped: a write that fails from here was stopped by this, and is nothing to tell.
    input_stopped: bool,
}

/// One child, as its threads share it.
struct Child {
    id: AtomicU64,
    pid: AtomicI32,
    call: Call,
    stop: stdio::Stop,
    state: Mutex<State>,
    changed: Condvar,
}

/// The handle: its going, whoever closes it, leaves no thread waiting for JS.
struct Held(Arc<Child>);

impl Drop for Held {
    fn drop(&mut self) {
        self.0.abandon();
    }
}

impl Child {
    fn new(call: &Call, stop: stdio::Stop) -> Self {
        let state = State {
            charged: [0, 0],
            open: 0,
            last_read: Instant::now(),
            reaped: false,
            told_exit: false,
            abandoned: false,
            input: VecDeque::new(),
            queued: 0,
            held_back: false,
            demand: lines::Demand::default(),
            input_closed: false,
            input_stopped: false,
        };
        Child {
            id: AtomicU64::new(0),
            pid: AtomicI32::new(0),
            call: Call::of(call.owner),
            stop,
            state: Mutex::new(state),
            changed: Condvar::new(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn id(&self) -> u64 {
        self.id.load(Ordering::Relaxed)
    }

    /// An event of `kind`, with room for `more` bytes after its header.
    fn header(&self, kind: u8, more: usize) -> Vec<u8> {
        let mut event = Vec::with_capacity(HEADER + more);
        event.extend_from_slice(&[MARK, kind]);
        event.extend_from_slice(&self.id().to_le_bytes()[..6]);
        event
    }

    /// Say `bytes` to JS: false when nobody is listening.
    fn tell(&self, kind: u8, bytes: &[u8]) -> bool {
        let mut event = self.header(kind, bytes.len());
        event.extend_from_slice(bytes);
        self.call.emit(event)
    }

    /// Wait for room in output `which`, with `pending` bytes of a line still arriving: false once nobody is listening.
    fn room(&self, which: usize, pending: usize) -> bool {
        let mut state = self.lock();
        while !state.abandoned && lines::held(&mut state, which, pending, |ask| self.tell(ASK, &ask.to_le_bytes())) {
            state = self.changed.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
        !state.abandoned
    }

    /// Output `which` said `bytes`, told as they came or, framed, as the lines they ended (none: nothing to tell). False
    /// once nobody is listening.
    fn output(&self, which: usize, bytes: &[u8], framer: Option<&mut Framer>) -> bool {
        let event = match framer {
            None => {
                let mut event = self.header(which as u8, bytes.len());
                event.extend_from_slice(bytes);
                Some(event)
            }
            Some(framer) => lines::event(framer, self.lock().demand.dropping, self.header(LINES, bytes.len()), bytes),
        };
        {
            let mut state = self.lock();
            if let Some(event) = &event {
                state.charged[which] += event.len() - HEADER + CHUNK_COST;
                lines::told(&mut state, which);
            }
            state.last_read = Instant::now();
        }
        event.is_none_or(|event| self.call.emit(event))
    }

    /// Everything output `which` will ever say, in order, framed by `framer` if it has one. A read that fails ends it, as
    /// a pipe's end does; a line still arriving then is no line.
    fn read_output(&self, which: usize, mut from: impl Read, mut framer: Option<Framer>) {
        let mut buffer = vec![0; CHUNK];
        while self.room(which, framer.as_ref().map_or(0, Framer::pending)) {
            match from.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) if !self.output(which, &buffer[..read], framer.as_mut()) => break,
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        // the pipe closes here, before anything is said of it
        drop(from);
        self.tell(OUTPUT_END + which as u8, &[]);
        let told_exit = {
            let mut state = self.lock();
            state.open -= 1;
            self.changed.notify_all();
            state.told_exit && state.open == 0
        };
        if told_exit {
            self.close();
        }
    }

    /// JS took `amount` of output `which`.
    fn ack(&self, which: usize, amount: usize) {
        let mut state = self.lock();
        state.charged[which] = state.charged[which].saturating_sub(amount);
        self.changed.notify_all();
    }

    /// Queue `bytes` for stdin.
    fn write(&self, bytes: Vec<u8>) -> Written {
        let mut state = self.lock();
        if state.input_closed {
            return Written::Gone;
        }
        state.queued += bytes.len();
        state.input.push_back(bytes);
        self.changed.notify_all();
        state.held_back = state.queued >= INPUT_HIGH;
        if state.held_back {
            Written::Full
        } else {
            Written::Queued
        }
    }

    /// Stdin ends once what is queued is written: whether it was open.
    fn end_input(&self) -> bool {
        let mut state = self.lock();
        let open = !state.input_closed;
        state.input_closed = true;
        self.changed.notify_all();
        open
    }

    /// The next bytes for stdin, or None at its end.
    fn next_input(&self) -> Option<Vec<u8>> {
        let mut state = self.lock();
        loop {
            if let Some(bytes) = state.input.pop_front() {
                return Some(bytes);
            }
            if state.input_closed {
                return None;
            }
            state = self.changed.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Stdin is done with, whatever is left queued, and a write stuck on it gives up.
    fn close_input(&self) {
        {
            let mut state = self.lock();
            state.input_closed = true;
            state.input_stopped = true;
            state.input.clear();
            state.queued = 0;
            state.held_back = false;
            self.changed.notify_all();
        }
        self.stop.input();
    }

    /// Everything JS queues for stdin, in order, until its end or the first failed write.
    fn write_input(&self, mut to: impl Write) {
        while let Some(bytes) = self.next_input() {
            let result = to.write_all(&bytes);
            // what stdin says is told under the lock, so none of it can follow `close_input`, and so `CLOSED`: the last word
            let mut state = self.lock();
            if let Err(error) = result {
                // gone before it is told, so a write JS makes on hearing it is refused, not queued for nowhere
                state.input_closed = true;
                if !state.input_stopped {
                    self.tell(INPUT_FAILED, json!([stdio::write_errno(&error), error.to_string()]).to_string().as_bytes());
                }
                drop(state);
                self.close_input();
                break;
            }
            state.queued = state.queued.saturating_sub(bytes.len());
            if state.held_back && state.queued <= INPUT_LOW {
                state.held_back = false;
                self.tell(INPUT_DRAINED, &[]);
            }
        }
        // the child's read ends here, on every platform (a POSIX stream has a second descriptor, for `Stop`)
        self.stop.input();
    }

    /// The child is gone: wait for what it wrote, until nothing has come for `QUIET` or for `EXIT_LIMIT` at most (this file's
    /// header).
    fn settle(&self) {
        let gone = Instant::now();
        let mut state = self.lock();
        state.last_read = gone;
        while state.open > 0 {
            let quiet = QUIET.checked_sub(state.last_read.elapsed());
            let Some(left) = quiet.zip(EXIT_LIMIT.checked_sub(gone.elapsed())).map(|(quiet, limit)| quiet.min(limit)) else { break };
            state = self.changed.wait_timeout(state, left).unwrap_or_else(PoisonError::into_inner).0;
        }
    }

    /// The child's whole life, from here: no zombie is left, whoever is listening.
    fn wait(&self, mut process: stdio::Process) {
        let status = stdio::reap(&mut process, || self.lock().reaped = true);
        self.settle();
        // stdin goes before the exit is told: JS writes on hearing it (as Node's `exit` handlers do), and that write must be
        // refused as gone, not queued for a child that is no more
        self.close_input();
        self.tell(EXIT, exit_of(status).as_bytes());
        let closed = {
            let mut state = self.lock();
            state.told_exit = true;
            state.open == 0
        };
        if closed {
            self.close();
        }
    }

    /// The last of it: exit told and both outputs ended.
    fn close(&self) {
        self.tell(CLOSED, &[]);
        CHILDREN.close(self.id());
    }

    /// Nobody is listening any more: nothing waits for JS, and stdin closes, as a parent's going closes it.
    fn abandon(&self) {
        self.close_input();
        let mut state = self.lock();
        state.abandoned = true;
        self.changed.notify_all();
    }

    /// Signal the child: false once it was reaped, so a pid handed on is never signalled.
    fn signal(&self, signal: i32) -> bool {
        let state = self.lock();
        !state.reaped && send_signal(self.pid.load(Ordering::Relaxed), signal)
    }
}

/// `[code, signal]`, as a ChildProcess's exit says them, or nothing known when the wait itself failed.
fn exit_of(status: io::Result<ExitStatus>) -> String {
    let (code, signal) = status.map_or((None, None), stdio::code_and_signal);
    json!([code, signal]).to_string()
}

/// The child `id` names, or None once it has gone.
fn child(id: u64) -> Option<Arc<Child>> {
    CHILDREN.with(id, |held| held.0.clone()).ok()
}

#[cfg(unix)]
fn send_signal(pid: i32, signal: i32) -> bool {
    // SAFETY: kill takes any pid and signal; `pid` is this child's, above 1, so never a whole group
    unsafe { libc::kill(pid, signal) == 0 }
}

/// Windows has no signals: 0 asks whether it runs, and any other ends it, as libuv's kill does.
#[cfg(windows)]
fn send_signal(pid: i32, signal: i32) -> bool {
    signal == 0 || crate::terminate(pid)
}

/// What became of a spawn that didn't start.
#[derive(Debug)]
enum Failure {
    /// The system's error, as Node's spawn gets it.
    Os(io::Error),
    /// The core's own: too many children, say.
    Refused(String),
}

/// A child that started.
#[derive(Debug, PartialEq)]
struct Started {
    id: u64,
    pid: i32,
    /// On Windows, it is in a Job Object.
    held: bool,
}

/// The threads, then the process, which they are fed. A spawn that fails feeds them nothing, and they end.
fn begin(child: &Arc<Child>, spec: &Spec, ends: stdio::Ends, wires: stdio::Wires, start: Start) -> io::Result<(i32, bool)> {
    let wait = fed(start, {
        let child = child.clone();
        move |process| child.wait(process)
    })?;
    let write = fed(start, {
        let child = child.clone();
        move |to: stdio::Input| child.write_input(to)
    })?;
    let framer = spec.lines.as_ref().map(|lines| Framer::new(lines.limit));
    let out = fed(start, {
        let child = child.clone();
        move |from: stdio::Output| child.read_output(0, from, framer)
    })?;
    let err = fed(start, {
        let child = child.clone();
        move |from: stdio::Output| child.read_output(1, from, None)
    })?;
    let process = stdio::start(spec, ends)?;
    let pid = process.id() as i32;
    child.pid.store(pid, Ordering::Relaxed);
    let held = stdio::hold(pid, &process);
    child.lock().open = 1 + usize::from(wires.errors.is_some());
    // each thread waits for this, so nothing here can fail short of a thread that died, whose pipe then closes
    let _ = write.send(wires.input);
    let _ = out.send(wires.output);
    if let Some(errors) = wires.errors {
        let _ = err.send(errors);
    }
    let _ = wait.send(process);
    Ok((pid, held))
}

/// One start at a time, from making a child's pipes to its exec: a fork holds a copy of every descriptor until then, so a child
/// that closed its stdin beside another's start would not read as closed, and a write into it would seem to succeed. No thread
/// but JS's starts one in the app; it is for the core's own tests, and costs nothing there.
static SPAWNING: Mutex<()> = Mutex::new(());

/// Start `spec` for `call`'s owner.
fn launch(spec: &Spec, call: &Call, start: Start) -> Result<Started, Failure> {
    let _alone = SPAWNING.lock();
    let (ends, wires, stop) = stdio::pipes(spec.stderr).map_err(Failure::Os)?;
    let child = Arc::new(Child::new(call, stop));
    let id = CHILDREN.open(call, Held(child.clone())).map_err(Failure::Refused)?;
    child.id.store(id, Ordering::Relaxed);
    match begin(&child, spec, ends, wires, start) {
        Ok((pid, held)) => Ok(Started { id, pid, held }),
        Err(error) => {
            CHILDREN.close(id);
            Err(Failure::Os(error))
        }
    }
}
