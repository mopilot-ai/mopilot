//! The two steps of a record write std does differently from libuv: closing the file, whose failure std's drop ignores,
//! and on Windows the rename, which libuv makes with one `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on the namespaced
//! paths Node hands it, where std tries a POSIX-semantics rename first.

use std::fs;
use std::io;
use std::path::Path;

/// `open` closed, with the failure `close` reports.
#[cfg(unix)]
pub fn close(open: fs::File) -> io::Result<()> {
    let fd = std::os::fd::IntoRawFd::into_raw_fd(open);
    // SAFETY: `fd` was just taken out of its File, so nothing else owns it, and it is closed once here
    let rc = unsafe { libc::close(fd) };
    closed(rc, io::Error::last_os_error)
}

/// What a close that returned `rc` means: libuv takes an interrupted close as done, since the descriptor is gone either
/// way (uv__close_nocheckstdio).
#[cfg(unix)]
pub fn closed(rc: libc::c_int, error: impl FnOnce() -> io::Error) -> io::Result<()> {
    if rc == 0 {
        return Ok(());
    }
    let error = error();
    match error.raw_os_error() {
        Some(libc::EINTR | libc::EINPROGRESS) => Ok(()),
        _ => Err(error),
    }
}

#[cfg(unix)]
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CloseHandle(handle: std::os::windows::io::RawHandle) -> i32;
    fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
}

#[cfg(windows)]
const MOVEFILE_REPLACE_EXISTING: u32 = 1;

/// `open` closed, with the failure `CloseHandle` reports.
#[cfg(windows)]
pub fn close(open: fs::File) -> io::Result<()> {
    let handle = std::os::windows::io::IntoRawHandle::into_raw_handle(open);
    // SAFETY: the handle was just taken out of its File, so nothing else owns it, and it is closed once here
    if unsafe { CloseHandle(handle) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `from` in place of `to` as libuv's fs__rename does it.
#[cfg(windows)]
pub fn rename(from: &Path, to: &Path) -> io::Result<()> {
    let (from, to) = (wide(from)?, wide(to)?);
    // SAFETY: both are NUL-terminated UTF-16 strings that live past the call
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// `path` made absolute and namespaced, NUL-terminated.
#[cfg(windows)]
fn wide(path: &Path) -> io::Result<Vec<u16>> {
    let absolute = std::path::absolute(path)?;
    Ok(namespaced(&absolute.to_string_lossy()).encode_utf16().chain([0]).collect())
}

/// An absolute Windows path as Node's `path.toNamespacedPath` makes it: `\\?\C:\…` for a drive, `\\?\UNC\server\…`
/// for a share, anything else (already `\\?\` or `\\.\`) as it is.
#[cfg(any(windows, test))]
pub fn namespaced(path: &str) -> String {
    let bytes = path.as_bytes();
    if let Some(share) = path.strip_prefix(r"\\") {
        if !share.starts_with(['?', '.']) {
            return format!(r"\\?\UNC\{share}");
        }
    } else if bytes.len() > 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\' {
        return format!(r"\\?\{path}");
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drive_or_a_share_is_namespaced_as_node_does_and_anything_else_is_left() {
        assert_eq!(namespaced(r"C:\Users\me\threads\a.v2"), r"\\?\C:\Users\me\threads\a.v2");
        assert_eq!(namespaced(r"\\server\share\a.v2"), r"\\?\UNC\server\share\a.v2");
        assert_eq!(namespaced(r"\\?\C:\a.v2"), r"\\?\C:\a.v2");
        assert_eq!(namespaced(r"\\.\pipe\x"), r"\\.\pipe\x");
        assert_eq!(namespaced("C:"), "C:");
        assert_eq!(namespaced("C:a"), "C:a");
        assert_eq!(namespaced(r"1:\a"), r"1:\a");
        assert_eq!(namespaced(r"ab\c"), r"ab\c");
        assert_eq!(namespaced("/tmp/a.v2"), "/tmp/a.v2");
    }

    #[cfg(unix)]
    #[test]
    fn a_close_that_fails_says_so_and_an_interrupted_one_is_done() {
        let error = |errno| move || io::Error::from_raw_os_error(errno);
        assert!(closed(0, error(libc::EIO)).is_ok());
        assert_eq!(closed(-1, error(libc::EIO)).expect_err("failed").raw_os_error(), Some(libc::EIO));
        assert!(closed(-1, error(libc::EINTR)).is_ok());
        assert!(closed(-1, error(libc::EINPROGRESS)).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn a_rename_replaces_the_file_and_one_held_open_without_sharing_stays_whole() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = std::env::temp_dir().join(format!("mopilot-store-sys-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("a folder");
        let (temp, file) = (dir.join(".t.tmp"), dir.join("x.v2"));
        fs::write(&file, b"old").expect("a file");
        fs::write(&temp, b"new").expect("a file");
        rename(&temp, &file).expect("replaced");
        assert_eq!(fs::read(&file).expect("the file"), b"new");
        fs::write(&temp, b"newer").expect("a file");
        let held = fs::OpenOptions::new().read(true).share_mode(0).open(&file).expect("held");
        let error = rename(&temp, &file).expect_err("held without sharing");
        assert!(crate::errors::uv_name(&error).0.starts_with('E'), "{error}");
        drop(held);
        assert_eq!(fs::read(&file).expect("the file"), b"new");
        close(fs::File::open(&file).expect("opened")).expect("closed");
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn SetHandleInformation(handle: std::os::windows::io::RawHandle, mask: u32, flags: u32) -> i32;
    }

    #[cfg(windows)]
    #[test]
    fn a_handle_that_will_not_close_is_a_failed_close() {
        use std::os::windows::io::{AsRawHandle, FromRawHandle};
        const HANDLE_FLAG_PROTECT_FROM_CLOSE: u32 = 2;
        let file = std::env::temp_dir().join(format!("mopilot-store-close-{}", std::process::id()));
        let open = fs::File::create(&file).expect("a file");
        let handle = open.as_raw_handle();
        // SAFETY: `handle` is `open`'s, which is alive; the flag only makes CloseHandle refuse it
        assert_ne!(unsafe { SetHandleInformation(handle, HANDLE_FLAG_PROTECT_FROM_CLOSE, HANDLE_FLAG_PROTECT_FROM_CLOSE) }, 0);
        // the kernel refuses to close it, as a handle whose close fails for any reason: the failure comes back
        assert!(close(open).is_err());
        // SAFETY: the refused close left `handle` open and owned by nothing; it is unprotected and closed here, once
        assert_ne!(unsafe { SetHandleInformation(handle, HANDLE_FLAG_PROTECT_FROM_CLOSE, 0) }, 0);
        // SAFETY: as above: `handle` is open, and this File is its only owner from here on
        close(unsafe { fs::File::from_raw_handle(handle) }).expect("closed once unprotected");
        fs::remove_file(&file).expect("removed");
    }
}
