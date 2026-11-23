// Native repro transport must actually hold replies independently of authoritative user records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPhoneSendMac } from './e2e/fixtures/phone-send-mac.mjs';

test('native fake Mac holds start and send replies until explicit controls and publishes records separately', {
  timeout: 5000,
}, async () => {
  const mac = await startPhoneSendMac();
  const post = async (path: string, body: object = {}) =>
    (
      await fetch(`${mac.origin}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  const rpc = (method: string, params: object = {}) => post('rpc', { method, params });
  const pending = async (key: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await post('control/state'))[key]) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Request never reached fake Mac: ${key}`);
  };
  try {
    let settled = false;
    const start = rpc('chat.start', { text: 'First', startId: 'same-start' }).then((value) => {
      settled = true;
      return value;
    });
    await pending('pendingStart');
    assert.equal(settled, false);
    assert.deepEqual(
      (await rpc('chat.follow')).items.map((r: { text: string }) => r.text),
      ['Running without user record'],
    );
    await post('control/acceptStart');
    assert.equal((await start).chatId, 'claude:native-send');
    assert.equal((await post('control/state')).recordCount, 0);
    await post('control/record');
    assert.equal((await rpc('chat.follow')).items[0].text, 'First');
    const send = rpc('chat.send', { text: 'Second', sendId: 'send-2' });
    await pending('pendingSend');
    await post('control/ackSend');
    await send;
    assert.equal((await post('control/state')).recordCount, 1, 'ack does not invent a record');
    await post('control/record');
    assert.equal((await rpc('chat.follow')).items[1].text, 'Second');
    const events = await (await fetch(`${mac.origin}/events?after=0`)).json();
    assert.equal(events.length, 2);
    assert.equal(events[0].live, false);
  } finally {
    await mac.close();
  }
});

test('native fake Mac refuses one start and retains the retry identity under the next pending request', { timeout: 5000 }, async () => {
  const mac = await startPhoneSendMac();
  const post = async (path: string, body: object = {}) =>
    (
      await fetch(`${mac.origin}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  try {
    const first = post('rpc', { method: 'chat.start', params: { text: 'Retry', startId: 'one' } });
    while (!(await post('control/state')).pendingStart) await new Promise((resolve) => setTimeout(resolve, 10));
    await post('control/refuseStart');
    assert.equal((await first).error, 'Fake Mac refused this start.');
    const second = post('rpc', { method: 'chat.start', params: { text: 'Retry', startId: 'one' } });
    while (!(await post('control/state')).pendingStart) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual((await post('control/state')).startIds, ['one', 'one']);
    await post('control/acceptStart');
    assert.equal((await second).chatId, 'claude:native-send');
  } finally {
    await mac.close();
  }
});

const harness = async () => {
  const mac = await startPhoneSendMac();
  const post = async (path: string, body: object = {}) =>
    (
      await fetch(`${mac.origin}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    ).json();
  const rpc = (method: string, params: object = {}) => post('rpc', { method, params });
  const control = (command: string) => post(`control/${command}`);
  const pending = async (key: string) => {
    for (let i = 0; i < 100; i++) {
      if ((await control('state'))[key]) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`Request never reached fake Mac: ${key}`);
  };
  return { mac, rpc, control, pending };
};

test('native fake Mac advertises message identity by default, and hosts and legacy modes on request until reset', {
  timeout: 5000,
}, async () => {
  const { mac, rpc, control } = await harness();
  try {
    assert.deepEqual((await rpc('machine.hello')).capabilities, { permissionCeiling: 'auto-review', methods: [], messageIdentity: 1 });
    await control('hosts');
    await control('legacy');
    assert.deepEqual((await rpc('machine.hello')).capabilities, { permissionCeiling: 'auto-review', methods: [], machines: true });
    await control('reset');
    assert.equal((await rpc('machine.hello')).capabilities.machines, undefined);
    assert.equal((await rpc('machine.hello')).capabilities.messageIdentity, 1);
    const { machines } = await rpc('machines.list');
    assert.deepEqual(
      machines.map((m: { id: string; name: string }) => [m.id, m.name]),
      [
        ['local', 'This Mac'],
        ['host-1', 'Fake Host'],
      ],
    );
    assert.deepEqual(await rpc('machines.folders', { id: 'host-1' }), { path: null, roots: ['/srv/work'], entries: [], more: false });
    assert.deepEqual(await rpc('machines.folders', { id: 'host-1', path: '/srv/work' }), {
      path: '/srv/work',
      roots: [],
      entries: [],
      more: false,
    });
  } finally {
    await mac.close();
  }
});

test('native fake Mac keeps chunked uploads, serves the message picture and records picture sends with the Mac-derived identity', {
  timeout: 5000,
}, async () => {
  const { mac, rpc, control, pending } = await harness();
  try {
    const part = await rpc('chat.attach', {
      stream: 's1',
      index: 0,
      total: 2,
      data: Buffer.from('ab').toString('base64'),
      name: 'a.png',
      mime: 'image/png',
    });
    assert.deepEqual(part, { stream: 's1', received: 1, done: false });
    const whole = await rpc('chat.attach', {
      stream: 's1',
      index: 1,
      total: 2,
      data: Buffer.from('cde').toString('base64'),
      name: 'a.png',
      mime: 'image/png',
    });
    assert.deepEqual(whole, { stream: 's1', received: 2, done: true, id: 'attachment-1' });
    assert.deepEqual((await control('state')).uploads, [{ id: 'attachment-1', name: 'a.png', mime: 'image/png', bytes: 5 }]);

    const start = rpc('chat.start', { text: '', startId: 'start-1', attachments: ['attachment-1'], hostId: 'host-1', folder: '/srv/work' });
    await pending('pendingStart');
    await control('acceptStart');
    await start;
    const send = rpc('chat.send', { chatId: 'claude:native-send', text: '', sendId: 'send-1', attachments: ['attachment-1'] });
    await pending('pendingSend');
    await control('ackSend');
    await send;
    const plain = rpc('chat.send', { chatId: 'claude:native-send', text: 'words', sendId: 'send-2' });
    await pending('pendingSend');
    await control('ackSend');
    await plain;
    const state = await control('state');
    assert.deepEqual(state.startAttachments, [['attachment-1']]);
    assert.deepEqual(state.sendAttachments, [['attachment-1'], []]);
    assert.deepEqual(state.startHosts, [{ hostId: 'host-1', folder: '/srv/work' }]);

    await control('record');
    const { messageIdentity } = await import('../shared/remote/messageIdentity.mjs');
    const { createHash } = await import('node:crypto');
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
    const [first] = (await rpc('chat.follow')).items;
    assert.deepEqual(first, {
      role: 'user',
      text: '',
      id: 'message-1',
      images: 1,
      clientId: messageIdentity(hash, 'pair', 'chat.start', null, 'start-1'),
    });
    await control('record');
    const second = (await rpc('chat.follow')).items[1];
    assert.equal(second.text, 'words', 'the latest send is the one recorded');
    assert.equal(second.images, undefined, 'a words-only send carries no picture fields');

    const picture = await rpc('messages.image', { chatId: 'claude:native-send', itemId: 'message-1', index: 0, maxSide: 360 });
    assert.match(picture.data, /^\/9j\//);
    assert.deepEqual([picture.width, picture.height], [1, 1]);
    assert.equal((await control('state')).imageReads, 1);

    await control('reset');
    assert.deepEqual(
      Object.entries(await control('state')).filter(([key]) =>
        ['startAttachments', 'sendAttachments', 'startHosts', 'uploads'].includes(key),
      ),
      [
        ['startAttachments', []],
        ['sendAttachments', []],
        ['startHosts', []],
        ['uploads', []],
      ],
    );
    assert.equal((await control('state')).imageReads, 0);
  } finally {
    await mac.close();
  }
});

test('native fake Mac records a picture-only send under its own send identity and a start without Host picks as unplaced', {
  timeout: 5000,
}, async () => {
  const { mac, rpc, control, pending } = await harness();
  try {
    const start = rpc('chat.start', { text: 'Words', startId: 'start-2' });
    await pending('pendingStart');
    await control('acceptStart');
    await start;
    assert.deepEqual((await control('state')).startHosts, [{ hostId: null, folder: null }]);
    await control('record');
    const send = rpc('chat.send', { chatId: 'claude:native-send', text: '', sendId: 'send-9', attachments: ['attachment-9'] });
    await pending('pendingSend');
    await control('ackSend');
    await send;
    await control('record');
    const { messageIdentity } = await import('../shared/remote/messageIdentity.mjs');
    const { createHash } = await import('node:crypto');
    const row = (await rpc('chat.follow')).items[1];
    assert.equal(
      row.clientId,
      messageIdentity(
        (bytes: Uint8Array) => createHash('sha256').update(bytes).digest(),
        'pair',
        'chat.send',
        'claude:native-send',
        'send-9',
      ),
    );
    assert.equal(row.id, 'message-2');
  } finally {
    await mac.close();
  }
});
