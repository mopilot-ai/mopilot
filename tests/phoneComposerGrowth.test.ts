// The composer tells the app's frame how much taller than at rest it is (#5686): lines typed, files, a quote, a skill or the open voice note all leave it on a send, so the room under the sent message is made for the view the chat will have without them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, createRoot } from './support/phone/component-kit';

const composerPath = '../mobile/src/components/Composer';
const framePath = '../mobile/src/remote/frameLift';
const { Composer } = await import(composerPath);
const { ComposerGrowthContext } = await import(framePath);
const turnLinePath = '../mobile/src/components/TurnLine';
const { ChangesChip } = await import(turnLinePath);

const base = {
  draft: '',
  setDraft: () => {},
  placeholder: 'Message this chat',
  focusKey: 'k',
  autoFocus: false,
  running: false,
  disabled: false,
  stopDisabled: false,
  send: () => {},
  stop: () => {},
};

async function mount(growth: { extra: number } | null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (props: object) =>
    act(async () =>
      root.render(createElement(ComposerGrowthContext.Provider, { value: growth }, createElement(Composer, { ...base, ...props }))),
    );
  await show({});
  // the composer's own frame: the first view that hears its layout
  const layout = (height: number) =>
    act(async () =>
      ([...host.querySelectorAll('*')].find((n) => (n as any).__onLayout) as any).__onLayout({ nativeEvent: { layout: { height } } }),
    );
  return {
    show,
    layout,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('the composer’s height over its resting height, whatever makes it taller, and nothing once it goes away', async () => {
  const growth = { extra: -1 };
  const c = await mount(growth);
  await c.layout(120);
  assert.equal(growth.extra, 0, 'at rest: an empty field, nothing else');
  await c.show({ draft: 'one\ntwo\nthree' });
  await c.layout(200);
  assert.equal(growth.extra, 80, 'three lines typed');
  await c.show({ draft: '', attached: true });
  await c.layout(192);
  assert.equal(growth.extra, 72, 'two photos in the tray: they leave on the send too');
  await c.show({ draft: '', bare: false });
  await c.layout(150);
  assert.equal(growth.extra, 30, 'a quote above the field (not at rest, so the resting height is not taken from it)');
  await c.show({});
  await c.layout(120);
  assert.equal(growth.extra, 0, 'back at rest');
  await c.show({ draft: 'one line' });
  await c.layout(110);
  assert.equal(growth.extra, 0, 'squeezed below its resting height (a short screen): it gives back nothing, never less');
  await c.done();
  assert.equal(growth.extra, 0, 'gone: nothing to give back');
});

test('a composer that has not been at rest yet gives nothing back, and one with no frame around it works as before', async () => {
  const growth = { extra: -1 };
  const c = await mount(growth);
  await c.show({ draft: 'a draft restored when the chat opened' });
  await c.layout(150);
  assert.equal(growth.extra, 0, 'no resting height measured yet');
  await c.done();
  const plain = await mount(null);
  await plain.layout(120);
  await plain.done();
});

test('the Changes chip above the composer tells the frame its height while it shows, and that it is gone when a send hides it', async () => {
  const growth = { extra: 0, chip: -1 };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(
        ComposerGrowthContext.Provider,
        { value: growth },
        createElement(ChangesChip, { added: 3, removed: 1, open: () => {} }),
      ),
    ),
  );
  const view = [...host.querySelectorAll('*')].find((n) => (n as any).__onLayout) as any;
  await act(async () => view.__onLayout({ nativeEvent: { layout: { height: 48 } } }));
  assert.equal(growth.chip, 48);
  await act(async () => root.render(createElement(ComposerGrowthContext.Provider, { value: growth })));
  assert.equal(growth.chip, 0, 'hidden: nothing to give back');
  await act(async () => root.render(createElement(ChangesChip, { added: 1, removed: 0, open: () => {} })));
  await act(async () => root.unmount());
  host.remove();
});
