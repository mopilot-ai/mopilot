// Account switch rollback must not retire a later selected account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sub, flush } from './support/electron-accounts.ts';

test('an older failed switch does not roll back the newer queued account selection', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] } });
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, no) => {
    reject = no;
  });
  const applied: string[] = [];
  a.applyNow = async () => {
    applied.push(a.state.active);
    if (applied.length === 1) await pending;
    return a.view();
  };
  const first = a.switchTo('b');
  const rejected = assert.rejects(first, /first switch failed/);
  await flush();
  const second = a.switchTo('c');
  reject(new Error('first switch failed'));
  await rejected;
  await second;
  assert.deepEqual(applied, ['b', 'c']);
  assert.equal(a.state.active, 'c');
});

for (const outcomes of [
  [false, false],
  [true, false],
  [true, true],
  [false, false, true],
]) {
  test(`queued switch outcomes ${outcomes.join('/')} use the last settled selection`, async (t) => {
    const { a } = setup(t, { state: { accounts: [sub('b'), sub('c'), sub('d')] } });
    const applied: string[] = [];
    a.applyNow = async () => {
      const index = applied.length;
      applied.push(a.state.active);
      if (!outcomes[index]) throw new Error('apply failed');
      return a.view();
    };
    const ids = ['b', 'c', 'd'].slice(0, outcomes.length);
    const results = await Promise.allSettled(ids.map((id) => a.switchTo(id)));
    assert.deepEqual(
      results.map((r) => r.status === 'fulfilled'),
      outcomes,
    );
    assert.deepEqual(applied, ids);
    assert.equal(a.state.active, ids.filter((_id, i) => outcomes[i]).at(-1) ?? 'default');
    assert.equal(a.pendingApply, false);
  });
}

for (const change of ['removed', 'replaced', 'removing', 'expired']) {
  test(`a queued target that is ${change} is rejected before application`, async (t) => {
    const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] } });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const applied: string[] = [];
    a.applyNow = async () => {
      applied.push(a.state.active);
      await pending;
    };
    const first = a.switchTo('b');
    await flush();
    const second = a.switchTo('c');
    const rejected = assert.rejects(second, change === 'expired' ? /Sign in/ : /Unknown account/);
    if (change === 'removed') a.state.accounts = a.state.accounts.filter((x: any) => x.id !== 'c');
    if (change === 'replaced') a.state.accounts = a.state.accounts.map((x: any) => (x.id === 'c' ? { ...x } : x));
    if (change === 'removing') a.removing.set('c', Promise.resolve());
    if (change === 'expired') a.get('c').status = 'expired';
    finish();
    await first;
    await rejected;
    assert.deepEqual(applied, ['b']);
    assert.equal(a.state.active, 'b');
    assert.equal(a.pendingApply, false);
  });
}

for (const change of ['other-selection', 'target-replaced', 'prior-removed', 'prior-removing', 'no-prior', 'null-prior']) {
  test(`failed application preserves current selection ownership: ${change}`, async (t) => {
    const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] } });
    if (change === 'null-prior') a.state.active = null;
    if (change === 'no-prior') a.state.active = 'missing';
    a.applyNow = async () => {
      if (change === 'other-selection') a.state.active = 'c';
      if (change === 'target-replaced') a.state.accounts = a.state.accounts.map((x: any) => (x.id === 'b' ? { ...x } : x));
      if (change === 'prior-removed') a.state.accounts = a.state.accounts.filter((x: any) => x.id !== 'default');
      if (change === 'prior-removing') a.removing.set('default', Promise.resolve());
      throw new Error('apply failed');
    };
    await assert.rejects(a.switchTo('b'), /apply failed/);
    if (change === 'other-selection' || change.startsWith('prior-')) assert.equal(a.state.active, 'c');
    if (change === 'target-replaced') assert.equal(a.state.active, 'b');
    if (change === 'null-prior') assert.equal(a.state.active, null);
    if (change === 'no-prior') assert.equal(a.state.active, 'default');
    assert.equal(a.pendingApply, false);
  });
}

test('a replaced prior record is not restored as the previous selection', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] } });
  a.applyNow = async () => {
    // An unrelated key reuses the old id; rollback must not silently select its different billing lane.
    a.state.accounts = a.state.accounts.map((account: any) =>
      account.id === 'default' ? { id: 'default', kind: 'apiKey', status: 'ok' } : account,
    );
    throw new Error('apply failed');
  };
  await assert.rejects(a.switchTo('b'), /apply failed/);
  assert.equal(a.state.active, 'c');
});

test('rollback leaves no selection when the previous account is gone and there is no fallback', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] } });
  a.applyNow = async () => {
    a.state.accounts = a.state.accounts.filter((x: any) => x.id !== 'default');
    throw new Error('apply failed');
  };
  await assert.rejects(a.switchTo('b'), /apply failed/);
  assert.equal(a.state.active, null);
});

test('plain apply and repeated same-id switches share one queue without deadlocking', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b'), sub('c')] } });
  const applied: string[] = [];
  a.applyNow = async () => {
    applied.push(a.state.active);
    if (applied.length === 1) throw new Error('first failed');
  };
  const first = assert.rejects(a.switchTo('b'), /first failed/);
  const plain = a.apply();
  const same = a.switchTo('b');
  const third = a.switchTo('c');
  await Promise.all([first, plain, same, third]);
  assert.deepEqual(applied, ['b', 'default', 'b', 'c']);
  assert.equal(a.state.active, 'c');
  assert.equal(a.pendingApply, false);
});

test('unknown account rejection leaves the application queue usable', async (t) => {
  const { a } = setup(t, { state: { accounts: [sub('b')] } });
  a.applyNow = async () => {};
  await assert.rejects(a.switchTo('missing'), /Unknown account/);
  await a.switchTo('b');
  assert.equal(a.state.active, 'b');
});
