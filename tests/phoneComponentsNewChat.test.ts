// New chat on the phone: the greeting, the Start path, attachments behind +, dictation behind the mic, and an honest start that survives leaving.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, flush, click, inputText } from './support/phone/component-kit';
import { scripted, fakeMedia } from './support/phone/m3';
import { PROMPT, mount, has, button, chip, tap, typeIn, attach, dictate, tile } from './support/phone/newchat-kit';

// a chat started in one test is remembered for the next New chat (mobile/src/remote/lastPicks.ts): each test starts with none
const { forgetPicks } = await import('../mobile/src/remote/lastPicks');
beforeEach(() => forgetPicks());

test('a new chat starts with the agent, project, model, effort and a capped permission picked in Claude-style sheets, then opens', async () => {
  const { runtime, calls } = scripted((m) => (m === 'chat.start' ? { chatId: 'claude:new' } : undefined));
  const snapshot = runtime.snapshot;
  runtime.snapshot = () => ({ ...snapshot(), user: { id: 'u', name: 'Dax Hill' } });
  const { host, opened, sents, sendings } = await mount(runtime, fakeMedia().media);
  has(host, /Back at it, Dax/);
  // the chips above the composer: agent, computer, project; the model pill in its bar
  assert.ok(chip(host, 'Agent').textContent!.includes('Claude Code'));
  assert.ok(chip(host, 'Computer').textContent!.includes('Computer'));
  assert.ok(chip(host, 'Project').textContent!.includes('No project'));
  assert.equal(button(host, 'Model, claude model Low')!.textContent, 'claude modelLow');
  // empty, the bar ends with the mic and a send that cannot go yet
  assert.ok(button(host, 'Dictate'));
  assert.equal(button(host, 'Start chat')!.disabled, true);
  await click('Model, claude model Low');
  has(host, /Select model/);
  assert.equal(button(host, 'claude model')!.getAttribute('aria-selected') ?? 'true', 'true');
  await click('Effort, Recommended, Low');
  has(host, /Effort/);
  await click('High');
  // ‹ came back to the models; the effort row now says High
  assert.ok(button(host, 'Effort, High'));
  await click('Permissions, Ask');
  // the phone is never offered full access; a disabled row shows why and is not a button
  assert.doesNotMatch(host.textContent!, /Bypass/);
  has(host, /Not for this model/);
  assert.equal(button(host, 'Auto'), undefined);
  await click('Ask');
  await click('Close');
  assert.doesNotMatch(host.textContent!, /Select model/);
  await tap(chip(host, 'Project'));
  await click('App');
  assert.ok(chip(host, 'Project').textContent!.includes('App'));
  await attach('Photo library');
  assert.ok(tile(host, 'photo.jpg', 'attached'));
  await typeIn('Fix the bug');
  await click('Start chat');
  const start = calls.find((c) => c[0] === 'chat.start')![1];
  assert.deepEqual(
    { ...start, deadline: undefined },
    {
      harness: 'claude',
      text: 'Fix the bug',
      projectId: 'app',
      model: 'claude-m',
      effort: 'high',
      permission: 'default',
      attachments: ['0123456789abcdef'],
      startId: start.startId,
      deadline: undefined,
    },
  );
  assert.deepEqual(opened, ['claude:new']);
  // the chat's page opened on the tap with the message, and the Mac's answer only named the chat
  assert.deepEqual(sendings, ['Fix the bug']);
  assert.deepEqual(sents, [
    {
      text: 'Fix the bug',
      id: start.startId,
      pictures: ['data:image/jpeg;base64,QUJD'],
      nativeId: runtime.messageIdentity('chat.start', null, start.startId),
    },
  ]);
});

test('a failed load offers retry, a failed menu says so, and a failed start keeps the message', async () => {
  let fail = true;
  const { runtime } = scripted((m) => {
    if (m === 'harnesses.list' && fail) throw new Error('Computer is offline');
    if (m === 'options.get' && fail === false && (runtime as any).bad) throw new Error('menu broke');
    if (m === 'chat.start') throw new Error('Mac refused');
    return undefined;
  });
  const { host } = await mount(runtime, fakeMedia().media);
  has(host, /offline or asleep/);
  has(host, /Could not load/);
  assert.equal(button(host, 'Add to session'), undefined, 'nothing to attach to before the Mac answers');
  fail = false;
  (runtime as any).bad = true;
  await click('Retry');
  has(host, /menu broke/);
  (runtime as any).bad = false;
  await tap(chip(host, 'Agent'));
  await click('Codex');
  await typeIn('Try');
  await click('Start chat');
  has(host, /Mac refused/);
  assert.equal(button(host, 'Start chat')!.disabled, false);
});

test('uploads block Start until done, can be cancelled and retried, and a failed picker shows its reason', async () => {
  let release: (v: unknown) => void = () => {};
  let mode = 'hang';
  const { runtime } = scripted((m) => {
    if (m === 'chat.attach')
      return mode === 'hang' ? new Promise((r) => (release = r)) : mode === 'fail' ? Promise.reject(new Error('Mac full')) : undefined;
    return undefined;
  });
  const { media, log } = fakeMedia({ cameraError: 'Allow camera access in Settings to take a photo.' });
  const { host } = await mount(runtime, media);
  await typeIn('Go');
  await attach('Photo library');
  assert.doesNotMatch(host.textContent!, /Add to session/, 'the sheet closes for the picker');
  assert.ok(tile(host, 'photo.jpg', 'sending 0%'));
  has(host, /Wait for uploads/);
  assert.equal(button(host, 'Start chat')!.disabled, true);
  // removing a tile that is still sending cancels it, and Start is free again
  await click('Remove photo.jpg');
  assert.equal(host.querySelector('[aria-label^="photo.jpg"]'), null);
  assert.equal(button(host, 'Start chat')!.disabled, false);
  mode = 'fail';
  await attach('Photo library');
  assert.ok(tile(host, 'photo.jpg', 'failed: Mac full'));
  mode = 'ok';
  await click('Retry upload of photo.jpg');
  assert.ok(tile(host, 'photo.jpg', 'attached'));
  assert.equal(button(host, 'Start chat')!.disabled, false);
  await click('Remove photo.jpg');
  assert.equal(host.querySelector('[aria-label^="photo.jpg"]'), null);
  await attach('Camera');
  has(host, /Allow camera access/);
  assert.deepEqual(log, ['recent', 'library', 'recent', 'library', 'recent', 'camera']);
  release(null);
});

test('a cancelled picker adds nothing, and past ten files the rows are no longer buttons', async () => {
  const { runtime } = scripted(() => undefined);
  const a = await mount(runtime, fakeMedia({ library: null }).media);
  await attach('Photo library');
  assert.doesNotMatch(a.host.textContent!, /photo.jpg/);
  const b = await mount(runtime, fakeMedia().media);
  for (let i = 0; i < 10; i++) await attach('Photo library');
  await click('Add to session');
  assert.equal(button(b.host, 'Photos')!.disabled, true);
  assert.equal(button(b.host, 'Camera')!.disabled, true);
  assert.equal(button(b.host, 'Add files'), undefined);
  has(b.host, /Up to ten files/);
});

test('a voice note is transcribed on the Mac and shown for editing before it joins the message', async () => {
  let heard = 'spoken words';
  const { runtime, calls } = scripted((m) => (m === 'chat.transcribe' ? { text: heard } : undefined));
  const { media, log } = fakeMedia();
  const { host } = await mount(runtime, media);
  await dictate();
  has(host, /Stop and transcribe/);
  await click('Stop and transcribe');
  const audio = calls.find((c) => c[0] === 'chat.attach')![1];
  assert.deepEqual([audio.purpose, audio.mime, audio.data], ['audio', 'audio/wav', 'UklGRg==']);
  assert.deepEqual(calls.find((c) => c[0] === 'chat.transcribe')![1], { stream: audio.stream, mime: 'audio/wav' });
  has(host, /Nothing is sent yet/);
  await inputText('Transcript', 'edited words');
  await click('Use text');
  // the sheet closes and the words join the message; send can go now, and the mic stays beside it
  assert.doesNotMatch(host.textContent!, /Nothing is sent yet/);
  assert.equal(host.querySelector<HTMLInputElement>(`input[placeholder="${PROMPT}"]`)!.value, 'edited words');
  assert.equal(button(host, 'Start chat')!.disabled, false);
  assert.ok(button(host, 'Dictate'));
  await typeIn('Existing');
  heard = 'more';
  await click('Model, claude model Low');
  await click('Close');
  // dictation adds to the text through the voice sheet
  await typeIn('');
  await dictate();
  await click('Stop and transcribe');
  await typeIn('Existing');
  await click('Use text');
  assert.equal(host.querySelector<HTMLInputElement>(`input[placeholder="${PROMPT}"]`)!.value, 'Existing more');
  assert.equal(
    calls.some((c) => c[0] === 'chat.start'),
    false,
  );
  heard = ' ';
  await typeIn('');
  await dictate();
  await click('Stop and transcribe');
  has(host, /No speech was heard/);
  // each Use text closes the sheet, and the voice note it held cancels on the way out
  assert.deepEqual(
    log.filter((x) => x !== 'cancel'),
    ['start', 'stop', 'start', 'stop', 'start', 'stop'],
  );
  assert.ok(log.includes('cancel'));
});

test('a refused microphone shows why, and a recording can be cancelled', async () => {
  const { runtime } = scripted(() => undefined);
  const denied = await mount(runtime, fakeMedia({ startError: 'Allow microphone access in Settings to dictate.' }).media);
  await dictate();
  has(denied.host, /Allow microphone access/);
  const a = fakeMedia();
  const { host } = await mount(runtime, a.media);
  await dictate();
  await click('Cancel recording');
  has(host, /Record voice note/);
  await click('Close');
  assert.equal(button(host, 'Record voice note'), undefined);
  // closing the sheet drops whatever it held: the voice note cancels on the way out
  assert.deepEqual(a.log, ['start', 'cancel', 'cancel']);
});

test('leaving mid-flight is safe: a late start result is ignored', async () => {
  let finish: (v: unknown) => void = () => {};
  const { runtime } = scripted((m) => (m === 'chat.start' ? new Promise((r) => (finish = r)) : undefined));
  const { host, root, opened } = await mount(runtime, fakeMedia().media);
  await typeIn('x');
  await click('Start chat');
  has(host, /Starting…/);
  await act(async () => root.unmount());
  finish({ chatId: 'late' });
  await flush();
  assert.deepEqual(opened, []);
});

test('a load that settles after leaving, by success or by failure, changes nothing', async () => {
  for (const settle of ['ok', 'fail']) {
    let finish: (v: unknown) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const { runtime } = scripted((m) => (m === 'harnesses.list' ? new Promise((res, rej) => ((finish = res), (fail = rej))) : undefined));
    const { host, root } = await mount(runtime, fakeMedia().media);
    await act(async () => root.unmount());
    await act(async () => (settle === 'ok' ? finish({ harnesses: [] }) : fail(new Error('late'))));
    await flush();
    assert.equal(host.textContent, '');
  }
});

test('a start that fails after leaving does not touch the closed screen, and a late upload is ignored', async () => {
  let fail: (e: Error) => void = () => {};
  let land: (v: unknown) => void = () => {};
  const { runtime } = scripted((m) =>
    m === 'chat.start' ? new Promise((_ok, no) => (fail = no)) : m === 'chat.attach' ? new Promise((ok) => (land = ok)) : undefined,
  );
  const { host, root, opened } = await mount(runtime, fakeMedia().media);
  await typeIn('x');
  await attach('Photo library');
  await click('Start chat').catch(() => {});
  await act(async () => root.unmount());
  await act(async () => fail(new Error('gone')));
  await act(async () => land({ id: '0123456789abcdef' }));
  await flush();
  assert.deepEqual(opened, []);
  assert.equal(host.textContent, '');
});

test('changed picks after a failed start get a new start id', async () => {
  let fail = true;
  const { runtime, calls } = scripted((m) => {
    if (m === 'chat.start' && fail) throw new Error('Mac refused');
    return m === 'chat.start' ? { chatId: 'c' } : undefined;
  });
  await mount(runtime, fakeMedia().media);
  await typeIn('one');
  await click('Start chat');
  await typeIn('two');
  fail = false;
  await click('Start chat');
  const ids = calls.filter((c) => c[0] === 'chat.start').map((c) => c[1].startId);
  assert.notEqual(ids[0], ids[1]);
});

test("Back and Android's back button leave New chat, a lost start is not offered again, and an open sheet takes the back button first", async () => {
  (globalThis as any).__phonePlatform = 'android';
  try {
    const { runtime } = scripted(() => undefined);
    const { startMemory } = await import('../mobile/src/remote/startMemory');
    startMemory.idFor(runtime, 'picks', () => 'start-1');
    startMemory.markLost(runtime);
    const { host, backs } = await mount(runtime, fakeMedia().media);
    has(host, /Start not confirmed/);
    const press = () => ((globalThis as any).__phoneBackListeners as Array<() => boolean>).at(-1)!();
    await tap(chip(host, 'Agent'));
    await act(async () => void press());
    assert.equal(backs(), 0, 'the sheet closed, the page stayed');
    assert.doesNotMatch(host.textContent!, /Gemini|Codex/);
    await act(async () => void press());
    assert.equal(backs(), 1);
    assert.equal(startMemory.lost(runtime), false);
    await click('Back');
    assert.equal(backs(), 2);
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});

test('in New chat the sheet offers the chosen permission and the computer, and each opens its page', async () => {
  const { runtime } = scripted(() => undefined);
  const { host } = await mount(runtime, fakeMedia().media);
  await click('Add to session');
  await click('Permission, Ask');
  has(host, /Select model/);
  assert.doesNotMatch(host.textContent!, /Add to session/, 'the sheet leaves before the page opens');
  await click('Close');
  await click('Add to session');
  // the chip under the sheet has the same name: the row is the one drawn last
  const rows = [...document.querySelectorAll('button[aria-label="Computer, Computer"]')];
  await act(async () => (rows.at(-1) as HTMLElement).click());
  await flush();
  assert.doesNotMatch(host.textContent!, /Add to session/, 'the sheet leaves before the page opens');
  assert.ok(button(host, 'Close'), 'the computer sheet is open');
});
