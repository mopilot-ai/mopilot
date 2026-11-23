//! The proc crate's core routes: `proc.table`, every process as JSON `[pid, ppid, pgid]` rows (the rows
//! electron/platform/processTree.cjs reads from `ps`), `proc.commands`, every process as `[pid, ppid, command, executable]` (the rows
//! electron/harness/claude/presence.cjs reads from `ps`), `proc.pressure`, the kernel's pressure level or `null`, and
//! `proc.started`, when one process started in Unix milliseconds or `null` (electron/platform/processIdentity.cjs
//! processStart), `proc.kill`, a process tree ended children first (electron/platform/winbin.cjs killTree on Windows, for taskkill),
//! `proc.contain`, a child's tree held in a Windows Job Object (spawnGroup; the payload is its pid and when it was
//! spawned), and `proc.endContained`, what was held ended (endGroup, after the child exited).

use crate::{CommandLine, Process};
use dispatch::Route;
use std::io;

fn table(_: &[u8]) -> Result<Vec<u8>, String> {
    table_reply(crate::table())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn identities(_: &[u8]) -> Result<Vec<u8>, String> {
    identities_reply(crate::identities())
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn identities_reply(read: io::Result<Vec<crate::ProcessIdentity>>) -> Result<Vec<u8>, String> {
    match read {
        Ok(rows) => Ok(format!(
            "[{}]",
            rows.iter()
                .map(|row| {
                    let p = row.process;
                    format!("[{},{},{},{}]", p.pid, p.ppid, p.pgid, json_string(&row.birth))
                })
                .collect::<Vec<_>>()
                .join(",")
        )
        .into_bytes()),
        Err(e) => Err(format!("read process identities: {e}")),
    }
}

fn commands(_: &[u8]) -> Result<Vec<u8>, String> {
    commands_reply(crate::commands())
}

fn commands_reply(read: io::Result<Vec<CommandLine>>) -> Result<Vec<u8>, String> {
    match read {
        Ok(rows) => {
            let row = |p: &CommandLine| format!("[{},{},{},{}]", p.pid, p.ppid, json_string(&p.command), json_string(&p.executable));
            let body: Vec<String> = rows.iter().map(row).collect();
            Ok(format!("[{}]", body.join(",")).into_bytes())
        }
        Err(e) => Err(format!("read the command lines: {e}")),
    }
}

/// `s` as a JSON string: quotes, backslashes and control characters escaped.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn started(payload: &[u8]) -> Result<Vec<u8>, String> {
    let pid = pid_of(payload)?;
    started_reply(pid, crate::started(pid))
}

fn started_reply(pid: i32, read: io::Result<Option<u64>>) -> Result<Vec<u8>, String> {
    match read {
        Ok(Some(at)) => Ok(at.to_string().into_bytes()),
        Ok(None) => Ok(b"null".to_vec()),
        Err(e) => Err(format!("read when {pid} started: {e}")),
    }
}

fn kill(payload: &[u8]) -> Result<Vec<u8>, String> {
    let pid = pid_of(payload)?;
    kill_reply(pid, crate::kill_tree(pid))
}

/// The pid a payload names: its bytes as a decimal number.
fn pid_of(payload: &[u8]) -> Result<i32, String> {
    std::str::from_utf8(payload).ok().and_then(|s| s.trim().parse().ok()).ok_or_else(|| "proc routes take a pid".to_string())
}

fn contain(payload: &[u8]) -> Result<Vec<u8>, String> {
    let (pid, at) = spawn_of(payload)?;
    crate::contain(pid, at).map(|held| held.to_string().into_bytes()).map_err(|e| format!("hold the tree of {pid}: {e}"))
}

/// The child a hold names: its pid and when it was spawned (Unix milliseconds), as two decimal numbers.
fn spawn_of(payload: &[u8]) -> Result<(i32, u64), String> {
    let text = std::str::from_utf8(payload).unwrap_or_default();
    let mut words = text.split_whitespace();
    match (words.next().and_then(|w| w.parse().ok()), words.next().and_then(|w| w.parse().ok()), words.next()) {
        (Some(pid), Some(at), None) => Ok((pid, at)),
        _ => Err("proc.contain takes a pid and when it was spawned".to_string()),
    }
}

fn end_contained(payload: &[u8]) -> Result<Vec<u8>, String> {
    let pid = pid_of(payload)?;
    match crate::end_contained(pid) {
        Ok(None) => Ok(b"null".to_vec()),
        ended => kill_reply(pid, ended.map(Option::unwrap_or_default)),
    }
}

fn kill_reply(pid: i32, killed: io::Result<Vec<i32>>) -> Result<Vec<u8>, String> {
    match killed {
        Ok(pids) => Ok(format!("[{}]", pids.iter().map(i32::to_string).collect::<Vec<_>>().join(",")).into_bytes()),
        Err(e) => Err(format!("kill the tree of {pid}: {e}")),
    }
}

fn pressure(_: &[u8]) -> Result<Vec<u8>, String> {
    pressure_reply(crate::pressure_level())
}

fn table_reply(read: io::Result<Vec<Process>>) -> Result<Vec<u8>, String> {
    match read {
        Ok(rows) => Ok(rows_json(&rows).into_bytes()),
        Err(e) => Err(format!("read the process table: {e}")),
    }
}

fn pressure_reply(read: io::Result<Option<u32>>) -> Result<Vec<u8>, String> {
    match read {
        Ok(Some(level)) => Ok(level.to_string().into_bytes()),
        Ok(None) => Ok(b"null".to_vec()),
        Err(e) => Err(format!("read the memory pressure level: {e}")),
    }
}

fn rows_json(rows: &[Process]) -> String {
    let body: Vec<String> = rows.iter().map(|p| format!("[{},{},{}]", p.pid, p.ppid, p.pgid)).collect();
    format!("[{}]", body.join(","))
}

inventory::submit! { Route { name: "proc.table", handler: table } }
#[cfg(any(target_os = "linux", target_os = "macos"))]
inventory::submit! { Route { name: "proc.identities", handler: identities } }
inventory::submit! { Route { name: "proc.pressure", handler: pressure } }
inventory::submit! { Route { name: "proc.commands", handler: commands } }
inventory::submit! { Route { name: "proc.started", handler: started } }
inventory::submit! { Route { name: "proc.kill", handler: kill } }
inventory::submit! { Route { name: "proc.contain", handler: contain } }
inventory::submit! { Route { name: "proc.endContained", handler: end_contained } }

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn identity_rows_include_birth_strings_and_preserve_read_errors() {
        let p = Process { pid: 7, ppid: 1, pgid: 7 };
        assert_eq!(
            identities_reply(Ok(vec![crate::ProcessIdentity { process: p, birth: "birth".into() }])),
            Ok(br#"[[7,1,7,"birth"]]"#.to_vec())
        );
        assert_eq!(identities_reply(Ok(vec![])), Ok(b"[]".to_vec()));
        assert_eq!(
            identities_reply(Err(io::Error::from(io::ErrorKind::PermissionDenied))),
            Err("read process identities: permission denied".into())
        );
        assert!(String::from_utf8(dispatch::dispatch("proc.identities", b"").expect("identities"))
            .expect("json")
            .contains(&format!("[{},", std::process::id())));
    }

    #[test]
    fn a_start_is_its_milliseconds_null_for_no_such_process_or_says_why_it_cannot_be_read() {
        assert_eq!(started_reply(7, Ok(Some(1_700_000_000_123))), Ok(b"1700000000123".to_vec()));
        assert_eq!(started_reply(7, Ok(None)), Ok(b"null".to_vec()));
        assert_eq!(
            started_reply(7, Err(io::Error::from(io::ErrorKind::PermissionDenied))),
            Err("read when 7 started: permission denied".into())
        );
        let own = dispatch::dispatch("proc.started", std::process::id().to_string().as_bytes()).expect("own start");
        let own: u128 = String::from_utf8(own).expect("utf-8").parse().expect("milliseconds");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis();
        assert!(now.abs_diff(own) < 3_600_000, "{own} against {now}");
        assert_eq!(dispatch::dispatch("proc.started", i32::MAX.to_string().as_bytes()), Ok(b"null".to_vec()));
        assert_eq!(dispatch::dispatch("proc.started", b"nope"), Err("proc routes take a pid".into()));
    }

    #[test]
    fn rows_are_json_triples() {
        assert_eq!(rows_json(&[]), "[]");
        assert_eq!(rows_json(&[Process { pid: 1, ppid: 0, pgid: 1 }, Process { pid: 9, ppid: 1, pgid: 9 }]), "[[1,0,1],[9,1,9]]");
    }

    #[test]
    fn the_replies_carry_a_reading_or_its_error() {
        assert_eq!(table_reply(Ok(vec![Process { pid: 1, ppid: 0, pgid: 1 }])), Ok(b"[[1,0,1]]".to_vec()));
        let denied = || io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(table_reply(Err(denied())), Err("read the process table: permission denied".into()));
        assert_eq!(pressure_reply(Ok(Some(4))), Ok(b"4".to_vec()));
        assert_eq!(pressure_reply(Ok(None)), Ok(b"null".to_vec()));
        assert_eq!(pressure_reply(Err(denied())), Err("read the memory pressure level: permission denied".into()));
    }

    #[test]
    fn command_lines_are_json_rows_with_their_strings_escaped() {
        let rows = vec![
            CommandLine { pid: 7, ppid: 1, command: "a \"b\" c\\d".into(), executable: "/bin/a b".into() },
            CommandLine { pid: 8, ppid: 7, command: "tab\there\u{1}".into(), executable: String::new() },
        ];
        assert_eq!(commands_reply(Ok(rows)), Ok(br#"[[7,1,"a \"b\" c\\d","/bin/a b"],[8,7,"tab\u0009here\u0001",""]]"#.to_vec()));
        assert_eq!(commands_reply(Ok(vec![])), Ok(b"[]".to_vec()));
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        assert_eq!(commands_reply(Err(denied)), Err("read the command lines: permission denied".into()));
    }

    #[test]
    fn a_kill_names_its_pid_and_replies_with_what_died() {
        assert_eq!(pid_of(b" 42\n"), Ok(42));
        for bad in [&b"x"[..], b"", &[0xff][..]] {
            assert_eq!(pid_of(bad), Err("proc routes take a pid".into()));
        }
        assert_eq!(kill_reply(9, Ok(vec![11, 9])), Ok(b"[11,9]".to_vec()));
        assert_eq!(kill_reply(9, Ok(vec![])), Ok(b"[]".to_vec()));
        let gone = io::Error::from(io::ErrorKind::InvalidInput);
        assert_eq!(kill_reply(1, Err(gone)), Err("kill the tree of 1: invalid input parameter".into()));
        // through the route: a pid it refuses, and a payload that names none
        assert!(dispatch::dispatch("proc.kill", b"1").is_err());
        assert!(dispatch::dispatch("proc.kill", b"nope").is_err());
    }

    #[test]
    fn a_hold_and_its_end_reply_with_what_they_did() {
        // not this process's child (POSIX holds nothing at all): not held, and nothing to end
        assert_eq!(dispatch::dispatch("proc.contain", b"4242 1761600000000"), Ok(b"false".to_vec()));
        assert_eq!(dispatch::dispatch("proc.endContained", b"4242"), Ok(b"null".to_vec()));
        assert!(dispatch::dispatch("proc.contain", b"1 1761600000000").is_err(), "proc.contain refuses init");
        assert!(dispatch::dispatch("proc.endContained", b"1").is_err(), "proc.endContained refuses init");
        assert_eq!(spawn_of(b" 42 1761600000000\n"), Ok((42, 1761600000000)));
        for bad in [&b"42"[..], b"42 x", b"42 1 2", b"", &[0xff][..]] {
            assert_eq!(spawn_of(bad), Err("proc.contain takes a pid and when it was spawned".into()));
        }
    }

    #[test]
    fn the_routes_reply_with_this_machine_s_table() {
        let table = String::from_utf8(dispatch::dispatch("proc.table", b"").expect("a table")).expect("utf-8");
        assert!(table.contains(&format!("[{},", std::process::id())), "{table}");
        assert!(dispatch::dispatch("proc.pressure", b"").is_ok());
        // command lines: macOS and Linux (Windows reads none yet)
        #[cfg(unix)]
        {
            let commands = String::from_utf8(dispatch::dispatch("proc.commands", b"").expect("command lines")).expect("utf-8");
            assert!(commands.contains(&format!("[{},", std::process::id())), "{commands}");
        }
    }
}
