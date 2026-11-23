//! The writer: one queue per file, written in batches, never two at a time for one file, and read back with the lines
//! not on disk yet.
//!
//! A harness streams hundreds of records a second, so an append only queues, and a thread of the writer's own writes. A
//! file's first lines go out at once, on the caller's thread, so the file exists from the first record, and so does
//! every line while the app quits. One lock per file covers its disk work, so a read never sees part of a write: it
//! takes that lock, reads, and adds what is still queued.

use crate::disk::Disk;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

/// Why a batch is written now, as the performance probe records it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    First,
    Tick,
    Soon,
    Flush,
    Drain,
    Retry,
}

impl Why {
    pub fn name(self) -> &'static str {
        match self {
            Why::First => "first",
            Why::Tick => "tick",
            Why::Soon => "soon",
            Why::Flush => "flush",
            Why::Drain => "drain",
            Why::Retry => "retry",
        }
    }
}

/// What a writer tells its owner.
#[derive(Debug, PartialEq)]
pub enum Event {
    /// A write failed, or lines were dropped: once until a write succeeds.
    Failed { file: String, what: String, message: String },
    /// A batch was written, for a file whose lines asked to be timed.
    Wrote { chat: String, records: usize, bytes: usize, ms: f64, why: Why },
}

/// How a writer batches.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// How long a line may wait before its file is written.
    pub flush: Duration,
    /// A queue this large is written now rather than at the next tick.
    pub soon_bytes: usize,
    /// While a file's writes fail, its queue keeps at most this much; older lines past it are dropped and reported.
    pub max_pending_bytes: usize,
}

/// What an append says of its file, the first time and after.
#[derive(Clone, Debug, Default)]
pub struct Meta {
    pub mode: Option<u32>,
    pub what: String,
    pub chat: String,
    pub timed: bool,
}

/// Lines not written yet.
#[derive(Default)]
struct Queue {
    bytes: Vec<u8>,
    meta: Meta,
    removed: bool,
    /// the last write failed, reported once until one succeeds
    failing: bool,
    /// lines dropped while failing, not reported yet
    dropped: usize,
    /// a batch left the queue and has not reached the file or come back
    writing: bool,
}

/// What only the file's disk work touches.
#[derive(Default)]
struct Io {
    /// a failed write left part of a line, so the next starts with a newline
    torn: bool,
    /// the file's last byte was checked for a line a crash left unfinished
    tail_checked: bool,
}

struct File {
    path: PathBuf,
    queue: Mutex<Queue>,
    io: Mutex<Io>,
}

/// When the writer's thread works next.
#[derive(Default)]
struct Timing {
    /// the next batch for every file
    due: Option<Instant>,
    /// files past `soon_bytes`
    soon: Vec<Arc<File>>,
    /// lines are written as they come until then: the app is quitting
    sync_until: Option<Instant>,
    stopped: bool,
}

struct Shared {
    disk: Box<dyn Disk>,
    options: Options,
    events: Box<dyn Fn(Event) + Send + Sync>,
    files: Mutex<BTreeMap<String, Arc<File>>>,
    timing: Mutex<Timing>,
    wake: Condvar,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// How much of `queue`'s lines to drop for the bound: never its last one.
fn trim(queue: &mut Queue, max: usize) {
    let mut cut = 0;
    while queue.bytes.len() - cut > max {
        let Some(end) = queue.bytes[cut..].iter().position(|&b| b == b'\n') else { break };
        if cut + end + 1 >= queue.bytes.len() {
            break;
        }
        cut += end + 1;
        queue.dropped += 1;
    }
    queue.bytes.drain(..cut);
}

impl Shared {
    fn syncing(&self) -> bool {
        lock(&self.timing).sync_until.is_some_and(|until| Instant::now() < until)
    }

    /// The next batch of every file, once `flush` has passed.
    fn tick(&self) {
        let mut timing = lock(&self.timing);
        if timing.due.is_none() {
            timing.due = Some(Instant::now() + self.options.flush);
            self.wake.notify_all();
        }
    }

    fn all(&self) -> Vec<Arc<File>> {
        lock(&self.files).values().cloned().collect()
    }

    /// Append `file`'s queue. A failure keeps what reached the file, queues the rest again and reports it.
    fn write(&self, file: &File, why: Why) {
        let mut io = lock(&file.io);
        let (batch, meta, why) = {
            let mut queue = lock(&file.queue);
            if queue.bytes.is_empty() || queue.removed {
                return;
            }
            let why = if queue.failing { Why::Retry } else { why };
            queue.writing = true;
            (std::mem::take(&mut queue.bytes), queue.meta.clone(), why)
        };
        let started = Instant::now();
        let mut base = None;
        let outcome = self.append(file, &mut io, &batch, &meta, &mut base);
        match outcome {
            Ok(()) => {
                io.torn = false;
                let mut queue = lock(&file.queue);
                queue.failing = false;
                queue.writing = false;
                drop(queue);
                if meta.timed {
                    let ms = (started.elapsed().as_secs_f64() * 100_000.0).round() / 100.0;
                    let records = batch.iter().filter(|&&b| b == b'\n').count();
                    (self.events)(Event::Wrote { chat: meta.chat.clone(), records, bytes: batch.len(), ms, why });
                }
            }
            Err(error) => {
                self.recover(file, &mut io, batch, base, error, &meta);
                if !self.syncing() {
                    self.tick();
                }
            }
        }
    }

    /// The append itself. `base` is the file's size as it began, once that is known.
    fn append(&self, file: &File, io: &mut Io, batch: &[u8], meta: &Meta, base: &mut Option<u64>) -> io::Result<()> {
        self.disk.prepare(&file.path)?;
        let size = self.disk.size(&file.path)?;
        // the first write this process makes to a file a crash left with half a line ends that line first
        if !io.tail_checked {
            if size > 0 && self.disk.byte_at(&file.path, size - 1)? != b'\n' {
                io.torn = true;
            }
            io.tail_checked = true;
        }
        *base = Some(size);
        if io.torn {
            let mut ended = Vec::with_capacity(batch.len() + 1);
            ended.push(b'\n');
            ended.extend_from_slice(batch);
            self.disk.append(&file.path, &ended, meta.mode)
        } else {
            self.disk.append(&file.path, batch, meta.mode)
        }
    }

    /// Put back the part of `batch` not on disk, whole lines of it: a line cut partway is written again after a newline,
    /// so the torn part reads as one skipped line and nothing is doubled.
    fn recover(&self, file: &File, io: &mut Io, batch: Vec<u8>, base: Option<u64>, error: io::Error, meta: &Meta) {
        let mut written = 0;
        if let Some(base) = base {
            match self.disk.size(&file.path) {
                Ok(size) => written = size.saturating_sub(base) as usize,
                // how much reached the file is unknown: the batch is written again whole, after a newline
                Err(_) => io.torn = true,
            }
        }
        let mut keep = 0;
        if written > 0 {
            let body = (written - usize::from(io.torn)).min(batch.len());
            keep = batch[..body].iter().rposition(|&b| b == b'\n').map_or(0, |at| at + 1);
            io.torn = keep != body;
        }
        let mut queue = lock(&file.queue);
        queue.writing = false;
        let later = std::mem::take(&mut queue.bytes);
        queue.bytes = batch[keep..].to_vec();
        queue.bytes.extend_from_slice(&later);
        trim(&mut queue, self.options.max_pending_bytes);
        let dropped = std::mem::take(&mut queue.dropped);
        if queue.failing && dropped == 0 {
            return;
        }
        queue.failing = true;
        drop(queue);
        let message = match dropped {
            0 => error.to_string(),
            1 => format!("1 transcript line dropped: {error}"),
            lines => format!("{lines} transcript lines dropped: {error}"),
        };
        (self.events)(Event::Failed { file: path_text(&file.path), what: meta.what.clone(), message });
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A file's bytes with the lines not on disk yet after them; a torn last line is ended first, as the writer does on disk.
fn with_pending(mut bytes: Vec<u8>, pending: &[u8]) -> Vec<u8> {
    if !pending.is_empty() {
        if bytes.last().is_some_and(|&b| b != b'\n') {
            bytes.push(b'\n');
        }
        bytes.extend_from_slice(pending);
    }
    bytes
}

/// The error reading a removed or missing file gives.
fn missing(file: &str) -> io::Error {
    io::Error::new(io::ErrorKind::NotFound, format!("ENOENT: no such file, open '{file}'"))
}

/// A writer and its thread. Dropping it writes what is queued and ends the thread.
pub struct Writer {
    shared: Arc<Shared>,
}

impl Writer {
    pub fn new(disk: impl Disk, options: Options, events: impl Fn(Event) + Send + Sync + 'static) -> Self {
        let shared = Arc::new(Shared {
            disk: Box::new(disk),
            options,
            events: Box::new(events),
            files: Mutex::new(BTreeMap::new()),
            timing: Mutex::new(Timing::default()),
            wake: Condvar::new(),
        });
        let worker = shared.clone();
        thread::Builder::new().name("transcript".into()).spawn(move || run(&worker)).expect("a thread for the writer");
        Writer { shared }
    }

    fn file(&self, name: &str) -> Option<Arc<File>> {
        lock(&self.shared.files).get(name).cloned()
    }

    /// Queue `lines` (whole lines) for `name`. The first lines for a file go out at once.
    pub fn append(&self, name: &str, lines: &[u8], meta: Meta) {
        if lines.is_empty() {
            return;
        }
        let (file, fresh) = {
            let mut files = lock(&self.shared.files);
            let fresh = !files.contains_key(name);
            let file = files
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(File { path: PathBuf::from(name), queue: Mutex::default(), io: Mutex::default() }));
            (file.clone(), fresh)
        };
        let queued = {
            let mut queue = lock(&file.queue);
            if queue.removed {
                return;
            }
            if fresh {
                queue.meta = meta;
            } else {
                queue.meta.timed = meta.timed;
            }
            queue.bytes.extend_from_slice(lines);
            queue.bytes.len()
        };
        if fresh {
            self.shared.write(&file, Why::First);
        } else if self.shared.syncing() {
            self.shared.write(&file, Why::Drain);
        } else if queued >= self.shared.options.soon_bytes {
            lock(&self.shared.timing).soon.push(file);
            self.shared.wake.notify_all();
        } else {
            self.shared.tick();
        }
    }

    /// Write `name`'s queue now, returning once what was queued before this call is on disk, or its write failed and was
    /// reported. A quit's flush counts as the quit.
    pub fn flush(&self, name: &str) {
        if let Some(file) = self.file(name) {
            self.shared.write(&file, if self.shared.syncing() { Why::Drain } else { Why::Flush });
        }
    }

    /// Write everything queued; for the next `sync` lines are written as they come (the app is quitting). A quit that does
    /// not happen after all ends that, so lines are batched again.
    pub fn drain(&self, sync: Duration) {
        lock(&self.shared.timing).sync_until = Some(Instant::now() + sync);
        for file in self.shared.all() {
            self.shared.write(&file, Why::Drain);
        }
    }

    /// The file's bytes with its pending lines after them, as it will read once they are written.
    pub fn read(&self, name: &str) -> io::Result<Vec<u8>> {
        let Some(file) = self.file(name) else { return self.shared.disk.read(Path::new(name)) };
        let _io = lock(&file.io);
        let bytes = self.shared.disk.read(&file.path);
        let queue = lock(&file.queue);
        if queue.removed {
            return Err(missing(name));
        }
        match bytes {
            Ok(bytes) => Ok(with_pending(bytes, &queue.bytes)),
            Err(error) if error.kind() == io::ErrorKind::NotFound && !queue.bytes.is_empty() => Ok(queue.bytes.clone()),
            Err(error) => Err(error),
        }
    }

    /// Whether the file exists or has pending lines.
    pub fn has(&self, name: &str) -> bool {
        match self.file(name) {
            Some(file) => {
                let queue = lock(&file.queue);
                !queue.removed && (!queue.bytes.is_empty() || queue.writing || self.shared.disk.exists(&file.path))
            }
            None => self.shared.disk.exists(Path::new(name)),
        }
    }

    /// How many bytes for `name` are not on disk yet.
    pub fn pending(&self, name: &str) -> usize {
        self.file(name).map_or(0, |file| {
            let queue = lock(&file.queue);
            if queue.removed {
                0
            } else {
                queue.bytes.len()
            }
        })
    }

    /// Remove the file: queued lines are dropped, and later lines are ignored. While a write or a read holds the file, which
    /// the JS thread can't wait for, it goes as soon as they let it go.
    pub fn remove(&self, name: &str) -> io::Result<()> {
        let file = {
            let mut files = lock(&self.shared.files);
            files
                .entry(name.to_string())
                .or_insert_with(|| Arc::new(File { path: PathBuf::from(name), queue: Mutex::default(), io: Mutex::default() }))
                .clone()
        };
        {
            let mut queue = lock(&file.queue);
            queue.removed = true;
            queue.bytes.clear();
        }
        if file.io.try_lock().is_ok() {
            return self.shared.disk.remove(&file.path);
        }
        let shared = self.shared.clone();
        std::thread::spawn(move || {
            let _io = lock(&file.io);
            let _ = shared.disk.remove(&file.path);
        });
        Ok(())
    }
}

impl Drop for Writer {
    fn drop(&mut self) {
        lock(&self.shared.timing).stopped = true;
        self.shared.wake.notify_all();
    }
}

/// The writer's thread: every file at each tick, a file past the bound now, and what is left when the writer goes.
fn run(shared: &Shared) {
    loop {
        let (soon, tick, stopped) = {
            let mut timing = lock(&shared.timing);
            loop {
                let now = Instant::now();
                let due = timing.due.is_some_and(|at| at <= now);
                if timing.stopped || due || !timing.soon.is_empty() {
                    if due {
                        timing.due = None;
                    }
                    break (std::mem::take(&mut timing.soon), due, timing.stopped);
                }
                timing = match timing.due {
                    Some(at) => shared.wake.wait_timeout(timing, at - now).unwrap_or_else(PoisonError::into_inner).0,
                    None => shared.wake.wait(timing).unwrap_or_else(PoisonError::into_inner),
                };
            }
        };
        for file in soon {
            shared.write(&file, Why::Soon);
        }
        if tick || stopped {
            for file in shared.all() {
                shared.write(&file, Why::Tick);
            }
        }
        if stopped {
            return;
        }
    }
}
