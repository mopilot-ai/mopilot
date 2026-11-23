// Selecting part of a message (#4825): a long press on a reply or on your own message offers Copy and Select Text; Select Text opens the message as read-only text the system selects any range of; VoiceOver has the same two actions; prose is no longer selectable whole by the system, and code and tables still are.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';

const textPath = '../mobile/src/presentation/replyText';
const bubblePath = '../mobile/src/components/MessageBubble';
const markdownPath = '../mobile/src/components/Markdown';
const momoPath = '../mobile/src/screens/MomoChat';
const i18nPath = '../mobile/src/ui/i18n';
const { selectableText } = await import(textPath);
const { MessageBubble } = await import(bubblePath);
const { MomoTranscript } = await import(momoPath);
const { showLocale } = await import(i18nPath);
const g = globalThis as any;

const REPLY =
  '# Plan\n\nFirst **bold** and [a link](https://a.io) here.\nSecond line.\n\n- one\n- two\n\n3. three\n\n> quoted\n\n```py\nprint(1)\n```\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![diagram](x.png)';

test('a reply as plain text to select from: blocks a blank line apart, list marks kept, a table as tab-separated rows, code as it is', () => {
  const plain = selectableText(REPLY);
  assert.ok(plain.startsWith('Plan\n\nFirst bold and a link here.\nSecond line.\n\n• one\n• two\n\n'), plain);
  assert.ok(plain.includes('3. three'));
  assert.ok(plain.includes('quoted'));
  assert.ok(plain.includes('print(1)'));
  assert.ok(plain.includes('a\tb\n1\t2'), 'a table row is its cells, tab-separated');
  assert.ok(plain.includes('diagram'));
  assert.ok(!plain.includes('**') && !plain.includes('](') && !plain.includes('---'));
  assert.equal(selectableText(''), '');
  // an image with no description, one by reference, and a reference definition (which draws nothing) are not harm
  assert.equal(selectableText('A ![](x.png) B'), 'A  B');
  assert.equal(selectableText('See ![the plot][p]\n\n[p]: x.png'), 'See the plot');
  assert.equal(selectableText('![][p]\n\n[p]: x.png'), '');
  assert.equal(selectableText('[p]: x.png'), '');
  assert.equal(selectableText('#'), '');
  assert.equal(selectableText('one  \ntwo'), 'one\ntwo', 'a hard break is a new line');
  assert.equal(selectableText('3. three\n4. four'), '3. three\n4. four');
  assert.equal(selectableText('```\n```'), '');
});

async function mount(node: any) {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, done: () => act(async () => root.unmount()) };
}
const pressable = (host: Element) => [...host.querySelectorAll('button')].find((b: any) => b.__press?.onLongPress) as any;

test('phone heartbeat replies display, copy and select the report while user examples stay literal', async () => {
  const report = 'Finished **two** changes.\n\n[Report](https://example.com/report)';
  const raw = `<heartbeat><automation_id>daily</automation_id><decision>NOTIFY</decision><message>${report}</message></heartbeat>`;
  for (const role of ['assistant', 'preview', 'user', 'activity']) {
    const v = await mount(createElement(MessageBubble, { role, text: raw }));
    if (role === 'assistant' || role === 'preview') {
      assert.match(v.host.textContent!, /Finished two changes/);
      assert.doesNotMatch(v.host.textContent!, /heartbeat|automation_id|NOTIFY/);
      await act(async () => pressable(v.host).__press.onLongPress());
      await act(async () => g.__actionSheet.pick(0));
      await flush();
      assert.equal(g.__clipboard, report);
      await act(async () => g.__actionSheet.pick(1));
      assert.equal((document.querySelector('[role=dialog] input') as HTMLInputElement).getAttribute('data-text'), selectableText(report));
    } else {
      assert.match(v.host.textContent!, /<heartbeat>/);
    }
    await v.done();
  }
});

test('phone live heartbeat metadata remains hidden before the report is complete', async () => {
  const v = await mount(createElement(MessageBubble, { role: 'preview', text: '<heartbeat><automation_id>daily', streaming: true }));
  assert.doesNotMatch(v.host.textContent!, /heartbeat|automation_id|daily/);
  await v.done();
});

test('a long press on a reply offers Copy and Select Text; Copy takes the reply as written; Select Text opens its plain text read-only, and Done closes it', async () => {
  const v = await mount(createElement(MessageBubble, { role: 'assistant', text: REPLY }));
  await act(async () => pressable(v.host).__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Copy', 'Select Text', 'Cancel']);
  assert.equal(g.__actionSheet.cancel, 2);
  await act(async () => g.__actionSheet.pick(0));
  await flush();
  assert.equal(g.__clipboard, REPLY);
  await act(async () => g.__actionSheet.pick(2));
  assert.equal(document.querySelector('[role=dialog]'), null, 'Cancel does nothing');
  await act(async () => g.__actionSheet.pick(1));
  const field = document.querySelector('[role=dialog] input') as HTMLInputElement;
  assert.equal(field.getAttribute('data-text'), selectableText(REPLY));
  assert.equal(field.readOnly, true, 'selectable, not editable');
  await act(async () => (document.querySelector('[role=dialog] button[aria-label="Done"]') as HTMLButtonElement).click());
  assert.equal(document.querySelector('[role=dialog]'), null);
  await v.done();
});

test('your own message has the same menu, with its words as written', async () => {
  const v = await mount(createElement(MessageBubble, { role: 'user', text: 'Please **fix** it' }));
  await act(async () => pressable(v.host).__press.onLongPress());
  await act(async () => g.__actionSheet.pick(1));
  assert.equal((document.querySelector('[role=dialog] input') as HTMLInputElement).getAttribute('data-text'), 'Please **fix** it');
  await v.done();
});

test('the menu is in the language shown', async () => {
  const v = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hi' }));
  await act(async () => showLocale('zh-Hans'));
  await act(async () => pressable(v.host).__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['复制', '选择文本', '取消']);
  await act(async () => showLocale('en'));
  await v.done();
});

test('where there is no system menu the long press goes straight to the selectable text', async () => {
  g.__phonePlatform = 'android';
  try {
    g.__actionSheet = undefined;
    const v = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Hi there' }));
    await act(async () => pressable(v.host).__press.onLongPress());
    assert.equal(g.__actionSheet, undefined);
    assert.equal((document.querySelector('[role=dialog] input') as HTMLInputElement).getAttribute('data-text'), 'Hi there');
    await v.done();
  } finally {
    g.__phonePlatform = undefined;
  }
});

test("VoiceOver has Copy and Select Text on the reply's first block and on your message, and the pressable is not an element of its own", async () => {
  const v = await mount(createElement(MessageBubble, { role: 'assistant', text: 'First\n\nSecond' }));
  assert.equal(pressable(v.host).getAttribute('aria-label'), null);
  const first = [...v.host.querySelectorAll('span')].find((s: any) => s.textContent === 'First') as any;
  const second = [...v.host.querySelectorAll('span')].find((s: any) => s.textContent === 'Second') as any;
  assert.equal(typeof first.__onAccessibilityAction, 'function', 'the first block carries the actions');
  assert.equal(second.__onAccessibilityAction, undefined, 'the others stay plain');
  await act(async () => first.__onAccessibilityAction({ nativeEvent: { actionName: 'copy' } }));
  await flush();
  assert.equal(g.__clipboard, 'First\n\nSecond');
  await act(async () => first.__onAccessibilityAction({ nativeEvent: { actionName: 'selectText' } }));
  assert.ok(document.querySelector('[role=dialog] input'));
  await v.done();
  const mine = await mount(createElement(MessageBubble, { role: 'user', text: 'Mine' }));
  const own = [...mine.host.querySelectorAll('span')].find((s: any) => s.textContent === 'Mine') as any;
  assert.equal(typeof own.__onAccessibilityAction, 'function');
  await mine.done();
});

test("a reply's prose, code and tables are not selectable whole by the system, so one long press opens one menu", async () => {
  const v = await mount(createElement(MessageBubble, { role: 'assistant', text: 'Words\n\n```\ncode\n```\n\n| a |\n|---|\n| 1 |' }));
  const mark = (text: string) =>
    ([...v.host.querySelectorAll('span')].find((s: any) => s.textContent === text) as any)?.getAttribute('data-selectable');
  assert.equal(mark('Words'), 'false');
  assert.equal(mark('code'), 'false', "the app's menu is the only one on a code block");
  assert.equal(mark('1'), 'false', 'and on a table cell');
  await v.done();
});

test("MoMo's replies and your lines there have the same menu", async () => {
  const rows = [
    { kind: 'message', key: 'a', row: { key: 'a', role: 'user', text: 'Remind me' } },
    { kind: 'message', key: 'b', row: { key: 'b', role: 'assistant', text: 'Sure, tomorrow.' } },
  ];
  const v = await mount(
    createElement(MomoTranscript, {
      rows,
      cards: [],
      answeredOnMac: [],
      answer: async () => true,
      act: () => {},
      canAct: true,
      working: false,
      progress: null,
    }),
  );
  const presses = [...v.host.querySelectorAll('button')].filter((b: any) => b.__press?.onLongPress) as any[];
  assert.equal(presses.length, 2);
  for (const [i, said] of ['Remind me', 'Sure, tomorrow.'].entries()) {
    await act(async () => presses[i].__press.onLongPress());
    await act(async () => g.__actionSheet.pick(1));
    assert.equal((document.querySelector('[role=dialog] input') as HTMLInputElement).getAttribute('data-text'), said);
    await act(async () => (document.querySelector('[role=dialog] button[aria-label="Done"]') as HTMLButtonElement).click());
  }
  await v.done();
});

test('a long press on a code block offers Copy code, on a table Copy table (tab-separated rows), each with Copy and Select Text; elsewhere the menu is unchanged', async () => {
  const text = 'Words\n\n```py\nprint(1)\nprint(2)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const v = await mount(createElement(MessageBubble, { role: 'assistant', text }));
  const holders = [...v.host.querySelectorAll('button')].filter((b: any) => b.__press?.onLongPress) as any[];
  // the outermost is the reply; a code block and a table each have their own
  assert.equal(holders.length, 3);
  const [reply, code, table] = holders;
  await act(async () => code.__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Copy code', 'Copy', 'Select Text', 'Cancel']);
  assert.equal(g.__actionSheet.cancel, 3);
  await act(async () => g.__actionSheet.pick(0));
  await flush();
  assert.equal(g.__clipboard, 'print(1)\nprint(2)');
  await act(async () => table.__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Copy table', 'Copy', 'Select Text', 'Cancel']);
  await act(async () => g.__actionSheet.pick(0));
  await flush();
  assert.equal(g.__clipboard, 'a\tb\n1\t2');
  await act(async () => table.__press.onLongPress());
  await act(async () => g.__actionSheet.pick(1));
  await flush();
  assert.equal(g.__clipboard, text, 'Copy is still the whole message');
  await act(async () => reply.__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Copy', 'Select Text', 'Cancel']);
  await act(async () => g.__actionSheet.pick(2));
  assert.equal(document.querySelector('[role=dialog]'), null);
  await act(async () => code.__press.onLongPress());
  await act(async () => g.__actionSheet.pick(2));
  assert.ok(document.querySelector('[role=dialog] input'), 'Select Text from a code block opens the sheet');
  await v.done();
});

test('a plain Markdown card still selects code and tables natively, and a long press there does nothing of its own', async () => {
  const { Markdown } = await import(markdownPath);
  const v = await mount(createElement(Markdown, { text: '```\ncode\n```\n\n| a |\n|---|\n| 1 |' }));
  const mark = (t: string) =>
    ([...v.host.querySelectorAll('span')].find((s: any) => s.textContent === t) as any)?.getAttribute('data-selectable');
  assert.equal(mark('code'), 'true');
  assert.equal(mark('1'), 'true');
  const holders = [...v.host.querySelectorAll('button')].filter((b: any) => b.__press?.onLongPress) as any[];
  g.__actionSheet = undefined;
  await act(async () => holders.forEach((h) => h.__press.onLongPress()));
  assert.equal(g.__actionSheet, undefined);
  await v.done();
});

test('where the chat has a composer a long press on a code block or a table starts with Ask, which hands over the block’s words; the whole message has no Ask', async () => {
  const { ReplyContext } = await import('../mobile/src/replyContext');
  const text = 'Words\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const asked: string[] = [];
  const v = await mount(
    createElement(
      ReplyContext.Provider,
      { value: (s: string) => asked.push(s) },
      createElement(MessageBubble, { role: 'assistant', text }),
    ),
  );
  const holders = [...v.host.querySelectorAll('button')].filter((b: any) => b.__press?.onLongPress) as any[];
  const [reply, code, table] = holders;
  await act(async () => code.__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Ask', 'Copy code', 'Copy', 'Select Text', 'Cancel']);
  await act(async () => g.__actionSheet.pick(0));
  await act(async () => table.__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Ask', 'Copy table', 'Copy', 'Select Text', 'Cancel']);
  await act(async () => g.__actionSheet.pick(0));
  assert.deepEqual(asked, ['print(1)', 'a\tb\n1\t2']);
  await act(async () => reply.__press.onLongPress());
  assert.deepEqual(g.__actionSheet.options, ['Copy', 'Select Text', 'Cancel'], 'no selection, no Ask');
  await v.done();
});
