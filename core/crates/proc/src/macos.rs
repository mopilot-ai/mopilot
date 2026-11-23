//! macOS: the process table from libproc (`proc_listallpids`, `proc_pidinfo`), command lines from `KERN_PROCARGS2`, and
//! the pressure level from `kern.memorystatus_vm_pressure_level`.

use crate::{CommandLine, Process, ProcessIdentity};
use std::io;
use std::mem::size_of;
use std::ptr::null_mut;

/// Every process: the pids from `proc_listallpids`, then each one's parent and group from its short BSD info, which
/// the kernel gives for other users' processes too. A process that exits before its info is read is left out.
pub fn table() -> io::Result<Vec<Process>> {
    Ok(all_pids(list_pids)?.into_iter().filter_map(short_info).collect())
}

/// Full BSD information includes the kernel birth time at microsecond precision in the same record.
pub fn identities() -> io::Result<Vec<ProcessIdentity>> {
    Ok(all_pids(list_pids)?.into_iter().map(identity).collect::<io::Result<Vec<_>>>()?.into_iter().flatten().collect())
}

fn identity(pid: libc::pid_t) -> io::Result<Option<ProcessIdentity>> {
    let found = identity_with(|info| {
        let size = size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the output points to exactly one proc_bsdinfo and its passed size is correct.
        let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (info as *mut libc::proc_bsdinfo).cast(), size) };
        if n <= 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    });
    match found {
        // macOS restricts full BSD info for protected processes, but short BSD info still identifies their group.
        Err(error) if matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES)) => short_identity_with(|| short_checked(pid)),
        other => other,
    }
}

/// Preserve a protected process as explicitly birth-unknown, never as absent; retirement rejects it if owned. It is
/// absent only when the short read proves it exited after the full read was refused.
fn short_identity_with(read: impl Fn() -> io::Result<Option<Process>>) -> io::Result<Option<ProcessIdentity>> {
    Ok(read()?.map(|process| ProcessIdentity { process, birth: String::new() }))
}

/// A process's short BSD info, or `None` when ESRCH proves it is gone; any other failure is an error.
fn short_checked(pid: libc::pid_t) -> io::Result<Option<Process>> {
    short_checked_with(|info| {
        let size = size_of::<libc::proc_bsdshortinfo>() as libc::c_int;
        // SAFETY: errno is this thread's; the out-pointer has room for one proc_bsdshortinfo, and `size` says so
        let n = unsafe {
            *libc::__error() = 0;
            libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, (info as *mut libc::proc_bsdshortinfo).cast(), size)
        };
        if n <= 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(n as usize)
        }
    })
}

/// Only ESRCH proves the process disappeared; a short record or another error leaves its group unknown.
fn short_checked_with(read: impl Fn(&mut libc::proc_bsdshortinfo) -> io::Result<usize>) -> io::Result<Option<Process>> {
    // SAFETY: proc_bsdshortinfo is plain data; zeroed is a valid value for every field
    let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
    match read(&mut info) {
        Ok(n) if n == size_of::<libc::proc_bsdshortinfo>() => {
            Ok(Some(Process { pid: info.pbsi_pid as i32, ppid: info.pbsi_ppid as i32, pgid: info.pbsi_pgid as i32 }))
        }
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => Ok(None),
        _ => Err(io::Error::new(io::ErrorKind::PermissionDenied, "process group identity is unavailable")),
    }
}

/// Only ESRCH proves the process disappeared; a short record or another error invalidates the snapshot.
fn identity_with(read: impl Fn(&mut libc::proc_bsdinfo) -> io::Result<usize>) -> io::Result<Option<ProcessIdentity>> {
    // SAFETY: proc_bsdinfo is plain data and the out-pointer has room for exactly its passed size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let n = match read(&mut info) {
        Ok(n) => n,
        Err(error) if error.raw_os_error() == Some(libc::ESRCH) => return Ok(None),
        Err(error) => return Err(error),
    };
    if n != size_of::<libc::proc_bsdinfo>() {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "short process identity record"));
    }
    Ok(Some(ProcessIdentity {
        process: Process { pid: info.pbi_pid as i32, ppid: info.pbi_ppid as i32, pgid: info.pbi_pgid as i32 },
        birth: format!("macos:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
    }))
}

/// `struct kinfo_proc` as sysctl writes it: its first member `kp_proc` opens with `p_starttime` (sys/proc.h). The libc crate
/// has no binding, and only its size and that first field are read.
#[repr(C)]
struct KinfoProc {
    start: libc::timeval,
    rest: [u8; 648 - size_of::<libc::timeval>()],
}

/// When `pid` started (Unix milliseconds), or `None` for no such process: the start `ps` prints, from `KERN_PROC_PID`,
/// which the kernel gives for every user's process, where `proc_pidinfo`'s full record stops at this user's.
pub fn started(pid: libc::pid_t) -> io::Result<Option<u64>> {
    started_with(|info, size| {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
        // SAFETY: the name has the 4 ints given, and the out-pointer has room for the `size` bytes passed
        unsafe { libc::sysctl(mib.as_mut_ptr(), 4, (info as *mut KinfoProc).cast(), size, null_mut(), 0) }
    })
}

/// The start `read` writes, sized as it says: nothing written is no such process, and any other size isn't a process record.
fn started_with(read: impl Fn(&mut KinfoProc, &mut usize) -> libc::c_int) -> io::Result<Option<u64>> {
    // SAFETY: KinfoProc is plain data; zeroed is a valid value for every field
    let mut info: KinfoProc = unsafe { std::mem::zeroed() };
    let mut size = size_of::<KinfoProc>();
    if read(&mut info, &mut size) != 0 {
        return Err(io::Error::last_os_error());
    }
    match size {
        0 => Ok(None),
        n if n == size_of::<KinfoProc>() => Ok(Some(info.start.tv_sec as u64 * 1000 + info.start.tv_usec as u64 / 1000)),
        _ => Err(io::Error::new(io::ErrorKind::InvalidData, "short process record")),
    }
}

/// Every process with its command line: its parent from its short BSD info and its arguments from `KERN_PROCARGS2`. The
/// kernel gives only this user's processes' arguments, so another user's reads as its name in parentheses, as `ps`
/// shows it: `proc_name`'s, else the short info's (`proc_name` too can be refused). A process that exits meanwhile is
/// left out.
pub fn commands() -> io::Result<Vec<CommandLine>> {
    Ok(all_pids(list_pids)?
        .into_iter()
        .filter_map(|pid| {
            let (p, comm) = short(pid)?;
            let args = procargs(pid);
            let command = args.as_deref().and_then(parse_procargs).unwrap_or_else(|| format!("({})", name(pid).unwrap_or(comm)));
            let executable = args.as_deref().and_then(parse_executable).unwrap_or_default();
            Some(CommandLine { pid: p.pid, ppid: p.ppid, command, executable })
        })
        .collect())
}

/// `proc_listallpids` into `buf`: the pids it wrote, or with an empty buffer how many there are.
fn list_pids(buf: &mut [libc::pid_t]) -> libc::c_int {
    // SAFETY: the buffer is valid for `len` pids, and the size passed is its size in bytes; a null buffer asks for the count
    unsafe {
        let bytes = std::mem::size_of_val(buf) as libc::c_int;
        libc::proc_listallpids(if buf.is_empty() { null_mut() } else { buf.as_mut_ptr().cast() }, bytes)
    }
}

/// A process's `KERN_PROCARGS2` bytes, or `None` when the kernel won't give them (another user's process, one gone).
fn procargs(pid: libc::pid_t) -> Option<Vec<u8>> {
    read_sized(|buf, size| {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        // SAFETY: the name has the 3 ints given; the out-pointer is null (a size query) or has room for `size` bytes
        unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buf, size, null_mut(), 0) }
    })
}

/// The bytes `read` writes: sized by a call with no buffer, then read into a buffer of that size. `None` when either call
/// fails or there is nothing to read.
fn read_sized(read: impl Fn(*mut libc::c_void, &mut usize) -> libc::c_int) -> Option<Vec<u8>> {
    let mut size = 0usize;
    if read(null_mut(), &mut size) != 0 || size == 0 {
        return None;
    }
    let mut buf = vec![0u8; size];
    if read(buf.as_mut_ptr().cast(), &mut size) != 0 {
        return None;
    }
    buf.truncate(size);
    Some(buf)
}

/// `KERN_PROCARGS2`'s layout: argc as a native-endian int, the executable's path, NUL padding, then argc NUL-terminated
/// arguments (the environment follows). The arguments joined by spaces, as `ps` shows them; `None` for none or a buffer
/// too short to hold argc.
pub(crate) fn parse_procargs(bytes: &[u8]) -> Option<String> {
    let argc = usize::try_from(i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?)).ok()?;
    let rest = &bytes[4..];
    let mut at = rest.iter().position(|&b| b == 0)?;
    while rest.get(at) == Some(&0) {
        at += 1;
    }
    let args: Vec<String> = rest[at..].split(|&b| b == 0).take(argc).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
    (!args.is_empty()).then(|| args.join(" "))
}

/// The executable's path in `KERN_PROCARGS2`: the string after argc, or `None` for a buffer that holds none.
pub(crate) fn parse_executable(bytes: &[u8]) -> Option<String> {
    let rest = bytes.get(4..)?;
    let path = &rest[..rest.iter().position(|&b| b == 0)?];
    (!path.is_empty()).then(|| String::from_utf8_lossy(path).into_owned())
}

/// A process's executable name (`proc_name`), or `None` when it is gone.
fn name(pid: libc::pid_t) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the out-pointer has room for the buffer's length in bytes, which is the size passed
    let n = unsafe { libc::proc_name(pid, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| String::from_utf8_lossy(&buf[..n as usize]).into_owned())
}

/// The pids `list` writes: sized by a call with an empty buffer, then read into a buffer with room to spare. The list can
/// grow between sizing and reading, so a buffer that comes back full is doubled and read again.
fn all_pids(list: impl Fn(&mut [libc::pid_t]) -> libc::c_int) -> io::Result<Vec<libc::pid_t>> {
    let count = list(&mut []);
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut room = count as usize + 64;
    loop {
        let mut pids = vec![0 as libc::pid_t; room];
        let n = list(&mut pids);
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        if (n as usize) < room {
            pids.truncate(n as usize);
            return Ok(pids);
        }
        room *= 2;
    }
}

fn short_info(pid: libc::pid_t) -> Option<Process> {
    short(pid).map(|(p, _)| p)
}

/// A process's short BSD info: its pid, parent and group, and its short command name (up to 16 bytes).
fn short(pid: libc::pid_t) -> Option<(Process, String)> {
    // SAFETY: proc_bsdshortinfo is plain data; zeroed is a valid value for every field
    let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_bsdshortinfo>() as libc::c_int;
    // SAFETY: the out-pointer has room for one proc_bsdshortinfo, and `size` says so
    let n = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDT_SHORTBSDINFO, 0, (&mut info as *mut libc::proc_bsdshortinfo).cast(), size) };
    let comm: Vec<u8> = info.pbsi_comm.iter().take_while(|&&c| c != 0).map(|&c| c as u8).collect();
    (n == size).then(|| {
        (
            Process { pid: info.pbsi_pid as i32, ppid: info.pbsi_ppid as i32, pgid: info.pbsi_pgid as i32 },
            String::from_utf8_lossy(&comm).into_owned(),
        )
    })
}

/// The kernel's memory pressure level: 1 normal, 2 warning, 4 critical.
pub fn pressure_level() -> io::Result<u32> {
    pressure_with(|level| {
        let mut size = size_of::<libc::c_int>();
        // SAFETY: the name is NUL-terminated and the out-pointer has room for the int the kernel writes
        unsafe {
            libc::sysctlbyname(
                c"kern.memorystatus_vm_pressure_level".as_ptr(),
                (level as *mut libc::c_int).cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        }
    })
}

/// The level `read` writes, or the OS error when it returns non-zero.
fn pressure_with(read: impl Fn(&mut libc::c_int) -> libc::c_int) -> io::Result<u32> {
    let mut level: libc::c_int = 0;
    if read(&mut level) != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(level as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn identities_keep_the_kernel_birth_and_refuse_a_gone_process() {
        let pid = std::process::id() as libc::pid_t;
        let first = identity(pid).expect("read self").expect("self");
        assert_eq!(identity(pid).expect("read again"), Some(first.clone()));
        assert_eq!(first.process.ppid, unsafe { libc::getppid() });
        assert!(first.birth.starts_with("macos:"));
        assert_eq!(identity(-1).expect("invalid process is gone"), None);
        assert_eq!(identity(i32::MAX).expect("gone"), None);
        assert!(identities().expect("identities").contains(&first));
    }

    #[test]
    fn a_start_reads_for_any_user_s_process_and_none_for_no_process() {
        let own = started(std::process::id() as libc::pid_t).expect("own start").expect("a start");
        let birth = identity(std::process::id() as libc::pid_t).expect("read self").expect("self").birth;
        let seconds: u64 = birth.split(':').nth(1).expect("seconds").parse().expect("a number");
        assert_eq!(own / 1000, seconds);
        // launchd is root's: proc_pidinfo's full record is refused, and this still dates it, before this process
        assert!(started(1).expect("launchd").expect("a start") < own);
        assert_eq!(started(i32::MAX).expect("no such process"), None);
    }

    #[test]
    fn a_start_is_read_from_the_record_the_kernel_writes() {
        let start = started_with(|info, _| {
            info.start = libc::timeval { tv_sec: 100, tv_usec: 1999 };
            0
        });
        assert_eq!(start.expect("a start"), Some(100_001));
        assert_eq!(
            started_with(|_, size| {
                *size = 0;
                0
            })
            .expect("no such process"),
            None
        );
        assert!(started_with(|_, size| {
            *size = 8;
            0
        })
        .is_err());
        assert!(started_with(|_, _| -1).is_err());
    }

    #[test]
    fn partial_identity_errors_never_become_an_omitted_process() {
        assert_eq!(identity_with(|_| Err(io::Error::from_raw_os_error(libc::ESRCH))).expect("gone"), None);
        for code in [libc::EACCES, libc::EIO] {
            assert!(identity_with(|_| Err(io::Error::from_raw_os_error(code))).is_err());
        }
        assert!(identity_with(|_| Ok(1)).is_err());
        let protected = Process { pid: 42, ppid: 1, pgid: 42 };
        assert_eq!(
            short_identity_with(|| Ok(Some(protected))).expect("short identity"),
            Some(ProcessIdentity { process: protected, birth: String::new() })
        );
        // a protected process that exits between the refused full read and the short read is gone, not an error
        assert_eq!(short_identity_with(|| Ok(None)).expect("gone"), None);
        assert!(short_identity_with(|| Err(io::Error::from_raw_os_error(libc::EPERM))).is_err());
    }

    #[test]
    fn a_short_record_is_absent_only_on_esrch() {
        let record = short_checked_with(|info| {
            info.pbsi_pid = 7;
            info.pbsi_ppid = 1;
            info.pbsi_pgid = 7;
            Ok(size_of::<libc::proc_bsdshortinfo>())
        });
        assert_eq!(record.expect("a record"), Some(Process { pid: 7, ppid: 1, pgid: 7 }));
        assert_eq!(short_checked_with(|_| Err(io::Error::from_raw_os_error(libc::ESRCH))).expect("gone"), None);
        for code in [libc::EPERM, libc::EACCES, libc::EIO, 0] {
            assert!(short_checked_with(|_| Err(io::Error::from_raw_os_error(code))).is_err(), "errno {code}");
        }
        assert!(short_checked_with(|_| Ok(1)).is_err());
        let own = std::process::id() as libc::pid_t;
        assert_eq!(short_checked(own).expect("self").expect("a record").pid, own);
        assert_eq!(short_checked(i32::MAX).expect("no such process"), None);
        // launchd is root's: its full record is refused, and its short record still names its group
        assert_eq!(identity(1).expect("launchd").expect("a process").process.pid, 1);
    }

    #[test]
    fn a_list_that_fills_its_buffer_is_read_again_with_twice_the_room() {
        let reads = Cell::new(0);
        let pids = all_pids(|buf| {
            if buf.is_empty() {
                return 1;
            }
            reads.set(reads.get() + 1);
            // the first read fills the 65 slots: more processes started since sizing
            let n = if reads.get() == 1 { buf.len() } else { 70 };
            for (i, slot) in buf.iter_mut().take(n).enumerate() {
                *slot = i as libc::pid_t + 1;
            }
            n as libc::c_int
        })
        .expect("pids");
        assert_eq!(reads.get(), 2);
        assert_eq!(pids.len(), 70);
        assert_eq!(pids[69], 70);
    }

    #[test]
    fn procargs_read_the_arguments_after_argc_the_path_and_its_padding() {
        let mut bytes = 3i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/bin/sleep\0\0\0sleep\0-n\0with space\0HOME=/x\0");
        assert_eq!(parse_procargs(&bytes).as_deref(), Some("sleep -n with space"));
        // fewer arguments than argc says: what is there
        let mut short = 5i32.to_ne_bytes().to_vec();
        short.extend_from_slice(b"/a\0a\0b");
        assert_eq!(parse_procargs(&short).as_deref(), Some("a b"));
        // no argc, a path never ended, no arguments, a negative argc
        assert_eq!(parse_procargs(b"\x01\x00"), None);
        let mut open = 1i32.to_ne_bytes().to_vec();
        open.extend_from_slice(b"/no/end");
        assert_eq!(parse_procargs(&open), None);
        let mut none = 0i32.to_ne_bytes().to_vec();
        none.extend_from_slice(b"/a\0\0");
        assert_eq!(parse_procargs(&none), None);
        let mut negative = (-1i32).to_ne_bytes().to_vec();
        negative.extend_from_slice(b"/a\0a\0");
        assert_eq!(parse_procargs(&negative), None);
    }

    #[test]
    fn the_executable_is_the_path_after_argc_whatever_the_arguments_name() {
        let mut bytes = 2i32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"/usr/bin/lldb\0\0\0lldb\0./Claude.app/Contents/MacOS/Claude\0");
        assert_eq!(parse_executable(&bytes).as_deref(), Some("/usr/bin/lldb"));
        assert_eq!(parse_procargs(&bytes).as_deref(), Some("lldb ./Claude.app/Contents/MacOS/Claude"));
        // spaces stay in the path, and no argc, an unended path or an empty one is none
        let mut spaced = 1i32.to_ne_bytes().to_vec();
        spaced.extend_from_slice(b"/Old Apps -x /a b\0a\0");
        assert_eq!(parse_executable(&spaced).as_deref(), Some("/Old Apps -x /a b"));
        assert_eq!(parse_executable(b"\x01\x00"), None);
        let mut open = 1i32.to_ne_bytes().to_vec();
        open.extend_from_slice(b"/no/end");
        assert_eq!(parse_executable(&open), None);
        let mut empty = 1i32.to_ne_bytes().to_vec();
        empty.extend_from_slice(b"\0a\0");
        assert_eq!(parse_executable(&empty), None);
    }

    #[test]
    fn a_sized_read_is_none_when_the_size_or_the_read_fails_or_is_empty() {
        let bytes = read_sized(|buf, size| {
            if buf.is_null() {
                *size = 4;
            } else {
                // SAFETY: the buffer has room for the 4 bytes the sizing said
                unsafe { std::ptr::copy_nonoverlapping(b"abcd".as_ptr(), buf.cast(), 4) };
                *size = 3;
            }
            0
        });
        assert_eq!(bytes.as_deref(), Some(&b"abc"[..]));
        assert_eq!(read_sized(|_, _| -1), None);
        assert_eq!(read_sized(|_, _| 0), None);
        assert_eq!(read_sized(|buf, size| if buf.is_null() { (*size = 8, 0).1 } else { -1 }), None);
    }

    #[test]
    fn another_user_s_process_reads_as_its_name_and_a_gone_one_has_none() {
        // launchd is root's: its arguments are not this user's to read (unless the tests run as root)
        let rows = commands().expect("command lines");
        let launchd = rows.iter().find(|p| p.pid == 1).expect("launchd is listed");
        // `(launchd)`, or its path when the tests run as root
        assert!(launchd.command.contains("launchd"), "{}", launchd.command);
        // this process's own file, and none for a process whose arguments can't be read
        let me = rows.iter().find(|p| p.pid == std::process::id() as i32).expect("this process is listed");
        assert_eq!(std::path::Path::new(&me.executable), std::env::current_exe().expect("this file"));
        assert!(rows.iter().filter(|p| p.command.starts_with('(')).all(|p| p.executable.is_empty()));
        // every process the table lists has a command line (one may start or exit between the two reads)
        assert!(rows.len() + 16 >= table().expect("a table").len());
        assert_eq!(name(-1), None);
        // this process's own name is readable
        let me = std::process::id() as libc::pid_t;
        assert!(name(me).is_some_and(|n| !n.is_empty()));
        assert_eq!(procargs(-1), None);
    }

    #[test]
    fn a_failed_sizing_or_read_is_an_error() {
        assert!(all_pids(|_| -1).is_err());
        assert!(all_pids(|buf| if buf.is_empty() { 3 } else { -1 }).is_err());
    }

    #[test]
    fn the_pressure_level_is_what_the_kernel_writes_or_its_error() {
        assert_eq!(
            pressure_with(|level| {
                *level = 4;
                0
            })
            .expect("a level"),
            4
        );
        assert!(pressure_with(|_| -1).is_err());
    }
}
