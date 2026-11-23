// Saved-login FIFO ownership across key-button IPC and in-page assist, using only synthetic in-memory boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { deferred } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { fillLogin } = require('../electron/capabilities/browser/userFill.cjs');
const { register } = require('../electron/app/ipc/browserLogins.cjs');
const { createLoginAssist } = require('../electron/capabilities/browser/loginAssist.cjs');
const tick = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
function fixture(options: any = {}) {
  const wc: any = new EventEmitter();
  let focus = '',
    destroyed = false;
  const values: Record<string, string> = {};
  const writes: string[] = [],
    gets: string[] = [];
  const approvals: any[] = options.approvals || [];
  let confirms = 0,
    prefix = '';
  Object.assign(wc, {
    id: 7,
    session: {},
    getURL: () => 'https://synthetic.example/login',
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: async (_world: any, [{ code }]: any) => {
      const step = /const step = "(probe|username|password)"/.exec(code)?.[1];
      if (!step) {
        prefix = /console.log\("([^"]+)"/.exec(code)?.[1] || '';
        return;
      }
      if (step === 'probe') return { username: true, password: true };
      focus = step;
      return true;
    },
    insertText: async (value: string) => {
      writes.push(value);
      values[focus] = value;
      await options.insert?.(value);
    },
  });
  const store = {
    list: () => ['A', 'B', 'C'].map((id) => ({ id })),
    get: (id: string) => {
      gets.push(id);
      return options.lookup ? options.lookup(id) : { username: `user-${id}`, password: `password-${id}` };
    },
  };
  const confirm = async () => {
    const approval = approvals[confirms++];
    return approval ? approval.promise : true;
  };
  const run = (id: string) => fillLogin({ wc, store, id, confirm });
  const handlers: any = {};
  register(
    {
      handle: (name: string, fn: any) => {
        handlers[name] = fn;
      },
    },
    {
      store: () => store,
      assist: () => ({}),
      webContents: { fromId: () => wc },
      panelSessions: () => [wc.session],
      confirm,
    },
  );
  const ipc = (id: string) => handlers['browser:fillLogin']({}, wc.id, id);
  const notices: any[] = [];
  const assist = createLoginAssist({
    store: () => store,
    confirm,
    isAgent: () => false,
    notify: (_wc: any, detail: any) => notices.push(detail),
  });
  const attach = () => {
    assist.attach(wc);
    wc.emit('dom-ready');
  };
  const pick = (id: string) => wc.emit('console-message', { message: `${prefix}fill:${id}` });
  const retire = (destroy = false) => {
    if (destroy) {
      destroyed = true;
      wc.emit('destroyed');
    } else wc.emit('did-start-navigation', { isMainFrame: true });
  };
  return { wc, run, ipc, attach, pick, values, writes, gets, notices, retire, confirms: () => confirms };
}

test('key-button IPC and assist share one indivisible FIFO fill sequence', async () => {
  const hold = deferred();
  const f = fixture({ insert: (value: string) => (value === 'user-A' ? hold.promise : undefined) });
  f.attach();
  const a = f.ipc('A');
  await tick();
  f.pick('B');
  await tick();
  assert.equal(f.confirms(), 2, 'both explicit requests retain their own approval');
  assert.deepEqual(f.writes, ['user-A'], 'B must not interleave with A');
  hold.resolve();
  assert.equal(await a, 'filled');
  await tick();
  assert.deepEqual(f.writes, ['user-A', 'password-A', 'user-B', 'password-B']);
  assert.deepEqual(f.values, { username: 'user-B', password: 'password-B' });
  assert.deepEqual(f.notices, []);
});

for (const order of [
  [0, 1],
  [1, 0],
]) {
  test(`independent approvals resolved ${order.join(',')} serialize in approval order`, async () => {
    const approvals = [deferred(), deferred()];
    const f = fixture({ approvals });
    const a = f.run('A'),
      b = f.run('B');
    await tick();
    assert.equal(f.confirms(), 2);
    approvals[order[0]].resolve(true);
    await tick();
    assert.deepEqual(
      f.writes,
      [`user-${order[0] === 0 ? 'A' : 'B'}`, `password-${order[0] === 0 ? 'A' : 'B'}`],
      'an unanswered approval cannot block an approved request',
    );
    approvals[order[1]].resolve(true);
    assert.deepEqual(await Promise.all([a, b]), ['filled', 'filled']);
    assert.deepEqual(
      f.writes,
      order.flatMap((i) => [`user-${i === 0 ? 'A' : 'B'}`, `password-${i === 0 ? 'A' : 'B'}`]),
    );
  });
}

for (const outcome of ['reject', 'cancel']) {
  test(`a first-request ${outcome} releases the next independently approved fill`, async () => {
    const first = deferred();
    const f = fixture({ approvals: [first] });
    const a = f.run('A'),
      b = f.run('B');
    await tick();
    if (outcome === 'reject') first.reject(new Error('synthetic approval failure'));
    else first.resolve(outcome !== 'cancel');
    assert.equal(await a, outcome === 'cancel' ? 'cancelled' : 'failed');
    assert.equal(await b, 'filled');
    assert.deepEqual(f.values, { username: 'user-B', password: 'password-B' });
  });
}

test('active insertion rejection releases both approved followers in FIFO order', async () => {
  const hold = deferred();
  const f = fixture({ insert: (v: string) => (v === 'user-A' ? hold.promise : undefined) });
  const a = f.run('A');
  await tick();
  const b = f.run('B'),
    c = f.run('C');
  await tick();
  assert.deepEqual(f.writes, ['user-A']);
  hold.reject(new Error('synthetic insertion failure'));
  assert.deepEqual(await Promise.all([a, b, c]), ['failed', 'filled', 'filled']);
  assert.deepEqual(f.writes, ['user-A', 'user-B', 'password-B', 'user-C', 'password-C']);
  assert.deepEqual(f.values, { username: 'user-C', password: 'password-C' });
});

for (const destroy of [false, true]) {
  test(`retirement (${destroy ? 'destroy' : 'navigation'}) settles active unanswered and queued requests promptly`, async () => {
    const first = deferred(),
      second = deferred();
    const f = fixture({ approvals: [first, second] });
    const a = f.run('A'),
      b = f.run('B');
    await tick();
    f.retire(destroy);
    assert.deepEqual(await Promise.all([a, b]), ['origin_changed', 'origin_changed']);
    assert.deepEqual(f.writes, []);
    assert.equal(f.wc.listenerCount('did-start-navigation'), 0);
    assert.equal(f.wc.listenerCount('destroyed'), 0);
    if (!destroy) {
      assert.equal(await f.run('C'), 'filled');
      assert.deepEqual(f.writes, ['user-C', 'password-C']);
    }
    first.resolve(true);
    second.reject(new Error('late obsolete rejection'));
    await tick();
    assert.equal(f.gets.includes('A') || f.gets.includes('B'), false);
  });
}

test('retired queued request cannot fill a replacement or clear its pending queue on late rejection', async () => {
  const hold = deferred(),
    replacement = deferred();
  const f = fixture({
    insert: (value: string) => (value === 'user-A' ? hold.promise : value === 'user-C' ? replacement.promise : undefined),
  });
  const a = f.run('A');
  await tick();
  const b = f.run('B');
  await tick();
  assert.deepEqual(f.writes, ['user-A']);
  f.retire();
  assert.deepEqual(await Promise.all([a, b]), ['origin_changed', 'origin_changed']);
  const c = f.run('C');
  await tick();
  hold.reject(new Error('synthetic obsolete acknowledgment'));
  await tick();
  const next = f.run('B');
  await tick();
  assert.deepEqual(f.writes, ['user-A', 'user-C']);
  replacement.resolve();
  assert.deepEqual(await Promise.all([c, next]), ['filled', 'filled']);
  assert.deepEqual(f.writes, ['user-A', 'user-C', 'password-C', 'user-B', 'password-B']);
  assert.equal(f.wc.listenerCount('did-start-navigation'), 0);
  assert.equal(f.wc.listenerCount('destroyed'), 0);
});

test('declined approval cannot let a later fill leapfrog an active writer', async () => {
  const hold = deferred(),
    cancel = deferred();
  const f = fixture({ approvals: [undefined, cancel], insert: (v: string) => (v === 'user-A' ? hold.promise : undefined) });
  const a = f.run('A');
  await tick();
  const b = f.run('B');
  await tick();
  cancel.resolve(false);
  assert.equal(await b, 'cancelled');
  const c = f.run('C');
  await tick();
  assert.deepEqual(f.writes, ['user-A']);
  hold.resolve();
  assert.deepEqual(await Promise.all([a, c]), ['filled', 'filled']);
  assert.deepEqual(f.writes, ['user-A', 'password-A', 'user-C', 'password-C']);
});

test('distinct webContents objects with the same numeric id do not block each other', async () => {
  const hold = deferred();
  const f = fixture({ insert: (v: string) => (v === 'user-A' ? hold.promise : undefined) }),
    g = fixture();
  const a = f.run('A');
  await tick();
  assert.equal(await g.run('B'), 'filled');
  assert.deepEqual(f.writes, ['user-A']);
  f.retire();
  assert.equal(await a, 'origin_changed');
  hold.resolve(true);
  await tick();
});

for (const removed of [true, false]) {
  test(`queued login is read at slot acquisition (${removed ? 'deleted' : 'updated'})`, async () => {
    const hold = deferred();
    let changed = false;
    const f = fixture({
      insert: (v: string) => (v === 'user-A' ? hold.promise : undefined),
      lookup: (id: string) =>
        id === 'B' && changed
          ? removed
            ? null
            : { username: 'updated-user-B', password: 'updated-password-B' }
          : { username: `user-${id}`, password: `password-${id}` },
    });
    const a = f.run('A');
    await tick();
    const b = f.run('B');
    await tick();
    assert.deepEqual(f.gets, ['A']);
    changed = true;
    hold.resolve();
    assert.deepEqual(await Promise.all([a, b]), ['filled', removed ? 'not_found' : 'filled']);
    assert.deepEqual(f.writes, removed ? ['user-A', 'password-A'] : ['user-A', 'password-A', 'updated-user-B', 'updated-password-B']);
    assert.equal(await f.run('C'), 'filled', 'a missing queued login must not strand later requests');
  });
}
