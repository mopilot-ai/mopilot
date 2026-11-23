//! An OS error named as Node names it (libuv's code and text, `uv_table.rs`), so a write the core makes fails with the
//! message a Node `fs` call made: `EACCES: permission denied, open '<file>'`.

use crate::uv_table::{named, NAMES};
use std::io;

/// The code and text libuv gives `error` (`uv_err_name`, `uv_strerror`), which Node's synchronous fs calls throw with;
/// an error the OS did not raise (a short write) keeps Rust's own text.
pub fn uv_name(error: &io::Error) -> (String, String) {
    match error.raw_os_error() {
        Some(raw) => named(raw).map_or_else(|| unnamed(raw), |(code, text)| (code.to_string(), text.to_string())),
        None => ("UNKNOWN".to_string(), error.to_string()),
    }
}

/// The table as JSON, `[[code, name, text], …]`, for `store.errorNames`: what the tests hold to Node's own map.
pub fn names_json() -> String {
    serde_json::Value::from(NAMES.iter().map(|&(code, name, text)| serde_json::json!([code, name, text])).collect::<Vec<_>>()).to_string()
}

/// An errno libuv has no name for (EDQUOT, a quota) passes through as its negative, which libuv spells out as both.
#[cfg(unix)]
fn unnamed(errno: i32) -> (String, String) {
    let text = format!("Unknown system error -{errno}");
    (text.clone(), text)
}

/// A Win32 error libuv does not translate is UV_UNKNOWN.
#[cfg(windows)]
fn unnamed(_: i32) -> (String, String) {
    ("UNKNOWN".to_string(), "unknown error".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_in_the_table_reads_as_its_own_row_and_the_json_lists_them_all() {
        for &(code, name, text) in NAMES {
            assert_eq!(uv_name(&io::Error::from_raw_os_error(code)), (name.to_string(), text.to_string()), "{code}");
        }
        let json: serde_json::Value = serde_json::from_str(&names_json()).expect("JSON");
        assert_eq!(json.as_array().map(Vec::len), Some(NAMES.len()));
        assert_eq!(json[0], serde_json::json!([NAMES[0].0, NAMES[0].1, NAMES[0].2]));
        assert_eq!(uv_name(&io::Error::from(io::ErrorKind::WriteZero)), ("UNKNOWN".to_string(), "write zero".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn an_errno_libuv_has_no_name_for_is_its_number_spelled_out() {
        assert_eq!(uv_name(&io::Error::from_raw_os_error(libc::EACCES)).0, "EACCES");
        assert_eq!(uv_name(&io::Error::from_raw_os_error(libc::ENOTCONN)).1, "socket is not connected");
        let quota = format!("Unknown system error -{}", libc::EDQUOT);
        assert_eq!(uv_name(&io::Error::from_raw_os_error(libc::EDQUOT)), (quota.clone(), quota));
    }

    #[cfg(windows)]
    #[test]
    fn a_win32_code_reads_as_libuvs_translation_and_any_other_is_unknown() {
        let name = |code| uv_name(&io::Error::from_raw_os_error(code)).0;
        assert_eq!(
            [1231, 267, 1314, 998, 5, 32, 112, 206, 2, 3, 183, 145, 17, 19, 1].map(name),
            [
                "ENETUNREACH",
                "ENOENT",
                "EPERM",
                "EFAULT",
                "EPERM",
                "EBUSY",
                "ENOSPC",
                "ENAMETOOLONG",
                "ENOENT",
                "ENOENT",
                "EEXIST",
                "ENOTEMPTY",
                "EXDEV",
                "EROFS",
                "EISDIR"
            ]
        );
        assert_eq!(uv_name(&io::Error::from_raw_os_error(99_999)), ("UNKNOWN".to_string(), "unknown error".to_string()));
        assert_eq!(NAMES.len(), 100, "every case of uv_translate_sys_error");
    }
}
