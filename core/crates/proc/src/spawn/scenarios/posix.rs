//! A child's life on POSIX: real processes, through the routes.

use super::*;
use std::fs;
use std::os::fd::AsRawFd;

const SECOND: Duration = Duration::from_secs(1);

#[test]
fn output_comes_whole_and_in_order_and_the_exit_after_its_last_byte() {
    let listener = Listener::new();
    let script = "i=0; while [ $i -lt 3000 ]; do printf 'line %06d of the chunk stream\\n' $i; i=$((i+1)); done; echo done >&2; exit 7";
    let Started { id, .. } = listener.spawn(&sh(script));
    let child = Arc::downgrade(&super::child(id).expect("it runs"));
    let heard = listener.taking_until(CLOSED);
    let expected: String = (0..3000).map(|i| format!("line {i:06} of the chunk stream\n")).collect();
    assert_eq!(bytes_of(&heard, 0), expected.into_bytes());
    assert_eq!(bytes_of(&heard, 1), b"done\n");
    assert!(heard.iter().all(|h| h.id == id));
    let at = |kind| heard.iter().position(|h| h.kind == kind).expect("told");
    let last_byte = heard.iter().rposition(|h| h.kind < OUTPUT_END).expect("bytes");
    assert!(last_byte < at(EXIT));
    assert!(at(OUTPUT_END) < at(EXIT));
    assert!(at(OUTPUT_END + 1) < at(EXIT));
    assert_eq!(heard.last().map(|h| h.kind), Some(CLOSED));
    assert_eq!(exit_in(&heard), json!([7, null]));
    gone(&child);
    assert!(super::child(id).is_none(), "the handle went with its last event");
}

#[test]
fn a_spawn_through_its_route_says_how_to_talk_to_the_child() {
    let listener = Listener::new();
    let path = std::env::var("PATH").expect("a PATH");
    let payload = json!({ "command": "true", "args": [], "cwd": null, "env": [["PATH", path]], "stderr": false, "group": true, "hide": false, "verbatim": false });
    let reply = dispatch_call("proc.spawn", payload.to_string().as_bytes(), &listener.call).expect("a reply");
    let reply: serde_json::Value = serde_json::from_slice(&reply).expect("JSON");
    assert_eq!((reply["id"].is_u64(), reply["pid"].is_i64()), (true, true), "{reply}");
    assert_eq!((&reply["held"], &reply["cost"], &reply["ack"]), (&json!(false), &json!(CHUNK_COST), &json!(ACK_EVERY)));
    listener.until(CLOSED);
}

/// `script` from a thread that blocks SIGUSR1: a shell can't undo what it starts with, so this ends it only if it started with
/// an empty mask.
#[test]
fn a_signal_blocked_here_is_not_blocked_in_a_child() {
    let listener = Listener::new();
    // SAFETY: both are this thread's mask, and `set` this stack's; it goes back as it was below
    let previous = unsafe {
        let (mut set, mut previous): (libc::sigset_t, libc::sigset_t) = (std::mem::zeroed(), std::mem::zeroed());
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGUSR1);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut previous);
        previous
    };
    listener.spawn(&sh("kill -USR1 $$; echo survived"));
    // SAFETY: as above
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) };
    let heard = listener.until(CLOSED);
    assert_eq!(exit_in(&heard), json!([null, libc::SIGUSR1]));
    assert_eq!(bytes_of(&heard, 0), b"");
}

#[test]
fn a_child_gets_exactly_its_arguments_directory_and_environment() {
    let listener = Listener::new();
    let dir = fs::canonicalize(std::env::temp_dir()).expect("a temp folder");
    let mut run = sh("printf '%s|' \"$@\" \"$PWD\" \"$ONLY\" \"${HOME-unset}\"; env | wc -l");
    run.args.extend(["sh".into(), "one two".into(), "".into(), "é\"\\".into()]);
    run.cwd = Some(dir.display().to_string());
    run.env.push(("ONLY".into(), "a=b c".into()));
    listener.spawn(&run);
    let heard = listener.until(CLOSED);
    let text = String::from_utf8(bytes_of(&heard, 0)).expect("UTF-8");
    assert!(text.starts_with(&format!("one two||é\"\\|{}|a=b c|unset|", dir.display())), "{text}");
}

#[test]
fn a_grouped_child_leads_its_own_session_and_an_ungrouped_one_stays_in_this_group() {
    let listener = Listener::new();
    let Started { id, pid, held } = listener.spawn(&spec("cat", &[]));
    assert!(!held, "POSIX holds a child in its group");
    // SAFETY: both read one process's numbers
    let (group, session) = unsafe { (libc::getpgid(pid), libc::getsid(pid)) };
    assert_eq!((group, session), (pid, pid));
    assert!(super::child(id).expect("it runs").end_input());
    listener.until(CLOSED);

    let mut plain = spec("cat", &[]);
    plain.group = false;
    let Started { id, pid, .. } = listener.spawn(&plain);
    // SAFETY: as above
    assert_eq!(unsafe { libc::getpgid(pid) }, unsafe { libc::getpgrp() });
    assert_eq!(dispatch("proc.endInput", id.to_string().as_bytes()), Ok(b"true".to_vec()));
    assert_eq!(dispatch("proc.endInput", id.to_string().as_bytes()), Ok(b"false".to_vec()));
    listener.until(CLOSED);
}

#[test]
fn stderr_goes_nowhere_when_it_is_no_pipe() {
    let listener = Listener::new();
    let mut quiet = sh("echo out; echo err >&2");
    quiet.stderr = false;
    listener.spawn(&quiet);
    let heard = listener.until(CLOSED);
    assert_eq!(bytes_of(&heard, 0), b"out\n");
    assert_eq!(heard.iter().map(|h| h.kind).filter(|&kind| [1, OUTPUT_END + 1].contains(&kind)).count(), 0);
}

#[test]
fn stdin_keeps_its_order_and_ends_when_asked() {
    let listener = Listener::new();
    let Started { id, .. } = listener.spawn(&spec("cat", &[]));
    let child = super::child(id).expect("it runs");
    let mut expected = Vec::new();
    for i in 0..2000 {
        let line = format!("{i}\n").into_bytes();
        expected.extend_from_slice(&line);
        assert_eq!(child.write(line), Written::Queued);
    }
    assert!(child.end_input());
    assert_eq!(child.write(b"too late".to_vec()), Written::Gone);
    assert!(!child.end_input());
    let heard = listener.taking_until(CLOSED);
    assert_eq!(bytes_of(&heard, 0), expected);
}

#[test]
fn a_write_whose_child_end_went_is_epipe_however_the_socket_says_it() {
    for errno in [libc::ENOTCONN, libc::ESHUTDOWN, libc::EPIPE] {
        assert_eq!(stdio::write_errno(&io::Error::from_raw_os_error(errno)), Some(libc::EPIPE), "{errno}");
    }
    assert_eq!(stdio::write_errno(&io::Error::from_raw_os_error(libc::EBADF)), Some(libc::EBADF));
    assert_eq!(stdio::write_errno(&io::Error::other("no system error")), None);
}

#[test]
fn a_write_to_a_child_that_closed_its_stdin_is_told_and_blocks_nothing() {
    let listener = Listener::new();
    let Started { id, .. } = listener.spawn(&sh("exec 0<&-; echo closed; exec sleep 30"));
    let weak = Arc::downgrade(&super::child(id).expect("it runs"));
    assert_eq!(listener.next().bytes, b"closed\n");
    let payload = [id.to_string().as_bytes(), b"\nhello"].concat();
    assert_eq!(dispatch("proc.write", &payload), Ok(b"0".to_vec()));
    let failed = listener.until(INPUT_FAILED).pop().expect("told");
    let (errno, _): (Option<i32>, String) = serde_json::from_slice(&failed.bytes).expect("JSON");
    assert_eq!(errno, Some(libc::EPIPE));
    assert_eq!(dispatch("proc.write", &payload), Ok(b"2".to_vec()), "and the next is told at once");
    assert_eq!(dispatch("proc.signal", format!("{id} {}", libc::SIGKILL).as_bytes()), Ok(b"true".to_vec()));
    assert_eq!(exit_in(&listener.until(CLOSED)), json!([null, libc::SIGKILL]));
    gone(&weak);
}

#[test]
fn a_child_that_never_reads_stalls_only_its_writer_and_full_stdin_drains_when_it_does() {
    let listener = Listener::new();
    let Started { id, pid, .. } = listener.spawn(&spec("sleep", &["30"]));
    let child = super::child(id).expect("it runs");
    let weak = Arc::downgrade(&child);
    let page = vec![b'x'; 256 << 10];
    let started = Instant::now();
    let payload = [id.to_string().as_bytes(), b"\n", &page].concat();
    while dispatch("proc.write", &payload) != Ok(b"1".to_vec()) {}
    assert!(started.elapsed() < SECOND, "writing queues, whatever the child does");
    assert!(listener.events.recv_timeout(Duration::from_millis(50)).is_err(), "nothing was drained");
    drop(child);
    // SAFETY: this test's own child, which is not reaped until the wait below is told
    unsafe { libc::kill(pid, libc::SIGKILL) };
    // the write stuck on a full socket gave up with the child: told if its pipe failed first, and nothing follows the close
    assert_eq!(exit_in(&listener.until(CLOSED)), json!([null, libc::SIGKILL]));
    gone(&weak);
    assert!(listener.events.recv_timeout(Duration::from_millis(50)).is_err(), "the close is the last word");

    let Started { id, .. } = listener.spawn(&sh("cat > /dev/null"));
    let child = super::child(id).expect("it runs");
    while child.write(page.clone()) != Written::Full {}
    assert_eq!(listener.next().kind, INPUT_DRAINED);
    assert_eq!(child.write(page.clone()), Written::Queued);
    child.end_input();
    listener.until(CLOSED);
}

#[test]
fn framed_stdout_takes_a_line_longer_than_the_window_whole_and_the_exit_behind_it() {
    let listener = Listener::new();
    let script = "head -c 3000000 /dev/zero | tr '\\0' x; printf '\\n{\"last\":1}\\n\\npartial'; exit 4";
    let Started { .. } = listener.spawn(&Spec { lines: Some(lines::LineSpec { limit: None }), ..sh(script) });
    let heard = listener.taking_until(CLOSED);
    assert_eq!(lines_of(&heard), (vec![vec![b'x'; 3_000_000], b"{\"last\":1}".to_vec(), Vec::new()], false));
    assert!(heard.iter().all(|h| h.kind != 0), "no bytes but lines");
    let at = |kind| heard.iter().position(|h| h.kind == kind).expect("told");
    assert!(heard.iter().rposition(|h| h.kind == LINES).expect("lines") < at(OUTPUT_END));
    assert!(at(OUTPUT_END) < at(EXIT));
    assert_eq!(exit_in(&heard), json!([4, null]));
}

#[test]
fn output_nobody_takes_stops_at_the_window_and_goes_on_once_it_is_taken() {
    let listener = Listener::new();
    let Started { id, .. } = listener.spawn(&spec("yes", &[]));
    let child = super::child(id).expect("it runs");
    let mut taken = 0;
    let mut chunks = 0;
    while let Ok(heard) = listener.events.recv_timeout(Duration::from_millis(300)) {
        taken += heard.bytes.len();
        chunks += 1;
    }
    assert!((WINDOW / 2..=WINDOW + CHUNK).contains(&taken), "{taken} bytes went out before the reader stopped");
    // whatever JS has not taken, the exit is told once the child is gone, and what was unread still comes after it
    assert!(child.signal(libc::SIGKILL));
    listener.until(EXIT);
    assert!(!child.signal(0), "a child reaped is signalled no more");
    assert!(listener.events.recv_timeout(Duration::from_millis(50)).is_err(), "the reader still waits for JS");
    let amount = taken + chunks * CHUNK_COST;
    assert_eq!(dispatch("proc.ack", format!("{id} 0 {amount}").as_bytes()), Ok(Vec::new()));
    let heard = listener.until(CLOSED);
    assert!(heard.iter().any(|h| h.kind == OUTPUT_END));
    assert_eq!(dispatch("proc.ack", format!("{id} 0 {amount}").as_bytes()), Ok(Vec::new()), "too late is no error");
}

#[test]
fn a_process_that_outlives_the_child_holds_its_pipe_and_not_its_exit() {
    let listener = Listener::new();
    let Started { id, .. } = listener.spawn(&sh("(sleep 1; echo late) & echo first; exit 3"));
    let weak = Arc::downgrade(&super::child(id).expect("it runs"));
    let before = listener.until(EXIT);
    assert_eq!(bytes_of(&before, 0), b"first\n");
    assert_eq!(exit_in(&before), json!([3, null]));
    assert!(before.iter().all(|h| h.kind != OUTPUT_END), "its stdout is still open");
    // stdin went with the exit, and its end and the handle's wait for the pipe
    assert!(super::child(id).is_some());
    assert_eq!(dispatch("proc.write", &[id.to_string().as_bytes(), b"\nx"].concat()), Ok(b"2".to_vec()));
    let after = listener.until(CLOSED);
    assert_eq!(bytes_of(&after, 0), b"late\n");
    gone(&weak);
}

#[test]
fn a_write_made_on_hearing_the_exit_is_refused_as_gone() {
    // JS writes the moment it hears the exit, on the thread that tells it: stdin must be gone by then, not open a moment longer
    let owner = new_owner();
    let (sink, answers) = channel();
    attach(owner, move |message| {
        let heard = heard_of(message);
        // what came before the exit (its output) is let by; the exit is answered with a write, there and then
        let answer = (heard.kind == EXIT).then(|| dispatch("proc.write", &[heard.id.to_string().as_bytes(), b"\nx"].concat()));
        let _ = sink.send(answer);
    });
    let call = Call::of(owner);
    let Started { .. } = launch(&sh("echo first; (sleep 1; echo late) & exit 3"), &call, start_thread).expect("it starts");
    let answer = loop {
        if let Some(answer) = answers.recv_timeout(LONG).expect("the exit is told") {
            break answer;
        }
    };
    assert_eq!(answer, Ok(b"2".to_vec()), "stdin went before the exit was told");
    release(owner);
    detach(owner);
}

#[test]
fn a_survivor_that_never_goes_quiet_does_not_hold_the_exit() {
    for script in ["(while :; do echo x; sleep 0.05; done) & exit 3", "(while :; do echo x >&2; sleep 0.05; done) & exit 3"] {
        let listener = Listener::new();
        let Started { pid, .. } = listener.spawn(&sh(script));
        assert_eq!(exit_in(&listener.taking_until(EXIT)), json!([3, null]), "{script}");
        // SAFETY: the group the child led, which only the survivor is left in: what endGroup does on hearing of the exit
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        listener.taking_until(CLOSED);
    }
}

#[test]
fn stdin_closed_at_once_ends_the_child_s_read_with_what_is_queued_dropped() {
    let listener = Listener::new();
    let Started { id, .. } = listener.spawn(&sh("sleep 0.05; cat > /dev/null; echo ended"));
    let child = super::child(id).expect("it runs");
    assert_eq!(child.write(vec![b'x'; 256 << 10]), Written::Queued);
    assert_eq!(dispatch("proc.closeInput", id.to_string().as_bytes()), Ok(Vec::new()));
    assert_eq!(child.write(b"too late".to_vec()), Written::Gone);
    assert_eq!(bytes_of(&listener.taking_until(CLOSED), 0), b"ended\n");
}

#[test]
fn a_handle_that_goes_with_its_environment_closes_stdin_and_leaves_no_thread_waiting_for_it() {
    // `cat` ends on the end of its input; `yes` on its pipe's, once its reader, stopped at a full window, lets go
    for (command, wrote) in [("cat", false), ("yes", true)] {
        let listener = Listener::new();
        let Started { id, pid, .. } = listener.spawn(&spec(command, &[]));
        let weak = Arc::downgrade(&super::child(id).expect("it runs"));
        if wrote {
            while listener.events.recv_timeout(Duration::from_millis(300)).is_ok() {}
        }
        release(listener.call.owner);
        gone(&weak);
        // the waiter let go last, having reaped it: no zombie, nothing at the pid
        // SAFETY: signal 0 only asks
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{command} was reaped");
    }
}

#[test]
fn what_a_system_refuses_comes_back_as_its_error() {
    let listener = Listener::new();
    let reply = |spec_json: serde_json::Value| {
        let answer = dispatch_call("proc.spawn", spec_json.to_string().as_bytes(), &listener.call).expect("a reply");
        serde_json::from_slice::<serde_json::Value>(&answer).expect("JSON")
    };
    let spawn = |command: &str, cwd: Option<&str>| {
        reply(
            json!({ "command": command, "args": [], "cwd": cwd, "env": [["PATH", "/nowhere"]], "stderr": true, "group": true, "hide": false, "verbatim": false }),
        )
    };
    assert_eq!(spawn("mopilot-no-such-binary", None)["errno"], libc::ENOENT);
    assert_eq!(spawn("/mopilot/no/such/binary", None)["errno"], libc::ENOENT);
    assert_eq!(spawn("/bin/sh", Some("/mopilot/no/such/folder"))["errno"], libc::ENOENT, "a bad cwd reads as Node's does");
    let file = std::env::temp_dir().join(format!("mopilot-not-executable-{}", std::process::id()));
    fs::write(&file, "text").expect("a file");
    assert_eq!(spawn(file.to_str().expect("UTF-8"), None)["errno"], libc::EACCES);
    fs::remove_file(&file).expect("removed");
    assert!(listener.events.recv_timeout(Duration::from_millis(50)).is_err(), "no event came of any of them");
}

#[test]
fn a_descriptor_that_is_not_close_on_exec_stays_out_of_a_child() {
    let listener = Listener::new();
    let file = fs::File::open("/dev/null").expect("a descriptor");
    let fd = file.as_raw_fd();
    // SAFETY: fcntl on a descriptor this holds
    unsafe { libc::fcntl(fd, libc::F_SETFD, 0) };
    let mut run = sh("[ -e /dev/fd/$0 ] && echo kept || echo gone");
    run.args.push(fd.to_string());
    listener.spawn(&run);
    assert_eq!(bytes_of(&listener.until(CLOSED), 0), b"gone\n");
}

#[test]
fn both_ends_of_a_socket_pair_have_the_buffers_libuv_gives_a_child() {
    let (ours, theirs) = stdio::socket_pair().expect("a pair");
    for socket in [&ours, &theirs] {
        for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
            let (mut size, mut length) = (0 as libc::c_int, size_of::<libc::c_int>() as libc::socklen_t);
            // SAFETY: the socket is open, and `size` has room for `length` bytes
            let read = unsafe { libc::getsockopt(socket.as_raw_fd(), libc::SOL_SOCKET, option, (&raw mut size).cast(), &mut length) };
            assert_eq!(read, 0);
            // Linux reports double what it was asked for
            assert!([stdio::SOCKET_BUFFER, 2 * stdio::SOCKET_BUFFER].contains(&size), "{size}");
        }
    }
}

#[test]
fn a_signal_this_process_ignores_is_back_at_its_default_in_a_child() {
    // SAFETY: a signal no test here sends or expects, whose disposition only this test changes
    let before = unsafe { libc::signal(libc::SIGXFSZ, libc::SIG_IGN) };
    let listener = Listener::new();
    listener.spawn(&sh("kill -s XFSZ $$; echo survived"));
    let heard = listener.until(CLOSED);
    // SAFETY: as above, putting back what it found
    unsafe { libc::signal(libc::SIGXFSZ, before) };
    assert_eq!(exit_in(&heard), json!([null, libc::SIGXFSZ]));
    assert_eq!(bytes_of(&heard, 0), b"");
}
