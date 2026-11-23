//! A child's life on Windows: real processes, through the routes.

use super::*;

const ERROR_FILE_NOT_FOUND: i64 = 2;
const ERROR_INVALID_NAME: i64 = 123;

fn cmd(script: &str) -> Spec {
    spec("cmd", &["/d", "/c", script])
}

#[test]
fn a_child_is_held_runs_and_is_told_of_with_its_unsigned_exit_code() {
    let listener = Listener::new();
    let Started { id, held, .. } = listener.spawn(&cmd("echo one& exit /b -1073741819"));
    assert!(held, "in a Job Object from its spawn");
    let weak = Arc::downgrade(&super::child(id).expect("it runs"));
    let heard = listener.until(CLOSED);
    assert_eq!(bytes_of(&heard, 0), b"one\r\n");
    assert_eq!(exit_in(&heard), json!([0xC000_0005_u32, null]));
    gone(&weak);
}

#[test]
fn verbatim_arguments_reach_cmd_as_they_are_and_quoted_ones_as_one() {
    let listener = Listener::new();
    let mut raw = spec("cmd", &["/d", "/s", "/c", "\"echo a  b\""]);
    raw.verbatim = true;
    raw.hide = false;
    raw.stderr = false;
    listener.spawn(&raw);
    assert_eq!(bytes_of(&listener.until(CLOSED), 0), b"a  b\r\n");
}

#[test]
fn stdin_reaches_a_child_and_a_kill_ends_it() {
    let listener = Listener::new();
    let Started { id, .. } = listener.spawn(&cmd("findstr x"));
    let child = super::child(id).expect("it runs");
    assert_eq!(child.write(b"x\r\n".to_vec()), Written::Queued);
    assert!(child.end_input());
    assert_eq!(bytes_of(&listener.until(CLOSED), 0), b"x\r\n");

    let Started { id, pid, .. } = listener.spawn(&cmd("ping -n 30 127.0.0.1"));
    let child = super::child(id).expect("it runs");
    assert!(child.signal(0), "0 only asks");
    assert!(child.signal(15));
    assert_eq!(exit_in(&listener.until(EXIT)), json!([1, null]));
    assert!(!child.signal(0), "a child reaped is signalled no more");
    // the ping it left in its job, which is what holds the pipe open
    crate::end_contained(pid).expect("a pid").expect("held");
    listener.until(CLOSED);
}

/// What `proc.spawn` of `command` replies, with `args`.
fn spawn_reply(listener: &Listener, command: &str, args: &[&str]) -> serde_json::Value {
    let payload = json!({ "command": command, "args": args, "cwd": null, "env": [], "stderr": true, "group": false, "hide": true, "verbatim": false });
    let reply = dispatch_call("proc.spawn", payload.to_string().as_bytes(), &listener.call).expect("a reply");
    serde_json::from_slice(&reply).expect("JSON")
}

#[test]
fn a_folder_or_a_quoted_path_comes_back_as_not_found_as_node_says() {
    let listener = Listener::new();
    let folder = std::env::temp_dir().join(format!("mopilot-spawn-folder-{}", std::process::id()));
    std::fs::create_dir_all(&folder).expect("a folder");
    // a folder is not found (2), as Node's search skips it, where CreateProcessW says access denied (5)
    assert_eq!(spawn_reply(&listener, &folder.display().to_string(), &[])["errno"], ERROR_FILE_NOT_FOUND);
    // a quoted name is an invalid one (123), which JS names ENOENT as libuv does
    let quoted = format!("\"{}\"", folder.join("codex.exe").display());
    assert_eq!(spawn_reply(&listener, &quoted, &[])["errno"], ERROR_INVALID_NAME);
    let _ = std::fs::remove_dir(&folder);
}

#[test]
fn a_folder_with_a_program_beside_it_runs_the_program_as_node_does() {
    let listener = Listener::new();
    let base = std::env::temp_dir().join(format!("mopilot-spawn-beside-{}", std::process::id()));
    let folder = base.join("codex");
    std::fs::create_dir_all(&folder).expect("a folder");
    let system = std::env::var("SystemRoot").expect("SystemRoot, which every Windows process has");
    std::fs::copy(std::path::Path::new(&system).join("System32").join("cmd.exe"), base.join("codex.exe")).expect("a program");
    // `<base>\codex` names the folder; Rust's resolution, as libuv's, runs codex.exe beside it
    let reply = spawn_reply(&listener, &folder.display().to_string(), &["/d", "/c", "exit 3"]);
    assert!(reply.get("errno").is_none(), "it starts: {reply}");
    let heard = listener.until(CLOSED);
    assert_eq!(exit_in(&heard), json!([3, null]));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_folder_with_a_com_program_beside_it_runs_that_program_as_libuv_does() {
    let listener = Listener::new();
    let base = std::env::temp_dir().join(format!("mopilot-spawn-com-{}", std::process::id()));
    let folder = base.join("codex");
    std::fs::create_dir_all(&folder).expect("a folder");
    let system = std::env::var("SystemRoot").expect("SystemRoot, which every Windows process has");
    // a program file runs by its content whatever its extension: cmd.exe as codex.com
    std::fs::copy(std::path::Path::new(&system).join("System32").join("cmd.exe"), base.join("codex.com")).expect("a program");
    // libuv tries `.com` before `.exe`, and Rust's own resolution tries only `.exe`, which isn't there
    let reply = spawn_reply(&listener, &folder.display().to_string(), &["/d", "/c", "exit 4"]);
    assert!(reply.get("errno").is_none(), "it starts: {reply}");
    let heard = listener.until(CLOSED);
    assert_eq!(exit_in(&heard), json!([4, null]));
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_binary_that_is_not_there_comes_back_as_its_error() {
    let listener = Listener::new();
    let payload = json!({ "command": "mopilot-no-such-binary", "args": [], "cwd": null, "env": [], "stderr": true, "group": false, "hide": true, "verbatim": false });
    let reply = dispatch_call("proc.spawn", payload.to_string().as_bytes(), &listener.call).expect("a reply");
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&reply).expect("JSON")["errno"], ERROR_FILE_NOT_FOUND);
}

#[test]
fn a_root_left_to_finish_runs_on_in_its_job_until_it_is_gone() {
    let listener = Listener::new();
    let Started { pid, held, .. } = listener.spawn(&cmd("echo up& ping -n 2 127.0.0.1 > nul& exit /b 7"));
    assert!(held);
    // in its job from the spawn, so this ends what it started so far, its ping or nothing
    crate::windows::end_contained(pid, false).expect("held");
    let heard = listener.until(CLOSED);
    assert_eq!(bytes_of(&heard, 0), b"up\r\n");
    assert_eq!(exit_in(&heard), json!([7, null]));
    // still held once it is gone, and this lets the job go
    assert!(crate::windows::end_contained(pid, false).is_some());
    assert!(crate::windows::end_contained(pid, false).is_none());
}

#[test]
fn closing_the_job_ends_the_child_as_this_process_s_going_closes_it() {
    let listener = Listener::new();
    let Started { pid, held, .. } = listener.spawn(&cmd("ping -n 30 127.0.0.1"));
    assert!(held);
    crate::windows::close_job(pid);
    listener.until(EXIT);
    // the ping was in the job too: nothing is left holding its pipes
    listener.until(CLOSED);
}
