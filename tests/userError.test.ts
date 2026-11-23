// shared/userError.mjs: a failure as one short sentence a person reads, never a system code, a network error code, an
// exit code, a stack or a path (#1863).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userError, errorText, describeError, UNKNOWN_ERROR } from '../shared/userError.mjs';
import { createRequire } from 'node:module';
const { missingFolderError } = createRequire(import.meta.url)('../electron/session/chatFolderGuard.cjs');

test('system codes, from the error or its text, read as sentences', () => {
  for (const [error, line] of [
    [Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }), 'File or program not found.'],
    ['spawn opencode ENOENT · stderr line', 'File or program not found.'],
    [new Error("EACCES: permission denied, open '/Users/me/.codex/config.toml.tmp'"), 'Permission denied.'],
    [Object.assign(new Error('operation not permitted'), { code: 'EPERM' }), 'Permission denied.'],
    [new Error('connect ECONNREFUSED 192.168.1.20:47321'), "Couldn't connect."],
    [new Error('read ECONNRESET'), 'The connection was lost.'],
    [new Error('connect ETIMEDOUT 10.0.0.1:443'), 'The connection timed out.'],
    [new Error('getaddrinfo ENOTFOUND example.com'), "Couldn't reach the server."],
    [new Error('ENOSPC: no space left on device, write'), 'The disk is full.'],
  ] as const)
    assert.equal(userError(error), line, String(error));
});

test('network errors and exit codes read as sentences', () => {
  assert.equal(userError(new Error('net::ERR_INTERNET_DISCONNECTED')), "You're offline.");
  assert.equal(userError('net::ERR_NAME_NOT_RESOLVED (-105)'), "Couldn't reach the server.");
  assert.equal(userError('net::ERR_CONNECTION_REFUSED'), "Couldn't connect.");
  assert.equal(userError('net::ERR_TIMED_OUT'), 'The connection timed out.');
  assert.equal(userError('net::ERR_CERT_AUTHORITY_INVALID'), 'Network error.');
  assert.equal(userError('Codex app-server exited (101).\npanic'), 'It quit unexpectedly.');
  assert.equal(userError('npm exited with code 243', { who: 'npm' }), 'npm quit unexpectedly.');
  assert.equal(userError('exit code 1'), 'It quit unexpectedly.');
  assert.equal(userError('Claude Code process exited with signal SIGKILL', { who: 'Claude Code' }), 'Claude Code quit unexpectedly.');
});

test('anything else reads as its first sentence, without the IPC wrapper, a stack or paths', () => {
  assert.equal(userError(new Error("Error invoking remote method 'x': Error: Not signed in. Run login")), 'Not signed in. Run login.');
  // a long line keeps only its first sentence
  assert.equal(userError(`The request failed. ${'x '.repeat(80)}`), 'The request failed.');
  assert.equal(userError('y'.repeat(130)), `${'Y'}${'y'.repeat(129)}.`);
  assert.equal(userError(new Error('Bad config\n    at f (/Users/me/app.js:1:2)')), 'Bad config.');
  assert.equal(userError('Could not write /Users/me/.codex/config.toml, try again'), 'Could not write, try again.');
  assert.equal(userError("Can't open '/tmp/a b/c': busy"), "Can't open: busy.");
  assert.equal(userError({ code: -32600, message: 'thread not found' }), 'Thread not found.');
  assert.equal(userError('Version 1.2.3 is required!'), 'Version 1.2.3 is required!');
  assert.equal(userError("EISDIR: illegal operation on a directory, open '/x'"), 'Illegal operation on a directory.');
  assert.equal(userError(new Error('EBUSY')), 'The file is in use.');
  assert.equal(userError(new Error('EWHATEVER')), UNKNOWN_ERROR);
  assert.equal(
    userError('Update check failed: https://mopilot.ai/feed answered 500'),
    'Update check failed: https://mopilot.ai/feed answered 500.',
  );
});

test('nothing readable falls back, and a hostile error never throws', () => {
  for (const error of [null, undefined, '', 0, '/Users/me/x', '   ', '--'] as unknown[])
    assert.equal(userError(error), UNKNOWN_ERROR, String(error));
  assert.equal(userError(null, { fallback: 'Install failed.' }), 'Install failed.');
  const hostile = {
    get code() {
      throw new Error('no');
    },
    toString() {
      throw new Error('no');
    },
  };
  assert.equal(userError(hostile), 'Unprintable error.');
  assert.equal(describeError(hostile), 'unprintable error');
  assert.equal(errorText(Object.assign(new Error('x'), { code: 5 })), 'x');
});

test('path removal preserves possessives and contractions around an unquoted folder', () => {
  const raw =
    "This chat's folder no longer exists: /Users/me/.mopilot/worktrees/abcd/repo. Its worktree couldn't be restored: The project folder is gone. Restore the folder, or continue in a new chat.";
  assert.equal(userError(raw), "This chat's folder no longer exists.");
  assert.equal(userError("This chat's folder is '/tmp/a b/c', and it couldn't open."), "This chat's folder is, and it couldn't open.");
  assert.equal(
    userError(raw.replace('/Users/me/.mopilot/worktrees/abcd/repo', "/tmp/O'Brien/repo")),
    "This chat's folder no longer exists.",
  );
  assert.equal(userError("Can't open '/tmp/O'Brien/repo': busy"), "Can't open: busy.");
  assert.equal(userError('Can\'t open "/tmp/O\'Brien/repo": busy'), "Can't open: busy.");
  for (const folder of ['/tmp/my repo/project', "/tmp/O'Brien/repo", '/tmp/a "quoted" repo/project', '/tmp/new\nline/repo']) {
    assert.equal(userError(missingFolderError(folder, 'The project folder is gone')), "This chat's folder no longer exists.");
  }
});
