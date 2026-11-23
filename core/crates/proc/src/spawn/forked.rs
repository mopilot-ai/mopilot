//! A child started by fork and exec, on Linux, as libuv starts one there: `Command`, with what `Command` leaves out added
//! between the two. Nothing else is inherited but stdio, as far as can be seen: the listing is taken just before the fork, so a
//! descriptor another thread opens in those microseconds, and doesn't mark close-on-exec, still reaches the child. libuv does no
//! sweep at all on Linux, and relies on every descriptor being close-on-exec.

use super::stdio::{block_signals, command_of, Ends};
use super::Spec;
use std::io;
use std::os::fd::RawFd;
use std::os::unix::process::CommandExt;

pub(in crate::spawn) use std::process::Child as Process;

/// The descriptors above stdio this process has open. Read before the fork, since listing a folder allocates.
pub(in crate::spawn) fn open_descriptors() -> Vec<RawFd> {
    let entries = std::fs::read_dir("/dev/fd").into_iter().flatten().flatten();
    entries.filter_map(|entry| entry.file_name().to_str()?.parse().ok()).filter(|&fd| fd > 2).collect()
}

/// What runs in the child between fork and exec. `Command` has set up stdio and the directory, and it leaves the signal mask
/// as it found it; this does the rest of what libuv does, in libuv's order, the mask last. It makes only async-signal-safe
/// calls: a fork of a threaded process has this one thread, and a lock any other held stays held.
pub(in crate::spawn) fn before_exec(group: bool, open: Vec<RawFd>) -> impl FnMut() -> io::Result<()> + Send + Sync + 'static {
    move || {
        for signal in 1..32 {
            // SAFETY: signal is async-signal-safe. Handlers go at exec anyway: this resets what is ignored (the two signals
            // that can't be changed refuse, harmlessly)
            unsafe { libc::signal(signal, libc::SIG_DFL) };
        }
        if group {
            // SAFETY: setsid is async-signal-safe and takes nothing. A process just forked leads no group, so it can't fail
            unsafe { libc::setsid() };
        }
        for &fd in &open {
            // SAFETY: fcntl is async-signal-safe, and a descriptor closed since it was listed only fails
            unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        }
        // SAFETY: both are async-signal-safe, and `empty` is this stack's. What the fork was blocked with goes here, not earlier
        unsafe {
            let mut empty: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut empty);
            libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
        }
        Ok(())
    }
}

/// Start a child. Signals stay blocked from before the fork to after the exec, so a handler this process inherited can't run
/// in the child, as libuv does; `spawn` returns once the exec has, which is as long as libuv's fork path holds its caller.
pub(in crate::spawn) fn start(spec: &Spec, ends: Ends) -> io::Result<Process> {
    let mut command = command_of(&spec.command, spec, ends);
    command.args(&spec.args);
    let setup = before_exec(spec.group, open_descriptors());
    // SAFETY: `before_exec` makes only async-signal-safe calls, and allocates nothing
    unsafe { command.pre_exec(setup) };
    let previous = block_signals();
    let started = command.spawn();
    // SAFETY: `previous` is what this thread's mask was, read above
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) };
    started
}
