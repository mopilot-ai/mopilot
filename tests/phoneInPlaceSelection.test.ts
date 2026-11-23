// In-place selection (#4837): with the native view, a reply's prose draws as native runs (links open as everywhere else, the menu's own entry copies the message), the other blocks keep their views and open the reply's menu, and with the flag off or no native view nothing changes.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
/** The native view in the test DOM: a div that keeps its props, newest last, for a test to drive. */
function FakeNative(props: any) {
  (g.__nativeRuns ??= []).push(props);
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}
mock.module(require.resolve('expo'), { namedExports: { requireNativeView: () => FakeNative } });
const nativePath = '../mobile/src/platform/selectableTextNative';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const bubblePath = '../mobile/src/components/MessageBubble';
const markdownPath = '../mobile/src/components/Markdown';
const linksPath = '../mobile/src/chatLinks';
const gatePath = '../mobile/src/presentation/nativeGate';
await import(nativePath);
const { setInPlaceSelection, inPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const { Markdown } = await import(markdownPath);
const { ChatLinkContext } = await import(linksPath);
const { nativeGate, MENU_GRACE, MENU_WAIT } = await import(gatePath);

async function mount(node: any) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, done: () => act(async () => root.unmount()) };
}
const REPLY =
  'Hello **world** and [a chat](mopilot:chat/claude:c2).\n\n- one\n- two\n\n```py\nprint(1)\n```\n\nAfter the code.\n\n> a quote\n\n| a |\n|---|\n| 1 |';

test('the flag is off until the build turns it on, and then needs the native view', () => {
  assert.equal(inPlaceSelection(), false);
  setInPlaceSelection(true);
  assert.equal(inPlaceSelection(), true);
  setInPlaceSelection(false);
  assert.equal(inPlaceSelection(), false);
});

test('with the flag on, stretches of prose are native runs and code and quotes keep their own views and a table’s cells are runs', async () => {
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  try {
    const v = await mount(createElement(MessageBubble, { role: 'assistant', text: REPLY }));
    const runs = [...v.host.querySelectorAll('[data-native-run]')].map((d) => d.getAttribute('data-native-run'));
    // the table's cells are native runs too (#5359): one each
    assert.deepEqual(runs, ['Hello world and a chat.\n•\tone\n•\ttwo', 'After the code.', 'a', '1']);
    assert.ok(v.host.textContent!.includes('print(1)'), 'the code block is drawn as before');
    assert.ok(v.host.textContent!.includes('a quote'));
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('with the flag off the reply is drawn as before, with no native run', async () => {
  g.__nativeRuns = [];
  const v = await mount(createElement(MessageBubble, { role: 'assistant', text: REPLY }));
  assert.equal(v.host.querySelectorAll('[data-native-run]').length, 0);
  assert.equal(g.__nativeRuns.length, 0);
  assert.ok(v.host.textContent!.includes('Hello'));
  await v.done();
});

test('a run sizes itself to the height the view reports, opens a link as a link in a reply does, and its menu entry copies the message', async () => {
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  g.__openedUrls = [];
  const opened: string[] = [];
  try {
    const v = await mount(
      createElement(
        ChatLinkContext.Provider,
        { value: (id: string) => opened.push(id) },
        createElement(MessageBubble, { role: 'assistant', text: REPLY }),
      ),
    );
    const first = () => g.__nativeRuns.filter((p: any) => p.runs[0].t === 'Hello ').at(-1);
    assert.equal(first().style.height, 26, 'a line until the view says');
    // Select Text stays an action of the native text for VoiceOver (the reply's React text had it), and is not a line of the menu
    assert.deepEqual(first().menuEntries, [
      { id: 'copyMessage', title: 'Copy message' },
      { id: 'selectText', title: 'Select Text', vo: '1' },
    ]);
    // until the view has measured its text the reply stays as React draws it, the native view laying out unseen beside it (no reply at a line's height)
    const holder = () => v.host.querySelector('[data-native-run^="Hello "]')!.parentElement!;
    assert.ok(v.host.textContent!.includes('Hello world and a chat.'), 'the reply is still drawn by React');
    assert.deepEqual(JSON.parse(holder().getAttribute('data-style')!), { position: 'absolute', top: 0, left: 0, right: 0, opacity: 0 });
    assert.deepEqual(
      [holder().getAttribute('pointer-events'), holder().getAttribute('importantforaccessibility')],
      ['none', 'no-hide-descendants'],
      'unseen means untouchable and unread',
    );
    await act(async () => first().onContentSize({ nativeEvent: { height: 81.33, width: 300 } }));
    assert.equal(first().style.height, 81.33);
    // both swap in the one commit: the React blocks of that run are gone and the native view is in the layout
    assert.ok(!v.host.textContent!.includes('Hello world and a chat.'), 'the React drawing of the run is gone');
    assert.equal(holder().getAttribute('data-style'), null);
    assert.deepEqual([holder().getAttribute('pointer-events'), holder().getAttribute('importantforaccessibility')], ['auto', 'auto']);
    assert.ok(v.host.textContent!.includes('print(1)'), 'the blocks that are not runs stay');
    // a chat link opens the chat; any other link goes to iOS
    await act(async () => first().onLinkPress({ nativeEvent: { url: 'mopilot:chat/claude:c2' } }));
    await act(async () => first().onLinkPress({ nativeEvent: { url: 'https://a.io/x' } }));
    assert.deepEqual(opened, ['claude:c2']);
    assert.deepEqual(g.__openedUrls, ['https://a.io/x']);
    // an address that is not opened (a phone number, a custom scheme) does nothing on a tap
    await act(async () => first().onLinkPress({ nativeEvent: { url: 'tel:+15551234' } }));
    assert.deepEqual([opened.length, g.__openedUrls.length], [1, 1]);
    // a long press offers Open in browser and Copy link, as a link in a reply still streaming does; each does what it says
    g.__actionSheet = undefined;
    await act(async () => first().onLinkPress({ nativeEvent: { url: 'https://a.io/y', menu: '1' } }));
    assert.deepEqual(g.__actionSheet.options, ['Open in browser', 'Copy link', 'Cancel']);
    await act(async () => g.__actionSheet.pick(0));
    assert.deepEqual(g.__openedUrls, ['https://a.io/x', 'https://a.io/y']);
    g.__actionSheet = undefined;
    await act(async () => first().onLinkPress({ nativeEvent: { url: 'mopilot:chat/claude:c3', menu: '1' } }));
    await act(async () => g.__actionSheet.pick(0));
    assert.deepEqual(opened, ['claude:c2', 'claude:c3']);
    // a link that is not opened offers only Copy link
    g.__actionSheet = undefined;
    await act(async () => first().onLinkPress({ nativeEvent: { url: 'tel:+15551234', menu: '1' } }));
    assert.deepEqual(g.__actionSheet.options, ['Copy link', 'Cancel']);
    await act(async () => g.__actionSheet.pick(0));
    await flush();
    assert.equal(g.__clipboard, 'tel:+15551234');
    await act(async () => first().onMenuAction({ nativeEvent: { id: 'copyMessage' } }));
    await flush();
    assert.equal(g.__clipboard, REPLY);
    // VoiceOver's Select Text opens the same read-only text as the sheet's
    assert.equal(document.querySelector('[role=dialog]'), null);
    await act(async () => first().onMenuAction({ nativeEvent: { id: 'selectText' } }));
    assert.ok(document.querySelector('[role=dialog] input'), 'the text the system selects any range of');
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('beside native runs a long press on a quote opens Copy and Select Text, on code its own menu, and with no native view under the finger on the reply and the table the same', async () => {
  setInPlaceSelection(true);
  try {
    const v = await mount(createElement(MessageBubble, { role: 'assistant', text: REPLY }));
    const all = [...v.host.querySelectorAll('button')].filter((b: any) => b.__press?.onLongPress) as any[];
    // the reply's own holder contains the table too: the table's is the innermost
    const table = all.filter((b) => b.querySelector('[role="grid"]')).at(-1);
    // no touch has begun on a shown native view: a press on the table is the table's menu, never nothing
    nativeGate.touch(false);
    g.__actionSheet = undefined;
    await act(async () => table.__press.onLongPress());
    assert.ok(g.__actionSheet, 'the table’s own menu');
    // a native cell under the finger answers it itself
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      nativeGate.touch(true);
      g.__actionSheet = undefined;
      await act(async () => table.__press.onLongPress());
      nativeGate.answer();
      await act(async () => mock.timers.tick(MENU_WAIT));
      assert.equal(g.__actionSheet, undefined, 'the cell showed its menu');
      // and one that shows nothing leaves the table's menu after the wait
      nativeGate.touch(true);
      await act(async () => table.__press.onLongPress());
      assert.equal(g.__actionSheet, undefined, 'not before the view has had its time');
      await act(async () => mock.timers.tick(MENU_WAIT));
      assert.ok(g.__actionSheet, 'the table’s menu, never nothing');
    } finally {
      mock.timers.reset();
    }
    g.__actionSheet = undefined;
    nativeGate.touch(false);
    // the reply as a whole, the quote and the code block: each opens its menu when no native view is under the finger
    const holders = all.filter((b) => b !== table);
    assert.equal(holders.length, 3);
    const options = async (holder: any) => {
      await act(async () => holder.__press.onLongPress());
      return g.__actionSheet.options;
    };
    const kinds: string[][] = [];
    for (const h of holders) {
      g.__actionSheet = undefined;
      kinds.push((await options(h)) ?? [`nothing for ${h.textContent}`]);
    }
    assert.ok(kinds.some((o) => o[0] === 'Copy code'));
    // under a shown native view the quote and the code block open nothing of their own (a second menu): the holders that hold no other holder
    nativeGate.touch(true);
    for (const h of holders.filter((b) => !holders.some((o) => o !== b && b.contains(o)))) {
      g.__actionSheet = undefined;
      await act(async () => h.__press.onLongPress());
      assert.equal(g.__actionSheet, undefined, `no second menu from ${h.textContent}`);
    }
    nativeGate.touch(false);
    assert.ok(
      kinds.filter((o) => o.length === 3 && o[0] === 'Copy' && o[1] === 'Select Text').length === 2,
      `the quote and the reply: the reply’s own menu ${JSON.stringify(kinds)}`,
    );
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('a long press is never left with nothing: the sheet opens on React text, beside the runs, and on a shown native run the view does not answer, and stays shut when it does (#5369)', async () => {
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const v = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hello world' }));
    const holder = () => [...v.host.querySelectorAll('button')].find((b: any) => b.__press?.onLongPress) as any;
    const touched = [...v.host.querySelectorAll('div')].filter((d: any) => d.__touchStartCapture) as any[];
    const [outer, run] = touched;
    const SHEET = ['Copy', 'Select Text', 'Cancel'];
    /** a touch: where it began, whether the finger lifts, whether the view answers (a menu shown) */
    const pressed = async ({ onRun, lifts = false, answers = false }: { onRun: boolean; lifts?: boolean; answers?: boolean }) => {
      g.__actionSheet = undefined;
      await act(async () => outer.__touchStartCapture());
      if (onRun) await act(async () => run.__touchStartCapture());
      await act(async () => holder().__press.onLongPress());
      if (answers) await act(async () => g.__nativeRuns.at(-1).onMenuShown());
      if (lifts) await act(async () => outer.__touchEnd());
      await act(async () => mock.timers.tick(MENU_WAIT + MENU_GRACE));
      return g.__actionSheet?.options;
    };
    // the run is not native yet (the view has not measured its text): the press on it is the app's sheet, at once
    assert.deepEqual(await pressed({ onRun: true }), SHEET, 'before the run is native');
    assert.deepEqual(await pressed({ onRun: false }), SHEET, 'beside the runs');
    // the view measured its text and is shown
    await act(async () => g.__nativeRuns.at(-1).onContentSize({ nativeEvent: { height: 40, width: 300 } }));
    assert.equal(await pressed({ onRun: true, answers: true }), undefined, 'on a shown native run that presents its menu: its menu only');
    assert.equal(await pressed({ onRun: true, lifts: true, answers: true }), undefined, 'and the same when the finger lifted first');
    // words selected without a menu yet (a handle held still) answer too
    g.__actionSheet = undefined;
    await act(async () => outer.__touchStartCapture());
    await act(async () => run.__touchStartCapture());
    await act(async () => holder().__press.onLongPress());
    await act(async () => g.__nativeRuns.at(-1).onSelect());
    await act(async () => mock.timers.tick(MENU_WAIT + MENU_GRACE));
    assert.equal(g.__actionSheet, undefined, 'a selection in progress');
    // the view shows nothing (a blank stretch of it, a recogniser that failed): the sheet, once, within the wait
    assert.deepEqual(await pressed({ onRun: true }), SHEET, 'a shown native run that answers nothing');
    assert.deepEqual(await pressed({ onRun: true, lifts: true }), SHEET, 'and with the finger up');
    // the next touch is not on a run again: the sheet at once
    assert.deepEqual(await pressed({ onRun: false }), SHEET, 'the claim does not outlive its touch');
    // a touch that is taken by a scroll (cancelled) ends the wait like a lift
    g.__actionSheet = undefined;
    await act(async () => outer.__touchStartCapture());
    await act(async () => run.__touchStartCapture());
    await act(async () => holder().__press.onLongPress());
    await act(async () => outer.__touchCancel());
    await act(async () => mock.timers.tick(MENU_GRACE));
    assert.deepEqual(g.__actionSheet?.options, SHEET, 'a cancelled touch with no answer');
    await v.done();
  } finally {
    mock.timers.reset();
    setInPlaceSelection(false);
  }
});

test('your own message keeps its menu with the flag on', async () => {
  setInPlaceSelection(true);
  try {
    const v = await mount(createElement(MessageBubble, { role: 'user', text: 'Mine' }));
    const holder = [...v.host.querySelectorAll('button')].find((b: any) => b.__press?.onLongPress) as any;
    await act(async () => holder.__press.onLongPress());
    assert.deepEqual(g.__actionSheet.options, ['Copy', 'Select Text', 'Cancel']);
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('a plain Markdown card with the flag off is unchanged, and one with inPlace draws runs', async () => {
  g.__nativeRuns = [];
  const plain = await mount(createElement(Markdown, { text: 'Just a **paragraph**.' }));
  assert.equal(plain.host.querySelectorAll('[data-native-run]').length, 0);
  await plain.done();
  const native = await mount(
    createElement(Markdown, { text: 'Just a **paragraph**.', inPlace: { copyMessage: () => undefined, selectText: () => undefined } }),
  );
  assert.equal(native.host.querySelectorAll('[data-native-run]').length, 1);
  await native.done();
});

test('a reply still streaming stays on the React blocks (with their word fade and the long-press menu) and becomes native runs once it is no longer streaming', async () => {
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  try {
    const live = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hello **world** again.', streaming: true }));
    assert.equal(live.host.querySelectorAll('[data-native-run]').length, 0, 'no native run while streaming');
    assert.ok(live.host.textContent!.includes('Hello world again.'), 'the React blocks draw the words');
    await live.done();
    const done = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hello **world** again.', streaming: false }));
    assert.equal(done.host.querySelectorAll('[data-native-run]').length, 1, 'native once the turn has ended');
    await done.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('a height the native view reports before it has laid its text out (less than a line) is not taken: the run stays on the React text until it has measured', async () => {
  setInPlaceSelection(true);
  g.__nativeRuns = [];
  try {
    const v = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hello world' }));
    const run = () => (g.__nativeRuns as any[]).at(-1);
    const shown = () => v.host.textContent;
    await act(async () => run().onContentSize({ nativeEvent: { height: 14, width: 370 } }));
    assert.ok(String(shown()).includes('Hello world'));
    assert.equal(run().style.height, 26, 'still unmeasured: the line it was given');
    await act(async () => run().onContentSize({ nativeEvent: { height: 52, width: 370 } }));
    assert.equal(run().style.height, 52, 'its real height once it has laid the text out');
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});
