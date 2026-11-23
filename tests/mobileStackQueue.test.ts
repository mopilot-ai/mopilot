// Mobile Remote end to end, scenario 11: messages typed while the Mac is away. They wait on the phone in order, go once when the Mac is back, survive a reply that was lost, and can be cancelled; the Mac never hands the same message to the harness twice. What is kept on the device is in mobileStackQueuePersist.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, type Relay } from './support/mobileStack.ts';
import { fakeSafe, fs, openSealed } from './support/remoteKit.ts';
import path from 'node:path';

async function connected(relay: Relay, macOpts: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, macOpts);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  mac.known.add('c2');
  return { mac, phone, pairId };
}
/** What reached the Mac's chat panel, in order. */
const reached = (mac: any) => mac.calls.filter((c: any[]) => c[0] === 'send').map((c: any[]) => `${c[1].chatId}:${c[1].text}`);

test('messages typed while the Mac is away wait in order and go once when it is back', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the Mac');
  const first = phone.runtime.send('c1', 'first');
  phone.runtime.send('c2', 'other chat');
  phone.runtime.send('c1', 'second');
  assert.deepEqual(
    phone.snap().outbox.map((i: any) => [i.chatId, i.text, i.status]),
    [
      ['c1', 'first', 'queued'],
      ['c2', 'other chat', 'queued'],
      ['c1', 'second', 'queued'],
    ],
  );
  assert.equal(phone.snap().outbox[0].id, first);

  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  again.known.add('c2');
  await until(() => phone.snap().outbox.length === 0, 'the queue to be delivered');
  assert.deepEqual(reached(again), ['c1:first', 'c2:other chat', 'c1:second'], 'in the order typed, each once');
  assert.equal(phone.snap().phase, 'online');
  // and the live path works afterwards
  phone.runtime.send('c1', 'live');
  await until(() => reached(again).length === 4 && phone.snap().outbox.length === 0, 'a message sent while online');
});

test('a message typed offline can be cancelled and never reaches the Mac', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the Mac');
  const id = phone.runtime.send('c1', 'changed my mind');
  phone.runtime.send('c1', 'keep this');
  assert.equal(phone.runtime.cancelSend(id), true);
  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => phone.snap().outbox.length === 0 && reached(again).length === 1, 'the rest to be delivered');
  assert.deepEqual(reached(again), ['c1:keep this']);
});

test('a message typed offline can be edited and the Mac gets the new words, once', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the Mac');
  const id = phone.runtime.send('c1', 'first draft');
  assert.equal(phone.runtime.editSend(id, 'final words'), true);
  assert.equal(phone.runtime.editSend(id, '   '), false, 'nothing to say is not a message');
  assert.equal(phone.snap().outbox[0].id, id, 'the same message, the same send id');
  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => phone.snap().outbox.length === 0 && reached(again).length === 1, 'the edited message to be delivered');
  assert.deepEqual(reached(again), ['c1:final words']);
  assert.equal(phone.runtime.editSend(id, 'too late'), false, 'delivered: gone');
});

test('a reply lost to a dropped connection does not send the message twice', async () => {
  const relay = await startRelay();
  const reachedTexts: string[] = [];
  let release: () => void = () => undefined;
  const { mac, phone } = await connected(relay, {
    ops: {
      send: async (m: any) => {
        reachedTexts.push(m.text);
        await new Promise<void>((resolve) => (release = resolve));
        return {};
      },
    },
  });
  void mac;
  const id = phone.runtime.send('c1', 'exactly once');
  await until(() => reachedTexts.length === 1, 'the Mac to start the send');
  // the phone loses its connection before the Mac answers
  phone.goOffline();
  await until(() => phone.snap().outbox[0]?.status === 'queued', 'the message to go back to waiting');
  release();
  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().phase === 'online', 'the phone to come back');
  await until(() => phone.snap().outbox.length === 0, 'the sent-again message to be answered');
  assert.deepEqual(reachedTexts, ['exactly once'], 'the Mac took the message once; the resend got the first outcome');
  assert.equal(id.length > 8, true);
});

test('a message the Mac refuses stays on the phone with the reason, holds back its chat, and goes on Retry', async () => {
  const relay = await startRelay();
  const reachedTexts: string[] = [];
  let refuse = true;
  const { mac, phone } = await connected(relay, {
    ops: {
      send: async (m: any) => {
        reachedTexts.push(m.text);
        if (refuse && m.text === 'bad') throw new Error('The harness did not accept the message.');
        return {};
      },
    },
  });
  void mac;
  const bad = phone.runtime.send('c1', 'bad');
  phone.runtime.send('c1', 'after');
  phone.runtime.send('c2', 'unrelated');
  await until(
    () => phone.snap().outbox.length === 2 && phone.snap().outbox[0].status === 'failed',
    'the refusal and the unrelated chat’s message to go',
  );
  assert.deepEqual(
    phone.snap().outbox.map((i: any) => [i.text, i.status, i.error]),
    [
      ['bad', 'failed', 'The harness did not accept the message.'],
      ['after', 'queued', null],
    ],
  );
  assert.deepEqual(reachedTexts, ['bad', 'unrelated'], 'the later message of that chat did not overtake it');
  refuse = false;
  assert.equal(phone.runtime.retrySend(bad), true);
  await until(() => phone.snap().outbox.length === 0, 'the retry and the held message');
  assert.deepEqual(reachedTexts, ['bad', 'unrelated', 'bad', 'after']);
});

test('sending with no computer to connect to is refused at once', async () => {
  const relay = await startRelay();
  const phone = await startPhone(relay);
  assert.throws(() => phone.runtime.send('c1', 'nowhere'), /Connect to a computer first/);
  assert.deepEqual(phone.snap().outbox, []);
});

test('signing out or removing the computer forgets what was waiting for it', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the Mac');
  phone.runtime.send('c1', 'for the old account');
  assert.equal(phone.snap().outbox.length, 1);
  await phone.runtime.signOut();
  assert.deepEqual(phone.snap().outbox, [], 'a signed-out phone keeps nothing for the next account');
  assert.throws(() => phone.runtime.send('c1', 'nobody'), /Connect to a computer first/);

  const other = await startRelay();
  const second = await connected(other);
  second.mac.stop();
  await until(() => second.phone.snap().reconnect?.pairId === second.pairId, 'the second phone to wait');
  second.phone.runtime.send('c1', 'for a computer that is removed');
  assert.equal(second.phone.snap().outbox.length, 1);
  await second.phone.runtime.unpair(second.pairId);
  assert.deepEqual(second.phone.snap().outbox, []);
});

/** Every file named `name` under a folder. */
async function filesNamed(dir: string, name: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await filesNamed(full, name)));
    else if (entry.name === name) found.push(full);
  }
  return found;
}
const ledgerText = async (userData: string, safe: ReturnType<typeof fakeSafe>) =>
  (await Promise.all((await filesNamed(userData, 'sends.json')).map((f) => openSealed(f, safe)))).join('');

test('a Mac that stopped between taking a message and answering keeps every same-id retry uncertain; only an informed new message sends', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const first: string[] = [];
  const { mac, phone, pairId } = await connected(relay, {
    safe,
    ops: {
      send: async (m: any) => {
        first.push(m.text);
        return new Promise(() => undefined);
      },
    },
  });
  const id = phone.runtime.send('c1', 'was it sent?');
  await until(
    async () => first.length === 1 && (await ledgerText(mac.userData, safe)).includes('pending'),
    'the Mac to take the message and keep a record',
  );
  mac.stop();
  await until(
    () => phone.snap().outbox[0]?.status === 'queued' && phone.snap().reconnect?.pairId === pairId,
    'the message to wait for the Mac',
  );

  const second: string[] = [];
  const again = await startMac(relay, {
    userData: mac.userData,
    safe,
    ops: {
      send: async (m: any) => {
        second.push(m.text);
        return {};
      },
    },
  });
  again.known.add('c1');
  await until(() => phone.snap().outbox[0]?.status === 'failed', 'the Mac to answer');
  assert.match(phone.snap().outbox[0].error!, /may have reached the chat/);
  assert.deepEqual(second, [], 'not sent on the phone’s say-so');
  assert.equal(phone.snap().outbox[0].id, id);
  for (let n = 0; n < 3; n++) {
    assert.equal(phone.runtime.retrySend(id), false, 'generic Retry is disabled for typed uncertainty');
    await assert.rejects(phone.ask('chat.send', { chatId: 'c1', text: 'was it sent?', attachments: [], sendId: id }), {
      code: 'send_uncertain',
    });
    assert.equal(phone.snap().outbox[0].id, id, 'the phone never silently mints a new id');
    assert.match(phone.snap().outbox[0].error!, /may have reached the chat/);
    assert.deepEqual(second, [], 'a second or later retry does not redispatch');
  }
  assert.match(await ledgerText(again.userData, safe), /"pending"/, 'the durable uncertainty is retained');
  // Explicit user action after checking the chat: discard the uncertain draft and compose another message.
  assert.equal(phone.runtime.cancelSend(id), true);
  const newId = phone.runtime.send('c1', 'I checked: please send this new message');
  assert.notEqual(newId, id);
  await until(() => phone.snap().outbox.length === 0, 'the explicit new message to be accepted');
  assert.deepEqual(second, ['I checked: please send this new message']);
});

test('a reply lost with the connection and a Mac that restarted afterwards: the message is answered from the record and not sent again', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  let release: () => void = () => undefined;
  const first: string[] = [];
  const { mac, phone, pairId } = await connected(relay, {
    safe,
    ops: {
      send: async (m: any) => {
        first.push(m.text);
        await new Promise<void>((r) => (release = r));
        return { warning: 'Queued behind another message.' };
      },
    },
  });
  phone.runtime.send('c1', 'only once');
  await until(() => first.length === 1, 'the Mac to take the message');
  phone.goOffline();
  await until(() => phone.snap().outbox[0]?.status === 'queued', 'the message to wait');
  release();
  await until(async () => (await ledgerText(mac.userData, safe)).includes('"done"'), 'the Mac to finish and keep the receipt');
  mac.stop();

  const second: string[] = [];
  const again = await startMac(relay, {
    userData: mac.userData,
    safe,
    ops: {
      send: async (m: any) => {
        second.push(m.text);
        return {};
      },
    },
  });
  again.known.add('c1');
  phone.comeBack();
  phone.foreground();
  await until(
    () => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId && phone.snap().outbox.length === 0,
    'the message to be answered',
  );
  assert.deepEqual(first, ['only once']);
  assert.deepEqual(second, [], 'the restarted Mac answered from its record, with no second turn');
});

test('reconnecting twice while a message waits still delivers it once', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  phone.goOffline();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  phone.runtime.send('c1', 'twice over');
  phone.comeBack();
  phone.foreground();
  phone.foreground();
  await until(() => phone.snap().outbox.length === 0, 'the message to be delivered');
  phone.goOffline();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait again');
  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().phase === 'online', 'the second reconnect');
  assert.deepEqual(reached(mac), ['c1:twice over']);
});

test('an older Mac that cannot recognise a repeated send: nothing is queued for later and a lost connection is left to the person', async () => {
  const relay = await startRelay();
  let release: () => void = () => undefined;
  const { phone } = await connected(relay, {
    ops: {
      send: async () => {
        await new Promise<void>((r) => (release = r));
        return {};
      },
    },
  });
  const request = phone.runtime.request.bind(phone.runtime);
  // what an older MoPilot says in its hello: no sendId
  phone.runtime.request = async (method: string, params: any) => {
    const answer = await request(method, params);
    if (method !== 'machine.hello') return answer;
    const { sendId: _s, ...capabilities } = (answer as any).capabilities;
    return { ...(answer as any), capabilities };
  };
  phone.runtime.send('c1', 'maybe arrived');
  await until(() => phone.snap().outbox[0]?.status === 'sending', 'the message to go out');
  phone.goOffline();
  await until(() => phone.snap().outbox[0]?.status === 'failed', 'the lost connection to be reported');
  assert.match(phone.snap().outbox[0].error!, /Check the chat/);
  release();
  // and with the Mac known to be old, a message is not taken for later
  assert.throws(() => phone.runtime.send('c1', 'later'), /older MoPilot that cannot hold messages for later/);
});

test('a computer that cannot answer the hello is not taken for an old one: the message can be sent again, and each connection asks anew', async () => {
  const relay = await startRelay();
  const reachedTexts: string[] = [];
  const { mac, phone, pairId } = await connected(relay, {
    ops: {
      send: async (m: any) => {
        reachedTexts.push(m.text);
        return {};
      },
    },
  });
  void mac;
  const request = phone.runtime.request.bind(phone.runtime);
  let failHello = true;
  phone.runtime.request = async (method: string, params: any) => {
    if (method === 'machine.hello' && failHello) throw new Error('The request failed.');
    return request(method, params);
  };
  const id = phone.runtime.send('c1', 'after a failed hello');
  await until(() => phone.snap().outbox[0]?.status === 'failed', 'the message to say it was not sent');
  assert.match(phone.snap().outbox[0].error!, /request failed/);
  assert.deepEqual(reachedTexts, [], 'not sent blind');
  failHello = false;
  assert.equal(phone.runtime.retrySend(id), true);
  await until(() => phone.snap().outbox.length === 0, 'the retry to go');
  assert.deepEqual(reachedTexts, ['after a failed hello']);
  // a new connection asks again: the first answer is not kept for the life of the app
  let hellos = 0;
  const counting = phone.runtime.request;
  phone.runtime.request = async (method: string, params: any) => (method === 'machine.hello' && hellos++, counting(method, params));
  phone.goOffline();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().phase === 'online', 'the phone to return');
  phone.runtime.send('c1', 'second connection');
  await until(() => phone.snap().outbox.length === 0 && reachedTexts.length === 2, 'the second message');
  assert.equal(hellos, 1, 'the new connection read the hello again');
});

test('a connection that goes away while the computer is asked what it can do sends nothing and leaves the message waiting', async () => {
  const relay = await startRelay();
  const reachedTexts: string[] = [];
  const { phone, pairId } = await connected(relay, {
    ops: {
      send: async (m: any) => {
        reachedTexts.push(m.text);
        return {};
      },
    },
  });
  const request = phone.runtime.request.bind(phone.runtime);
  let answer: (v: unknown) => void = () => undefined;
  let refuse: (e: Error) => void = () => undefined;
  let held = 0;
  phone.runtime.request = (method: string, params: any) =>
    method === 'machine.hello' && held === 0
      ? (held++, new Promise((resolve, reject) => ((answer = resolve), (refuse = reject))))
      : request(method, params);
  phone.runtime.send('c1', 'waits for the hello');
  await until(() => held === 1, 'the hello to be asked');
  phone.goOffline();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the connection to go');
  answer({ capabilities: { sendId: true } });
  await until(() => phone.snap().outbox[0]?.status === 'queued', 'the message to keep waiting');
  assert.deepEqual(reachedTexts, []);
  // and again, with the hello failing because the connection went
  held = 0;
  phone.comeBack();
  phone.foreground();
  await until(() => held === 1, 'the hello to be asked on the new connection');
  phone.goOffline();
  await until(() => phone.snap().phase === 'offline' && phone.snap().reconnect?.pairId === pairId, 'the connection to go again');
  refuse(new Error('Connection closed'));
  await until(() => phone.snap().outbox[0]?.status === 'queued', 'the message to keep waiting again');
  held = 5;
  phone.comeBack();
  phone.foreground();
  await until(() => phone.snap().outbox.length === 0, 'the message to go on a connection that stayed up');
  assert.deepEqual(reachedTexts, ['waits for the hello']);
});
