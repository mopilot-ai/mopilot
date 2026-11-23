// The names Windows' system errors take in libuv, which Node's spawn and the Rust core's (coreChild.cjs) give a harness spawn's failure.

/**
 * The names Windows' errors take in libuv (uv_translate_sys_error, src/win/error.c), for what a harness spawn or write can
 * hit: the rows of libuv's that CreateProcessW, a handle or a pipe can give (not its socket and device ones). A name a
 * spawn gets wrong reads as "spawn UNKNOWN": a quoted path (Explorer's Copy as path) is 123, a file that is no program 193
 * (EFTYPE, as Node's spawn says). 109 and 232 are a write's, which libuv names EPIPE (uv_translate_write_sys_error).
 */
const WINDOWS_ERRORS = {
  1: 'EISDIR', // ERROR_INVALID_FUNCTION
  2: 'ENOENT', // ERROR_FILE_NOT_FOUND
  3: 'ENOENT', // ERROR_PATH_NOT_FOUND
  4: 'EMFILE', // ERROR_TOO_MANY_OPEN_FILES
  5: 'EPERM', // ERROR_ACCESS_DENIED
  6: 'EBADF', // ERROR_INVALID_HANDLE
  8: 'ENOMEM', // ERROR_NOT_ENOUGH_MEMORY
  14: 'ENOMEM', // ERROR_OUTOFMEMORY
  15: 'ENOENT', // ERROR_INVALID_DRIVE
  32: 'EBUSY', // ERROR_SHARING_VIOLATION
  33: 'EBUSY', // ERROR_LOCK_VIOLATION
  50: 'ENOTSUP', // ERROR_NOT_SUPPORTED
  87: 'EINVAL', // ERROR_INVALID_PARAMETER
  109: 'EPIPE', // ERROR_BROKEN_PIPE, on a write
  111: 'ENAMETOOLONG', // ERROR_BUFFER_OVERFLOW
  123: 'ENOENT', // ERROR_INVALID_NAME
  126: 'ENOENT', // ERROR_MOD_NOT_FOUND
  161: 'ENOENT', // ERROR_BAD_PATHNAME
  193: 'EFTYPE', // ERROR_BAD_EXE_FORMAT
  203: 'ENOENT', // ERROR_ENVVAR_NOT_FOUND
  206: 'ENAMETOOLONG', // ERROR_FILENAME_EXCED_RANGE
  208: 'E2BIG', // ERROR_META_EXPANSION_TOO_LONG
  230: 'EPIPE', // ERROR_BAD_PIPE
  231: 'EBUSY', // ERROR_PIPE_BUSY
  232: 'EPIPE', // ERROR_NO_DATA, on a write
  233: 'EPIPE', // ERROR_PIPE_NOT_CONNECTED
  267: 'ENOENT', // ERROR_DIRECTORY
  740: 'EACCES', // ERROR_ELEVATION_REQUIRED
  998: 'EFAULT', // ERROR_NOACCESS
  1004: 'EBADF', // ERROR_INVALID_FLAGS
  1314: 'EPERM', // ERROR_PRIVILEGE_NOT_HELD
  1920: 'EACCES', // ERROR_CANT_ACCESS_FILE
  1921: 'ELOOP', // ERROR_CANT_RESOLVE_FILENAME
  4392: 'ENOENT', // ERROR_INVALID_REPARSE_DATA
};

module.exports = { WINDOWS_ERRORS };
