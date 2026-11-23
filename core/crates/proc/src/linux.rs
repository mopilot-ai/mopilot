//! Linux: the process table from `/proc/<pid>/stat`, and command lines from `/proc/<pid>/cmdline`.

use crate::{CommandLine, Process, ProcessIdentity};
use std::{fs, io};

/// A process's stat line. A command name can be cut in the middle of a character or not be UTF-8 at all, and it isn't what is read.
fn read_stat(pid: i32) -> io::Result<String> {
    fs::read(format!("/proc/{pid}/stat")).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether a read failed because the process is gone: an entry can go before it is opened (not found) or after (no such process).
fn gone(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(libc::ESRCH)
}

/// Whether a stat row is a process the kernel has let go of. Its stat still reads for a moment after its signal state is
/// released, with -1 for its group (`do_task_stat`): nothing runs in it any more, so it counts as gone.
fn released(row: &Process) -> bool {
    row.pgid < 0
}

/// Every process listed under /proc.
pub fn table() -> io::Result<Vec<Process>> {
    let names = fs::read_dir("/proc")?.map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()));
    rows(names, read_stat)
}

/// Each process's parent, group and kernel start tick are read from the same /proc record.
pub fn identities() -> io::Result<Vec<ProcessIdentity>> {
    identity_rows(fs::read_dir("/proc")?.map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned())), read_stat)
}

fn identity_rows(
    names: impl Iterator<Item = io::Result<String>>,
    read: impl Fn(i32) -> io::Result<String>,
) -> io::Result<Vec<ProcessIdentity>> {
    let mut out = Vec::new();
    for name in names {
        let Ok(pid) = name?.parse::<i32>() else { continue };
        let stat = match read(pid) {
            Ok(stat) => stat,
            Err(error) if gone(&error) => continue,
            Err(error) => return Err(error),
        };
        let row = parse_identity(pid, &stat).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "malformed process identity"))?;
        if !released(&row.process) {
            out.push(row);
        }
    }
    Ok(out)
}

/// Field 22 is the kernel's start tick; counting starts after the final command-name parenthesis.
fn start_ticks(stat: &str) -> Option<u64> {
    stat[stat.rfind(')')? + 1..].split_whitespace().nth(19)?.parse().ok()
}

fn parse_identity(pid: i32, stat: &str) -> Option<ProcessIdentity> {
    let process = parse_stat(pid, stat)?;
    let start = start_ticks(stat)?;
    Some(ProcessIdentity { process, birth: format!("linux:{start}") })
}

/// When `pid` started (Unix milliseconds), reckoned as `ps` does: the boot time plus its start tick at the kernel's tick
/// rate. `None` when it is gone. A process `hidepid=2` hides reads as gone, the kernel saying no more than that; under
/// `hidepid=1` its stat is refused, which stays an error, so the caller hears why it has no answer.
pub fn started(pid: i32) -> io::Result<Option<u64>> {
    // SAFETY: sysconf takes any name and reads a constant
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    started_with(pid, read_stat, || fs::read_to_string("/proc/stat"), ticks_per_second)
}

fn started_with(
    pid: i32,
    stat: impl Fn(i32) -> io::Result<String>,
    system: impl Fn() -> io::Result<String>,
    ticks_per_second: libc::c_long,
) -> io::Result<Option<u64>> {
    let text = match stat(pid) {
        Ok(text) => text,
        Err(error) if gone(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let malformed = || io::Error::new(io::ErrorKind::InvalidData, "malformed process start");
    // a group of -1 is a process the kernel has let go of: its stat still reads for a moment, but nothing runs in it
    if released(&parse_stat(pid, &text).ok_or_else(malformed)?) {
        return Ok(None);
    }
    let ticks = start_ticks(&text).ok_or_else(malformed)?;
    let booted = boot_seconds(&system()?).ok_or_else(malformed)?;
    let rate = u64::try_from(ticks_per_second).ok().filter(|&rate| rate > 0).ok_or_else(malformed)?;
    Ok(Some(booted * 1000 + ticks * 1000 / rate))
}

/// When the machine booted (Unix seconds): /proc/stat's `btime` line.
fn boot_seconds(system: &str) -> Option<u64> {
    system.lines().find_map(|line| line.strip_prefix("btime "))?.trim().parse().ok()
}

/// Every process listed under /proc with its command line: its arguments joined by spaces, or its name from its stat in
/// parentheses when it has none (a kernel thread) or they cannot be read.
pub fn commands() -> io::Result<Vec<CommandLine>> {
    let names = fs::read_dir("/proc")?.map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()));
    command_rows(names, read_stat, |pid| fs::read(format!("/proc/{pid}/cmdline")))
}

/// The processes among `names` with their command lines, each read by `stat` and `cmdline`, skipped as `rows` skips them.
fn command_rows(
    names: impl Iterator<Item = io::Result<String>>,
    stat: impl Fn(i32) -> io::Result<String>,
    cmdline: impl Fn(i32) -> io::Result<Vec<u8>>,
) -> io::Result<Vec<CommandLine>> {
    let mut rows = Vec::new();
    for name in names {
        let Ok(pid) = name?.parse::<i32>() else { continue };
        let Ok(text) = stat(pid) else { continue };
        let Some(p) = parse_stat(pid, &text).filter(|row| !released(row)) else { continue };
        let args = cmdline(pid).map(|b| join_args(&b)).unwrap_or_default();
        let command = if args.is_empty() { format!("({})", comm(&text)) } else { args };
        rows.push(CommandLine { pid, ppid: p.ppid, command, executable: String::new() });
    }
    Ok(rows)
}

/// A cmdline's NUL-separated arguments joined by spaces, as `ps` shows them.
fn join_args(bytes: &[u8]) -> String {
    bytes.split(|&b| b == 0).filter(|a| !a.is_empty()).map(String::from_utf8_lossy).collect::<Vec<_>>().join(" ")
}

/// The command name in a stat line, between its first `(` and last `)`.
fn comm(stat: &str) -> &str {
    match (stat.find('('), stat.rfind(')')) {
        (Some(a), Some(z)) if a < z => &stat[a + 1..z],
        _ => "?",
    }
}

/// The processes among `names` (the entries of /proc), each read by `read`. A name that is not a pid is skipped, and so
/// is a process that exits between listing and reading (its stat can no longer be read or reads as released) or whose
/// stat does not parse.
fn rows(names: impl Iterator<Item = io::Result<String>>, read: impl Fn(i32) -> io::Result<String>) -> io::Result<Vec<Process>> {
    let mut rows = Vec::new();
    for name in names {
        let Ok(pid) = name?.parse::<i32>() else { continue };
        let Ok(stat) = read(pid) else { continue };
        if let Some(row) = parse_stat(pid, &stat).filter(|row| !released(row)) {
            rows.push(row);
        }
    }
    Ok(rows)
}

/// `pid (comm) state ppid pgrp …`: the command can hold spaces and parentheses, so fields count from its last `)`.
pub(crate) fn parse_stat(pid: i32, stat: &str) -> Option<Process> {
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace().skip(1);
    let ppid = fields.next()?.parse().ok()?;
    let pgid = fields.next()?.parse().ok()?;
    Some(Process { pid, ppid, pgid })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_gone_after_its_entry_was_opened_counts_as_gone() {
        assert!(gone(&io::Error::from(io::ErrorKind::NotFound)));
        assert!(gone(&io::Error::from_raw_os_error(libc::ESRCH)));
        assert!(!gone(&io::Error::from(io::ErrorKind::PermissionDenied)));
        let stat = "43 (x) S 7 43 ".to_owned() + &vec!["0"; 17].join(" ") + " 5";
        let names = [Ok("42".to_owned()), Ok("43".to_owned())].into_iter();
        let read = |pid| if pid == 42 { Err(io::Error::from_raw_os_error(libc::ESRCH)) } else { Ok(stat.clone()) };
        assert_eq!(identity_rows(names, read).expect("identities").len(), 1);
    }

    #[test]
    fn a_process_the_kernel_released_is_gone_from_every_table() {
        let line = |pid: i32, pgid: i32| format!("{pid} (x) X 0 {pgid} {} 5", vec!["0"; 16].join(" "));
        let read = |pid: i32| Ok(line(pid, if pid == 2 { -1 } else { pid }));
        let names = || ["1", "2", "3"].map(|n| Ok(n.to_owned())).into_iter();
        let pids = rows(names(), read).expect("rows").iter().map(|p| p.pid).collect::<Vec<_>>();
        assert_eq!(pids, [1, 3]);
        let born = identity_rows(names(), read).expect("identities").iter().map(|p| p.process.pid).collect::<Vec<_>>();
        assert_eq!(born, [1, 3]);
        let named = command_rows(names(), read, |_| Ok(Vec::new())).expect("commands").iter().map(|p| p.pid).collect::<Vec<_>>();
        assert_eq!(named, [1, 3]);
    }

    #[test]
    fn a_stat_that_is_not_utf8_is_still_a_process() {
        let bytes = b"42 (run_\xe6\x95) S 7 42 ".to_vec();
        let stat = String::from_utf8_lossy(&bytes);
        assert_eq!(parse_stat(42, &stat), Some(Process { pid: 42, ppid: 7, pgid: 42 }));
        assert!(read_stat(std::process::id() as i32).expect("own stat").contains('('));
        assert!(read_stat(i32::MAX).is_err());
    }

    #[test]
    fn a_start_is_the_boot_time_plus_its_ticks_and_only_a_gone_process_reads_as_none() {
        let line = |pgid: i32, ticks: &str| format!("42 (a (b) c) S 7 {pgid} {} {ticks}", vec!["0"; 16].join(" "));
        let at = |stat: String, system: &str, rate| started_with(42, |_| Ok(stat.clone()), || Ok(system.to_owned()), rate);
        let system = "cpu  1 2 3\nbtime 1700000000\nprocesses 9\n";
        assert_eq!(at(line(42, "250"), system, 100).expect("a start"), Some(1_700_000_002_500));
        assert_eq!(at(line(42, "250"), system, 1000).expect("another tick rate"), Some(1_700_000_000_250));
        // released by the kernel: gone, whatever else its stat says
        assert_eq!(at(line(-1, "250"), system, 100).expect("released"), None);
        assert_eq!(at(line(-1, "bad"), "no btime", 0).expect("released"), None);
        // what can't be read as a start is an error, never a time or gone
        assert!(at("garbage".into(), system, 100).is_err());
        assert!(at(line(42, "bad"), system, 100).is_err());
        assert!(at(line(42, "250"), "cpu  1 2 3\n", 100).is_err());
        assert!(at(line(42, "250"), "btime soon\n", 100).is_err());
        assert!(at(line(42, "250"), system, 0).is_err());
        assert!(at(line(42, "250"), system, -1).is_err());
        let stat = line(42, "250");
        let no_system = started_with(42, |_| Ok(stat.clone()), || Err(io::Error::from(io::ErrorKind::PermissionDenied)), 100);
        assert!(no_system.is_err());
        // gone before it was read, and hidepid=1 refusing it: only the first is gone
        let read = |error: i32| started_with(42, |_| Err(io::Error::from_raw_os_error(error)), || Ok(system.to_owned()), 100);
        assert_eq!(read(libc::ENOENT).expect("gone"), None);
        assert_eq!(read(libc::ESRCH).expect("gone"), None);
        assert_eq!(read(libc::EPERM).expect_err("refused").raw_os_error(), Some(libc::EPERM));
        // this process and init, which started first; no process at all
        let own = started(std::process::id() as i32).expect("own start").expect("a start");
        assert!(started(1).expect("init").expect("a start") <= own);
        assert_eq!(started(i32::MAX).expect("no such process"), None);
    }

    #[test]
    fn identities_use_kernel_start_ticks_and_skip_only_proven_gone_entries() {
        let stat = format!("42 (a (b) c) S 7 42 {} 987654", vec!["0"; 16].join(" "));
        let expected = ProcessIdentity { process: Process { pid: 42, ppid: 7, pgid: 42 }, birth: "linux:987654".into() };
        assert_eq!(parse_identity(42, &stat), Some(expected.clone()));
        assert_eq!(parse_identity(42, "garbage"), None);
        assert_eq!(parse_identity(42, "42 (x) S 7 42"), None);
        assert_eq!(parse_identity(42, &stat.replace("987654", "bad")), None);
        let names = ["42", "not-a-pid", "43"].map(|s| Ok(s.to_owned())).into_iter();
        let reads = std::cell::RefCell::new(Vec::new());
        let read = |pid| {
            reads.borrow_mut().push(pid);
            if pid == 42 {
                Ok(stat.clone())
            } else {
                Err(io::Error::from(io::ErrorKind::NotFound))
            }
        };
        assert_eq!(identity_rows(names, read).expect("identities"), vec![expected]);
        assert_eq!(*reads.borrow(), vec![42, 43]);
        for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Other] {
            let names = [Ok("42".into()), Ok("43".into())].into_iter();
            assert!(identity_rows(names, |pid| if pid == 42 { Ok(stat.clone()) } else { Err(io::Error::from(kind)) }).is_err());
        }
        assert!(identity_rows([Ok("42".into())].into_iter(), |_| Ok("malformed".into())).is_err());
        assert!(identity_rows([Err(io::Error::from(io::ErrorKind::PermissionDenied))].into_iter(), read).is_err());
        assert_eq!(*reads.borrow(), vec![42, 43], "a directory-entry error must not call the process reader");
        let own = identities().expect("kernel identities").into_iter().find(|p| p.process.pid == std::process::id() as i32).expect("self");
        assert_eq!(own.process.ppid, unsafe { libc::getppid() });
        assert!(own.birth.starts_with("linux:"));
    }

    #[test]
    fn the_table_skips_what_is_not_a_process_and_a_process_that_is_gone() {
        let names = ["1", "self", "2", "3"].map(|n| Ok(n.to_string())).into_iter();
        let read = |pid: i32| match pid {
            1 => Ok("1 (init) S 0 1 1".to_string()),
            2 => Err(io::Error::from(io::ErrorKind::NotFound)),
            _ => Ok("garbage".to_string()),
        };
        assert_eq!(rows(names, read).expect("rows"), vec![Process { pid: 1, ppid: 0, pgid: 1 }]);
        let broken = [Err(io::Error::from(io::ErrorKind::PermissionDenied))].into_iter();
        assert!(rows(broken, read).is_err());
    }

    #[test]
    fn command_lines_join_the_arguments_or_fall_back_to_the_name() {
        let names = ["1", "2", "3", "4", "x"].map(|n| Ok(n.to_string())).into_iter();
        let stat = |pid: i32| match pid {
            3 => Err(io::Error::from(io::ErrorKind::NotFound)),
            4 => Ok("garbage".to_string()),
            _ => Ok(format!("{pid} (kworker/0:1) S 1 {pid} {pid}")),
        };
        let cmdline = |pid: i32| match pid {
            1 => Ok(b"/sbin/init\0splash\0".to_vec()),
            _ => Err(io::Error::from(io::ErrorKind::PermissionDenied)),
        };
        assert_eq!(
            command_rows(names, stat, cmdline).expect("rows"),
            vec![
                CommandLine { pid: 1, ppid: 1, command: "/sbin/init splash".into(), executable: String::new() },
                CommandLine { pid: 2, ppid: 1, command: "(kworker/0:1)".into(), executable: String::new() },
            ]
        );
        let broken = [Err(io::Error::from(io::ErrorKind::PermissionDenied))].into_iter();
        assert!(command_rows(broken, stat, cmdline).is_err());
        assert_eq!(join_args(b"a\0\0b\0"), "a b");
        assert_eq!(comm("1 (a (b) c) S"), "a (b) c");
        assert_eq!(comm(") odd ("), "?");
        assert_eq!(comm("none"), "?");
    }

    #[test]
    fn a_stat_line_reads_its_parent_and_group_past_a_command_with_parentheses() {
        let row = parse_stat(42, "42 (a (b) c) S 7 42 42 0 -1 4194560").expect("a row");
        assert_eq!(row, Process { pid: 42, ppid: 7, pgid: 42 });
        assert_eq!(parse_stat(1, "1 (init"), None);
        assert_eq!(parse_stat(1, "1 (init) S x 1"), None);
        assert_eq!(parse_stat(1, "1 (init) S 0"), None);
    }
}
