//! macOS: who holds the far end of a Unix socket. LOCAL_PEERPID names the last process to use that end, which can have
//! exited while another holds it silently, and by then a third process can have that number. So the number counts only for
//! a process that holds the far end now: one of its descriptors must be the socket joined to ours, by the kernel's opaque
//! handles (`proc_pidinfo`, `proc_pidfdinfo`, what lsof's `->0x...` shows). A process this user may not inspect holds nothing.

use std::io;
use std::mem::size_of;
use std::ptr::null_mut;

/// `struct socket_fdinfo` of sys/proc_info.h, by size and field offsets as the SDK's compiler lays them out (MacOSX.sdk,
/// macOS 26): its size, `psi.soi_pcb`, `psi.soi_family`, `psi.soi_kind`, `psi.soi_proto.pri_un.unsi_conn_pcb`. A record
/// of any other size is refused, so a kernel that changed the record fails closed.
const RECORD: usize = 792;
const SOI_PCB: usize = 168;
const SOI_FAMILY: usize = 184;
const SOI_KIND: usize = 256;
const UNSI_CONN_PCB: usize = 272;
/// sys/proc_info.h's flavor for that record, and its kind for a Unix socket.
const PROC_PIDFDSOCKETINFO: libc::c_int = 3;
const SOCKINFO_UN: i32 = 3;
/// What `PROC_PIDLISTFDS` lists for each descriptor.
const LISTED: usize = size_of::<libc::proc_fdinfo>();

/// A Unix socket's two ends by the kernel's handles: its own and the one it is connected to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Ends {
    near: u64,
    far: u64,
}

impl Ends {
    /// Whether these are the two sides of one connection, seen from both.
    fn joins(self, other: Ends) -> bool {
        self.near == other.far && self.far == other.near
    }
}

/// The pid LOCAL_PEERPID gives for `fd`, when that process holds the far end.
pub fn peer_pid(fd: i32) -> io::Result<i32> {
    let pid = last_user(fd)?;
    proven(pid, socket_of(std::process::id() as i32, fd)?)
}

/// `pid`, when it holds the far end of the socket whose ends are `ours`.
fn proven(pid: i32, ours: Option<Ends>) -> io::Result<i32> {
    if ours.is_some_and(|ends| holds(pid, ends)) {
        Ok(pid)
    } else {
        Err(io::Error::new(io::ErrorKind::NotFound, format!("process {pid} does not hold the far end")))
    }
}

/// Whether the holder proof tells sockets apart here, for `one` and `other` of two separate pairs: neither joins the other,
/// and a socket no process has is held by nobody. A proof that accepted anything would pass the accepting check alone.
pub fn tells_sockets_apart(one: i32, other: i32) -> bool {
    let me = std::process::id() as i32;
    let joined = match (socket_of(me, one), socket_of(me, other)) {
        (Ok(Some(one)), Ok(Some(other))) => one.joins(other),
        _ => true,
    };
    // kernel handles are hashed addresses, never these
    !joined && !holds(me, Ends { near: 1, far: 2 })
}

/// The last process to use the far end of `fd`.
fn last_user(fd: i32) -> io::Result<i32> {
    let mut pid: libc::pid_t = 0;
    let mut len = size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: getsockopt fills `pid` for at most `len` bytes, or fails on a descriptor that isn't a connected socket
    let ok = unsafe { libc::getsockopt(fd, libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut len) };
    if ok == 0 {
        Ok(pid)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Whether one of process `pid`'s descriptors is the socket joined to `ours`. Only that match shows it: a process that is
/// gone or can't be read, or a descriptor closed while it is read, shows nothing.
fn holds(pid: i32, ours: Ends) -> bool {
    open_sockets(pid)
        .is_ok_and(|fds| fds.into_iter().any(|fd| socket_of(pid, fd).is_ok_and(|ends| ends.is_some_and(|theirs| theirs.joins(ours)))))
}

/// The descriptors of process `pid` that are sockets.
fn open_sockets(pid: i32) -> io::Result<Vec<i32>> {
    // SAFETY: with no buffer the call only says how many bytes a listing needs
    let needed = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, null_mut(), 0) };
    let needed = listed_bytes(needed, libc::c_int::MAX)?;
    // room to spare, since a listing that fills it may have been cut short
    let mut rows = vec![libc::proc_fdinfo { proc_fd: 0, proc_fdtype: 0 }; needed / LISTED + 32];
    let room = (rows.len() * LISTED) as libc::c_int;
    // SAFETY: the buffer holds exactly `room` bytes of plain records
    let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, rows.as_mut_ptr().cast(), room) };
    rows.truncate(listed_bytes(read, room)? / LISTED);
    Ok(rows.into_iter().filter(|row| row.proc_fdtype == libc::PROX_FDTYPE_SOCKET as u32).map(|row| row.proc_fd).collect())
}

/// How many bytes a listing gave, from what the call returned and the room it had: a failure, a listing that filled its
/// room, or one that isn't a whole number of rows is no answer.
fn listed_bytes(read: libc::c_int, room: libc::c_int) -> io::Result<usize> {
    if read <= 0 {
        Err(io::Error::last_os_error())
    } else if [read >= room, !(read as usize).is_multiple_of(LISTED)].contains(&true) {
        Err(io::Error::new(io::ErrorKind::InvalidData, "a cut descriptor listing"))
    } else {
        Ok(read as usize)
    }
}

/// The ends of descriptor `fd` of process `pid`, when it is a connected Unix socket.
fn socket_of(pid: i32, fd: i32) -> io::Result<Option<Ends>> {
    let mut record = [0u8; RECORD];
    // SAFETY: the buffer holds exactly RECORD bytes, and the kernel copies at most that many
    let read = unsafe { libc::proc_pidfdinfo(pid, fd, PROC_PIDFDSOCKETINFO, record.as_mut_ptr().cast(), RECORD as libc::c_int) };
    whole_record(read)?;
    Ok(ends_of(&record))
}

/// Whether a read gave a whole record, of exactly the size whose layout this file knows.
fn whole_record(read: libc::c_int) -> io::Result<()> {
    if read <= 0 {
        Err(io::Error::last_os_error())
    } else if read as usize != RECORD {
        Err(io::Error::new(io::ErrorKind::InvalidData, format!("a socket record of {read} bytes")))
    } else {
        Ok(())
    }
}

/// The ends a record names, when it is of a Unix socket connected at both. A closed far end reads as handle 0.
fn ends_of(record: &[u8; RECORD]) -> Option<Ends> {
    let int = |at: usize| i32::from_ne_bytes(std::array::from_fn(|i| record[at + i]));
    let handle = |at: usize| u64::from_ne_bytes(std::array::from_fn(|i| record[at + i]));
    let ends = Ends { near: handle(SOI_PCB), far: handle(UNSI_CONN_PCB) };
    // the two ends are different sockets: the same handle in both fields is not a reading of them
    let connected_unix =
        [int(SOI_FAMILY) == libc::AF_UNIX, int(SOI_KIND) == SOCKINFO_UN, ends.near != 0, ends.far != 0, ends.near != ends.far];
    (!connected_unix.contains(&false)).then_some(ends)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::connected_by_a_process_that_exited;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    /// A record with these fields.
    fn record(family: i32, kind: i32, near: u64, far: u64) -> [u8; RECORD] {
        let mut out = [0u8; RECORD];
        out[SOI_FAMILY..SOI_FAMILY + 4].copy_from_slice(&family.to_ne_bytes());
        out[SOI_KIND..SOI_KIND + 4].copy_from_slice(&kind.to_ne_bytes());
        out[SOI_PCB..SOI_PCB + 8].copy_from_slice(&near.to_ne_bytes());
        out[UNSI_CONN_PCB..UNSI_CONN_PCB + 8].copy_from_slice(&far.to_ne_bytes());
        out
    }

    #[test]
    fn a_record_names_ends_only_for_a_unix_socket_connected_at_both() {
        assert_eq!(ends_of(&record(libc::AF_UNIX, SOCKINFO_UN, 7, 9)), Some(Ends { near: 7, far: 9 }));
        assert_eq!(ends_of(&record(libc::AF_INET, SOCKINFO_UN, 7, 9)), None);
        assert_eq!(ends_of(&record(libc::AF_UNIX, 2, 7, 9)), None);
        assert_eq!(ends_of(&record(libc::AF_UNIX, SOCKINFO_UN, 0, 9)), None);
        assert_eq!(ends_of(&record(libc::AF_UNIX, SOCKINFO_UN, 7, 0)), None, "the far end has closed");
        assert_eq!(ends_of(&record(libc::AF_UNIX, SOCKINFO_UN, 7, 7)), None, "one handle for both ends reads nothing");
    }

    #[test]
    fn two_sockets_join_only_when_each_names_the_other() {
        let a = Ends { near: 1, far: 2 };
        assert!(a.joins(Ends { near: 2, far: 1 }));
        assert!(!a.joins(Ends { near: 2, far: 3 }));
        assert!(!a.joins(Ends { near: 3, far: 1 }));
        assert!(!a.joins(a), "a socket is not its own far end");
    }

    #[test]
    fn a_read_of_any_other_size_or_a_cut_listing_is_no_answer() {
        assert!(whole_record(RECORD as libc::c_int).is_ok());
        assert!(whole_record(0).is_err());
        assert_eq!(whole_record(RECORD as libc::c_int - 1).expect_err("short").kind(), io::ErrorKind::InvalidData);
        assert_eq!(whole_record(RECORD as libc::c_int + 1).expect_err("long").kind(), io::ErrorKind::InvalidData);
        assert_eq!(listed_bytes(16, 64).expect("two rows"), 16);
        assert!(listed_bytes(0, 64).is_err());
        assert!(listed_bytes(-1, 64).is_err());
        assert_eq!(listed_bytes(64, 64).expect_err("full").kind(), io::ErrorKind::InvalidData);
        assert_eq!(listed_bytes(12, 64).expect_err("a part of a row").kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn separate_pairs_are_told_apart_and_what_is_not_a_socket_is_not() {
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;
        let (one, _one) = UnixStream::pair().expect("a pair");
        let (other, _other) = UnixStream::pair().expect("a pair");
        let (same, same_far) = UnixStream::pair().expect("a pair");
        assert!(tells_sockets_apart(one.as_raw_fd(), other.as_raw_fd()));
        assert!(!tells_sockets_apart(same.as_raw_fd(), same_far.as_raw_fd()), "the ends of one pair join");
        assert!(!tells_sockets_apart(-1, other.as_raw_fd()));
    }

    #[test]
    fn the_peer_of_a_socket_pair_holds_it_and_a_closed_far_end_has_no_peer() {
        let (a, b) = UnixStream::pair().expect("a pair");
        let me = std::process::id() as i32;
        assert_eq!(peer_pid(a.as_raw_fd()).expect("a peer"), me);
        let ours = socket_of(me, a.as_raw_fd()).expect("readable").expect("connected");
        let theirs = socket_of(me, b.as_raw_fd()).expect("readable").expect("connected");
        assert!(ours.joins(theirs), "both sides read through the record's layout");
        assert!(holds(me, ours));
        drop(b);
        // a sibling test's fork holds a copy of every descriptor until its child exits, so the far end closes soon, not now
        let closed = (0..2000).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(1));
            peer_pid(a.as_raw_fd()).is_err()
        });
        assert!(closed);
        assert_eq!(socket_of(me, a.as_raw_fd()).expect("readable"), None);
        assert!(peer_pid(-1).is_err());
        assert_eq!(proven(me, None).expect_err("no socket of ours").kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn a_process_that_holds_nothing_or_can_t_be_read_does_not_hold_the_socket() {
        let (a, _b) = UnixStream::pair().expect("a pair");
        let ours = socket_of(std::process::id() as i32, a.as_raw_fd()).expect("readable").expect("connected");
        let mut other = std::process::Command::new("/bin/sleep").arg("30").spawn().expect("it runs");
        let refused = proven(other.id() as i32, Some(ours));
        other.kill().expect("killed");
        other.wait().expect("reaped");
        assert_eq!(refused.expect_err("it holds nothing").kind(), io::ErrorKind::NotFound);
        // launchd, another user's, and a process that is gone
        assert!(!holds(1, ours));
        assert!(open_sockets(i32::MAX).is_err());
        assert!(!holds(i32::MAX, ours));
    }

    #[test]
    fn the_last_user_has_exited_while_another_holds_the_end_so_its_number_counts_for_no_one() {
        let (accepted, _held, child) = connected_by_a_process_that_exited();

        // the kernel still names the child, which holds nothing now; the process that does hold the end is proved to
        assert_eq!(last_user(accepted.as_raw_fd()).expect("recorded"), child);
        assert_eq!(peer_pid(accepted.as_raw_fd()).expect_err("the child is gone").kind(), io::ErrorKind::NotFound);
        let ours = socket_of(std::process::id() as i32, accepted.as_raw_fd()).expect("readable").expect("connected");
        assert!(holds(std::process::id() as i32, ours));
    }
}
