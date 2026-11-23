// Codex adapter cases for a copy that keeps quitting as it starts: a default copy gives way to the next installed one,
// the user's own pick is kept and named when main gives up, and an answered start or a stop on purpose starts the count over.
import { test, assert, setup, wait, crash, inits, NO_REPLY } from './fixture.ts';
import { waitFor } from '../waitFor.ts';

const copy = (path: string) => ({ path, version: null, via: null, from: null });

/**
 * A scripted app-server whose copies are `copies` (in the order the default falls back through): the start runs the
 * current one, and one listed in `quits` exits before it answers initialize. `pinned`: the user picked the first.
 */
function copiesSetup(o: { copies: string[]; quits: Set<string>; pinned?: boolean }) {
  let using = o.copies[0];
  const asked: (string | null)[] = [];
  const codexCopies = {
    copyOf: (bin: string | null) => ({ copy: copy(bin ?? 'codex'), pinned: !!o.pinned }),
    fallBack: (bin: string | null) => {
      asked.push(bin);
      if (o.pinned) return null;
      const next = o.copies[o.copies.indexOf(bin as string) + 1];
      if (next) using = next;
      return next ? copy(next) : null;
    },
  };
  const s = setup({}, { backoff: [5, 10, 20], codexCopies });
  const server = s.server as any;
  server.start = () => {
    server.starts++;
    server.bin = using;
  };
  const send = server.send;
  server.send = (m: any) => {
    if (m.method === 'initialize' && o.quits.has(server.bin)) {
      server.sent.push(m);
      setImmediate(() => crash(server));
      return;
    }
    send(m);
  };
  /** Waits until the statuses so far end with `kind` (a fixed sleep can end too soon on a busy machine). */
  const until = async (kind: string) => {
    await waitFor(() => s.statuses.at(-1)?.kind === kind, `status ${kind}`).catch(() => undefined);
    assert.equal(s.statuses.at(-1)?.kind, kind, JSON.stringify(s.statuses));
  };
  return { ...s, server, asked, until, using: () => using };
}

export function registerCopyFallback() {
  test('a default copy that quits as it starts is tried once more, then gives way to the next installed copy, which windows hear', async () => {
    const t = copiesSetup({ copies: ['alpha', 'stable'], quits: new Set(['alpha']) });
    await assert.rejects(t.a.connect(), /exited/);
    await t.until('ready');
    assert.deepEqual(t.statuses, [
      // the first start's exit is restarted too: it ran and quit, so a binary is there
      { kind: 'exit', code: 1, signal: null, stderr: 'boom', copy: copy('alpha'), pinned: false, restarting: true },
      { kind: 'restarting', attempt: 1, inMs: 5 },
      { kind: 'exit', code: 1, signal: null, stderr: 'boom', copy: copy('alpha'), pinned: false, restarting: true },
      { kind: 'switched', from: copy('alpha'), to: copy('stable') },
      // the backoff starts over for the copy it moved to
      { kind: 'restarting', attempt: 1, inMs: 5 },
      { kind: 'ready' },
    ]);
    assert.deepEqual(t.asked, ['alpha']);
    assert.equal(t.server.bin, 'stable');
    // it came back: a later crash of it starts a new count (one restart that quits is not two in a row)
    crash(t.server);
    await t.until('ready');
    assert.deepEqual(t.asked, ['alpha'], 'a copy that answered is not set aside for one crash');
  });

  test("the user's own pick that keeps quitting is kept: after the backoff, main gives up naming it as theirs", async () => {
    const t = copiesSetup({ copies: ['mine', 'stable'], quits: new Set(['mine']), pinned: true });
    await assert.rejects(t.a.connect(), /exited/);
    await t.until('gaveUp');
    assert.deepEqual(t.statuses.at(-1), { kind: 'gaveUp', copy: copy('mine'), pinned: true });
    assert.equal(t.statuses.filter((s) => s.kind === 'switched').length, 0);
    assert.deepEqual(
      t.statuses.filter((s) => s.kind === 'restarting').map((s) => s.inMs),
      [5, 10, 20],
    );
    assert.equal(t.using(), 'mine');
    assert.equal(inits(t.server), 4);
    await wait(40);
    assert.equal(inits(t.server), 4, 'nothing runs after it gave up');
  });

  test('every installed copy quits as it starts: each is tried, then main gives up naming the last', async () => {
    const t = copiesSetup({ copies: ['alpha', 'beta'], quits: new Set(['alpha', 'beta']) });
    await assert.rejects(t.a.connect(), /exited/);
    await t.until('gaveUp');
    assert.deepEqual(t.asked.slice(0, 2), ['alpha', 'beta']);
    assert.deepEqual(
      t.statuses.filter((s) => s.kind === 'switched'),
      [{ kind: 'switched', from: copy('alpha'), to: copy('beta') }],
    );
    assert.deepEqual(t.statuses.at(-1), { kind: 'gaveUp', copy: copy('beta'), pinned: false });
  });

  test('a stop on purpose (Restart, a new pick) starts the count of failed starts over', async () => {
    const t = copiesSetup({ copies: ['alpha', 'stable'], quits: new Set(['alpha']) });
    await assert.rejects(t.a.connect(), /exited/);
    assert.equal(t.a.failedStarts, 1);
    t.server.emit({ kind: 'stopped' });
    assert.equal(t.a.failedStarts, 0);
    assert.equal(t.a.restartTimer, null, 'the restart it had scheduled is called off');
    // the next start that quits is the first again: restarted, not switched
    await assert.rejects(t.a.connect(), /exited/);
    assert.deepEqual(t.statuses.at(-1), { kind: 'restarting', attempt: 1, inMs: 5 });
    assert.deepEqual(t.asked, []);
    t.server.emit({ kind: 'stopped' });
  });

  test('without installed copies to move between (no codexCopies), a copy that keeps quitting is only restarted', async () => {
    // initialize is never answered: each exit is one before it answered
    const { a, server, statuses } = setup({ initialize: NO_REPLY }, { backoff: [5] });
    const quit = () => server.emit({ kind: 'exit', code: 1, signal: null, stderr: 'boom' });
    a.connect().catch(() => undefined);
    quit();
    await waitFor(() => inits(server) >= 2, 'a second init');
    quit();
    assert.equal(statuses.filter((s) => s.kind === 'switched').length, 0);
    assert.deepEqual(statuses.at(-1), { kind: 'gaveUp', copy: copy('codex'), pinned: false });
  });

  test('a copy that could not be run at all (no process) is left down the first time, and said by its error alone', async () => {
    const t = copiesSetup({ copies: ['alpha', 'stable'], quits: new Set() });
    t.server.proc = null;
    t.server.bin = 'alpha';
    t.server.emit({ kind: 'error', error: 'spawn alpha EACCES' });
    await wait(20);
    // not "keeps quitting": a Codex that is not installed reads as such (ENOENT)
    assert.deepEqual(t.statuses, [{ kind: 'error', error: 'spawn alpha EACCES', restarting: false }]);
    assert.equal(t.a.failedStarts, 1, 'it still counts as a start that failed');
  });
}
