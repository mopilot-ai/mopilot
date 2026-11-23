// Windows' system errors take libuv's names (electron/platform/windowsErrors.cjs), the ones Node's spawn gives: a spawn the
// Rust core makes fails with the same code, and none that a spawn, a handle or a pipe can hit reads as UNKNOWN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { errorName } = require('../electron/platform/coreChild.cjs');

test("libuv's rows for what a spawn, a handle or a pipe can hit", () => {
  // the rest of libuv's rows a spawn can hit (src/win/error.c): a quoted path from Explorer's Copy as path is 123
  const libuv: [number, string][] = [
    [1, 'EISDIR'],
    [6, 'EBADF'],
    [33, 'EBUSY'],
    [230, 'EPIPE'],
    [231, 'EBUSY'],
    [233, 'EPIPE'],
    [998, 'EFAULT'],
    [1004, 'EBADF'],
    [4, 'EMFILE'],
    [14, 'ENOMEM'],
    [15, 'ENOENT'],
    [32, 'EBUSY'],
    [50, 'ENOTSUP'],
    [87, 'EINVAL'],
    [111, 'ENAMETOOLONG'],
    [123, 'ENOENT'],
    [126, 'ENOENT'],
    [161, 'ENOENT'],
    [203, 'ENOENT'],
    [206, 'ENAMETOOLONG'],
    [208, 'E2BIG'],
    [740, 'EACCES'],
    [1314, 'EPERM'],
    [1920, 'EACCES'],
    [1921, 'ELOOP'],
    [4392, 'ENOENT'],
  ];
  for (const [code, name] of libuv) assert.equal(errorName(code, 'win32'), name, String(code));
});
