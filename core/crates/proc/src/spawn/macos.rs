//! A child started by `posix_spawn` on macOS, as libuv starts one there: libuv's source says fork and exec degrades badly from
//! Big Sur in a process with many MAP_JIT pages, as Electron has. All of what the child starts with is the spawn's: a session
//! of its own, every signal at its default, an empty mask, and no descriptor of this process but its stdio
//! (`POSIX_SPAWN_CLOEXEC_DEFAULT`, which the kernel applies, so there is no window for another thread's). libuv takes the
//! session flag from macOS 10.15 on; the Host's oldest macOS is 13.5.
//!
//! `posix_spawnp` would search this process's PATH, and libuv calls Apple's buggy besides, so `search` does what libuv does:
//! the child's PATH, in order, past what is not there. A directory to run in that doesn't exist fails the spawn with ENOENT, as
//! from Node, because the chdir is a file action of the spawn.

use super::stdio::Ends;
use super::Spec;
use libc::{c_char, c_int};
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;
use std::ptr;

/// sys/spawn.h's, which the libc crate doesn't name.
const POSIX_SPAWN_SETSID: c_int = 0x0400;
/// paths.h's `_PATH_DEFPATH`: where a child with no PATH of its own is looked for.
const DEFAULT_PATH: &str = "/usr/bin:/bin";
/// What a name in a folder can be, and a folder of PATH.
const NAME_MAX: usize = 255;
const PATH_MAX: usize = libc::PATH_MAX as usize;

/// A child this process must reap. A thread here takes no signal, so its wait can't be cut short.
pub(in crate::spawn) struct Process(pub(super) i32);

impl Process {
    pub(in crate::spawn) fn id(&self) -> u32 {
        self.0 as u32
    }

    pub(in crate::spawn) fn wait(&mut self) -> io::Result<ExitStatus> {
        let mut status = 0;
        // SAFETY: `status` is this function's, and waitpid takes any pid
        let reaped = unsafe { libc::waitpid(self.0, &mut status, 0) };
        if reaped < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(status))
    }
}

/// A call's error number as a result.
fn checked(code: c_int) -> io::Result<()> {
    if code == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(code))
    }
}

/// What the spawn sets up in the child.
struct Attributes(libc::posix_spawnattr_t);

impl Attributes {
    fn new(group: bool) -> io::Result<Self> {
        let mut attributes = ptr::null_mut();
        // SAFETY: `attributes` receives a new set, which `Drop` destroys once made
        checked(unsafe { libc::posix_spawnattr_init(&mut attributes) })?;
        let mut made = Attributes(attributes);
        let session = if group { POSIX_SPAWN_SETSID } else { 0 };
        let flags = libc::POSIX_SPAWN_SETSIGDEF | libc::POSIX_SPAWN_SETSIGMASK | libc::POSIX_SPAWN_CLOEXEC_DEFAULT | session;
        // SAFETY: `made.0` is the set made above, and the flags all fit a short
        checked(unsafe { libc::posix_spawnattr_setflags(&mut made.0, flags as libc::c_short) })?;
        let (mut all, mut none): (libc::sigset_t, libc::sigset_t) = (0, 0);
        // SAFETY: as above; both sets are this function's, and the kernel skips the two signals that can't be changed
        unsafe {
            libc::sigfillset(&mut all);
            libc::sigemptyset(&mut none);
            checked(libc::posix_spawnattr_setsigdefault(&mut made.0, &all))?;
            checked(libc::posix_spawnattr_setsigmask(&mut made.0, &none))?;
        }
        Ok(made)
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: made by `new`, and destroyed once
        unsafe { libc::posix_spawnattr_destroy(&mut self.0) };
    }
}

/// What the spawn does to descriptors and the directory, in the child, before it runs.
struct Actions(libc::posix_spawn_file_actions_t);

impl Actions {
    fn new(cwd: Option<&CString>, ends: &Ends) -> io::Result<Self> {
        let mut actions = ptr::null_mut();
        // SAFETY: `actions` receives a new list, which `Drop` destroys once made
        checked(unsafe { libc::posix_spawn_file_actions_init(&mut actions) })?;
        let mut made = Actions(actions);
        if let Some(cwd) = cwd {
            // SAFETY: the list is the one made above, and the call copies `cwd`
            checked(unsafe { libc::posix_spawn_file_actions_addchdir_np(&mut made.0, cwd.as_ptr()) })?;
        }
        made.move_to(ends.input.as_raw_fd(), libc::STDIN_FILENO)?;
        made.move_to(ends.output.as_raw_fd(), libc::STDOUT_FILENO)?;
        if let Some(errors) = &ends.errors {
            made.move_to(errors.as_raw_fd(), libc::STDERR_FILENO)?;
        } else {
            // SAFETY: as above; the path is a C string, and the call copies it
            checked(unsafe {
                libc::posix_spawn_file_actions_addopen(&mut made.0, libc::STDERR_FILENO, c"/dev/null".as_ptr(), libc::O_RDWR, 0)
            })?;
        }
        Ok(made)
    }

    /// `fd` is the child's `to`. Every `fd` is above stdio (`child_end`), so none is overwritten before its turn.
    fn move_to(&mut self, fd: RawFd, to: RawFd) -> io::Result<()> {
        // SAFETY: the list is this value's, and both numbers are only recorded here
        checked(unsafe { libc::posix_spawn_file_actions_adddup2(&mut self.0, fd, to) })
    }
}

impl Drop for Actions {
    fn drop(&mut self) {
        // SAFETY: made by `new`, and destroyed once
        unsafe { libc::posix_spawn_file_actions_destroy(&mut self.0) };
    }
}

/// `attempt`'s answer, past any EINTR.
fn retried(attempt: &mut impl FnMut(&str) -> c_int, path: &str) -> c_int {
    loop {
        let code = attempt(path);
        if code != libc::EINTR {
            return code;
        }
    }
}

/// libuv's search for `file` (a copy of musl's execvp): a name with a slash is used as it is; any other is tried in each folder
/// of `path`, an empty one meaning here, past what isn't there or can't be used, and refused if any was refused. 0 once
/// `attempt` started it, or the error number.
fn search(file: &str, path: &str, mut attempt: impl FnMut(&str) -> c_int) -> c_int {
    if file.contains('/') {
        return retried(&mut attempt, file);
    }
    if file.len() > NAME_MAX {
        return libc::ENAMETOOLONG;
    }
    let (mut failure, mut denied) = (libc::ENOENT, false);
    for folder in path.split(':').filter(|folder| folder.len() < PATH_MAX) {
        let candidate = if folder.is_empty() { file.to_string() } else { format!("{folder}/{file}") };
        match retried(&mut attempt, &candidate) {
            libc::EACCES => denied = true,
            code @ (libc::ENOENT | libc::ENOTDIR) => failure = code,
            code => return code,
        }
    }
    if denied {
        libc::EACCES
    } else {
        failure
    }
}

/// `strings` as C's argv and envp want them: pointers ending in a null, valid while `strings` is.
fn pointers(strings: &[CString]) -> Vec<*mut c_char> {
    strings.iter().map(|string| string.as_ptr().cast_mut()).chain([ptr::null_mut()]).collect()
}

/// Start a child. This holds the caller as libuv's `posix_spawn` holds it: the call returns once the child is running.
pub(in crate::spawn) fn start(spec: &Spec, ends: Ends) -> io::Result<Process> {
    let args = std::iter::once(&spec.command).chain(&spec.args).map(|arg| CString::new(arg.as_str()));
    let args = args.collect::<Result<Vec<_>, _>>()?;
    let env = spec.env.iter().map(|(name, value)| CString::new(format!("{name}={value}")));
    let env = env.collect::<Result<Vec<_>, _>>()?;
    let cwd = spec.cwd.as_deref().map(CString::new).transpose()?;
    let attributes = Attributes::new(spec.group)?;
    let actions = Actions::new(cwd.as_ref(), &ends)?;
    let (argv, envp) = (pointers(&args), pointers(&env));
    let path = spec.env.iter().find(|(name, _)| name == "PATH").map_or(DEFAULT_PATH, |(_, value)| value.as_str());
    let mut pid = 0;
    let started = search(&spec.command, path, |program| {
        CString::new(program).map_or(libc::EINVAL, |program| {
            // SAFETY: every pointer is valid for the call: `program` here, `argv` and `envp` over the strings above, each array
            // ending in a null, and `attributes` and `actions` made and not yet destroyed. `pid` is this function's
            unsafe { libc::posix_spawn(&mut pid, program.as_ptr(), &actions.0, &attributes.0, argv.as_ptr(), envp.as_ptr()) }
        })
    });
    checked(started)?;
    Ok(Process(pid))
}

#[cfg(test)]
mod tests {
    use super::super::scenarios::spec;
    use super::*;

    /// What `search` tries for `file`, each try answered from `answers`.
    fn tried(file: &str, path: &str, mut answers: Vec<c_int>) -> (c_int, Vec<String>) {
        let mut seen = Vec::new();
        answers.reverse();
        let code = search(file, path, |candidate| {
            seen.push(candidate.to_string());
            answers.pop().expect("an answer for each try")
        });
        (code, seen)
    }

    #[test]
    fn a_name_with_a_slash_is_used_as_it_is_and_tried_once() {
        assert_eq!(tried("./a/b", "/x", vec![libc::ENOENT]), (libc::ENOENT, vec!["./a/b".to_string()]));
        assert_eq!(tried("/a", "", vec![libc::EINTR, 0]), (0, vec!["/a".to_string(), "/a".to_string()]), "EINTR goes again");
    }

    #[test]
    fn a_bare_name_goes_down_path_past_what_is_not_there() {
        let (code, seen) = tried("x", "/a::/c", vec![libc::ENOENT, libc::ENOTDIR, 0]);
        assert_eq!((code, seen), (0, vec!["/a/x".to_string(), "x".to_string(), "/c/x".to_string()]), "an empty folder means here");
        assert_eq!(tried("x", "/a:/b", vec![libc::ENOENT, libc::ENOTDIR]).0, libc::ENOTDIR, "the last failure is the answer");
        assert_eq!(tried("x", "", vec![libc::ENOENT]).1, vec!["x".to_string()]);
    }

    #[test]
    fn a_refused_folder_is_remembered_and_any_other_failure_ends_the_search() {
        assert_eq!(tried("x", "/a:/b", vec![libc::EACCES, libc::ENOENT]).0, libc::EACCES);
        assert_eq!(tried("x", "/a:/b", vec![libc::EACCES, 0]).0, 0, "found past it");
        assert_eq!(tried("x", "/a:/b", vec![libc::ENOEXEC]), (libc::ENOEXEC, vec!["/a/x".to_string()]));
    }

    #[test]
    fn a_name_or_folder_too_long_for_the_system_is_not_tried() {
        assert_eq!(tried(&"x".repeat(NAME_MAX + 1), "/a", vec![]).0, libc::ENAMETOOLONG);
        let long = format!("{}:/b", "/".repeat(PATH_MAX));
        assert_eq!(tried("x", &long, vec![libc::ENOENT]).1, vec!["/b/x".to_string()]);
        assert_eq!(tried("x", &"/".repeat(PATH_MAX), vec![]).0, libc::ENOENT, "nothing to try is nothing found");
    }

    #[test]
    fn a_call_s_error_is_the_system_s_and_a_wait_for_no_child_says_so() {
        assert!(checked(0).is_ok());
        assert_eq!(checked(libc::EPERM).expect_err("an error").raw_os_error(), Some(libc::EPERM));
        assert_eq!(Process(i32::MAX).wait().expect_err("no such child").raw_os_error(), Some(libc::ECHILD));
    }

    #[test]
    fn what_no_process_can_be_given_is_refused_before_anything_starts() {
        let refused = |spec: &Spec| {
            let (ends, ..) = crate::spawn::stdio::pipes(true).expect("pipes");
            start(spec, ends).err().map(|error| error.kind())
        };
        let mut bad = spec("/bin/sh", &["a\0b"]);
        assert_eq!(refused(&bad), Some(io::ErrorKind::InvalidInput));
        bad = spec("/bin/sh", &[]);
        bad.env.push(("A".into(), "a\0b".into()));
        assert_eq!(refused(&bad), Some(io::ErrorKind::InvalidInput));
        bad = spec("/bin/sh", &[]);
        bad.cwd = Some("a\0b".into());
        assert_eq!(refused(&bad), Some(io::ErrorKind::InvalidInput));
    }

    #[test]
    fn a_wait_for_what_can_t_be_waited_for_says_it_ended_and_fails() {
        let mut said = false;
        let waited = crate::spawn::stdio::reap(&mut Process(i32::MAX), || said = true);
        assert!(said);
        assert_eq!(waited.expect_err("no such child").raw_os_error(), Some(libc::ECHILD));
    }
}
