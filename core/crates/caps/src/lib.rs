//! Who is at the other end of a capability socket (docs/architecture/rust-core.md §6 step 5): the process the kernel
//! names for a Unix socket, a process's ancestry from one reading of the process table, and the file a process runs. The
//! checks that use them (electron/capabilities/mcp/socket.cjs: the claimed pid is the peer, and the harness started it)
//! stay JS's; there is no other source for these answers, and a failure here refuses the connection.

use proc::Process;
use std::io;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod routes;

/// The pid of the process at the other end of the connected Unix socket `fd`, by the kernel's word, while it holds that
/// end. The kernel's own answer can name a process that has gone, whose number another can have: macOS's LOCAL_PEERPID names
/// the last process to use the end, Linux's SO_PEERCRED the process that connected. So each platform also proves the holder
/// (`macos::peer_pid`, `linux::peer_pid`). Unsupported elsewhere.
pub fn peer_pid(fd: i32) -> io::Result<i32> {
    #[cfg(target_os = "macos")]
    return macos::peer_pid(fd);
    #[cfg(target_os = "linux")]
    return linux::peer_pid(fd);
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = fd;
        Err(io::Error::new(io::ErrorKind::Unsupported, "no Unix socket peers on this platform"))
    }
}

/// Whether the peer check works on this machine, shown by running it: the holder proof names this process for a socket pair
/// of its own, and the process table and the file a process runs can be read. On macOS it also refuses what no process holds,
/// which a spawn can't disturb. Closing a socket's far end is not tried here: a spawn anywhere in this process holds a copy of
/// a closing descriptor for a moment, and one wrong answer would hide the tools for a run.
/// A core without the proof has no such route to ask. Windows reads only the table here: its peers are netstat's.
pub fn ready() -> bool {
    ![proc::table().is_ok(), unix_checks_work()].contains(&false)
}

#[cfg(unix)]
fn unix_checks_work() -> bool {
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    let me = std::process::id() as i32;
    UnixStream::pair().and_then(|one| Ok((one, UnixStream::pair()?))).is_ok_and(|((near, _far), (other, _other_far))| {
        #[cfg(target_os = "macos")]
        let apart = macos::tells_sockets_apart(near.as_raw_fd(), other.as_raw_fd());
        #[cfg(not(target_os = "macos"))]
        let apart = other.as_raw_fd() != near.as_raw_fd();
        ![peer_pid(near.as_raw_fd()).is_ok_and(|pid| pid == me), executable(me).is_ok(), apart].contains(&false)
    })
}

#[cfg(not(unix))]
fn unix_checks_work() -> bool {
    true
}

/// `pid` and its ancestors in `table`, nearest first, until one is 1 or below or not in the table: what ps -o ppid= gives,
/// one level at a time. A process can sit any depth below the one a check looks for, so only the table's size bounds the
/// chain, which ends a loop of rows that a reading caught mid-change. A check with a depth of its own cuts this chain itself.
pub fn ancestry(table: &[Process], pid: i32) -> Vec<i32> {
    let mut chain = Vec::new();
    let mut p = Some(pid);
    while let Some(at) = p.filter(|&at| at > 1) {
        chain.push(at);
        if chain.len() > table.len() {
            break;
        }
        p = table.iter().find(|row| row.pid == at).map(|row| row.ppid);
    }
    chain
}

/// The file process `pid` runs, by the kernel: `argv[0]` is the process's own word, this is not. On macOS `proc_pidpath`
/// fails when that file has been deleted. On Linux `/proc/<pid>/exe` then reads `<path> (deleted)`. Either way a deleted
/// file does not read as the path it had. Unsupported elsewhere.
pub fn executable(pid: i32) -> io::Result<String> {
    #[cfg(target_os = "macos")]
    {
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: proc_pidpath writes at most the length it is given into the buffer it is given
        let n = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if n <= 0 {
            return Err(io::Error::last_os_error());
        }
        path.truncate(n as usize);
        Ok(String::from_utf8_lossy(&path).into_owned())
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/exe")).map(|file| file.to_string_lossy().into_owned())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        Err(io::Error::new(io::ErrorKind::Unsupported, "no process files on this platform"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A connection this process accepted on a socket it holds itself, connected by a child that has exited: the child is
    /// what the kernel recorded, and the socket lives on with a process that has not used it. Returns the accepted end, the
    /// socket held, and the child's pid.
    #[cfg(unix)]
    pub(crate) fn connected_by_a_process_that_exited() -> (std::os::unix::net::UnixStream, std::os::fd::OwnedFd, i32) {
        use std::os::fd::FromRawFd;
        let dir = std::env::temp_dir().join(format!("caps-held-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder");
        let path = dir.join("s");
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("a listener");
        // SAFETY: socket takes no pointers, and its result is checked before it is owned
        let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
        assert!(raw >= 0);
        // SAFETY: `raw` is a new descriptor that nothing else owns
        let held = unsafe { std::os::fd::OwnedFd::from_raw_fd(raw) };
        // this test binary again, running only the test below, with the socket as its standard input
        let mut child = std::process::Command::new(std::env::current_exe().expect("this test"))
            .args(["--exact", "--ignored", "tests::connect_what_stdin_holds"])
            .env("CAPS_TEST_SOCKET", &path)
            .stdin(held.try_clone().expect("a copy"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("it runs");
        let pid = child.id() as i32;
        assert!(child.wait().expect("reaped").success(), "the child connected");
        let (accepted, _) = listener.accept().expect("a connection");
        std::fs::remove_dir_all(&dir).expect("removed");
        (accepted, held, pid)
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "the child of connected_by_a_process_that_exited, which runs it"]
    fn connect_what_stdin_holds() {
        let path = std::env::var("CAPS_TEST_SOCKET").expect("the socket's path");
        // SAFETY: zeroed is valid for this plain structure
        let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
        address.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (to, byte) in address.sun_path.iter_mut().zip(path.as_bytes()) {
            *to = *byte as libc::c_char;
        }
        let size = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        // SAFETY: the address outlives the call, and `size` is its size
        assert_eq!(unsafe { libc::connect(0, (&address as *const libc::sockaddr_un).cast(), size) }, 0);
    }

    #[test]
    fn the_ancestry_climbs_until_init_an_unknown_process_or_a_loop() {
        let row = |pid, ppid| Process { pid, ppid, pgid: pid };
        let table = [row(40, 30), row(30, 20), row(20, 1), row(7, 99)];
        assert_eq!(ancestry(&table, 40), vec![40, 30, 20]);
        // a parent not in the table ends the chain after it, as ps finds no parent for it
        assert_eq!(ancestry(&table, 7), vec![7, 99]);
        assert_eq!(ancestry(&table, 1), Vec::<i32>::new());
        // no depth stops it: a descendant far below its root still reaches it
        let deep: Vec<Process> = (2..500).map(|p| row(p, p + 1)).collect();
        assert_eq!(ancestry(&deep, 2).last(), Some(&500));
        // a reading caught mid-change can hold a loop of rows, which ends
        assert_eq!(ancestry(&[row(5, 6), row(6, 5)], 5), vec![5, 6, 5]);
        assert_eq!(ancestry(&[], 9), vec![9]);
    }

    #[cfg(unix)]
    #[test]
    fn a_process_runs_the_file_the_kernel_names_and_a_deleted_one_is_not_read_as_its_path() {
        let me = std::fs::canonicalize(std::env::current_exe().expect("this test")).expect("a path");
        assert_eq!(executable(std::process::id() as i32).expect("this file"), me.to_string_lossy());
        assert!(executable(i32::MAX).is_err());

        let dir = std::env::temp_dir().join(format!("caps-exe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("a folder");
        let file = std::fs::canonicalize(&dir).expect("a path").join("sleeper");
        std::fs::copy("/bin/sleep", &file).expect("a copy");
        let mut sleeper = std::process::Command::new(&file).arg("30").spawn().expect("it runs");
        let pid = sleeper.id() as i32;
        // spawn returns once the child has run the file
        assert_eq!(executable(pid).expect("its file"), file.to_string_lossy());
        std::fs::remove_file(&file).expect("deleted");
        let deleted = executable(pid);
        sleeper.kill().expect("killed");
        sleeper.wait().expect("reaped");
        std::fs::remove_dir(&dir).expect("removed");
        #[cfg(target_os = "macos")]
        assert_eq!(deleted.expect_err("no path").kind(), io::ErrorKind::NotFound);
        #[cfg(target_os = "linux")]
        assert_eq!(deleted.expect("its link"), format!("{} (deleted)", file.to_string_lossy()));
    }

    #[cfg(unix)]
    #[test]
    fn the_peer_of_a_socket_pair_is_this_process_and_a_bad_descriptor_is_an_error() {
        use std::os::fd::AsRawFd;
        let (a, _b) = std::os::unix::net::UnixStream::pair().expect("a pair");
        assert_eq!(peer_pid(a.as_raw_fd()).expect("a peer"), std::process::id() as i32);
        assert!(peer_pid(-1).is_err());
    }

    #[test]
    fn the_peer_check_works_on_this_machine() {
        assert!(ready());
    }

    #[cfg(not(unix))]
    #[test]
    fn there_are_no_unix_socket_peers_elsewhere() {
        assert_eq!(peer_pid(3).expect_err("unsupported").kind(), io::ErrorKind::Unsupported);
        assert_eq!(executable(4).expect_err("unsupported").kind(), io::ErrorKind::Unsupported);
    }
}
