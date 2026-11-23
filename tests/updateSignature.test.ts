// electron/updates/signature.cjs: which bundle codesign reads, what its report means, and how the updater reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { appBundleOf, bundleTeam, developerIdTeamOf, signatureReader } = createRequire(import.meta.url)('../electron/updates/signature.cjs');

const APP = '/Applications/MoPilot.app';
const RELEASE = 'Authority=Developer ID Application: MoPilot LLC (7392DG77JZ)\nTeamIdentifier=7392DG77JZ\n';
/** A fake execFile that answers codesign with this exit error and report, and records what it was asked. */
const codesign = (err: Error | null, report: string, seen: string[][] = []) =>
  Object.assign((cmd: string, args: string[], _o: unknown, cb: Function) => (seen.push([cmd, ...args]), cb(err, '', report)), { seen });

test('the bundle is the nearest .app that holds the executable, wherever the app is installed', () => {
  assert.equal(appBundleOf(`${APP}/Contents/MacOS/MoPilot`), APP);
  assert.equal(appBundleOf('/Users/a b/Downloads/MoPilot.app/Contents/MacOS/MoPilot'), '/Users/a b/Downloads/MoPilot.app');
  assert.equal(
    appBundleOf(`${APP}/Contents/Frameworks/MoPilot Helper.app/Contents/MacOS/MoPilot Helper`),
    `${APP}/Contents/Frameworks/MoPilot Helper.app`,
  );
  // /Applications is a folder of apps, not one
  assert.equal(appBundleOf('/Applications/MoPilot'), null);
  assert.equal(appBundleOf('/usr/local/bin/node'), null);
});

test('codesign reads the app bundle, never the folder it is installed in', async () => {
  const run = codesign(null, RELEASE);
  assert.equal(await bundleTeam({ execPath: `${APP}/Contents/MacOS/MoPilot`, run }), '7392DG77JZ');
  assert.deepEqual(run.seen, [['codesign', '-dvv', APP]]);
});

test('an unsigned bundle has no team; a bundle codesign could not read rejects with why', async () => {
  const execPath = `${APP}/Contents/MacOS/MoPilot`;
  const failed = Object.assign(new Error('Command failed: codesign'), { code: 1 });
  assert.equal(await bundleTeam({ execPath, run: codesign(failed, `${APP}: code object is not signed at all\n`) }), null);
  await assert.rejects(
    bundleTeam({ execPath, run: codesign(failed, '/Applications: bundle format unrecognized, invalid, or unsuitable\n') }),
    /codesign couldn't read \/Applications\/MoPilot\.app: \/Applications: bundle format unrecognized/,
  );
  // a timeout kills codesign before it writes anything
  const killed = Object.assign(new Error('Command failed: codesign -dvv'), { killed: true, signal: 'SIGTERM' });
  await assert.rejects(bundleTeam({ execPath, run: codesign(killed, '') }), /: Command failed: codesign -dvv$/);
  const run = codesign(null, RELEASE);
  await assert.rejects(bundleTeam({ execPath: '/usr/local/bin/node', run }), /\/usr\/local\/bin\/node is not inside an app bundle/);
  assert.deepEqual(run.seen, []);
});

test('only a Developer ID Application leaf certificate has a team Squirrel can update', () => {
  assert.equal(developerIdTeamOf(RELEASE), '7392DG77JZ');
  assert.equal(developerIdTeamOf('Authority=Developer ID Application: X (T)\nTeamIdentifier=not set\n'), null);
  assert.equal(developerIdTeamOf('Authority=Apple Development: Dev (29RC33CGL6)\nTeamIdentifier=TEAM123456\n'), null);
  assert.equal(developerIdTeamOf('Signature=adhoc\nTeamIdentifier=not set\n'), null);
});

test('the reader keeps a signed or unsigned answer and asks codesign again after one it could not read', async () => {
  const answers: Array<() => Promise<string | null>> = [
    async () => {
      throw new Error('timed out');
    },
    async () => 'TEAM',
  ];
  let reads = 0;
  const notes: unknown[][] = [];
  const read = signatureReader(
    () => answers[reads++](),
    (...args: unknown[]) => notes.push(args),
  );
  const unread = await read();
  assert.equal(unread?.status, 'error');
  assert.deepEqual(
    notes.map(([context, error]) => [context, (error as Error).message]),
    [['read the app signature for updates', 'timed out']],
  );
  assert.match(String(unread?.error), /^Couldn't read MoPilot's signature\. Check for updates to try again\.$/);
  assert.equal(await read(), null);
  assert.equal(await read(), null);
  assert.equal(reads, 2);

  let unsignedReads = 0;
  const unsigned = signatureReader(
    async () => (unsignedReads++, null),
    () => assert.fail('an unsigned answer is not an error'),
  );
  assert.deepEqual(await unsigned(), { status: 'unsupported' });
  assert.deepEqual(await unsigned(), { status: 'unsupported' });
  assert.equal(unsignedReads, 1);
});

test('two reads while codesign runs share its one answer', async () => {
  let reads = 0;
  let finish!: (team: string) => void;
  const read = signatureReader(
    () => (reads++, new Promise<string>((r) => (finish = r))),
    () => {},
  );
  const both = Promise.all([read(), read()]);
  await new Promise((r) => setImmediate(r));
  finish('TEAM');
  assert.deepEqual(await both, [null, null]);
  assert.equal(reads, 1);
});

test('the reader asks codesign about the running app by default', async () => {
  // node itself runs these tests from no app bundle, so codesign is never started
  const notes: unknown[] = [];
  const unread = await signatureReader(undefined, (_context: string, error: unknown) => notes.push(error))();
  assert.equal(unread?.status, 'error');
  assert.match(String(notes[0]), /is not inside an app bundle/);
});

test('a reader that throws instead of rejecting is an unread signature, read again next time', async () => {
  let reads = 0;
  const notes: unknown[] = [];
  const read = signatureReader(
    () => {
      if (++reads === 1) throw new Error('bad options');
      return Promise.resolve('TEAM');
    },
    (_context: string, error: unknown) => notes.push(error),
  );
  assert.equal((await read())?.status, 'error');
  assert.match(String(notes[0]), /bad options/);
  assert.equal(await read(), null);
});
