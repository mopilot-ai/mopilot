// Electron IPC identity unit cases with the shared fake main harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calls, ready } from './fixture';

export function registerIdentityCases() {
  test('accounts IPC goes to the accounts store', async () => {
    const h = await ready();
    const acc = h.one('Accounts');
    acc.view = () => 'view';
    assert.equal(await h.invoke('accounts:list'), 'view');
    acc.apply = async () => 'applied';
    assert.equal(await h.invoke('accounts:apply'), 'applied');
    acc.apply = async () => {
      throw new Error('x');
    };
    assert.equal(await h.invoke('accounts:apply'), 'view');
    await h.invoke('accounts:switch', 1);
    await h.invoke('accounts:login', 2);
    await h.invoke('accounts:login', '');
    await h.invoke('accounts:cancelLogin');
    await h.invoke('accounts:addApiKey', 'k', 'u', 'r');
    await h.invoke('accounts:addApiKey', null, undefined, '');
    await h.invoke('accounts:setMode', 3);
    await h.invoke('accounts:remove', 4);
    await h.invoke('accounts:refreshUsage', 'now');
    await h.invoke('accounts:refreshUsage', 60);
    await h.invoke('accounts:setAutoSwitch', 1);
    await h.invoke('accounts:setPool', 5);
    await h.invoke('accounts:pinChat', 6, 7);
    await h.invoke('accounts:pinChat', 6, null);
    assert.deepEqual(calls(acc.switchTo), [['1']]);
    assert.deepEqual(calls(acc.startLogin), [['2'], [null]]);
    assert.equal(acc.cancelLogin.mock.callCount(), 1);
    assert.deepEqual(calls(acc.addApiKey), [
      ['k', 'u', 'r'],
      ['', '', null],
    ]);
    assert.deepEqual(calls(acc.setMode), [['3']]);
    assert.deepEqual(calls(acc.remove), [['4']]);
    assert.deepEqual(calls(acc.refreshUsage), [
      [undefined, 'now'],
      [undefined, 'surface'],
    ]);
    assert.deepEqual(calls(acc.setAutoSwitch), [[true]]);
    assert.deepEqual(calls(acc.setPool), [['5']]);
    assert.deepEqual(calls(acc.pinChat), [
      ['6', '7'],
      ['6', null],
    ]);
  });
}

export function registerResetCardsCases() {
  test('reset cards: the handlers reach the account manager with the selected account and card, and return failures as values', async () => {
    // registerIpc runs outside registerCodex: the module-scope handle() must serve it (a ReferenceError kept the window from opening)
    const h = await ready();
    const accounts = h.one('Accounts');
    const seen: any[] = [];
    let fail: any = null;
    accounts.resetCredits = async (...args: any[]) => (seen.push(['read', ...args]), 'cards');
    accounts.consumeResetCredit = async (...args: any[]) => {
      seen.push(['consume', ...args]);
      if (fail) throw fail;
      return { outcome: 'reset' };
    };
    assert.deepEqual(await h.invoke('accounts:resetCredits', 7), { value: 'cards' });
    assert.deepEqual(await h.invoke('accounts:consumeResetCredit', 'a', 'card'), { value: { outcome: 'reset' } });
    assert.deepEqual(seen, [
      ['read', '7'],
      ['consume', 'a', 'card'],
    ]);
    fail = Object.assign(new Error('card already used'), { code: 'conflict' });
    assert.deepEqual(await h.invoke('accounts:consumeResetCredit', 'a', 'card'), {
      error: { message: 'card already used', code: 'conflict' },
    });
    fail = 'plain failure';
    assert.deepEqual(await h.invoke('accounts:consumeResetCredit', 'a', 'card'), { error: { message: 'plain failure', code: null } });
  });
}
