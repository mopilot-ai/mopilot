//! libuv's names for the OS's errors, as Node 24 bundles it (libuv 1.52.1): on POSIX each errno of `UV_ERRNO_MAP`
//! (include/uv.h) with its text, and on Windows `uv_translate_sys_error` (src/win/error.c), each Win32 or WSA code
//! (values from windows-sys) with the name and text it translates to. tests/recordFiles.test.ts holds the table the
//! core serves (`store.errorNames`) to Node's own `util.getSystemErrorMap()`, so a gap fails.

/// libuv's name and text for an OS error code, when it has one.
pub fn named(raw: i32) -> Option<(&'static str, &'static str)> {
    NAMES.iter().find(|(code, ..)| *code == raw).map(|&(_, name, text)| (name, text))
}

/// (errno, libuv's name, libuv's text).
#[cfg(unix)]
pub const NAMES: &[(i32, &str, &str)] = &[
    (libc::E2BIG, "E2BIG", "argument list too long"),
    (libc::EACCES, "EACCES", "permission denied"),
    (libc::EADDRINUSE, "EADDRINUSE", "address already in use"),
    (libc::EADDRNOTAVAIL, "EADDRNOTAVAIL", "address not available"),
    (libc::EAFNOSUPPORT, "EAFNOSUPPORT", "address family not supported"),
    (libc::EAGAIN, "EAGAIN", "resource temporarily unavailable"),
    (libc::EALREADY, "EALREADY", "connection already in progress"),
    (libc::EBADF, "EBADF", "bad file descriptor"),
    (libc::EBUSY, "EBUSY", "resource busy or locked"),
    (libc::ECANCELED, "ECANCELED", "operation canceled"),
    (libc::ECONNABORTED, "ECONNABORTED", "software caused connection abort"),
    (libc::ECONNREFUSED, "ECONNREFUSED", "connection refused"),
    (libc::ECONNRESET, "ECONNRESET", "connection reset by peer"),
    (libc::EDESTADDRREQ, "EDESTADDRREQ", "destination address required"),
    (libc::EEXIST, "EEXIST", "file already exists"),
    (libc::EFAULT, "EFAULT", "bad address in system call argument"),
    (libc::EFBIG, "EFBIG", "file too large"),
    (libc::EHOSTUNREACH, "EHOSTUNREACH", "host is unreachable"),
    (libc::EINTR, "EINTR", "interrupted system call"),
    (libc::EINVAL, "EINVAL", "invalid argument"),
    (libc::EIO, "EIO", "i/o error"),
    (libc::EISCONN, "EISCONN", "socket is already connected"),
    (libc::EISDIR, "EISDIR", "illegal operation on a directory"),
    (libc::ELOOP, "ELOOP", "too many symbolic links encountered"),
    (libc::EMFILE, "EMFILE", "too many open files"),
    (libc::EMSGSIZE, "EMSGSIZE", "message too long"),
    (libc::ENAMETOOLONG, "ENAMETOOLONG", "name too long"),
    (libc::ENETDOWN, "ENETDOWN", "network is down"),
    (libc::ENETUNREACH, "ENETUNREACH", "network is unreachable"),
    (libc::ENFILE, "ENFILE", "file table overflow"),
    (libc::ENOBUFS, "ENOBUFS", "no buffer space available"),
    (libc::ENODEV, "ENODEV", "no such device"),
    (libc::ENOENT, "ENOENT", "no such file or directory"),
    (libc::ENOMEM, "ENOMEM", "not enough memory"),
    #[cfg(target_os = "linux")]
    (libc::ENONET, "ENONET", "machine is not on the network"),
    (libc::ENOPROTOOPT, "ENOPROTOOPT", "protocol not available"),
    (libc::ENOSPC, "ENOSPC", "no space left on device"),
    (libc::ENOSYS, "ENOSYS", "function not implemented"),
    (libc::ENOTCONN, "ENOTCONN", "socket is not connected"),
    (libc::ENOTDIR, "ENOTDIR", "not a directory"),
    (libc::ENOTEMPTY, "ENOTEMPTY", "directory not empty"),
    (libc::ENOTSOCK, "ENOTSOCK", "socket operation on non-socket"),
    (libc::ENOTSUP, "ENOTSUP", "operation not supported on socket"),
    (libc::EOVERFLOW, "EOVERFLOW", "value too large for defined data type"),
    (libc::EPERM, "EPERM", "operation not permitted"),
    (libc::EPIPE, "EPIPE", "broken pipe"),
    (libc::EPROTO, "EPROTO", "protocol error"),
    (libc::EPROTONOSUPPORT, "EPROTONOSUPPORT", "protocol not supported"),
    (libc::EPROTOTYPE, "EPROTOTYPE", "protocol wrong type for socket"),
    (libc::ERANGE, "ERANGE", "result too large"),
    (libc::EROFS, "EROFS", "read-only file system"),
    (libc::ESHUTDOWN, "ESHUTDOWN", "cannot send after transport endpoint shutdown"),
    (libc::ESPIPE, "ESPIPE", "invalid seek"),
    (libc::ESRCH, "ESRCH", "no such process"),
    (libc::ETIMEDOUT, "ETIMEDOUT", "connection timed out"),
    (libc::ETXTBSY, "ETXTBSY", "text file is busy"),
    (libc::EXDEV, "EXDEV", "cross-device link not permitted"),
    (libc::ENXIO, "ENXIO", "no such device or address"),
    (libc::EMLINK, "EMLINK", "too many links"),
    (libc::EHOSTDOWN, "EHOSTDOWN", "host is down"),
    #[cfg(target_os = "linux")]
    (libc::EREMOTEIO, "EREMOTEIO", "remote I/O error"),
    (libc::ENOTTY, "ENOTTY", "inappropriate ioctl for device"),
    #[cfg(target_vendor = "apple")]
    (libc::EFTYPE, "EFTYPE", "inappropriate file type or format"),
    (libc::EILSEQ, "EILSEQ", "illegal byte sequence"),
    (libc::ESOCKTNOSUPPORT, "ESOCKTNOSUPPORT", "socket type not supported"),
    (libc::ENODATA, "ENODATA", "no data available"),
    #[cfg(target_os = "linux")]
    (libc::EUNATCH, "EUNATCH", "protocol driver not attached"),
    (libc::ENOEXEC, "ENOEXEC", "exec format error"),
];

/// (Win32 or WSA code, libuv's name, libuv's text), in error.c's order.
#[cfg(windows)]
pub const NAMES: &[(i32, &str, &str)] = &[
    (10013, "EACCES", "permission denied"),                      // WSAEACCES
    (740, "EACCES", "permission denied"),                        // ERROR_ELEVATION_REQUIRED
    (1920, "EACCES", "permission denied"),                       // ERROR_CANT_ACCESS_FILE
    (1227, "EADDRINUSE", "address already in use"),              // ERROR_ADDRESS_ALREADY_ASSOCIATED
    (10048, "EADDRINUSE", "address already in use"),             // WSAEADDRINUSE
    (10049, "EADDRNOTAVAIL", "address not available"),           // WSAEADDRNOTAVAIL
    (10047, "EAFNOSUPPORT", "address family not supported"),     // WSAEAFNOSUPPORT
    (10035, "EAGAIN", "resource temporarily unavailable"),       // WSAEWOULDBLOCK
    (232, "EAGAIN", "resource temporarily unavailable"),         // ERROR_NO_DATA
    (10037, "EALREADY", "connection already in progress"),       // WSAEALREADY
    (1004, "EBADF", "bad file descriptor"),                      // ERROR_INVALID_FLAGS
    (6, "EBADF", "bad file descriptor"),                         // ERROR_INVALID_HANDLE
    (33, "EBUSY", "resource busy or locked"),                    // ERROR_LOCK_VIOLATION
    (231, "EBUSY", "resource busy or locked"),                   // ERROR_PIPE_BUSY
    (32, "EBUSY", "resource busy or locked"),                    // ERROR_SHARING_VIOLATION
    (995, "ECANCELED", "operation canceled"),                    // ERROR_OPERATION_ABORTED
    (10004, "ECANCELED", "operation canceled"),                  // WSAEINTR
    (1113, "ECHARSET", "invalid Unicode character"),             // ERROR_NO_UNICODE_TRANSLATION
    (1236, "ECONNABORTED", "software caused connection abort"),  // ERROR_CONNECTION_ABORTED
    (10053, "ECONNABORTED", "software caused connection abort"), // WSAECONNABORTED
    (1225, "ECONNREFUSED", "connection refused"),                // ERROR_CONNECTION_REFUSED
    (10061, "ECONNREFUSED", "connection refused"),               // WSAECONNREFUSED
    (64, "ECONNRESET", "connection reset by peer"),              // ERROR_NETNAME_DELETED
    (10054, "ECONNRESET", "connection reset by peer"),           // WSAECONNRESET
    (183, "EEXIST", "file already exists"),                      // ERROR_ALREADY_EXISTS
    (80, "EEXIST", "file already exists"),                       // ERROR_FILE_EXISTS
    (998, "EFAULT", "bad address in system call argument"),      // ERROR_NOACCESS
    (10014, "EFAULT", "bad address in system call argument"),    // WSAEFAULT
    (1232, "EHOSTUNREACH", "host is unreachable"),               // ERROR_HOST_UNREACHABLE
    (10065, "EHOSTUNREACH", "host is unreachable"),              // WSAEHOSTUNREACH
    (122, "EINVAL", "invalid argument"),                         // ERROR_INSUFFICIENT_BUFFER
    (13, "EINVAL", "invalid argument"),                          // ERROR_INVALID_DATA
    (87, "EINVAL", "invalid argument"),                          // ERROR_INVALID_PARAMETER
    (1464, "EINVAL", "invalid argument"),                        // ERROR_SYMLINK_NOT_SUPPORTED
    (10022, "EINVAL", "invalid argument"),                       // WSAEINVAL
    (10046, "EINVAL", "invalid argument"),                       // WSAEPFNOSUPPORT
    (1102, "EIO", "i/o error"),                                  // ERROR_BEGINNING_OF_MEDIA
    (1111, "EIO", "i/o error"),                                  // ERROR_BUS_RESET
    (23, "EIO", "i/o error"),                                    // ERROR_CRC
    (1166, "EIO", "i/o error"),                                  // ERROR_DEVICE_DOOR_OPEN
    (1165, "EIO", "i/o error"),                                  // ERROR_DEVICE_REQUIRES_CLEANING
    (1393, "EIO", "i/o error"),                                  // ERROR_DISK_CORRUPT
    (1129, "EIO", "i/o error"),                                  // ERROR_EOM_OVERFLOW
    (1101, "EIO", "i/o error"),                                  // ERROR_FILEMARK_DETECTED
    (31, "EIO", "i/o error"),                                    // ERROR_GEN_FAILURE
    (1106, "EIO", "i/o error"),                                  // ERROR_INVALID_BLOCK_LENGTH
    (1117, "EIO", "i/o error"),                                  // ERROR_IO_DEVICE
    (1104, "EIO", "i/o error"),                                  // ERROR_NO_DATA_DETECTED
    (205, "EIO", "i/o error"),                                   // ERROR_NO_SIGNAL_SENT
    (110, "EIO", "i/o error"),                                   // ERROR_OPEN_FAILED
    (1103, "EIO", "i/o error"),                                  // ERROR_SETMARK_DETECTED
    (156, "EIO", "i/o error"),                                   // ERROR_SIGNAL_REFUSED
    (10056, "EISCONN", "socket is already connected"),           // WSAEISCONN
    (1921, "ELOOP", "too many symbolic links encountered"),      // ERROR_CANT_RESOLVE_FILENAME
    (4, "EMFILE", "too many open files"),                        // ERROR_TOO_MANY_OPEN_FILES
    (10024, "EMFILE", "too many open files"),                    // WSAEMFILE
    (10040, "EMSGSIZE", "message too long"),                     // WSAEMSGSIZE
    (111, "ENAMETOOLONG", "name too long"),                      // ERROR_BUFFER_OVERFLOW
    (206, "ENAMETOOLONG", "name too long"),                      // ERROR_FILENAME_EXCED_RANGE
    (1231, "ENETUNREACH", "network is unreachable"),             // ERROR_NETWORK_UNREACHABLE
    (10051, "ENETUNREACH", "network is unreachable"),            // WSAENETUNREACH
    (10055, "ENOBUFS", "no buffer space available"),             // WSAENOBUFS
    (161, "ENOENT", "no such file or directory"),                // ERROR_BAD_PATHNAME
    (267, "ENOENT", "no such file or directory"),                // ERROR_DIRECTORY
    (203, "ENOENT", "no such file or directory"),                // ERROR_ENVVAR_NOT_FOUND
    (2, "ENOENT", "no such file or directory"),                  // ERROR_FILE_NOT_FOUND
    (123, "ENOENT", "no such file or directory"),                // ERROR_INVALID_NAME
    (15, "ENOENT", "no such file or directory"),                 // ERROR_INVALID_DRIVE
    (4392, "ENOENT", "no such file or directory"),               // ERROR_INVALID_REPARSE_DATA
    (126, "ENOENT", "no such file or directory"),                // ERROR_MOD_NOT_FOUND
    (3, "ENOENT", "no such file or directory"),                  // ERROR_PATH_NOT_FOUND
    (11001, "ENOENT", "no such file or directory"),              // WSAHOST_NOT_FOUND
    (11004, "ENOENT", "no such file or directory"),              // WSANO_DATA
    (8, "ENOMEM", "not enough memory"),                          // ERROR_NOT_ENOUGH_MEMORY
    (14, "ENOMEM", "not enough memory"),                         // ERROR_OUTOFMEMORY
    (82, "ENOSPC", "no space left on device"),                   // ERROR_CANNOT_MAKE
    (112, "ENOSPC", "no space left on device"),                  // ERROR_DISK_FULL
    (277, "ENOSPC", "no space left on device"),                  // ERROR_EA_TABLE_FULL
    (1100, "ENOSPC", "no space left on device"),                 // ERROR_END_OF_MEDIA
    (39, "ENOSPC", "no space left on device"),                   // ERROR_HANDLE_DISK_FULL
    (2250, "ENOTCONN", "socket is not connected"),               // ERROR_NOT_CONNECTED
    (10057, "ENOTCONN", "socket is not connected"),              // WSAENOTCONN
    (145, "ENOTEMPTY", "directory not empty"),                   // ERROR_DIR_NOT_EMPTY
    (10038, "ENOTSOCK", "socket operation on non-socket"),       // WSAENOTSOCK
    (50, "ENOTSUP", "operation not supported on socket"),        // ERROR_NOT_SUPPORTED
    (109, "EOF", "end of file"),                                 // ERROR_BROKEN_PIPE
    (5, "EPERM", "operation not permitted"),                     // ERROR_ACCESS_DENIED
    (1314, "EPERM", "operation not permitted"),                  // ERROR_PRIVILEGE_NOT_HELD
    (230, "EPIPE", "broken pipe"),                               // ERROR_BAD_PIPE
    (233, "EPIPE", "broken pipe"),                               // ERROR_PIPE_NOT_CONNECTED
    (10058, "EPIPE", "broken pipe"),                             // WSAESHUTDOWN
    (10043, "EPROTONOSUPPORT", "protocol not supported"),        // WSAEPROTONOSUPPORT
    (19, "EROFS", "read-only file system"),                      // ERROR_WRITE_PROTECT
    (121, "ETIMEDOUT", "connection timed out"),                  // ERROR_SEM_TIMEOUT
    (10060, "ETIMEDOUT", "connection timed out"),                // WSAETIMEDOUT
    (17, "EXDEV", "cross-device link not permitted"),            // ERROR_NOT_SAME_DEVICE
    (1, "EISDIR", "illegal operation on a directory"),           // ERROR_INVALID_FUNCTION
    (208, "E2BIG", "argument list too long"),                    // ERROR_META_EXPANSION_TOO_LONG
    (10044, "ESOCKTNOSUPPORT", "socket type not supported"),     // WSAESOCKTNOSUPPORT
    (193, "EFTYPE", "inappropriate file type or format"),        // ERROR_BAD_EXE_FORMAT
];
