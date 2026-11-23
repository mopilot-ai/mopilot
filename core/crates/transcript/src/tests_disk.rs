//! The writer against a disk that can fail partway, and the routes on the real file system.

use crate::{Disk, Event, Meta, Options, RealDisk, Why, Writer};
use dispatch::dispatch;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const HOUR: Duration = Duration::from_secs(3600);

/// A disk in memory: one file's bytes, and what the next append does.
#[derive(Clone, Default)]
pub(crate) struct Memory {
    pub(crate) bytes: Arc<Mutex<Vec<u8>>>,
    /// bytes each failing append lets through, front first
    pub(crate) fail_after: Arc<Mutex<Vec<usize>>>,
    /// the size can't be read after a failure
    blind: Arc<Mutex<bool>>,
    /// a failing append leaves the size unreadable
    blind_after_failure: Arc<Mutex<bool>>,
    appends: Arc<Mutex<usize>>,
    /// reading the file fails, for a reason other than its being missing
    pub(crate) unreadable: Arc<Mutex<bool>>,
    /// the tail can't be read this many times
    pub(crate) tail_fails: Arc<Mutex<usize>>,
    /// a read or an append waits here while this is shut, saying it arrived
    pub(crate) gate: Arc<(Mutex<(bool, bool)>, Condvar)>,
}

/// Whether `ok` comes true within a few seconds. A wait has no branch of its own, as how long it takes varies between runs.
pub(crate) fn soon(ok: impl Fn() -> bool) -> bool {
    let wait = |_| {
        std::thread::sleep(Duration::from_millis(1));
        ok()
    };
    (0..5000).any(wait)
}

impl Memory {
    fn wait_at_gate(&self) {
        let (state, changed) = &*self.gate;
        let mut held = state.lock().unwrap();
        held.1 = true;
        changed.notify_all();
        drop(changed.wait_while(held, |held| held.0).unwrap());
    }
    pub(crate) fn shut(&self) {
        self.gate.0.lock().unwrap().0 = true;
    }
    pub(crate) fn open_gate(&self) {
        self.gate.0.lock().unwrap().0 = false;
        self.gate.1.notify_all();
    }
    pub(crate) fn until_arrived(&self) {
        let (state, changed) = &*self.gate;
        drop(changed.wait_while(state.lock().unwrap(), |held| !held.1).unwrap());
    }

    pub(crate) fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes.lock().unwrap()).into_owned()
    }
}

impl Disk for Memory {
    fn prepare(&self, _: &Path) -> io::Result<()> {
        Ok(())
    }
    fn size(&self, _: &Path) -> io::Result<u64> {
        if *self.blind.lock().unwrap() {
            return Err(io::Error::other("no size"));
        }
        Ok(self.bytes.lock().unwrap().len() as u64)
    }
    fn byte_at(&self, _: &Path, at: u64) -> io::Result<u8> {
        let mut fails = self.tail_fails.lock().unwrap();
        if *fails > 0 {
            *fails -= 1;
            return Err(io::Error::other("no tail"));
        }
        Ok(self.bytes.lock().unwrap()[at as usize])
    }
    fn append(&self, _: &Path, bytes: &[u8], _: Option<u32>) -> io::Result<()> {
        self.wait_at_gate();
        *self.appends.lock().unwrap() += 1;
        let cut = self.fail_after.lock().unwrap().pop();
        match cut {
            Some(cut) => {
                self.bytes.lock().unwrap().extend_from_slice(&bytes[..cut.min(bytes.len())]);
                *self.blind.lock().unwrap() = *self.blind_after_failure.lock().unwrap();
                Err(io::Error::other("disk full"))
            }
            None => {
                self.bytes.lock().unwrap().extend_from_slice(bytes);
                Ok(())
            }
        }
    }
    fn read(&self, _: &Path) -> io::Result<Vec<u8>> {
        self.wait_at_gate();
        if *self.unreadable.lock().unwrap() {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        let bytes = self.bytes.lock().unwrap();
        if bytes.is_empty() {
            return Err(io::Error::from(io::ErrorKind::NotFound));
        }
        Ok(bytes.clone())
    }
    fn remove(&self, _: &Path) -> io::Result<()> {
        self.bytes.lock().unwrap().clear();
        Ok(())
    }
    fn exists(&self, _: &Path) -> bool {
        !self.bytes.lock().unwrap().is_empty()
    }
}

/// A writer whose tick never comes by itself, and what it reported.
pub(crate) fn writer(disk: &Memory) -> (Writer, Arc<Mutex<Vec<Event>>>) {
    writer_with(disk, Options { flush: HOUR, soon_bytes: 1 << 20, max_pending_bytes: 16 << 20 })
}

pub(crate) fn writer_with(disk: &Memory, options: Options) -> (Writer, Arc<Mutex<Vec<Event>>>) {
    let events = Arc::new(Mutex::new(Vec::new()));
    let heard = events.clone();
    (Writer::new(disk.clone(), options, move |event| heard.lock().unwrap().push(event)), events)
}

pub(crate) fn timed() -> Meta {
    Meta { mode: Some(0o600), what: "write a log".into(), chat: "chat".into(), timed: true }
}

fn reasons(events: &Mutex<Vec<Event>>) -> Vec<Why> {
    events.lock().unwrap().iter().filter_map(|e| if let Event::Wrote { why, .. } = e { Some(*why) } else { None }).collect()
}

pub(crate) fn failures(events: &Mutex<Vec<Event>>) -> Vec<String> {
    events.lock().unwrap().iter().filter_map(|e| if let Event::Failed { message, .. } = e { Some(message.clone()) } else { None }).collect()
}

#[test]
fn the_first_line_goes_out_at_once_and_later_ones_wait_for_a_batch() {
    let disk = Memory::default();
    let (w, events) = writer(&disk);
    w.append("a", b"1\n", timed());
    assert_eq!(disk.text(), "1\n");
    w.append("a", b"2\n", timed());
    w.append("a", b"3\n", timed());
    assert_eq!(disk.text(), "1\n", "queued");
    assert_eq!(w.pending("a"), 4);
    assert_eq!(w.read("a").unwrap(), b"1\n2\n3\n", "a read sees what is queued");
    w.flush("a");
    assert_eq!(disk.text(), "1\n2\n3\n");
    assert_eq!(reasons(&events), [Why::First, Why::Flush]);
    assert_eq!(*disk.appends.lock().unwrap(), 2, "one batch");
}

#[test]
fn a_tick_writes_every_file_after_the_wait() {
    let disk = Memory::default();
    let (w, events) = writer_with(&disk, Options { flush: Duration::from_millis(10), soon_bytes: 1 << 20, max_pending_bytes: 1 << 20 });
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    // the writer appends, then says it wrote: wait for the word, which comes after the bytes
    assert!(soon(|| reasons(&events).len() == 2), "{}", disk.text());
    assert_eq!(disk.text(), "1\n2\n");
    assert_eq!(reasons(&events), [Why::First, Why::Tick]);
}

#[test]
fn a_large_queue_is_written_now() {
    let disk = Memory::default();
    let (w, events) = writer_with(&disk, Options { flush: HOUR, soon_bytes: 4, max_pending_bytes: 1 << 20 });
    w.append("a", b"1\n", timed());
    w.append("a", b"22222\n", timed());
    assert!(soon(|| reasons(&events).len() == 2), "{}", disk.text());
    assert_eq!(disk.text(), "1\n22222\n");
    assert_eq!(reasons(&events), [Why::First, Why::Soon]);
}

#[test]
fn a_file_a_crash_left_with_half_a_line_is_ended_first_and_only_once() {
    let disk = Memory::default();
    disk.bytes.lock().unwrap().extend_from_slice(b"{\"half");
    let (w, _) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    w.flush("a");
    assert_eq!(disk.text(), "{\"half\n1\n2\n");
}

#[test]
fn a_write_that_fails_partway_keeps_what_landed_and_rewrites_the_torn_line_after_a_newline() {
    let disk = Memory::default();
    let (w, events) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"22\n333\n", timed());
    disk.fail_after.lock().unwrap().push(4);
    w.flush("a");
    assert_eq!(disk.text(), "1\n22\n3");
    assert_eq!(failures(&events), ["disk full"]);
    assert_eq!(w.read("a").unwrap(), b"1\n22\n3\n333\n", "each record once, the torn part as one bad line");
    w.flush("a");
    assert_eq!(disk.text(), "1\n22\n3\n333\n");
    assert_eq!(reasons(&events), [Why::First, Why::Retry]);
    assert_eq!(failures(&events).len(), 1);
}

#[test]
fn a_failure_of_unknown_size_rewrites_the_whole_batch_after_a_newline() {
    let disk = Memory::default();
    let (w, events) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    disk.fail_after.lock().unwrap().push(1);
    *disk.blind_after_failure.lock().unwrap() = true;
    w.flush("a");
    assert_eq!(disk.text(), "1\n2");
    *disk.blind.lock().unwrap() = false;
    w.flush("a");
    assert_eq!(disk.text(), "1\n2\n2\n", "the record is whole once, and the torn part reads as one bad line");
    assert_eq!(failures(&events), ["disk full"]);
}

#[test]
fn a_size_that_cannot_be_read_before_the_append_writes_nothing_and_keeps_the_lines() {
    let disk = Memory::default();
    let (w, events) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    *disk.blind.lock().unwrap() = true;
    w.flush("a");
    assert_eq!(disk.text(), "1\n");
    *disk.blind.lock().unwrap() = false;
    w.flush("a");
    assert_eq!(disk.text(), "1\n2\n");
    assert_eq!(failures(&events), ["no size"]);
}

#[test]
fn a_failure_after_only_the_newline_leaves_no_torn_line() {
    let disk = Memory::default();
    disk.bytes.lock().unwrap().extend_from_slice(b"{half");
    let (w, _) = writer(&disk);
    disk.fail_after.lock().unwrap().push(1);
    w.append("a", b"1\n", timed());
    assert_eq!(disk.text(), "{half\n");
    w.flush("a");
    assert_eq!(disk.text(), "{half\n1\n");
}

#[test]
fn while_writes_keep_failing_the_queue_keeps_its_newest_lines_and_says_so() {
    let disk = Memory::default();
    let (w, events) = writer_with(&disk, Options { flush: HOUR, soon_bytes: 1 << 20, max_pending_bytes: 6 });
    w.append("a", b"1\n", timed());
    disk.fail_after.lock().unwrap().extend([0, 0, 0]);
    for line in [&b"2\n"[..], b"3\n", b"4\n", b"5\n"] {
        w.append("a", line, timed());
    }
    w.flush("a");
    assert_eq!(failures(&events), ["1 transcript line dropped: disk full"]);
    w.flush("a");
    w.append("a", b"6\n", timed());
    w.append("a", b"7\n", timed());
    w.flush("a");
    let said = failures(&events);
    assert_eq!(said.last().map(String::as_str), Some("2 transcript lines dropped: disk full"));
    w.flush("a");
    assert!(disk.text().ends_with("6\n7\n"), "{}", disk.text());
}

#[test]
fn removing_a_file_drops_its_queue_and_later_lines() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    w.remove("a").unwrap();
    assert_eq!(disk.text(), "");
    assert!(!w.has("a"));
    assert_eq!(w.pending("a"), 0);
    assert_eq!(w.read("a").unwrap_err().kind(), io::ErrorKind::NotFound);
    w.append("a", b"3\n", timed());
    w.flush("a");
    assert_eq!(disk.text(), "");
    // a file it never wrote
    w.remove("b").unwrap();
    assert!(!w.has("b"));
}

#[test]
fn has_and_read_for_a_file_this_writer_never_touched() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    assert!(!w.has("a"));
    assert_eq!(w.read("a").unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(w.pending("a"), 0);
    disk.bytes.lock().unwrap().extend_from_slice(b"on disk\n");
    assert!(w.has("a"));
    assert_eq!(w.read("a").unwrap(), b"on disk\n");
    w.flush("a");
}

#[test]
fn a_missing_file_with_pending_lines_reads_as_those_lines() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    disk.fail_after.lock().unwrap().push(0);
    w.append("a", b"1\n", timed());
    assert_eq!(disk.text(), "");
    assert!(w.has("a"));
    assert_eq!(w.read("a").unwrap(), b"1\n");
}

#[test]
fn after_a_drain_lines_are_written_as_they_come_and_a_quit_that_did_not_happen_ends_that() {
    let disk = Memory::default();
    let (w, events) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    w.drain(Duration::from_millis(30));
    assert_eq!(disk.text(), "1\n2\n");
    w.append("a", b"3\n", timed());
    assert_eq!(disk.text(), "1\n2\n3\n", "at once");
    w.flush("a");
    std::thread::sleep(Duration::from_millis(40));
    w.append("a", b"4\n", timed());
    assert_eq!(disk.text(), "1\n2\n3\n", "batched again");
    assert_eq!(reasons(&events), [Why::First, Why::Drain, Why::Drain]);
}

#[test]
fn a_writer_that_goes_writes_what_is_queued() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    drop(w);
    assert!(soon(|| disk.text() == "1\n2\n"), "{}", disk.text());
}

#[test]
fn nothing_is_timed_unless_asked_and_an_empty_append_is_nothing() {
    let disk = Memory::default();
    let (w, events) = writer(&disk);
    w.append("a", b"", Meta::default());
    assert!(!w.has("a"));
    w.append("a", b"1\n", Meta::default());
    assert!(events.lock().unwrap().is_empty());
    assert_eq!(Why::Tick.name(), "tick");
    assert_eq!(Why::Soon.name(), "soon");
    assert_eq!(Why::First.name(), "first");
    assert_eq!(Why::Flush.name(), "flush");
    assert_eq!(Why::Drain.name(), "drain");
    assert_eq!(Why::Retry.name(), "retry");
}

fn folder(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("transcript-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn the_real_disk_makes_folders_keeps_modes_and_reports_a_bad_path() {
    let dir = folder("disk");
    let file = dir.join("deep/a.jsonl");
    let (disk, name) = (RealDisk, file.to_string_lossy().into_owned());
    let events = Arc::new(Mutex::new(Vec::new()));
    let heard = events.clone();
    let w = Writer::new(RealDisk, Options { flush: HOUR, soon_bytes: 1 << 20, max_pending_bytes: 1 << 20 }, move |e| {
        heard.lock().unwrap().push(e)
    });
    w.append(&name, b"1\n", timed());
    w.append(&name, b"2\n", timed());
    assert_eq!(disk.size(&file).unwrap(), 2);
    assert_eq!(w.read(&name).unwrap(), b"1\n2\n");
    w.flush(&name);
    assert_eq!(disk.byte_at(&file, 3).unwrap(), b'\n');
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    w.remove(&name).unwrap();
    assert!(!file.exists());
    disk.remove(&file).unwrap();
    assert_eq!(disk.size(&file).unwrap(), 0);
    // a file where its folder should be
    std::fs::write(dir.join("plain"), "x").unwrap();
    let under = dir.join("plain/a.jsonl").to_string_lossy().into_owned();
    w.append(&under, b"1\n", timed());
    assert!(failures(&events).len() == 1);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_routes_open_append_read_and_close() {
    let dir = folder("routes");
    let file = dir.join("a.jsonl").to_string_lossy().into_owned();
    let open = br#"{"flushMs":3600000,"soonBytes":1048576,"maxPendingBytes":1048576}"#;
    let id = String::from_utf8(dispatch("transcript.open", open).unwrap()).unwrap();
    let at = format!(r#"{{"id":{id},"file":{file:?}}}"#);
    let line = |text: &str| {
        let head = format!(r#"{{"id":{id},"file":{file:?},"mode":384,"what":"w","chat":"c","timed":true}}"#);
        [head.as_bytes(), b"\n", text.as_bytes()].concat()
    };
    dispatch("transcript.append", &line("1\n")).unwrap();
    dispatch("transcript.append", &line("2\n")).unwrap();
    assert_eq!(dispatch("transcript.pending", at.as_bytes()), Ok(b"2".to_vec()));
    assert_eq!(dispatch("transcript.has", at.as_bytes()), Ok(b"true".to_vec()));
    assert_eq!(dispatch("transcript.read", at.as_bytes()), Ok(b"1\n2\n".to_vec()));
    let ask = format!(r#"{{"id":{id},"file":{file:?},"kinds":null,"needle":"2"}}"#);
    assert_eq!(dispatch("transcript.scan", ask.as_bytes()), Ok(br#"{"records":[],"torn":2,"found":true}"#.to_vec()));
    dispatch("transcript.flush", at.as_bytes()).unwrap();
    assert_eq!(dispatch("transcript.pending", at.as_bytes()), Ok(b"0".to_vec()));
    dispatch("transcript.drain", format!(r#"{{"id":{id},"syncMs":1}}"#).as_bytes()).unwrap();
    dispatch("transcript.remove", at.as_bytes()).unwrap();
    assert!(dispatch("transcript.read", at.as_bytes()).unwrap_err().starts_with("ENOENT"));
    assert!(dispatch("transcript.scan", ask.as_bytes()).unwrap_err().starts_with("ENOENT"));
    // a folder can't be removed as a file
    let folder = format!(r#"{{"id":{id},"file":{:?}}}"#, dir.to_string_lossy());
    assert!(dispatch("transcript.remove", folder.as_bytes()).is_err());
    let close = format!(r#"{{"id":{id}}}"#);
    assert_eq!(dispatch("transcript.close", close.as_bytes()), Ok(b"true".to_vec()));
    assert_eq!(dispatch("transcript.close", close.as_bytes()), Ok(b"false".to_vec()));
    assert!(dispatch("transcript.has", at.as_bytes()).unwrap_err().starts_with("no writer"));
    assert!(dispatch("transcript.open", b"{}").is_err());
    assert!(dispatch("transcript.append", b"no newline").is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_event_says_on_the_stream_what_the_writer_saw() {
    let failed = Event::Failed { file: "f".into(), what: "w".into(), message: "m".into() };
    let wrote = Event::Wrote { chat: "c".into(), records: 2, bytes: 4, ms: 1.5, why: Why::Tick };
    let json = |e| serde_json::from_slice::<serde_json::Value>(&crate::routes::event_json(7, e)).unwrap();
    assert_eq!(json(failed), serde_json::json!({ "transcript": 7, "failed": { "file": "f", "what": "w", "message": "m" } }));
    assert_eq!(
        json(wrote),
        serde_json::json!({ "transcript": 7, "wrote": { "chat": "c", "records": 2, "bytes": 4, "ms": 1.5, "reason": "tick" } })
    );
}

#[test]
fn the_routes_that_read_a_whole_file() {
    let dir = folder("whole");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("t.jsonl");
    let name = "01234567-89ab-cdef-0123-456789abcdef.wav";
    std::fs::write(&file, format!("{{\"type\":\"file-history-snapshot\",\"messageId\":\"p\"}}\n{{\"type\":\"user\",\"uuid\":\"p\",\"parentUuid\":null,\"path\":\"/a/{name}\"}}\n")).unwrap();
    let path = file.to_str().unwrap();
    let ask = |extra: String| format!("{{\"file\":{path:?},{extra}}}");

    assert_eq!(dispatch("transcript.contains", ask("\"needle\":\"history\",\"limit\":100".into()).as_bytes()), Ok(b"true".to_vec()));
    assert_eq!(dispatch("transcript.contains", ask("\"needle\":\"history\",\"limit\":4".into()).as_bytes()), Ok(b"false".to_vec()));
    assert_eq!(dispatch("transcript.checkpoints", ask("\"size\":1000".into()).as_bytes()), Ok(br#"{"p":null}"#.to_vec()));
    assert_eq!(dispatch("transcript.checkpoints", ask("\"size\":10".into()).as_bytes()), Ok(b"{}".to_vec()));

    let open = br#"{"flushMs":3600000,"soonBytes":1048576,"maxPendingBytes":1048576}"#;
    let id = String::from_utf8(dispatch("transcript.open", open).unwrap()).unwrap();
    let names = format!("{{\"id\":{id},\"files\":[{path:?},{:?}]}}", format!("{path}.absent"));
    assert_eq!(dispatch("transcript.audioRefs", names.as_bytes()), Ok(format!("[\"{name}\"]").into_bytes()));
    let unreadable = format!("{{\"id\":{id},\"files\":[{:?}]}}", dir.to_str().unwrap());
    assert!(dispatch("transcript.audioRefs", unreadable.as_bytes()).is_err());

    std::fs::remove_dir_all(&dir).unwrap();
    assert!(dispatch("transcript.contains", ask("\"needle\":\"x\",\"limit\":4".into()).as_bytes()).is_err());
    assert!(dispatch("transcript.checkpoints", ask("\"size\":4".into()).as_bytes()).is_err());
}
