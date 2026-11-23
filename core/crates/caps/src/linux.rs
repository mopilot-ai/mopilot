//! Linux: who holds the far end of a Unix socket. SO_PEERCRED keeps the pid of the process that connected: it reads the
//! same after that process has exited, and by then another process can have that number. So the number counts only for a
//! process that holds the far end now, shown by `/proc/<pid>/fd` against the far end's inode, which sock_diag gives (the
//! table `ss` reads). A pid of 0, a process in a pid namespace this one can't see, holds nothing here.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::path::Path;

/// linux/sock_diag.h, linux/unix_diag.h: the request type, what to show, and the attribute that answers it.
const SOCK_DIAG_BY_FAMILY: u16 = 20;
const UDIAG_SHOW_PEER: u32 = 4;
const UNIX_DIAG_PEER: u16 = 2;
/// Where a netlink message's body starts, and where a unix_diag_msg's attributes start.
const HEADER: usize = 16;
const ATTRIBUTES: usize = HEADER + 16;

/// The pid SO_PEERCRED gives for `fd`, when that process still holds the far end.
pub fn peer_pid(fd: i32) -> io::Result<i32> {
    let pid = connected_pid(fd)?;
    let far = far_end(fd)?;
    if holds(pid, far) {
        Ok(pid)
    } else {
        Err(io::Error::new(io::ErrorKind::NotFound, format!("process {pid} does not hold socket {far}")))
    }
}

/// The pid of the process that connected to `fd`, as connect recorded it.
fn connected_pid(fd: i32) -> io::Result<i32> {
    // SAFETY: ucred is plain data; zeroed is valid
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt fills `cred` for at most `len` bytes, or fails on a descriptor that isn't a connected socket
    let ok = unsafe { libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len) };
    if ok == 0 {
        Ok(cred.pid)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The inode a `/proc/<pid>/fd` link names, when it names a socket.
fn socket_inode(link: &Path) -> Option<u32> {
    link.to_str()?.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
}

/// The inode of the socket at the far end of `fd`, asking the kernel's table for that one socket. The kernel answers while
/// the request is sent, so the read does not wait.
fn far_end(fd: i32) -> io::Result<u32> {
    let not_found = || io::Error::new(io::ErrorKind::NotFound, format!("descriptor {fd} has no connected far end"));
    let own = socket_inode(&fs::read_link(format!("/proc/self/fd/{fd}"))?).ok_or_else(not_found)?;
    // SAFETY: socket takes no pointers, and its result is checked before it is used
    let raw = unsafe { libc::socket(libc::AF_NETLINK, libc::SOCK_RAW | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK, libc::NETLINK_SOCK_DIAG) };
    // SAFETY: `raw` is a new descriptor that nothing else owns
    let mut table = (raw >= 0).then(|| File::from(unsafe { OwnedFd::from_raw_fd(raw) })).ok_or_else(io::Error::last_os_error)?;
    table.write_all(&request(own))?;
    let mut reply = [0u8; 4096];
    let read = table.read(&mut reply)?;
    far_end_in(&reply[..read], own).ok_or_else(not_found)
}

/// A netlink header and a unix_diag_req asking for the far end of the socket with inode `own`.
fn request(own: u32) -> [u8; HEADER + 24] {
    let mut message = [0u8; HEADER + 24];
    message[..4].copy_from_slice(&((HEADER + 24) as u32).to_ne_bytes());
    message[4..6].copy_from_slice(&SOCK_DIAG_BY_FAMILY.to_ne_bytes());
    message[6..8].copy_from_slice(&(libc::NLM_F_REQUEST as u16).to_ne_bytes());
    message[HEADER] = libc::AF_UNIX as u8;
    message[HEADER + 8..HEADER + 12].copy_from_slice(&own.to_ne_bytes());
    message[HEADER + 12..HEADER + 16].copy_from_slice(&UDIAG_SHOW_PEER.to_ne_bytes());
    // all ones: no cookie to compare
    message[HEADER + 16..].fill(0xff);
    message
}

/// The far end's inode in the kernel's `reply` about socket `own`. None for any other reply: an error, another socket's,
/// a short one, or one naming no far end (0: it closed).
fn far_end_in(reply: &[u8], own: u32) -> Option<u32> {
    let u16_at = |at: usize| Some(u16::from_ne_bytes(reply.get(at..at + 2)?.try_into().ok()?));
    let u32_at = |at: usize| Some(u32::from_ne_bytes(reply.get(at..at + 4)?.try_into().ok()?));
    if u16_at(4)? != SOCK_DIAG_BY_FAMILY || u32_at(HEADER + 4)? != own {
        return None;
    }
    let end = (u32_at(0)? as usize).min(reply.len());
    let mut at = ATTRIBUTES;
    while at + 4 <= end {
        let length = u16_at(at)? as usize;
        if u16_at(at + 2)? == UNIX_DIAG_PEER {
            return u32_at(at + 4).filter(|&far| far != 0);
        }
        at += length.max(4).next_multiple_of(4);
    }
    None
}

/// Whether process `pid` has socket `inode` open. A process that is gone, or one this user may not inspect, holds nothing.
fn holds(pid: i32, inode: u32) -> bool {
    fs::read_dir(format!("/proc/{pid}/fd"))
        .is_ok_and(|fds| fds.flatten().any(|fd| fs::read_link(fd.path()).is_ok_and(|link| socket_inode(&link) == Some(inode))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::connected_by_a_process_that_exited;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;

    /// A reply about socket `own` carrying `attributes` as (type, value), each four bytes.
    fn reply(kind: u16, own: u32, attributes: &[(u16, u32)]) -> Vec<u8> {
        let mut out = vec![0u8; ATTRIBUTES];
        out[4..6].copy_from_slice(&kind.to_ne_bytes());
        out[HEADER + 4..HEADER + 8].copy_from_slice(&own.to_ne_bytes());
        for (kind, value) in attributes {
            out.extend(8u16.to_ne_bytes());
            out.extend(kind.to_ne_bytes());
            out.extend(value.to_ne_bytes());
        }
        let length = out.len() as u32;
        out[..4].copy_from_slice(&length.to_ne_bytes());
        out
    }

    #[test]
    fn a_reply_names_the_far_end_only_for_this_socket_and_only_when_there_is_one() {
        assert_eq!(far_end_in(&reply(SOCK_DIAG_BY_FAMILY, 7, &[(1, 99), (UNIX_DIAG_PEER, 42)]), 7), Some(42));
        assert_eq!(far_end_in(&reply(SOCK_DIAG_BY_FAMILY, 8, &[(UNIX_DIAG_PEER, 42)]), 7), None);
        assert_eq!(far_end_in(&reply(libc::NLMSG_ERROR as u16, 7, &[(UNIX_DIAG_PEER, 42)]), 7), None);
        assert_eq!(far_end_in(&reply(SOCK_DIAG_BY_FAMILY, 7, &[(UNIX_DIAG_PEER, 0)]), 7), None);
        assert_eq!(far_end_in(&reply(SOCK_DIAG_BY_FAMILY, 7, &[(1, 99)]), 7), None);
        assert_eq!(far_end_in(&[], 7), None);
        // cut short inside an attribute's value, and an attribute that gives no length of its own
        let whole = reply(SOCK_DIAG_BY_FAMILY, 7, &[(UNIX_DIAG_PEER, 42)]);
        assert_eq!(far_end_in(&whole[..ATTRIBUTES + 6], 7), None);
        let mut stuck = reply(SOCK_DIAG_BY_FAMILY, 7, &[(1, 99)]);
        stuck[ATTRIBUTES..ATTRIBUTES + 2].fill(0);
        assert_eq!(far_end_in(&stuck, 7), None);
    }

    #[test]
    fn a_link_names_a_socket_only_in_the_kernel_s_form() {
        assert_eq!(socket_inode(Path::new("socket:[42]")), Some(42));
        for other in ["pipe:[42]", "socket:[x]", "socket:[42", "/tmp/socket:[42]"] {
            assert_eq!(socket_inode(Path::new(other)), None, "{other}");
        }
    }

    #[test]
    fn the_peer_of_a_socket_pair_holds_it_and_a_closed_far_end_or_another_file_has_no_peer() {
        let (a, b) = UnixStream::pair().expect("a pair");
        assert_eq!(peer_pid(a.as_raw_fd()).expect("a peer"), std::process::id() as i32);
        drop(b);
        // a sibling test's fork holds a copy of every descriptor until its child exits, so the far end closes soon, not now
        let closed = (0..2000).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(1));
            peer_pid(a.as_raw_fd()).is_err()
        });
        assert!(closed);
        assert_eq!(peer_pid(a.as_raw_fd()).expect_err("closed").kind(), io::ErrorKind::NotFound);
        let file = File::open("/proc/self/stat").expect("a file");
        assert_eq!(far_end(file.as_raw_fd()).expect_err("no socket").kind(), io::ErrorKind::NotFound);
        assert!(far_end(-1).is_err());
        assert!(peer_pid(-1).is_err());
    }

    #[test]
    fn the_process_that_connected_has_exited_so_its_number_counts_for_no_one() {
        let (accepted, _held, child) = connected_by_a_process_that_exited();

        // the kernel still names the child, which holds nothing now
        assert_eq!(connected_pid(accepted.as_raw_fd()).expect("recorded"), child);
        let refused = peer_pid(accepted.as_raw_fd()).expect_err("the child is gone");
        assert_eq!(refused.kind(), io::ErrorKind::NotFound);
        assert!(far_end(accepted.as_raw_fd()).is_ok());
    }
}
