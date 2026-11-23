//! What only a fork needs: its child's setup between fork and exec, and the listing of what it must not keep.

use crate::spawn::forked;
use std::fs;
use std::os::fd::AsRawFd;

/// Runs in a process of its own: it changes what only a child may.
fn forked(check: impl FnOnce() -> bool) {
    // SAFETY: the child only makes the calls `check` makes, then exits, which writes its coverage
    let pid = unsafe { libc::fork() };
    if pid == 0 {
        let passed = check();
        // SAFETY: the end of the forked copy, whose status is all it says
        unsafe { libc::exit(i32::from(!passed)) };
    }
    let mut status = 0;
    // SAFETY: `status` receives the state of this test's own child
    assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
    assert_eq!(status, 0);
}

#[test]
fn between_fork_and_exec_a_child_is_set_up_as_libuv_sets_one_up() {
    for group in [true, false] {
        forked(move || {
            let file = fs::File::open("/dev/null").expect("a descriptor");
            let fd = file.as_raw_fd();
            // SAFETY: fcntl on a descriptor this holds; signal on one this process may change; a mask of this process's
            unsafe {
                libc::fcntl(fd, libc::F_SETFD, 0);
                libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                libc::sigaddset(&mut set, libc::SIGUSR1);
                libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
            }
            // SAFETY: only reads who this process is
            let before = unsafe { libc::getsid(0) };
            let done = forked::before_exec(group, vec![fd])().is_ok();
            // SAFETY: as above; the last reads what this signal's disposition is back to, and sets it the same
            let (session, me, flags, ignored) =
                unsafe { (libc::getsid(0), libc::getpid(), libc::fcntl(fd, libc::F_GETFD), libc::signal(libc::SIGXFSZ, libc::SIG_DFL)) };
            // SAFETY: reads this process's mask into `mask`
            let unblocked = unsafe {
                let mut mask: libc::sigset_t = std::mem::zeroed();
                libc::sigprocmask(libc::SIG_SETMASK, std::ptr::null(), &mut mask);
                libc::sigismember(&mask, libc::SIGUSR1) == 0
            };
            let expected = [before, me][usize::from(group)];
            [done, session == expected, flags & libc::FD_CLOEXEC != 0, ignored == libc::SIG_DFL, unblocked] == [true; 5]
        });
    }
}

#[test]
fn the_descriptors_a_child_must_not_keep_are_listed_and_stdio_is_not() {
    let file = fs::File::open("/dev/null").expect("a descriptor");
    let open = forked::open_descriptors();
    assert!(open.contains(&file.as_raw_fd()));
    assert!(open.iter().all(|&fd| fd > 2));
}
