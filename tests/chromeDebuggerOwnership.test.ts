// Pending Chrome debugger effects retain their session and tab owner until cleanup, including delayed native acknowledgements.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred, tick as flush } from './support/async-scenarios.ts';

async function setup() {
  const chrome = fakeChromeApi();
  const sent: any[] = [];
  const logged: string[] = [];
  const sessions = new Sessions({
    chrome,
    storage: chrome.storage.session,
    send: (m: any) => sent.push(m),
    log: (what: string) => logged.push(what),
  });
  await sessions.open('chat-a', {});
  const tab = await sessions.command('chat-a', 'chrome.tabs.create', [{}], 0);
  const attach = (chat = 'chat-a', turn = 0) => sessions.command(chat, 'chrome.debugger.attach', [{ tabId: tab.id }], turn);
  return { chrome, sessions, sent, logged, tab, attach };
}

for (const invalidator of ['close', 'peerGone', 'detach', 'remove', 'release', 'cancel', 'advance']) {
  for (const effectFirst of [false, true]) {
    test(`pending attach ${effectFirst ? 'acknowledgement' : 'effect'} after ${invalidator} releases its retired native attachment`, async () => {
      const { chrome, sessions, tab, attach } = await setup();
      const wait = deferred();
      const entered = deferred();
      const nativeAttach = chrome.debugger.attach;
      chrome.debugger.attach = async (...args) => {
        if (effectFirst) await nativeAttach(...args);
        entered.resolve(undefined);
        await wait.promise;
        if (!effectFirst) await nativeAttach(...args);
      };
      const pending = attach().then(
        () => null,
        (error: Error) => error,
      );
      await entered.promise;
      if (invalidator === 'close') await sessions.close('chat-a');
      else if (invalidator === 'peerGone') await sessions.peerGone();
      else if (invalidator === 'detach') await sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: tab.id }], 0);
      else if (invalidator === 'remove') sessions.onTabRemoved(tab.id);
      else if (invalidator === 'release') sessions.onTabUpdated(tab.id, { groupId: -1 }, { ...tab, groupId: -1 });
      else if (invalidator === 'cancel') sessions.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
      else sessions.advance('chat-a', 1);
      wait.resolve(undefined);
      const error = await pending;
      assert.equal(chrome.attached.has(tab.id), false, 'no native debugger survives its owner');
      assert.equal(sessions.chats.get('chat-a')?.attached.has(tab.id) ?? false, false);
      assert.match(error?.message ?? '', /no longer|ended|retired/);
      assert.ok(Object.values(chrome.store.session.sessions).every((s: any) => !s.attached.includes(tab.id)));
    });
  }
}

for (const replacement of ['reconnect', 'replace', 'transfer', 'readopt']) {
  test(`${replacement} waits for retired attach cleanup before acquiring the same native tab`, async () => {
    const { chrome, sessions, tab, attach } = await setup();
    const wait = deferred();
    const entered = deferred();
    const nativeAttach = chrome.debugger.attach;
    let calls = 0;
    chrome.debugger.attach = async (...args) => {
      assert.equal(chrome.attached.has(tab.id), false, 'new native attach follows completed cleanup');
      calls++;
      if (calls === 1) {
        entered.resolve(undefined);
        await wait.promise;
      }
      return nativeAttach(...args);
    };
    const old = attach().then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    let chat = 'chat-a';
    if (replacement === 'reconnect') await sessions.peerGone();
    else {
      if (replacement === 'replace') {
        await sessions.close(chat);
        await sessions.open(chat, {});
      } else {
        sessions.onTabUpdated(tab.id, { groupId: -1 }, { ...tab, groupId: -1 });
        if (replacement === 'transfer') {
          chat = 'chat-b';
          await sessions.open(chat, {});
        }
      }
      sessions.chats.get(chat)!.groupId = 77;
      sessions.onTabUpdated(tab.id, { groupId: 77 }, { ...tab, groupId: 77 });
    }
    const next = attach(chat);
    await flush();
    assert.equal(calls, 1, 'successor remains queued while old native attach is unresolved');
    wait.resolve(undefined);
    assert.match((await old)?.message ?? '', /no longer/);
    await next;
    assert.equal(chrome.attached.has(tab.id), true);
    assert.equal(sessions.chats.get(chat)!.attached.has(tab.id), true);
    assert.deepEqual(
      chrome.log.filter((c) => c[0].startsWith('debugger.')).map((c) => (c[0] === 'debugger.sendCommand' ? c[2] : c[0])),
      // the successor's attach puts the frame guard on the tab (frameGuard.mjs)
      ['debugger.attach', 'debugger.detach', 'debugger.attach', 'Page.addScriptToEvaluateOnNewDocument'],
    );
  });
}

for (const pendingAttach of [false, true]) {
  test(`new attach cannot overtake a retired ${pendingAttach ? 'pending' : 'acknowledged'} attachment's delayed native detach`, async () => {
    const { chrome, sessions, tab, attach } = await setup();
    const attachWait = deferred();
    const attachEntered = deferred();
    const nativeAttach = chrome.debugger.attach;
    let calls = 0;
    chrome.debugger.attach = async (...args) => {
      calls++;
      await nativeAttach(...args);
      if (pendingAttach && calls === 1) {
        attachEntered.resolve(undefined);
        await attachWait.promise;
      }
    };
    const first = attach().then(
      () => null,
      (error: Error) => error,
    );
    if (pendingAttach) await attachEntered.promise;
    else await first;
    const detachWait = deferred();
    const detachEntered = deferred();
    const nativeDetach = chrome.debugger.detach;
    chrome.debugger.detach = async (...args) => {
      detachEntered.resolve(undefined);
      await detachWait.promise;
      return nativeDetach(...args);
    };
    const releasing = sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: tab.id }], 0);
    attachWait.resolve(undefined);
    await detachEntered.promise;
    const next = attach();
    await flush();
    assert.equal(calls, 1);
    detachWait.resolve(undefined);
    await releasing;
    await first;
    await next;
    assert.equal(chrome.attached.has(tab.id), true);
    assert.equal(sessions.chats.get('chat-a')!.attached.has(tab.id), true);
  });
}

test('peer loss retires all captured tabs before waiting, and cannot clear a reconnected sibling', async () => {
  const { chrome, sessions, tab, attach } = await setup();
  const other = await sessions.command('chat-a', 'chrome.tabs.create', [{}], 0);
  await attach();
  await sessions.command('chat-a', 'chrome.debugger.attach', [{ tabId: other.id }], 0);
  const wait = deferred();
  const entered = deferred();
  const nativeDetach = chrome.debugger.detach;
  chrome.debugger.detach = async (target) => {
    if (target.tabId === tab.id) {
      entered.resolve(undefined);
      await wait.promise;
    }
    return nativeDetach(target);
  };
  const gone = sessions.peerGone();
  assert.equal(sessions.chats.get('chat-a')!.attached.size, 0);
  await entered.promise;
  await sessions.command('chat-a', 'chrome.debugger.attach', [{ tabId: other.id }], 0);
  wait.resolve(undefined);
  await gone;
  assert.deepEqual([...sessions.chats.get('chat-a')!.attached], [other.id]);
  assert.deepEqual([...chrome.attached], [other.id]);
});

test('a queued attach retired before dispatch does nothing, and a fresh attempt still works', async () => {
  const { chrome, sessions, tab, attach } = await setup();
  const old = attach().then(
    () => null,
    (error: Error) => error,
  );
  await sessions.peerGone();
  assert.match((await old)?.message ?? '', /no longer/);
  assert.equal(
    chrome.log.some((c) => c[0] === 'debugger.attach'),
    false,
  );
  await attach();
  assert.equal(chrome.attached.has(tab.id), true);
});

for (const retired of [false, true]) {
  test(`a ${retired ? 'retired' : 'current'} failed first attach releases its queue and permits retry`, async () => {
    const { chrome, sessions, tab, attach } = await setup();
    const wait = deferred();
    const entered = deferred();
    const nativeAttach = chrome.debugger.attach;
    chrome.debugger.attach = async () => {
      entered.resolve(undefined);
      await wait.promise;
    };
    const failed = assert.rejects(attach(), /native refusal/);
    await entered.promise;
    if (retired) await sessions.peerGone();
    wait.reject(new Error('native refusal'));
    await failed;
    chrome.debugger.attach = nativeAttach;
    await attach();
    assert.equal(chrome.attached.has(tab.id), true);
    assert.equal(
      chrome.log.some((c) => c[0] === 'debugger.detach'),
      false,
      'a rejected attach acquired nothing',
    );
  });
}

test('a duplicate attach rejection preserves the prior valid native attachment and cleanup ownership', async () => {
  const { chrome, sessions, tab, attach } = await setup();
  await attach();
  chrome.fail['debugger.attach'] = new Error('Another debugger is already attached');
  await assert.rejects(attach(), /already attached/);
  assert.equal(sessions.chats.get('chat-a')!.attached.has(tab.id), true);
  assert.equal(chrome.attached.has(tab.id), true);
  assert.equal(
    chrome.log.some((c) => c[0] === 'debugger.detach'),
    false,
  );
  await sessions.close('chat-a');
  assert.equal(chrome.attached.has(tab.id), false);
});

test('failed cleanup remains owned: replacement must finish cleanup before a successful retry', async () => {
  const { chrome, sessions, tab, attach } = await setup();
  await attach();
  chrome.fail['debugger.detach'] = new Error('detach temporarily failed');
  await assert.rejects(sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: tab.id }], 0), /temporarily failed/);
  await assert.rejects(attach(), /temporarily failed/);
  assert.equal(chrome.log.filter((c) => c[0] === 'debugger.attach').length, 1);
  delete chrome.fail['debugger.detach'];
  await attach();
  assert.equal(chrome.attached.has(tab.id), true);
  await sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: tab.id }], 0);
  assert.equal(chrome.attached.has(tab.id), false);
});

test('retirement during a retry cleanup prevents the waiting replacement from starting a native attach', async () => {
  const { chrome, sessions, tab, attach } = await setup();
  await attach();
  chrome.fail['debugger.detach'] = new Error('detach failed');
  await assert.rejects(sessions.command('chat-a', 'chrome.debugger.detach', [{ tabId: tab.id }], 0), /detach failed/);
  delete chrome.fail['debugger.detach'];
  const entered = deferred();
  const wait = deferred();
  const nativeDetach = chrome.debugger.detach;
  chrome.debugger.detach = async (...args) => {
    entered.resolve(undefined);
    await wait.promise;
    return nativeDetach(...args);
  };
  const next = attach().then(
    () => null,
    (error: Error) => error,
  );
  await entered.promise;
  await sessions.peerGone();
  wait.resolve(undefined);
  assert.match((await next)?.message ?? '', /no longer/);
  assert.equal(chrome.log.filter((c) => c[0] === 'debugger.attach').length, 1);
  assert.equal(chrome.attached.has(tab.id), false);
});

test('retired attach cleanup failures are logged and the next attempt retries the retained native effect', async () => {
  const { chrome, sessions, tab, attach, logged } = await setup();
  const entered = deferred();
  const wait = deferred();
  const nativeAttach = chrome.debugger.attach;
  chrome.debugger.attach = async (...args) => {
    await nativeAttach(...args);
    entered.resolve(undefined);
    await wait.promise;
  };
  const old = attach().then(
    () => null,
    (error: Error) => error,
  );
  await entered.promise;
  await sessions.peerGone();
  chrome.fail['debugger.detach'] = new Error('detach failed');
  wait.resolve(undefined);
  assert.match((await old)?.message ?? '', /no longer/);
  await flush();
  assert.ok(logged.includes('detach a retired attachment'));
  delete chrome.fail['debugger.detach'];
  chrome.debugger.attach = nativeAttach;
  await attach();
  assert.equal(chrome.attached.has(tab.id), true);
});

for (const absent of ['not-attached', 'no-tab']) {
  test(`terminal ${absent} cleanup after browser cancellation cannot strand a phantom attachment`, async () => {
    const { chrome, sessions, tab, attach } = await setup();
    const entered = deferred();
    const wait = deferred();
    const nativeAttach = chrome.debugger.attach;
    chrome.debugger.attach = async (...args) => {
      await nativeAttach(...args);
      entered.resolve(undefined);
      await wait.promise;
    };
    const pending = attach().then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    chrome.attached.delete(tab.id);
    sessions.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
    const nativeDetach = chrome.debugger.detach;
    chrome.debugger.detach = async (target) => {
      if (!chrome.attached.has(target.tabId)) {
        if (absent === 'not-attached') throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
        throw `No tab with given id ${target.tabId}.`;
      }
      return nativeDetach(target);
    };
    wait.resolve(undefined);
    assert.match((await pending)?.message ?? '', /no longer/);
    sessions.chats.get('chat-a')!.groupId = 77;
    sessions.onTabUpdated(tab.id, { groupId: 77 }, { ...tab, groupId: 77 });
    chrome.debugger.attach = nativeAttach;
    await attach();
    assert.equal(chrome.attached.has(tab.id), true);
  });
}

for (const alreadyQueued of [false, true]) {
  test(`new-turn attach ${alreadyQueued ? 'already queued' : 'after failure'} retries a retired effect without losing its live request`, async () => {
    const { chrome, sessions, tab, attach } = await setup();
    const entered = deferred();
    const wait = deferred();
    const nativeAttach = chrome.debugger.attach;
    let calls = 0;
    chrome.debugger.attach = async (...args) => {
      if (chrome.attached.has(tab.id)) throw new Error('Another debugger is already attached');
      await nativeAttach(...args);
      if (++calls === 1) {
        entered.resolve(undefined);
        await wait.promise;
      }
    };
    const old = attach().then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    sessions.advance('chat-a', 1);
    const nativeDetach = chrome.debugger.detach;
    let cleanups = 0;
    chrome.debugger.detach = async (...args) => {
      if (++cleanups === 1) throw new Error('transient detach failure');
      return nativeDetach(...args);
    };
    const next = alreadyQueued ? attach('chat-a', 1) : null;
    wait.resolve(undefined);
    assert.match((await old)?.message ?? '', /no longer/);
    await (next ?? attach('chat-a', 1));
    assert.equal(cleanups, 2);
    assert.equal(chrome.attached.has(tab.id), true);
    assert.equal(sessions.chats.get('chat-a')!.attached.has(tab.id), true);
  });
}

test('an obsolete duplicate rejection cannot mark the earlier accepted attachment for cleanup', async () => {
  const { chrome, sessions, tab, attach } = await setup();
  await attach();
  const entered = deferred();
  const wait = deferred();
  chrome.debugger.attach = async () => {
    entered.resolve(undefined);
    await wait.promise;
    throw new Error('Another debugger is already attached');
  };
  const duplicate = assert.rejects(attach(), /already attached/);
  await entered.promise;
  sessions.advance('chat-a', 1);
  wait.resolve(undefined);
  await duplicate;
  assert.equal(sessions.chats.get('chat-a')!.attached.has(tab.id), true);
  assert.equal(chrome.attached.has(tab.id), true);
  assert.equal(
    chrome.log.some((c) => c[0] === 'debugger.detach'),
    false,
  );
  await sessions.peerGone();
  assert.equal(chrome.attached.has(tab.id), false);
});
