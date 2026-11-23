//! A child's stdio, per platform, and what a spawn needs on all of them. POSIX: socket pairs, as libuv makes a child's `pipe`s
//! (a child can tell a socket from a pipe, and their buffers differ). Windows: anonymous pipes, and the Job Object that also
//! ends the child with this process, as libuv's does for a child Node started. How a child is started is `macos` or `forked`
//! on POSIX, and `Command` on Windows.

#[cfg(not(target_os = "macos"))]
use super::Spec;
use std::io::{self, Read, Write};
use std::process::ExitStatus;
#[cfg(not(target_os = "macos"))]
use std::process::{Command, Stdio};

#[cfg(all(unix, not(target_os = "macos")))]
pub(super) use super::forked::{start, Process};
#[cfg(target_os = "macos")]
pub(super) use super::macos::{start, Process};
#[cfg(windows)]
pub(super) use std::process::Child as Process;

pub(super) type Input = Box<dyn Write + Send>;
pub(super) type Output = Box<dyn Read + Send>;

/// This process's ends.
pub(super) struct Wires {
    pub(super) input: Input,
    pub(super) output: Output,
    pub(super) errors: Option<Output>,
}

/// The child's ends, which go when the spawn is done with them.
pub(super) struct Ends {
    pub(super) input: Theirs,
    pub(super) output: Theirs,
    pub(super) errors: Option<Theirs>,
}

/// A child's stdio, both ends of it.
pub(super) fn pipes(stderr: bool) -> io::Result<(Ends, Wires, Stop)> {
    let (their_input, input) = input_pipe()?;
    let stop = Stop::of(&input)?;
    let (their_output, output) = output_pipe()?;
    let (their_errors, errors): (Option<Theirs>, Option<Output>) = if stderr {
        let (theirs, errors) = output_pipe()?;
        (Some(theirs), Some(Box::new(errors)))
    } else {
        (None, None)
    };
    let ends = Ends { input: their_input, output: their_output, errors: their_errors };
    Ok((ends, Wires { input: Box::new(input), output: Box::new(output), errors }, stop))
}

/// `spec`'s program, directory, environment and stdio, for a platform that starts a child with `Command`.
#[cfg(not(target_os = "macos"))]
pub(super) fn command_of(program: &str, spec: &Spec, ends: Ends) -> Command {
    let mut command = Command::new(program);
    command.env_clear().envs(spec.env.iter().map(|(name, value)| (name, value)));
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    command.stdin(ends.input).stdout(ends.output).stderr(ends.errors.unwrap_or_else(Stdio::null));
    command
}

#[cfg(unix)]
use std::os::fd::{AsRawFd, OwnedFd};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

/// The child's end of a pipe, as what starts it wants it.
#[cfg(target_os = "macos")]
pub(super) type Theirs = OwnedFd;
#[cfg(not(target_os = "macos"))]
pub(super) type Theirs = Stdio;

/// What libuv sizes a child's sockets to: on macOS the default would be 8 KiB, and each read that many.
#[cfg(unix)]
pub(super) const SOCKET_BUFFER: libc::c_int = 64 << 10;

/// A socket pair as libuv makes one for a child, close-on-exec until the spawn moves it to stdio.
#[cfg(unix)]
pub(super) fn socket_pair() -> io::Result<(UnixStream, UnixStream)> {
    let (ours, theirs) = UnixStream::pair()?;
    for socket in [&ours, &theirs] {
        for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
            let (size, length) = (std::ptr::from_ref(&SOCKET_BUFFER).cast(), size_of::<libc::c_int>() as libc::socklen_t);
            // SAFETY: the socket is open, and `size` is valid for `length` bytes. A size refused leaves the default, as for libuv
            unsafe { libc::setsockopt(socket.as_raw_fd(), libc::SOL_SOCKET, option, size, length) };
        }
    }
    Ok((ours, theirs))
}

/// One end of a socket pair for the child, the other for this process.
#[cfg(unix)]
fn input_pipe() -> io::Result<(Theirs, UnixStream)> {
    let (ours, theirs) = socket_pair()?;
    Ok((child_end(theirs)?, ours))
}

/// `posix_spawn` moves descriptors with no scratch number between them, so none may be stdio's own already: a clone is never
/// below 3, whatever this process has closed.
#[cfg(target_os = "macos")]
fn child_end(socket: UnixStream) -> io::Result<Theirs> {
    socket.try_clone().map(OwnedFd::from)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn child_end(socket: UnixStream) -> io::Result<Theirs> {
    Ok(Stdio::from(OwnedFd::from(socket)))
}

#[cfg(unix)]
use input_pipe as output_pipe;

/// Stdin's second descriptor: a shutdown ends a write stuck on a full socket and the child's read, even when something that
/// outlived the child holds the far end.
#[cfg(unix)]
pub(super) struct Stop(std::sync::Mutex<Option<UnixStream>>);

#[cfg(unix)]
impl Stop {
    fn of(input: &UnixStream) -> io::Result<Self> {
        input.try_clone().map(|stop| Stop(std::sync::Mutex::new(Some(stop))))
    }

    /// Shut stdin and let go of this descriptor: on macOS a shutdown alone can leave a child asleep in its read of stdin,
    /// and the last descriptor's close disconnects it as well. Once done, again is nothing.
    pub(super) fn input(&self) {
        if let Some(stop) = self.0.lock().ok().and_then(|mut held| held.take()) {
            let _ = stop.shutdown(std::net::Shutdown::Both);
        }
    }
}

/// Block on this thread what can be blocked and still let a program's failures end it, as libuv does around a fork: what
/// was blocked before. A thread here also takes no signal for the process, so nothing here sees EINTR.
#[cfg(unix)]
pub(super) fn block_signals() -> libc::sigset_t {
    // SAFETY: a zeroed sigset_t is a valid one to fill, and all of these write only to `set` and `previous`, this thread's own
    unsafe {
        let (mut set, mut previous): (libc::sigset_t, libc::sigset_t) = (std::mem::zeroed(), std::mem::zeroed());
        libc::sigfillset(&mut set);
        for signal in [libc::SIGKILL, libc::SIGSTOP, libc::SIGTRAP, libc::SIGSEGV, libc::SIGBUS, libc::SIGILL, libc::SIGSYS, libc::SIGABRT]
        {
            libc::sigdelset(&mut set, signal);
        }
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, &mut previous);
        previous
    }
}

/// Wait for `process` to exit, say so with `exited`, and only then reap it: until it is reaped its pid can't be anyone else's,
/// and past `exited` nothing signals it. A wait that fails (something else reaped it) tells the same way.
#[cfg(unix)]
pub(super) fn reap(process: &mut Process, exited: impl FnOnce()) -> io::Result<ExitStatus> {
    // SAFETY: a zeroed siginfo_t is a valid place for an answer, which nothing reads. WNOWAIT leaves the child to be reaped, and
    // this thread takes no signal, so it can't be cut short
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        libc::waitid(libc::P_PID, process.id(), &mut info, libc::WEXITED | libc::WNOWAIT);
    }
    exited();
    process.wait()
}

/// POSIX holds a child in its process group instead.
#[cfg(unix)]
pub(super) fn hold(_pid: i32, _child: &Process) -> bool {
    false
}

#[cfg(unix)]
pub(super) fn code_and_signal(status: ExitStatus) -> (Option<i64>, Option<i32>) {
    (status.code().map(i64::from), status.signal())
}

/// The system's number for a write to a child's stdin that failed, as Node tells it: a socket pair whose far end went reads
/// as not connected or shut down as often as broken, depending on when the write met its going (macOS), and to Node it is
/// EPIPE either way.
pub(super) fn write_errno(error: &io::Error) -> Option<i32> {
    #[cfg(unix)]
    if matches!(error.raw_os_error(), Some(libc::ENOTCONN | libc::ESHUTDOWN)) {
        return Some(libc::EPIPE);
    }
    error.raw_os_error()
}

#[cfg(windows)]
use std::io::{PipeReader, PipeWriter};
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// `windowsHide`'s effect on a console program: no window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// ERROR_FILE_NOT_FOUND, what Node's spawn says (ENOENT) of a program that isn't there.
#[cfg(windows)]
const ERROR_FILE_NOT_FOUND: i32 = 2;

/// The program a spawn of `program` runs on Windows, as libuv's search finds it for Node's spawn. A path that is a folder is
/// not the program: `<path>.com`, then `<path>.exe`, beside it is, and with neither it is not found (ENOENT), where
/// CreateProcessW would refuse the folder as access denied (5, EPERM) and a pinned Codex that is a folder would read as
/// broken rather than not installed. Anything else is left to the spawn, a bare name to its search of PATH. A relative path
/// is the parent's, as the spawn reads it (Rust resolves the program against this process's folder, where libuv uses the
/// child's): a pinned Codex is absolute in practice.
#[cfg(windows)]
fn program_of(program: &str) -> io::Result<std::borrow::Cow<'_, str>> {
    // a bare name has no separator, which every absolute Windows path has
    if !program.contains(['/', '\\']) || !std::path::Path::new(program).is_dir() {
        return Ok(program.into());
    }
    for extension in [".com", ".exe"] {
        let beside = format!("{program}{extension}");
        if std::path::Path::new(&beside).is_file() {
            return Ok(beside.into());
        }
    }
    Err(io::Error::from_raw_os_error(ERROR_FILE_NOT_FOUND))
}

/// Start a child on Windows: a handle names it from here on, so its pid can't be handed on while it matters.
#[cfg(windows)]
pub(super) fn start(spec: &Spec, ends: Ends) -> io::Result<Process> {
    let program = program_of(&spec.command)?;
    let mut command = command_of(&program, spec, ends);
    if spec.verbatim {
        for arg in &spec.args {
            command.raw_arg(arg);
        }
    } else {
        command.args(&spec.args);
    }
    if spec.hide {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

#[cfg(windows)]
fn input_pipe() -> io::Result<(Theirs, PipeWriter)> {
    let (theirs, ours) = io::pipe()?;
    Ok((Stdio::from(theirs), ours))
}

#[cfg(windows)]
fn output_pipe() -> io::Result<(Theirs, PipeReader)> {
    let (ours, theirs) = io::pipe()?;
    Ok((Stdio::from(theirs), ours))
}

/// Stdin closes with the thread that writes it: a write stuck on a full pipe stays until the pipe's last reader goes.
#[cfg(windows)]
pub(super) struct Stop;

#[cfg(windows)]
impl Stop {
    fn of(_input: &PipeWriter) -> io::Result<Self> {
        Ok(Stop)
    }

    pub(super) fn input(&self) {}
}

/// Nothing to block: Windows has no signals to take.
#[cfg(windows)]
pub(super) fn block_signals() {}

/// Reap `process`, then say so with `exited`: its open handle keeps its pid from being handed on until it is dropped.
#[cfg(windows)]
pub(super) fn reap(process: &mut Process, exited: impl FnOnce()) -> io::Result<ExitStatus> {
    let status = process.wait();
    exited();
    status
}

/// Hold the child in a Job Object, by the handle this spawn returned, so no pid can have been handed on.
#[cfg(windows)]
pub(super) fn hold(pid: i32, child: &Process) -> bool {
    crate::windows::hold(pid, child.as_raw_handle())
}

#[cfg(windows)]
pub(super) fn code_and_signal(status: ExitStatus) -> (Option<i64>, Option<i32>) {
    // a Windows exit code is unsigned (0xC0000005, say), as Node tells it
    (status.code().map(|code| i64::from(code as u32)), None)
}
