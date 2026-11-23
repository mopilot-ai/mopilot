// scripts/notary.mjs with every command replaced: retry, notarytool's verdict, notarizing the packaged app and
// stapling tickets, tried again with a growing wait while Apple's ticket service fails; a rejected app is never stapled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { recorder } from './support/scripts-shared-cli.ts';
import { accepted } from './support/release-fixtures.ts';

const notary = await import('../scripts/notary.mjs');

const app = '/out/MoPilot-darwin-x64/MoPilot.app';
const auth = ['--key', 'k', '--key-id', 'kid', '--issuer', 'iss'];
// what stapler printed in releases 0.3.39 and 0.3.42 when CloudKit dropped the connection
const dropped = 'Command failed: xcrun stapler staple: The staple and validate action failed! Error 68.';

function run(exec: (cmd: string, args: string[]) => unknown) {
  const calls = recorder(exec);
  const log = recorder();
  const sleep = recorder();
  const fsx = { mkdtempSync: recorder(() => '/tmp/mopilot-notarize-1'), rmSync: recorder() };
  const done = () => notary.notarizeApp(app, auth, { exec: calls, log, sleep, fsx: fsx as any });
  const commands = () => calls.calls.map((c) => [c[0], ...c[1].slice(0, 2)].join(' '));
  return { calls, log, sleep, fsx, done, commands };
}

// release 0.3.39's DMG: the ticket service failed five times over two and a half minutes, which outlasted 5 tries 30 s apart
test("notarizeApp: the app's staple outlasts a ticket-service outage of several minutes, waiting longer each time", () => {
  let failures = 5;
  const r = run((cmd, args) => {
    if (cmd === 'xcrun' && args[1] === 'staple' && failures-- > 0) throw new Error(dropped);
    return accepted(cmd, args);
  });
  r.done();
  assert.deepEqual(r.commands(), [
    `codesign --verify --deep`,
    `ditto -c -k`,
    `xcrun notarytool submit`,
    ...Array(6).fill(`xcrun stapler staple`),
  ]);
  const zip = '/tmp/mopilot-notarize-1/MoPilot.zip';
  assert.deepEqual(r.calls.calls[0][1], ['--verify', '--deep', '--strict', app]);
  assert.deepEqual(r.calls.calls[1][1], ['-c', '-k', '--keepParent', app, zip]);
  assert.deepEqual(r.calls.calls[2][1], ['notarytool', 'submit', zip, ...auth, '--wait', '--timeout', '2h', '--output-format', 'json']);
  // `stapler staple` validates what it stapled; no separate `stapler validate` call can fail after it
  assert.deepEqual(r.calls.calls.at(-1)?.[1], ['stapler', 'staple', app]);
  assert.deepEqual(r.sleep.calls, [[30_000], [60_000], [120_000], [240_000], [300_000]]);
  assert.ok(r.log.calls.some((c) => c[0] === `Failed (attempt 1 of 8): ${dropped}; trying again in 30 s`));
  assert.ok(r.log.calls.some((c) => c[0] === `Failed (attempt 5 of 8): ${dropped}; trying again in 300 s`));
  // the zip's folder is removed once Apple has the app
  assert.deepEqual(r.fsx.rmSync.calls, [['/tmp/mopilot-notarize-1', { recursive: true, force: true }]]);
});

test('notarizeApp: stapling gives up after 8 tries, about 22 minutes, with the last failure', () => {
  const r = run((cmd, args) => {
    if (cmd === 'xcrun' && args[1] === 'staple') throw new Error(dropped);
    return accepted(cmd, args);
  });
  assert.throws(r.done, (e: Error) => e.message === dropped);
  assert.equal(r.commands().filter((c) => c === 'xcrun stapler staple').length, 8);
  assert.deepEqual(r.sleep.calls.flat(), [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  assert.equal(
    r.sleep.calls.flat().reduce((a: number, b: number) => a + b, 0),
    1_350_000,
  );
});

test('notarizeApp: a rejected app is not stapled, and the zip is still removed', () => {
  const r = run((cmd, args) => {
    if (cmd === 'xcrun' && args[1] === 'submit') return '{"id":"s1","status":"Invalid"}';
    if (cmd === 'xcrun' && args[1] === 'log') return 'not signed';
    return undefined;
  });
  assert.throws(r.done, /^Error: Notarizing MoPilot\.zip ended Invalid\nnot signed$/);
  assert.ok(!r.commands().some((c) => c.startsWith('xcrun stapler')));
  assert.equal(r.fsx.rmSync.calls.length, 1);
});

test('notarizeApp: a badly signed app fails before anything is zipped or sent to Apple', () => {
  const r = run((cmd) => {
    if (cmd === 'codesign') throw new Error('Command failed: codesign --verify: a sealed resource is missing or invalid');
  });
  assert.throws(r.done, /a sealed resource is missing or invalid/);
  assert.deepEqual(r.commands(), ['codesign --verify --deep']);
  assert.deepEqual(r.fsx.mkdtempSync.calls, []);
});

test("checkTicket: the ticket check is tried again while Apple's ticket service fails", () => {
  let failures = 1;
  const exec = recorder(() => {
    if (failures-- > 0) throw new Error('Command failed: xcrun stapler validate');
  });
  const sleep = recorder();
  notary.checkTicket(app, { exec, log: () => {}, sleep });
  assert.deepEqual(exec.calls, [
    ['xcrun', ['stapler', 'validate', app], { stdio: 'inherit' }],
    ['xcrun', ['stapler', 'validate', app], { stdio: 'inherit' }],
  ]);
  assert.deepEqual(sleep.calls, [[30_000]]);
});

test('notarizeApp: by default the zip goes in a new folder under the system temporary folder', () => {
  const exec = recorder((cmd: string, args: string[]) => accepted(cmd, args));
  notary.notarizeApp(app, auth, { exec, log: () => {}, sleep: () => {} });
  const zip = exec.calls[1][1][4];
  assert.match(path.basename(path.dirname(zip)), /^mopilot-notarize-/);
});

test('retry: a busy hdiutil is tried again, 5 seconds apart, and the last failure is thrown', () => {
  const log = recorder();
  const sleep = recorder();
  let n = 0;
  assert.equal(
    notary.retry(
      5,
      () =>
        ++n < 3
          ? (() => {
              throw new Error('Resource busy');
            })()
          : 'ok',
      { log, sleep },
    ),
    'ok',
  );
  assert.equal(n, 3);
  assert.deepEqual(sleep.calls, [[5000], [5000]]);
  assert.equal(log.calls[0][0], 'Failed (attempt 1 of 5): Resource busy; trying again in 5 s');
  n = 0;
  assert.throws(
    () =>
      notary.retry(
        2,
        () => {
          n++;
          throw new Error(`busy ${n}`);
        },
        { log, sleep },
      ),
    /^Error: busy 2$/,
  );
  assert.equal(sleep.calls.length, 3);
  // the real sleep blocks for about as long as asked
  const t0 = Date.now();
  assert.equal(notary.sleepSync(20), 'timed-out');
  assert.ok(Date.now() - t0 >= 15);
});

test("notarize: Apple's verdict decides, and a rejection carries Apple's log", () => {
  const auth = ['--key', 'k', '--key-id', 'kid', '--issuer', 'iss'];
  const log = recorder();
  assert.equal(notary.notarize('/o/a.dmg', auth, { exec: () => '{"id":"s1","status":"Accepted"}', log }), 's1');
  assert.deepEqual(log.calls[0].slice(0, 2), ['$', 'xcrun']);
  // Invalid, reported with a non-zero exit and the result on stdout: the log is fetched
  const exec = recorder((_c: string, args: string[]) => {
    if (args[1] === 'submit')
      throw Object.assign(new Error('exit 1'), { stdout: '{"id":"s2","status":"Invalid","message":"Processing complete"}' });
    return '{"issues":[{"message":"The binary is not signed."}]}';
  });
  assert.throws(
    () => notary.notarize('/o/a.dmg', auth, { exec, log }),
    (e: Error) => e.message === 'Notarizing a.dmg ended Invalid: Processing complete\n{"issues":[{"message":"The binary is not signed."}]}',
  );
  assert.deepEqual(exec.calls[1][1], ['notarytool', 'log', 's2', ...auth]);
  // the log itself can't be fetched
  const noLog = (_c: string, args: string[]) => {
    if (args[1] === 'submit') return '{"id":"s3","status":"Rejected"}';
    throw new Error('network down');
  };
  assert.throws(
    () => notary.notarize('/o/a.dmg', auth, { exec: noLog, log }),
    /^Error: Notarizing a\.dmg ended Rejected\n\(Apple's log could not be fetched: network down\)$/,
  );
  // no id and no status
  assert.throws(() => notary.notarize('/o/a.dmg', auth, { exec: () => '{}', log }), /^Error: Notarizing a\.dmg ended without a verdict$/);
  // not JSON, or a failure with nothing on stdout
  assert.throws(
    () => notary.notarize('/o/a.dmg', auth, { exec: () => 'Error: HTTP 401\n', log }),
    /notarytool returned no result for a\.dmg: Error: HTTP 401$/,
  );
  assert.throws(
    () =>
      notary.notarize('/o/a.dmg', auth, {
        exec: () => {
          throw new Error('xcrun missing');
        },
        log,
      }),
    /xcrun missing/,
  );
});
