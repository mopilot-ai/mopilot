// MoMo's sources hub (#2139 P2, electron/momo/sources/hub.cjs): state encrypted and owner-only, connect date as the floor, levels, disconnect deleting MoMo's copies, and the read gate: connected, not Blocked, decide(call) with private: true, an audit entry for every outcome, fail closed without decide, audit or encryption, and nothing returned for a source disconnected mid-read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hubFixture, fakeSafe, scratch, marked } from './support/momo-sources.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { SourcesHub, SourceError, dayStart } = require('../electron/momo/sources/hub.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const codeOf = (code: string) => (e: any) => e instanceof SourceError && e.code === code;
const read =
  (count = 2) =>
  async () => ({ count, rows: ['x'] });
const call = (source = 'calendar') => ({ source, action: `${source}.read`, chatId: 'momo-main', summary: 'events this week' });

test('needs an absolute folder; unknown sources are refused', () => {
  assert.throws(() => new SourcesHub({ dir: 'rel', safeStorage: fakeSafe() }), /absolute/);
  const { hub } = hubFixture();
  assert.throws(() => hub.connect('mail'), codeOf('unknown'));
  assert.throws(() => hub.disconnect('mail'), codeOf('unknown'));
  assert.throws(() => hub.copyDir('mail'), codeOf('unknown'));
  return assert.rejects(hub.read(call('mail'), read()), codeOf('unknown'));
});

test('connect stores the source encrypted, owner-only, Read only, with the connect time; Files starts with no folders', () => {
  const { hub, dir } = hubFixture();
  const changed: number[] = [];
  hub.on('changed', () => changed.push(1));
  assert.deepEqual(
    hub.list().map((s: any) => [s.id, s.connected]),
    [
      ['calendar', false],
      ['reminders', false],
      ['files', false],
    ],
  );
  assert.equal(hub.connect('calendar'), true);
  assert.equal(hub.connect('calendar'), true, 'connecting again keeps the first connect date');
  assert.equal(hub.connect('files'), true);
  assert.equal(changed.length, 2);
  const file = path.join(dir, 'sources', 'state.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('calendar'), false, 'nothing readable on disk');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, 'sources')).mode & 0o777, 0o700);
  const t = new Date(2026, 9, 23, 15, 30).getTime();
  assert.deepEqual(hub.get('calendar'), { connectedAt: t, level: 'read' });
  assert.deepEqual(hub.list()[2], { id: 'files', label: 'Files', connected: true, connectedAt: t, level: 'read', folders: [] });
  assert.equal(hub.floor('calendar'), new Date(2026, 9, 23).getTime());
  assert.equal(dayStart(t), new Date(2026, 9, 23).getTime());
  // a second hub on the same folder reads the same state back
  const again = new SourcesHub({ dir, safeStorage: hub.safe });
  assert.equal(again.get('calendar').level, 'read');
});

test('without encryption nothing is connected, listed or read, and connect refuses', async () => {
  const { hub, safe } = hubFixture();
  hub.connect('calendar');
  safe.available = false;
  assert.equal(hub.available(), false);
  assert.equal(hub.get('calendar'), null);
  assert.equal(hub.list()[0].connected, false);
  assert.throws(() => hub.connect('reminders'), codeOf('unavailable'));
  assert.throws(() => hub.setLevel('calendar', 'ask'), codeOf('unavailable'));
  await assert.rejects(hub.read(call(), read()), codeOf('not_connected'));
  const throwing = new SourcesHub({
    dir: scratch(),
    safeStorage: {
      isEncryptionAvailable: () => {
        throw new Error('x');
      },
    } as any,
  });
  assert.equal(throwing.available(), false);
  assert.equal(new SourcesHub({ dir: scratch(), safeStorage: null }).available(), false);
  // the probe passes but encrypting fails: the write is refused, nothing is stored
  safe.available = true;
  safe.failEncrypt = true;
  assert.throws(() => hub.connect('reminders'), codeOf('unavailable'));
});

test('a state that cannot be decrypted, or holds junk, reads as nothing connected', () => {
  const { hub, dir, safe } = hubFixture();
  hub.connect('calendar');
  const file = path.join(dir, 'sources', 'state.json');
  fs.writeFileSync(file, 'bm90IGVuY3J5cHRlZA==');
  const fresh = () => new SourcesHub({ dir, safeStorage: safe });
  assert.equal(fresh().get('calendar'), null);
  assert.ok(recentIgnored().some((x: any) => x.context === "decrypt MoMo's sources state"));
  // a state that can't be read at all (a folder in its place) is recorded too, and reads as nothing connected
  const odd = hubFixture();
  fs.mkdirSync(path.join(odd.dir, 'sources', 'state.json'), { recursive: true });
  assert.equal(odd.hub.get('calendar'), null);
  assert.ok(recentIgnored().some((x: any) => x.context === "read MoMo's sources state" && /EISDIR/.test(x.message)));
  const seal = (v: unknown) => safe.encryptString(JSON.stringify(v)).toString('base64');
  fs.writeFileSync(file, seal([1, 2]));
  assert.equal(fresh().get('calendar'), null);
  fs.writeFileSync(
    file,
    seal({
      calendar: { connectedAt: 1, level: 'read' },
      reminders: { connectedAt: 'x', level: 'read' },
      files: { connectedAt: 1, level: 'read', folders: [3] },
      mail: { connectedAt: 1, level: 'read' },
      notes: null,
    }),
  );
  assert.deepEqual(
    fresh()
      .list()
      .map((s: any) => s.connected),
    [true, false, false],
  );
  fs.writeFileSync(file, seal({ calendar: { connectedAt: 1, level: 'write' } }));
  assert.equal(fresh().get('calendar'), null);
});

test('levels and folders change only a connected source', () => {
  const { hub } = hubFixture();
  assert.throws(() => hub.setLevel('calendar', 'read'), codeOf('not_connected'));
  assert.throws(() => hub.floor('calendar'), codeOf('not_connected'));
  assert.throws(() => hub.floor('mail'), codeOf('not_connected'));
  hub.connect('calendar');
  assert.throws(() => hub.setLevel('calendar', 'write'), codeOf('bad_args'));
  hub.setLevel('calendar', 'blocked');
  assert.equal(hub.get('calendar').level, 'blocked');
  hub.connect('files');
  hub.setFolders(['/a', '/b', '/a']);
  assert.deepEqual(hub.get('files').folders, ['/a', '/b']);
});

test('disconnect forgets the source and deletes MoMo copies, even without encryption', () => {
  const { hub, dir, safe } = hubFixture();
  hub.connect('calendar');
  const copies = hub.copyDir('calendar');
  assert.equal(copies, path.join(dir, 'sources', 'calendar'));
  assert.equal(fs.statSync(copies).mode & 0o777, 0o700);
  fs.writeFileSync(path.join(copies, 'cache.json'), 'x');
  const before = hub.epoch('calendar');
  hub.disconnect('calendar');
  assert.equal(fs.existsSync(copies), false);
  assert.equal(hub.get('calendar'), null);
  assert.ok(hub.epoch('calendar') > before);
  hub.disconnect('calendar'); // nothing left: no error
  hub.connect('reminders');
  fs.mkdirSync(hub.copyDir('reminders'), { recursive: true });
  safe.available = false;
  // the copies go, but the state can't change without encryption: it says so instead of seeming disconnected
  assert.throws(
    () => hub.disconnect('reminders'),
    (e: any) => codeOf('unavailable')(e) && /copies of Reminders were deleted/.test(e.message),
  );
  assert.equal(fs.existsSync(path.join(dir, 'sources', 'reminders')), false);
});

test('a connect that waited while the source was disconnected or connected again is void', () => {
  const { hub } = hubFixture();
  const epoch = hub.epoch('calendar');
  hub.disconnect('calendar');
  assert.equal(hub.connect('calendar', { epoch }), false);
  assert.equal(hub.get('calendar'), null);
  assert.equal(hub.connect('calendar', { epoch: hub.epoch('calendar') }), true);
});

test('a read goes through decide with the level and private: true, then is audited with its count', async () => {
  const { hub, decided, audited } = hubFixture();
  await assert.rejects(hub.read(call(), read()), codeOf('not_connected'));
  assert.deepEqual([audited[0].decision, audited[0].reason], ['refused', 'not_connected'], 'refused, and audited');
  audited.length = 0;
  hub.connect('calendar');
  hub.setLevel('calendar', 'ask');
  assert.deepEqual(await hub.read(call(), read(2)), { count: 2, rows: ['x'] });
  assert.deepEqual(decided, [{ kind: 'source.read', ...call(), level: 'ask', private: true }]);
  assert.deepEqual(audited, [
    {
      at: new Date(2026, 9, 23, 15, 30).getTime(),
      action: 'calendar.read',
      source: 'calendar',
      chatId: 'momo-main',
      summary: 'events this week',
      decision: 'allowed',
      result: 'done',
      count: 2,
      private: true,
    },
  ]);
});

test('a chat’s scope (a routine’s run) reads only its sources: another is refused and audited before anything is asked', async () => {
  const { hub, decided, audited } = hubFixture();
  hub.connect('calendar');
  const scopes: Record<string, any> = {
    'run-cal': { sources: ['calendar', 'files'], name: 'Morning briefing' },
    'run-none': { sources: [], name: 'Quiet' },
    'run-gone': { sources: [], name: null },
  };
  hub.setScope((chatId: string) => scopes[chatId] ?? null);
  assert.deepEqual(await hub.read({ ...call(), chatId: 'run-cal' }, read(1)), { count: 1, rows: ['x'] });
  assert.deepEqual(await hub.read(call(), read(1)), { count: 1, rows: ['x'] }, 'no scope: any source');
  audited.length = 0;
  decided.length = 0;
  const refused = (chatId: string, message: RegExp) =>
    assert.rejects(hub.read({ ...call(), chatId, source: 'reminders', action: 'reminders.read' }, read()), (e: any) => {
      assert.equal(e.code, 'refused');
      assert.match(e.message, message);
      return true;
    });
  await refused(
    'run-cal',
    /^The routine “Morning briefing” reads only Calendar, Files: Reminders isn't one of them\. The user can add it by editing the routine in Settings › MoMo › Routines\.$/,
  );
  await refused('run-none', /^The routine “Quiet” reads no sources: Reminders isn't one of them/);
  await refused('run-gone', /^This routine was removed, so it reads no sources\.$/);
  assert.deepEqual(decided, [], 'nothing is asked');
  assert.deepEqual(
    audited.map((a: any) => [a.chatId, a.decision, a.reason]),
    [
      ['run-cal', 'refused', 'outside_routine'],
      ['run-none', 'refused', 'outside_routine'],
      ['run-gone', 'refused', 'outside_routine'],
    ],
  );
});

test('a routine edited or removed while its read waited (an approval card) or ran: nothing goes back, and it is audited', async () => {
  let scope: any = { sources: ['calendar'], name: 'Morning briefing' };
  // the scope is read at each check, and may be async
  const edited = hubFixture({
    allow: () => {
      scope = { sources: ['files'], name: 'Morning briefing' };
      return { allow: true };
    },
  });
  edited.hub.connect('calendar');
  edited.hub.setScope(async () => scope);
  await assert.rejects(edited.hub.read({ ...call(), chatId: 'run' }, read()), /reads only Files: Calendar isn't one of them/);
  assert.deepEqual(
    edited.audited.map((a: any) => [a.decision, a.result, a.reason]),
    [['allowed', 'refused', 'outside_routine']],
  );
  // removed while the read ran: what was read is dropped
  scope = { sources: ['calendar'], name: 'Morning briefing' };
  const during = hubFixture();
  during.hub.connect('calendar');
  during.hub.setScope(() => scope);
  await assert.rejects(
    during.hub.read({ ...call(), chatId: 'run' }, async () => {
      scope = { sources: [], name: null };
      return { count: 1, rows: ['x'] };
    }),
    /This routine was removed/,
  );
  assert.deepEqual(during.audited.at(-1).reason, 'outside_routine');
});

test('Blocked, a refusal, a throwing decide and no decide are all refused and audited', async () => {
  const blocked = hubFixture();
  blocked.hub.connect('calendar');
  blocked.hub.setLevel('calendar', 'blocked');
  await assert.rejects(blocked.hub.read(call(), read()), codeOf('blocked'));
  assert.equal(blocked.decided.length, 0);
  assert.equal(blocked.audited[0].reason, 'blocked');

  const refused = hubFixture({ allow: false });
  refused.hub.connect('calendar');
  let ran = false;
  await assert.rejects(
    refused.hub.read(call(), async () => ((ran = true), { count: 1 })),
    (e: any) => codeOf('refused')(e) && /denied by the user/.test(e.message),
  );
  assert.equal(ran, false);
  assert.deepEqual([refused.audited[0].decision, refused.audited[0].result], ['refused', 'refused']);

  const bare = hubFixture({ allow: () => ({ allow: false }) });
  bare.hub.connect('calendar');
  await assert.rejects(bare.hub.read(call(), read()), (e: any) => e.message === 'Reading Calendar was refused');

  const odd = hubFixture({ allow: () => null });
  odd.hub.connect('calendar');
  await assert.rejects(odd.hub.read(call(), read()), codeOf('refused'));

  const throwing = hubFixture({ decide: () => Promise.reject(new Error('sentinel down')) });
  throwing.hub.connect('calendar');
  await assert.rejects(
    throwing.hub.read(call(), read()),
    (e: any) => e.message === 'Reading Calendar was refused: the access check failed',
  );
  assert.ok(recentIgnored().some((x: any) => x.context === 'decide on a calendar.read read' && /sentinel down/.test(x.message)));

  const nonError = hubFixture({ decide: () => Promise.reject('plain') });
  nonError.hub.connect('calendar');
  await assert.rejects(nonError.hub.read(call(), read()), /the access check failed/);

  const none = hubFixture({ decide: null });
  none.hub.connect('calendar');
  await assert.rejects(none.hub.read(call(), read()), /the access check failed/);
});

test('no audit log, or one that fails, means nothing is read or returned', async () => {
  const none = hubFixture({ audit: null });
  none.hub.connect('calendar');
  await assert.rejects(none.hub.read(call(), read()), (e: any) => codeOf('refused')(e) && /no audit log/.test(e.message));
  const failing = hubFixture({ audit: { append: async () => Promise.reject(new Error('disk full')) } });
  failing.hub.connect('calendar');
  await assert.rejects(failing.hub.read(call(), read()), /disk full/);
});

test('a failed read is audited as failed with its code; a disconnect mid-read returns nothing', async () => {
  const { hub, audited } = hubFixture();
  hub.connect('calendar');
  await assert.rejects(
    hub.read(call(), async () => {
      throw new SourceError('macOS said no', 'not_granted');
    }),
    codeOf('not_granted'),
  );
  assert.deepEqual([audited[0].decision, audited[0].result, audited[0].reason], ['allowed', 'failed', 'not_granted']);
  await assert.rejects(
    hub.read(call(), async () => {
      hub.disconnect('calendar');
      return { count: 3 };
    }),
    (e: any) => codeOf('not_connected')(e) && /nothing was kept/.test(e.message),
  );
  assert.deepEqual([audited[1].result, audited[1].reason], ['refused', 'disconnected']);
});

test('a source Blocked or disconnected while decide waited (an approval card) reads nothing', async () => {
  let release: ((v: any) => void) | null = null;
  const waiting = hubFixture({ decide: () => new Promise((r) => (release = r)) });
  // until the read is at its decision (the card is up), however many steps come before it
  const atDecision = async () => {
    await waitFor(() => release, 'the read to reach its decision');
    const r = release!;
    release = null;
    return r;
  };
  waiting.hub.connect('calendar');
  let ran = false;
  const blocked = waiting.hub.read(call(), async () => ((ran = true), { count: 1 }));
  const first = await atDecision();
  waiting.hub.setLevel('calendar', 'blocked');
  first({ allow: true });
  await assert.rejects(blocked, codeOf('blocked'));
  assert.equal(ran, false);
  assert.deepEqual(
    [waiting.audited.at(-1).decision, waiting.audited.at(-1).result, waiting.audited.at(-1).reason],
    ['allowed', 'refused', 'blocked'],
  );

  waiting.hub.setLevel('calendar', 'read');
  const gone = waiting.hub.read(call(), async () => ((ran = true), { count: 1 }));
  const second = await atDecision();
  waiting.hub.disconnect('calendar');
  waiting.hub.connect('calendar');
  second({ allow: true });
  await assert.rejects(gone, codeOf('not_connected'));
  assert.equal(ran, false, 'a disconnect and connect while it waited voids it too');
  assert.equal(waiting.audited.at(-1).reason, 'disconnected');
});

test('while MoMo is not allowed nothing connects or reads (audited), but disconnect still deletes the copies', async () => {
  const { hub, flags, audited, decided, dir } = hubFixture();
  hub.connect('calendar');
  fs.writeFileSync(path.join(hub.copyDir('calendar'), 'copy.json'), '{}');
  flags.allowed = false;
  assert.throws(() => hub.assertCanConnect(), codeOf('not_allowed'));
  assert.throws(() => hub.connect('reminders'), codeOf('not_allowed'));
  await assert.rejects(hub.read(call(), read()), codeOf('not_allowed'));
  assert.deepEqual([audited[0].result, audited[0].reason], ['refused', 'not_allowed']);
  assert.equal(decided.length, 0);
  hub.disconnect('calendar');
  assert.equal(fs.existsSync(path.join(dir, 'sources', 'calendar')), false);
  flags.allowed = true;
  assert.equal(hub.get('calendar'), null);
  // without an allowed() at all, nothing connects
  const bare = new SourcesHub({ dir: scratch(), safeStorage: fakeSafe() });
  assert.throws(() => bare.connect('files'), codeOf('not_allowed'));
});

test('removing a Files folder voids reads running for it; adding one does not', () => {
  const { hub } = hubFixture();
  assert.throws(() => hub.setFolders(['/a']), codeOf('not_connected'));
  hub.connect('files');
  const e0 = hub.epoch('files');
  hub.setFolders(['/a', '/b']);
  assert.equal(hub.epoch('files'), e0, 'adding');
  hub.setFolders(['/a']);
  assert.ok(hub.epoch('files') > e0, 'removing');
});

test('Reset (#2291): every source is let go, its folder deleted and reads begun before return nothing; connecting again works', async () => {
  const { hub, dir } = hubFixture();
  const changed: number[] = [];
  hub.on('changed', () => changed.push(1));
  hub.connect('calendar');
  hub.connect('files');
  const copies = hub.copyDir('calendar');
  fs.writeFileSync(path.join(copies, 'events.bin'), 'x');
  const before = hub.epoch('calendar');
  hub.reset();
  assert.equal(fs.existsSync(path.join(dir, 'sources')), false);
  assert.deepEqual(
    hub.list().filter((s: any) => s.connected),
    [],
    'nothing is connected, though the state was cached',
  );
  assert.ok(hub.epoch('calendar') > before && hub.epoch('reminders') > 0, 'work begun before is void');
  assert.equal(changed.length, 3, 'Settings reads it again');
  assert.equal(hub.connect('calendar'), true);
  assert.equal((await hub.read(call(), read(3))).count, 3, 'a read right after, without a restart');
  hub.reset();
  hub.reset();
});

test('a read macOS refuses (not_granted) marks a connected source as needing the grant; a read that works, a connect or a disconnect clears it', async () => {
  const { hub } = hubFixture();
  hub.connect('calendar');
  hub.connect('files');
  const changed: number[] = [];
  hub.on('changed', () => changed.push(1));
  assert.equal(marked(hub, 'calendar'), false);
  assert.equal(hub.list()[0].needsGrant, undefined, 'a granted source says nothing');
  const refused = async () => {
    throw new SourceError('Calendar access isn’t granted', 'not_granted');
  };
  await assert.rejects(hub.read(call(), refused), codeOf('not_granted'));
  assert.equal(marked(hub, 'calendar'), true);
  assert.equal(hub.get('calendar').level, 'read', 'it stays connected: only the grant is missing');
  assert.deepEqual(
    hub.list().map((s: any) => [s.id, s.connected, s.needsGrant]),
    [
      ['calendar', true, true],
      ['reminders', false, undefined],
      ['files', true, undefined],
    ],
  );
  assert.equal(changed.length, 1);
  // refused again: nothing new to tell the windows
  await assert.rejects(hub.read(call(), refused), codeOf('not_granted'));
  assert.equal(changed.length, 1);
  // another failure is not about the grant
  await assert.rejects(
    hub.read(call(), async () => {
      throw new SourceError('boom', 'failed');
    }),
    codeOf('failed'),
  );
  assert.equal(marked(hub, 'calendar'), true);
  // a read that works proves the grant is back
  await hub.read(call(), read());
  assert.equal(marked(hub, 'calendar'), false);
  assert.equal(changed.length, 2);
  // connecting a connected source whose grant came back clears it too, and says so
  await assert.rejects(hub.read(call(), refused), codeOf('not_granted'));
  assert.equal(hub.connect('calendar'), true);
  assert.equal(marked(hub, 'calendar'), false);
  assert.equal(changed.length, 4);
  // a disconnect forgets the mark; the grant is not the hub's to remember for a source that is gone
  await assert.rejects(hub.read(call(), refused), codeOf('not_granted'));
  hub.disconnect('calendar');
  assert.equal(marked(hub, 'calendar'), false);
  hub.connect('calendar');
  assert.equal(hub.list()[0].needsGrant, undefined);
  // Reset MoMo forgets every mark
  await assert.rejects(hub.read(call(), refused), codeOf('not_granted'));
  hub.reset();
  assert.equal(marked(hub, 'calendar'), false);
});

test('marking the grant works for a source that is not connected only as nothing: no mark, no change', () => {
  const { hub } = hubFixture();
  const changed: number[] = [];
  hub.on('changed', () => changed.push(1));
  hub.markUngranted('reminders');
  hub.markGranted('reminders');
  assert.equal(marked(hub, 'reminders'), false);
  assert.deepEqual(changed, []);
  assert.equal(hub.ready('reminders'), false);
  hub.connect('reminders');
  assert.equal(hub.ready('reminders'), true);
  hub.markUngranted('reminders');
  assert.equal(hub.ready('reminders'), false, 'connected, but the grant is missing');
});
