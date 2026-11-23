//! The writer while a read or a write of the same file is held up on the disk, and how its events start.

use crate::tests_disk::{failures, soon, timed, writer, writer_with, Memory};
use crate::{Event, Options, Why};
use std::io;
use std::sync::Arc;
use std::time::Duration;

/// Whether what is on `disk` goes within a few seconds.
fn goes(disk: &Memory) -> bool {
    soon(|| disk.text().is_empty())
}

#[test]
fn a_file_removed_while_a_read_holds_it_still_goes() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    let w = Arc::new(w);
    w.append("a", b"1\n", timed());
    disk.gate.0.lock().unwrap().1 = false;
    disk.shut();
    let reader = {
        let w = w.clone();
        std::thread::spawn(move || w.read("a"))
    };
    disk.until_arrived();
    w.remove("a").unwrap();
    assert_eq!(disk.text(), "1\n", "the read is still at it");
    disk.open_gate();
    assert_eq!(reader.join().unwrap().unwrap_err().kind(), io::ErrorKind::NotFound);
    assert!(goes(&disk), "the file is still there");
}

#[test]
fn a_file_with_a_batch_on_its_way_counts_as_there() {
    let disk = Memory::default();
    disk.fail_after.lock().unwrap().push(0);
    let (w, _) = writer(&disk);
    let w = Arc::new(w);
    w.append("a", b"1\n", timed());
    assert!(w.has("a"), "the failed first line is queued again");
    disk.gate.0.lock().unwrap().1 = false;
    disk.shut();
    let flusher = {
        let w = w.clone();
        std::thread::spawn(move || w.flush("a"))
    };
    disk.until_arrived();
    assert_eq!(w.pending("a"), 0);
    assert!(w.has("a"), "its only line is in the write");
    disk.open_gate();
    flusher.join().unwrap();
    assert_eq!(disk.text(), "1\n");
}

#[test]
fn a_tail_that_could_not_be_read_is_read_again() {
    let disk = Memory::default();
    disk.bytes.lock().unwrap().extend_from_slice(b"torn");
    *disk.tail_fails.lock().unwrap() = 1;
    let (w, events) = writer(&disk);
    w.append("a", b"1\n", timed());
    assert_eq!(failures(&events), ["no tail"]);
    w.flush("a");
    assert_eq!(disk.text(), "torn\n1\n");
}

#[test]
fn an_event_starts_as_its_listener_knows_it() {
    let wrote = Event::Wrote { chat: "c".into(), records: 1, bytes: 2, ms: 3.0, why: Why::Tick };
    let text = String::from_utf8(crate::routes::event_json(7, wrote)).unwrap();
    assert!(text.starts_with(r#"{"transcript":7,"wrote":{"#), "{text}");
    let failed = Event::Failed { file: "f".into(), what: "w".into(), message: "m".into() };
    let text = String::from_utf8(crate::routes::event_json(7, failed)).unwrap();
    assert!(text.starts_with(r#"{"transcript":7,"failed":{"#), "{text}");
}

#[test]
fn a_bound_keeps_a_last_line_whole_or_not() {
    let disk = Memory::default();
    let options = Options { flush: Duration::from_secs(3600), soon_bytes: 1 << 20, max_pending_bytes: 2 };
    let (w, _) = writer_with(&disk, options);
    disk.fail_after.lock().unwrap().push(0);
    w.append("a", b"a long line\n", timed());
    assert_eq!(w.pending("a"), 12, "its only line stays, however long");
    disk.fail_after.lock().unwrap().push(0);
    w.append("b", b"no end", timed());
    assert_eq!(w.pending("b"), 6);
}

#[test]
fn a_write_that_fails_while_draining_waits_for_no_tick() {
    let disk = Memory::default();
    disk.fail_after.lock().unwrap().extend([0, 0]);
    let (w, _) = writer(&disk);
    w.append("a", b"1\n", timed());
    w.drain(Duration::from_secs(3600));
    assert_eq!(w.pending("a"), 2);
    w.flush("a");
    assert_eq!(disk.text(), "1\n");
}

#[test]
fn a_batch_that_came_back_to_a_removed_file_is_not_written() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    let w = Arc::new(w);
    w.append("a", b"1\n", timed());
    w.append("a", b"2\n", timed());
    disk.fail_after.lock().unwrap().push(0);
    disk.gate.0.lock().unwrap().1 = false;
    disk.shut();
    let flusher = {
        let w = w.clone();
        std::thread::spawn(move || w.flush("a"))
    };
    disk.until_arrived();
    w.remove("a").unwrap();
    disk.open_gate();
    flusher.join().unwrap();
    w.flush("a");
    assert!(goes(&disk), "the file is still there");
    assert!(!w.has("a"));
}

#[test]
fn a_file_that_ended_its_line_needs_no_newline_first() {
    let disk = Memory::default();
    disk.bytes.lock().unwrap().extend_from_slice(b"done\n");
    let (w, _) = writer(&disk);
    w.append("a", b"1\n", timed());
    assert_eq!(disk.text(), "done\n1\n");
}

#[test]
fn a_read_puts_pending_lines_after_the_file_as_they_will_land() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    // a failed write left half a line: the pending lines start on their own
    disk.fail_after.lock().unwrap().push(1);
    w.append("a", b"12\n", timed());
    assert_eq!(w.read("a").unwrap(), b"1\n12\n");
    w.flush("a");
    assert_eq!(w.read("a").unwrap(), b"1\n12\n", "nothing pending is the file as it is");

    // not on the disk at all: the pending lines are all there is
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    disk.fail_after.lock().unwrap().push(0);
    w.append("b", b"3\n", timed());
    assert_eq!(w.read("b").unwrap(), b"3\n");
    w.flush("b");
    disk.bytes.lock().unwrap().clear();
    assert_eq!(w.read("b").unwrap_err().kind(), io::ErrorKind::NotFound);
}

#[test]
fn a_file_counts_as_there_by_its_queue_or_the_disk() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    assert!(!w.has("never"));
    w.append("a", b"1\n", timed());
    w.flush("a");
    assert!(w.has("a"), "on the disk, nothing queued");
    disk.bytes.lock().unwrap().clear();
    assert!(!w.has("a"), "gone from the disk, nothing queued");
}

#[test]
fn a_file_that_cannot_be_read_says_so_whatever_is_queued() {
    let disk = Memory::default();
    let (w, _) = writer(&disk);
    disk.fail_after.lock().unwrap().push(0);
    w.append("a", b"1\n", timed());
    *disk.unreadable.lock().unwrap() = true;
    assert_eq!(w.read("a").unwrap_err().kind(), io::ErrorKind::PermissionDenied);
}
