//! The process table (pid, parent, process group, command line) and the system's memory pressure, read with native calls:
//! what electron/platform/processTree.cjs gets from `ps -A -o pid=,ppid=,pgid=`, electron/harness/claude/presence.cjs
//! from `ps -axww -o pid=,ppid=,command=` and electron/platform/memoryPressure.cjs from
//! `sysctl -n kern.memorystatus_vm_pressure_level`, without starting a process for each reading; and on Windows, a child's
//! tree held in a Job Object (`contain`), the counterpart of the process group spawnGroup gives it on POSIX; and the
//! harness children the core starts itself, with their stdio (`spawn`).

use std::io;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod routes;
mod spawn;
#[cfg(windows)]
mod windows;

/// One process, as `ps -o pid=,ppid=,pgid=` lists it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Process {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
}

/// A process identity from one kernel record; an empty birth preserves a protected process as unknown, never absent.
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub process: Process,
    pub birth: String,
}

/// The process table with kernel birth identities, for acknowledged process retirement.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub fn identities() -> io::Result<Vec<ProcessIdentity>> {
    #[cfg(target_os = "linux")]
    return linux::identities();
    #[cfg(target_os = "macos")]
    return macos::identities();
}

/// When `pid` started (Unix milliseconds), as `ps -o lstart=` tells it for any user's process: `None` when there is no such
/// process, or on Windows one this user can't open. An error is a process that is there but can't be read (Linux's
/// `hidepid=1`, for another user's), which the route reports rather than calling it gone.
pub fn started(pid: i32) -> io::Result<Option<u64>> {
    #[cfg(target_os = "macos")]
    return macos::started(pid);
    #[cfg(target_os = "linux")]
    return linux::started(pid);
    #[cfg(windows)]
    return Ok(windows::started(pid));
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Err(io::Error::new(io::ErrorKind::Unsupported, "no process start on this platform yet"));
}

/// One process with its command line, as `ps -o pid=,ppid=,command=` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandLine {
    pub pid: i32,
    pub ppid: i32,
    /// The arguments joined by spaces where they can be read (this user's processes), else the executable's name in
    /// parentheses, as `ps` shows it.
    pub command: String,
    /// On macOS the path it was started from, where its arguments can be read; empty otherwise. A file named in `command`
    /// may be an argument: this is what the process runs.
    pub executable: String,
}

/// Every process with its command line, in no particular order.
pub fn commands() -> io::Result<Vec<CommandLine>> {
    #[cfg(target_os = "macos")]
    return macos::commands();
    #[cfg(target_os = "linux")]
    return linux::commands();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(io::ErrorKind::Unsupported, "no command lines on this platform yet"));
}

/// Every process on the machine, in no particular order.
pub fn table() -> io::Result<Vec<Process>> {
    #[cfg(target_os = "macos")]
    return macos::table();
    #[cfg(target_os = "linux")]
    return linux::table();
    #[cfg(windows)]
    return windows::table();
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Err(io::Error::new(io::ErrorKind::Unsupported, "no process table on this platform yet"));
}

/// The order a tree is killed in: `root`'s descendants, deepest first, then `root`, so no parent outlives a child it
/// could start again.
pub fn kill_order(table: &[Process], root: i32) -> Vec<i32> {
    let mut order = descendants(table, root);
    order.reverse();
    order.push(root);
    order
}

/// Kill `root` and everything below it in `table`, children first, each with `kill`: the pids it killed.
pub fn kill_tree_with(table: &[Process], root: i32, kill: impl Fn(i32) -> bool) -> Vec<i32> {
    kill_order(table, root).into_iter().filter(|&pid| kill(pid)).collect()
}

/// Kill `root`'s whole tree from one reading of the table: what `taskkill /T /F` does on Windows, where a launcher
/// (node running a CLI, cmd.exe) doesn't pass termination on, without starting a process to do it. `root` is a real
/// process (above 1): 0 and -1 name whole process groups on POSIX, 1 is init.
/// On Windows, what `contain` holds for `root` goes first, the commands whose parent exited among them.
pub fn kill_tree(root: i32) -> io::Result<Vec<i32>> {
    real_pid(root)?;
    // the whole job at once, the root with it: ended one by one, a root could finish on its own first and be missed
    let mut killed = ended(root, true).unwrap_or_default();
    let rest: Vec<i32> = kill_tree_with(&table()?, root, terminate).into_iter().filter(|pid| !killed.contains(pid)).collect();
    killed.extend(rest);
    Ok(killed)
}

/// `pid` names one real process: above 1, so never a whole process group (0, -1) or init.
fn real_pid(pid: i32) -> io::Result<()> {
    if pid <= 1 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("pid {pid} is not one process")));
    }
    Ok(())
}

/// Hold `pid`, a child of this process spawned by `at` (Unix milliseconds), and everything it starts from now on, so
/// that `kill_tree` and `end_contained` reach them all, even a command whose parent has exited and so is no longer below
/// `pid` in the table: a Job Object on Windows. Whether it is held: false on POSIX, where the child's process group does
/// this, for a pid that isn't that child (one handed out again) and for a process gone meanwhile.
pub fn contain(pid: i32, at: u64) -> io::Result<bool> {
    real_pid(pid)?;
    #[cfg(windows)]
    return windows::contain(pid, at, &table()?);
    #[cfg(not(windows))]
    // no jobs on POSIX: nothing to hold, whenever it was spawned
    return {
        let _ = at;
        Ok(false)
    };
}

/// End what `contain` holds for `pid` and let it go: the pids it ended, or None when nothing is held for it. `pid` itself
/// is left to finish while it still runs; once it has exited its whole job ends. Unlike `kill_tree`, nothing outside
/// what was held is touched, so it is safe once `pid` has exited and its number may belong to another process.
pub fn end_contained(pid: i32) -> io::Result<Option<Vec<i32>>> {
    real_pid(pid)?;
    Ok(ended(pid, false))
}

/// What `contain` held for `pid`, ended: `pid` too when `with_root`, else it is left to finish while it runs. None when
/// nothing is held for it, and always on POSIX.
fn ended(pid: i32, with_root: bool) -> Option<Vec<i32>> {
    #[cfg(windows)]
    return windows::end_contained(pid, with_root);
    // no jobs on POSIX: nothing was held
    #[cfg(not(windows))]
    return {
        let _ = (pid, with_root);
        None
    };
}

/// End one process now: `TerminateProcess` on Windows, SIGKILL elsewhere. Whether it was ended.
fn terminate(pid: i32) -> bool {
    #[cfg(windows)]
    return windows::terminate(pid);
    // SAFETY: kill takes any pid and signal; kill_tree never passes one that names a group
    #[cfg(not(windows))]
    return unsafe { libc::kill(pid, libc::SIGKILL) } == 0;
}

/// The kernel's memory pressure level where it has one (macOS: 1 normal, 2 warning, 4 critical); `None` elsewhere, where
/// callers judge by the share of free memory instead.
pub fn pressure_level() -> io::Result<Option<u32>> {
    #[cfg(target_os = "macos")]
    return macos::pressure_level().map(Some);
    #[cfg(not(target_os = "macos"))]
    return Ok(None);
}

/// The processes below `root` in `table` (not `root` itself), children before their own children.
pub fn descendants(table: &[Process], root: i32) -> Vec<i32> {
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(parent) = stack.pop() {
        for p in table {
            // pid 0 is its own parent on macOS: never walk into it
            if p.ppid == parent && p.pid != parent && p.pid != root && !found.contains(&p.pid) {
                found.push(p.pid);
                stack.push(p.pid);
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[cfg(unix)]
    #[test]
    fn the_table_holds_this_process_with_its_parent_and_group() {
        let me = std::process::id() as i32;
        let rows = table().expect("a process table");
        let own = rows.iter().find(|p| p.pid == me).expect("this process is listed");
        assert_eq!(own.ppid, unsafe { libc::getppid() });
        assert_eq!(own.pgid, unsafe { libc::getpgrp() });
        assert!(rows.len() > 1);
    }

    #[cfg(unix)]
    #[test]
    fn the_command_lines_hold_this_process_and_a_child_with_its_arguments() {
        let mut child = Command::new("sleep").arg("7").spawn().expect("sleep starts");
        let me = std::process::id() as i32;
        // spawn returns once the child is forked, maybe before it runs exec: until then the system lists it with no
        // arguments yet (Linux shows "(sleep)"), so the listing is read again until the child's own command shows
        let rows = std::iter::repeat_with(|| {
            std::thread::sleep(std::time::Duration::from_millis(20));
            commands().expect("command lines")
        })
        .take(100)
        .find(|rows| rows.iter().any(|p| p.pid == child.id() as i32 && p.command.ends_with("sleep 7")))
        .expect("the child runs sleep 7 within 2 s");
        let own = rows.iter().find(|p| p.pid == me).expect("this process is listed");
        assert_eq!(own.ppid, unsafe { libc::getppid() });
        assert!(own.command.contains(std::env::args().next().as_deref().unwrap_or("?")), "{}", own.command);
        let kid = rows.iter().find(|p| p.pid == child.id() as i32).expect("the child is listed");
        assert_eq!(kid.ppid, me);
        assert!(kid.command.ends_with("sleep 7"), "{}", kid.command);
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_child_is_a_descendant_and_the_root_is_not() {
        let mut child = Command::new("sleep").arg("5").spawn().expect("sleep starts");
        let me = std::process::id() as i32;
        let below = descendants(&table().expect("a process table"), me);
        assert!(below.contains(&(child.id() as i32)));
        assert!(!below.contains(&me));
        child.kill().ok();
        child.wait().ok();
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_the_table_holds_this_process_and_termination_leaves_an_unrelated_child_alive() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

        struct OwnedChild(std::process::Child);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                self.0.kill().ok();
                self.0.wait().ok();
            }
        }
        let me = std::process::id() as i32;
        let rows = table().expect("a table");
        let own = rows.iter().find(|p| p.pid == me).expect("this process is listed");
        assert_eq!(own.pgid, me);
        // This checks the single-process primitive, without assuming how many descendants a system utility has.
        // The binding's controlled Node tree checks exact descendant-first order, as does kill_order below.
        let start = || {
            OwnedChild(
                Command::new("ping")
                    .args(["-n", "30", "127.0.0.1"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .expect("ping starts"),
            )
        };
        let mut target = start();
        let mut sentinel = start();
        let pid = target.0.id() as i32;
        assert!(terminate(pid), "the owned process is terminated");
        assert!(!target.0.wait().expect("the target ends").success());
        assert!(sentinel.0.try_wait().expect("the sentinel can be read").is_none());
        assert_eq!(commands().expect_err("no command lines").kind(), io::ErrorKind::Unsupported);
        for bad in [-1, 0, 1] {
            assert_eq!(kill_tree(bad).expect_err("refused").kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[cfg(windows)]
    #[test]
    fn on_windows_a_held_tree_ends_with_a_command_whose_parent_exited() {
        // cmd waits a second (time to hold it), then a second cmd starts ping in the background and exits at once: that
        // ping's parent is gone, so the table no longer leads to it from the root
        let mut cmd = Command::new("cmd")
            .args(["/c", "ping -n 2 127.0.0.1 > nul & cmd /c start /b ping -n 60 127.0.0.1 > nul & ping -n 60 127.0.0.1 > nul"])
            .spawn()
            .expect("cmd starts");
        let root = cmd.id() as i32;
        assert!(!contain(root, 0).expect("not by then"), "a process started after `at` is not the child meant");
        assert!(contain(root, now()).expect("held"));
        assert!(contain(root, now()).expect("held already"), "a second hold keeps the first");
        // what the job holds, still running, that the table doesn't lead to from the root; a console host Windows
        // starts for cmd is one of those from the start, so only one that turns up later is the command left behind
        let strays = || {
            let rows = table().expect("a table");
            let reachable = kill_order(&rows, root);
            let held = windows::held(root);
            held.into_iter().filter(|&p| rows.iter().any(|r| r.pid == p)).filter(|p| !reachable.contains(p)).collect::<Vec<_>>()
        };
        let from_start = strays();
        let started = std::time::Instant::now();
        let orphan = loop {
            if let Some(pid) = strays().into_iter().find(|p| !from_start.contains(p)) {
                break pid;
            }
            assert!(started.elapsed().as_secs() < 20, "no command outlived its parent");
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        let held = windows::held(root);
        let killed = kill_tree(root).expect("a kill");
        let context = format!("killed {killed:?}, held {held:?}, orphan {orphan}, root {root}");
        assert_eq!([killed.contains(&orphan), killed.contains(&root)], [true, true], "{context}");
        assert!(!cmd.wait().expect("cmd ends").success());
        assert_eq!(end_contained(root).expect("a pid"), None, "the kill let the job go");
        // a held child that exits on its own: what it left running ends without touching its pid's next owner
        let mut quick = Command::new("cmd")
            .args(["/c", "ping -n 2 127.0.0.1 > nul & cmd /c start /b ping -n 60 127.0.0.1 > nul"])
            .spawn()
            .expect("cmd starts");
        let quick_root = quick.id() as i32;
        assert!(contain(quick_root, now()).expect("held"));
        quick.wait().expect("cmd ends");
        let left = end_contained(quick_root).expect("a pid").expect("held");
        assert!(!left.is_empty(), "its background ping was still running");
    }

    /// Unix milliseconds now, as JS's Date.now() gives them.
    #[cfg(windows)]
    fn now() -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).expect("after 1970").as_millis() as u64
    }

    #[cfg(not(windows))]
    #[test]
    fn elsewhere_nothing_is_held_and_a_group_pid_is_refused() {
        assert!(!contain(std::process::id() as i32, u64::MAX).expect("not held"));
        assert_eq!(end_contained(std::process::id() as i32).expect("a pid"), None);
        for bad in [-1, 0, 1] {
            assert_eq!(contain(bad, u64::MAX).expect_err("refused").kind(), io::ErrorKind::InvalidInput);
            assert_eq!(end_contained(bad).expect_err("refused").kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn a_tree_dies_children_first_and_its_root_last() {
        let rows = [
            Process { pid: 10, ppid: 1, pgid: 10 },
            Process { pid: 11, ppid: 10, pgid: 10 },
            Process { pid: 12, ppid: 11, pgid: 12 },
            Process { pid: 13, ppid: 10, pgid: 13 },
            Process { pid: 14, ppid: 99, pgid: 14 },
        ];
        let order = kill_order(&rows, 10);
        assert_eq!(order.last(), Some(&10));
        assert!(order.iter().position(|&p| p == 12) < order.iter().position(|&p| p == 11), "{order:?}");
        assert!(!order.contains(&14));
        // what `kill` refuses (a process gone meanwhile) is left out of what was killed
        assert_eq!(kill_tree_with(&rows, 10, |pid| pid != 13).len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn kill_tree_ends_a_real_tree_and_refuses_a_group_or_init() {
        // a shell with a child of its own: both go. Not `sleep & wait`: a bare wait returns 0 once its child is killed, so
        // that shell could end cleanly before its own SIGKILL; this one fails whichever way its sleep ends
        let mut shell = Command::new("sh").args(["-c", "sleep 30 || exit 3"]).spawn().expect("sh starts");
        let root = shell.id() as i32;
        let child = loop {
            if let Some(c) = table().expect("a table").into_iter().find(|p| p.ppid == root) {
                break c.pid;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        let killed = kill_tree(root).expect("a kill");
        assert_eq!(killed, vec![child, root]);
        assert!(!shell.wait().expect("the shell ends").success());
        for bad in [-1, 0, 1] {
            assert_eq!(kill_tree(bad).expect_err("refused").kind(), io::ErrorKind::InvalidInput);
        }
    }

    #[test]
    fn descendants_follow_grandchildren_and_skip_a_self_parented_row() {
        let rows = [
            Process { pid: 0, ppid: 0, pgid: 0 },
            Process { pid: 10, ppid: 1, pgid: 10 },
            Process { pid: 11, ppid: 10, pgid: 10 },
            Process { pid: 12, ppid: 11, pgid: 12 },
            Process { pid: 13, ppid: 99, pgid: 13 },
        ];
        assert_eq!(descendants(&rows, 10), vec![11, 12]);
        assert_eq!(descendants(&rows, 0), Vec::<i32>::new());
        assert_eq!(descendants(&rows, 12), Vec::<i32>::new());
        // a loop back to the root, and a row listed twice, are walked once
        let looped =
            [Process { pid: 20, ppid: 21, pgid: 20 }, Process { pid: 21, ppid: 20, pgid: 20 }, Process { pid: 21, ppid: 20, pgid: 20 }];
        assert_eq!(descendants(&looped, 20), vec![21]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_pressure_level_is_the_kernel_s_on_macos() {
        assert!(matches!(pressure_level().expect("a pressure reading"), Some(1 | 2 | 4)));
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn there_is_no_pressure_level_elsewhere() {
        assert_eq!(pressure_level().expect("a pressure reading"), None);
    }
}
