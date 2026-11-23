// Adding a Mac nobody is signed in on (#3593): launchd has no GUI domain and refuses the agent in the background one ("Bootstrap failed: 5"), so starting it says so in words (shared/host/launchd.mjs) and the Add machine card asks for a sign-in there, pointing at Keep running after restart (shared/host/installFailure.mjs); a signed-in Mac's own failure, or a later command after it, is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { NO_GUI_SESSION, launchdStart } from '../shared/host/launchd.mjs';
import { DAEMON_PLIST } from '../shared/host/launchDaemon.mjs';
import { explainFailure } from '../shared/host/installFailure.mjs';

/** Runs the start command with a fake launchctl: `gui` says whether the GUI domain exists; bootstrap fails as macOS 26 does without one. */
function start(gui: boolean, daemon = false) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'no-gui-'));
  fs.writeFileSync(
    path.join(bin, 'launchctl'),
    `#!/bin/sh\ncase "$1 $2" in\n  "print gui/"*) ${gui ? 'exit 0' : 'exit 113'};;\n  print*) exit 113;;\n  bootstrap*) echo "Bootstrap failed: 5: Input/output error" >&2; exit 5;;\n  *) exit 0;;\nesac\n`,
    { mode: 0o755 },
  );
  const plist = path.join(bin, 'daemon.plist');
  if (daemon) fs.writeFileSync(plist, 'fixture');
  for (const [name, body] of Object.entries({ id: 'echo 501', pkill: 'echo fake-restart', sleep: 'exit 0' }))
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Redirect the filesystem probe and isolate every executable, including process signals.
  const command = launchdStart('/x.plist').replaceAll(DAEMON_PLIST, plist);
  // the command is part of a longer line (startAtBoot.cjs adds a fallback after it): a failure must not leave the shell
  const r = spawnSync('/bin/sh', ['-c', `${command} || echo failed-and-went-on`], {
    env: { PATH: bin },
    encoding: 'utf8',
  });
  fs.rmSync(bin, { recursive: true, force: true });
  return r;
}

test('with nobody signed in, starting the agent says so and fails without leaving the shell', () => {
  const r = start(false);
  assert.match(r.stderr, /Bootstrap failed: 5/);
  assert.ok(r.stderr.includes(NO_GUI_SESSION));
  assert.match(r.stdout, /failed-and-went-on/);
});

test('a signed-in Mac whose start fails keeps launchd’s own words only', () => {
  const r = start(true);
  assert.ok(!r.stderr.includes(NO_GUI_SESSION));
  assert.match(r.stdout, /failed-and-went-on/);
});

test('the Add machine card offers to start it before anyone signs in, and says why that failed', () => {
  const output = `Bootstrap failed: 5: Input/output error\n${NO_GUI_SESSION}`;
  const daemon = { kind: 'daemon', label: 'Enter password' };
  assert.deepEqual(explainFailure({ step: 'start', output, target: 'mini', destination: 'me@mini' }), {
    title: 'Nobody is signed in on mini',
    reason: 'An administrator password lets it start anyway.',
    action: daemon,
    cause: 'other',
  });
  assert.deepEqual(explainFailure({ step: 'daemon', output: 'That password didn’t work.', target: 'mini', destination: 'me@mini' }), {
    title: 'Couldn’t keep mini running without sign-in',
    reason: 'That password didn’t work.',
    action: daemon,
    cause: 'other',
  });
  // launchd's words alone, or the same words at another step, keep the general reason
  assert.equal(
    explainFailure({ step: 'start', output: 'Bootstrap failed: 5', target: 'mini', destination: 'me@mini' }).title,
    'MoPilot installed but didn’t start on mini',
  );
  assert.equal(
    explainFailure({ step: 'status', output, target: 'mini', destination: 'me@mini' }).title,
    'MoPilot installed but didn’t start on mini',
  );
});

test('a present daemon only invokes the isolated signal stub', () => {
  const r = start(false, true);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), 'fake-restart');
  assert.equal(r.stderr, '');
});
