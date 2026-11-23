// A step's screenshot opens to the Mac's full capture (steps.thumbnail) and falls back to the inline picture when the Mac has none or is away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, createElement, createRoot, flush } from './support/phone/component-kit';

import { fakeDraft } from './support/phone/drafts';
const clientPath = '../mobile/src/remote/stepPicture';
const rowsPath = '../mobile/src/presentation/stepRows';
const threadPath = '../mobile/src/presentation/thread';
const picturePath = '../mobile/src/components/StepPicture';
const threadScreenPath = '../mobile/src/screens/Thread';
const { readStepPicture, FULL_SIDE } = await import(clientPath);
const { callIdOf } = await import(rowsPath);
const { row } = await import(threadPath);
const { StepPicture, StepPictureProvider } = await import(picturePath);
const { Thread } = await import(threadScreenPath);
const { withOutbox } = await import('./support/phone/outbox-kit');

const SMALL = 'data:image/png;base64,iVBORw0KGgo=';
const FULL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('the full capture is read by call and shown only as a plain base64 picture', async () => {
  const asks: [string, any][] = [];
  const ok = async (method: string, params: any) => (asks.push([method, params]), { data: '/9j/4AAQSkZJRg==', width: 800, height: 500 });
  assert.equal(await readStepPicture(ok, 'c', 'call-1'), FULL);
  assert.deepEqual(asks, [['steps.thumbnail', { chatId: 'c', callId: 'call-1', maxSide: FULL_SIDE }]]);
  // no kept picture, an older Mac, a Mac that is away, and replies that are not a picture
  assert.equal(await readStepPicture(async () => ({}), 'c', 'x'), null);
  assert.equal(await readStepPicture(async () => null, 'c', 'x'), null);
  assert.equal(await readStepPicture(async () => Promise.reject(new Error('Computer is offline')), 'c', 'x'), null);
  assert.equal(await readStepPicture(async () => ({ data: 'not base64!' }), 'c', 'x'), null);
  assert.equal(await readStepPicture(async () => ({ data: 'A'.repeat(3_000_001) }), 'c', 'x'), null);
  assert.equal(await readStepPicture(async () => ({ data: 5 }), 'c', 'x'), null);
});

test('a step row keeps the call it stands for, saved or live, only when it has a usable id', () => {
  assert.deepEqual(callIdOf({ id: '["s","t","i"]' }), { callId: '["s","t","i"]' });
  assert.deepEqual(callIdOf({ id: 7 }), { callId: '7' });
  for (const none of [{}, { id: '' }, { id: null }, { id: 'x'.repeat(2049) }, { id: {} }]) assert.deepEqual(callIdOf(none), {});
  assert.equal(row({ role: 'step', text: 'Took a screenshot', id: 'a1' }, 'rows').callId, 'a1');
  assert.equal(row({ type: 'mcpToolCall', tool: 'computer', id: 'live-1', status: 'completed' }, 'items').callId, 'live-1');
  assert.equal('callId' in row({ role: 'step', text: 'Took a screenshot' }, 'rows'), false);
});

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const src = (host: HTMLElement) => host.querySelector('img')!.getAttribute('src');

test('enlarging a step picture reads the full capture once, shows it, and shrinking and enlarging again reuses it', async () => {
  const asks: string[] = [];
  let release!: (v: string | null) => void;
  const load = (id: string) => (asks.push(id), new Promise<string | null>((resolve) => (release = resolve)));
  const v = await mount(createElement(StepPictureProvider, { load }, createElement(StepPicture, { uri: SMALL, callId: 'c1' })));
  assert.equal(src(v.host), SMALL);
  await click('Show the screenshot larger');
  assert.deepEqual(asks, ['c1']);
  assert.equal(src(v.host), SMALL, 'the inline picture shows while the capture comes');
  await act(async () => release(FULL));
  await flush();
  assert.equal(src(v.host), FULL);
  await click('Show the screenshot smaller');
  assert.equal(src(v.host), SMALL, 'small again: the thumbnail');
  await click('Show the screenshot larger');
  assert.equal(src(v.host), FULL);
  assert.deepEqual(asks, ['c1'], 'one read per picture');
  await v.done();
});

test('a capture the Mac could not give leaves the inline picture and is asked for again on the next enlarge', async () => {
  const asks: string[] = [];
  const load = async (id: string) => (asks.push(id), null);
  const v = await mount(createElement(StepPictureProvider, { load }, createElement(StepPicture, { uri: SMALL, callId: 'c2' })));
  await click('Show the screenshot larger');
  await flush();
  assert.equal(src(v.host), SMALL);
  await click('Show the screenshot smaller');
  await click('Show the screenshot larger');
  await flush();
  assert.deepEqual(asks, ['c2', 'c2']);
  await v.done();
});

test('without a way to the Mac or a call id, enlarging just enlarges the inline picture', async () => {
  const asks: string[] = [];
  const load = async (id: string) => (asks.push(id), FULL);
  const bare = await mount(createElement(StepPicture, { uri: SMALL, callId: 'c3' }));
  await click('Show the screenshot larger');
  assert.equal(src(bare.host), SMALL);
  await bare.done();
  // a provider that is given no way to the Mac (nothing is followed) offers none either
  const idle = await mount(createElement(StepPictureProvider, {}, createElement(StepPicture, { uri: SMALL, callId: 'c4' })));
  await click('Show the screenshot larger');
  assert.equal(src(idle.host), SMALL);
  await idle.done();
  const noId = await mount(createElement(StepPictureProvider, { load }, createElement(StepPicture, { uri: SMALL })));
  await click('Show the screenshot larger');
  assert.equal(src(noId.host), SMALL);
  assert.deepEqual(asks, []);
  await noId.done();
});

test('in a chat, a step with a picture and a call id reads the capture from the Mac when its picture is enlarged', async () => {
  const asks: [string, any][] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string, params: any) => {
      asks.push([method, params]);
      if (method === 'chat.follow')
        return {
          rev: 1,
          feedSeq: 0,
          session: { turn: 'idle', cards: [] },
          itemsShape: 'rows',
          items: [
            { role: 'user', text: 'Look' },
            { role: 'step', text: 'Took a screenshot', thumbnail: SMALL, id: '["s","t","shot-1"]' },
            { role: 'assistant', text: 'Done.' },
          ],
        };
      return method === 'steps.thumbnail' ? { data: '/9j/4AAQSkZJRg==', width: 8, height: 5 } : {};
    },
  };
  withOutbox(runtime);
  const v = await mount(createElement(Thread, { runtime, chatId: 'c', back: () => {}, drafts: fakeDraft('') }));
  await flush();
  await click('Show the screenshot larger');
  await flush();
  assert.deepEqual(
    asks.filter(([m]) => m === 'steps.thumbnail'),
    [['steps.thumbnail', { chatId: 'c', callId: '["s","t","shot-1"]', maxSide: FULL_SIDE }]],
  );
  assert.equal(src(v.host), FULL);
  await v.done();
});
