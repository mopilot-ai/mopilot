// A chat's composer on the phone: the / menu of commands and skills and the @ menu of chats and files open as one types, a pick changes the draft, a skill rides beside the message, and a menu the computer lacks is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useState } from 'react';
import { act, createElement, createRoot, flush, click, inputText } from './support/phone/component-kit';
import { withOutbox } from './support/phone/outbox-kit';
import { fakeDraft } from './support/phone/drafts';
const phoneModulePath = '../mobile/src/screens/Thread';
const hookPath = '../mobile/src/remote/useComposerMenu';
const { Thread } = await import(phoneModulePath);
const { useComposerMenu } = await import(hookPath);

const COMMANDS = [
  { name: 'review', description: 'Review the changes', hint: '[focus]', kind: 'command', as: 'text' },
  { name: 'compact', description: '', hint: '', kind: 'command', as: 'text' },
  { name: 'pdf', description: 'Read PDF files', hint: '', kind: 'skill', as: 'skill' },
];
const LISTS = {
  chats: [{ id: 'claude:abc', title: 'Kyoto trip' }],
  files: [
    { path: 'src/price.ts', name: 'price.ts', directory: false },
    { path: 'src', name: 'src', directory: true },
  ],
};
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const mounted: any[] = [];
async function mount(o: { methods?: string[] | null; answer?: (method: string, p: any) => unknown; chatId?: string } = {}) {
  for (const old of mounted.splice(0)) await act(async () => old.unmount());
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  const calls: [string, any][] = [];
  let store: ReturnType<typeof fakeDraft> | undefined;
  const state = {
    get draft() {
      return store?.get() ?? '';
    },
  };
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: () => () => {},
    request: async (method: string, p: any) => {
      calls.push([method, p]);
      const custom = o.answer?.(method, p);
      if (custom !== undefined) {
        if (custom instanceof Error) throw custom;
        return custom;
      }
      if (method === 'chat.follow') return { rev: 1, feedSeq: 0, session: { turn: 'idle', cards: [] }, itemsShape: 'rows', items: [] };
      if (method === 'machine.hello')
        return { capabilities: { methods: o.methods === undefined ? ['commands.list', 'mentions.list'] : o.methods } };
      if (method === 'commands.list') return { commands: COMMANDS };
      if (method === 'mentions.list') return LISTS;
      return {};
    },
  };
  withOutbox(runtime);
  function Harness({ chatId }: { chatId: string }) {
    const [drafts] = useState(() => (store = fakeDraft('')));
    return createElement(Thread, {
      runtime,
      chatId,
      back: () => {},
      drafts,
    });
  }
  const show = (chatId: string) => act(async () => root.render(createElement(Harness, { chatId })));
  await show(o.chatId ?? 'c');
  await flush();
  const type = async (text: string) => {
    await inputText('Message this chat', text);
    await flush();
  };
  const rows = () => [...document.querySelectorAll('[role="menuitem"]')].map((r) => r.getAttribute('aria-label'));
  return {
    host,
    calls,
    state,
    type,
    rows,
    show,
    asked: (method: string) => calls.filter(([m]) => m === method),
    row: (label: RegExp) =>
      [...document.querySelectorAll('[role="menuitem"]')].find((r) => label.test(r.getAttribute('aria-label') ?? '')) as HTMLElement,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('typing / lists the chat’s commands with a short line each, narrows as one types, and a pick types /name', async () => {
  const t = await mount();
  await t.type('/');
  assert.deepEqual(t.asked('commands.list'), [['commands.list', { chatId: 'c' }]]);
  assert.deepEqual(t.rows(), ['Command /review, Review the changes', 'Command /compact', 'Skill /pdf, Read PDF files']);
  assert.equal(document.querySelector('[role="menu"]')?.getAttribute('aria-label'), 'Commands');
  assert.match(t.host.textContent!, /\/review \[focus\]/);
  await t.type('/co');
  assert.deepEqual(t.rows(), ['Command /compact']);
  assert.equal(t.asked('commands.list').length, 1, 'narrowing does not ask the computer again');
  await act(async () => t.row(/compact/).click());
  await flush();
  assert.equal(t.state.draft, '/compact ');
  assert.deepEqual(t.rows(), [], 'the menu is closed after a pick');
  assert.equal((document.querySelector('input[placeholder="Message this chat"]') as HTMLInputElement).value, '/compact ');
  await t.done();
});

test('a skill beside the message is a chip, not text; it goes with the message, and its chip can be removed', async () => {
  const t = await mount();
  await t.type('/pd');
  await act(async () => t.row(/pdf/).click());
  await flush();
  assert.equal(t.state.draft, '');
  assert.ok(document.querySelector('button[aria-label="Remove skill pdf"]'), 'the skill is named on a chip');
  await t.type('summarize this');
  await click('Send');
  const sent = t.asked('chat.send')[0][1];
  assert.equal(sent.text, 'summarize this');
  assert.deepEqual(sent.skills, ['pdf']);
  assert.equal(document.querySelector('button[aria-label="Remove skill pdf"]'), null, 'the skill went with the message');
  // a chip removed before sending
  await t.type('/pd');
  await act(async () => t.row(/pdf/).click());
  await flush();
  await click('/pdf ×');
  assert.equal(document.querySelector('button[aria-label="Remove skill pdf"]'), null);
  await t.type('plain');
  await click('Send');
  assert.equal(t.asked('chat.send')[1][1].skills, undefined, 'no skill, none sent');
  await t.done();
});

test('the menu follows the caret, not the end of the text: a / typed before other words opens it, moving away closes it', async () => {
  const t = await mount();
  await t.type('/re and more');
  assert.deepEqual(t.rows(), [], 'the caret is at the end, after "more"');
  const input = document.querySelector('input[placeholder="Message this chat"]') as any;
  const caretAt = async (n: number) => {
    await act(async () => input.__selectionChange({ nativeEvent: { selection: { start: n, end: n } } }));
    await flush();
  };
  await caretAt(3);
  assert.deepEqual(t.rows(), ['Command /review, Review the changes']);
  await caretAt(12);
  assert.deepEqual(t.rows(), []);
  await caretAt(3);
  await act(async () => t.row(/review/).click());
  await flush();
  assert.equal(t.state.draft, '/review and more');
  const told = input.__selections.filter(Boolean);
  assert.deepEqual(told, [{ start: 8, end: 8 }], 'the field is told once where the caret goes');
  assert.equal(input.__selections.at(-1), undefined, 'and let go of it once it is there');
  await t.done();
});

test('the same skill picked twice is one chip, and a pick with no menu open changes nothing', async () => {
  const t = await mount();
  for (let i = 0; i < 2; i++) {
    await t.type('/pd');
    await act(async () => t.row(/pdf/).click());
    await flush();
  }
  assert.equal(document.querySelectorAll('button[aria-label="Remove skill pdf"]').length, 1);
  // a press that arrives after the menu was closed (the caret moved on) does nothing
  const seen: any[] = [];
  const draftBefore = t.state.draft;
  // stable functions: a new one on each render would reset the hook on each render
  const noRequest = async () => ({});
  const noDraft = (text: string) => seen.push(text);
  function Probe() {
    const menu = useComposerMenu(noRequest, 'c', '', noDraft);
    seen.push(menu);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await act(async () =>
    seen.find((x) => typeof x === 'object').pick({ name: 'review', description: '', hint: '', skill: false, as: 'text' }),
  );
  assert.deepEqual(
    seen.filter((x) => typeof x === 'string'),
    [],
  );
  assert.equal(t.state.draft, draftBefore);
  await act(async () => root.unmount());
  await t.done();
});

test('an edit made at the caret moves it along with the letter typed, so the menu stays where the person is typing', async () => {
  const t = await mount();
  await t.type('/re and more');
  assert.deepEqual(t.rows(), [], 'the caret is at the end, after "more"');
  const input = document.querySelector('input[placeholder="Message this chat"]') as any;
  await act(async () => input.__selectionChange({ nativeEvent: { selection: { start: 3, end: 3 } } }));
  await flush();
  assert.deepEqual(t.rows(), ['Command /review, Review the changes']);
  // a letter typed at the caret, with no new report of the caret yet
  await t.type('/rev and more');
  assert.deepEqual(t.rows(), ['Command /review, Review the changes'], 'the caret moved to after "rev"');
  await t.type('/re and more');
  assert.deepEqual(t.rows(), ['Command /review, Review the changes'], 'and back with a letter taken away');
  await t.done();
});

test('rows shown for what was typed before cannot be pressed while the list for what is typed now is on its way', async () => {
  const t = await mount();
  await t.type('@a');
  await wait(200);
  assert.equal(t.rows().length, 3);
  await t.type('@ab');
  const row = t.row(/price/) as HTMLButtonElement;
  assert.equal(row.disabled, true);
  await act(async () => row.click());
  assert.equal(t.state.draft, '@ab', 'nothing was picked');
  await wait(200);
  assert.equal((t.row(/price/) as HTMLButtonElement).disabled, false);
  await t.done();
});

test('an eleventh skill is refused with a message and the typed word stays', async () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ name: `skill${i}`, description: '', hint: '', kind: 'skill', as: 'skill' }));
  const t = await mount({ answer: (method) => (method === 'commands.list' ? { commands: many } : undefined) });
  for (let i = 0; i < 10; i++) {
    await t.type(`/skill${i}`);
    await act(async () => t.row(new RegExp(`/skill${i}$`)).click());
    await flush();
  }
  assert.equal(document.querySelectorAll('button[aria-label^="Remove skill"]').length, 10);
  await t.type('/skill10');
  await act(async () => t.row(/skill10/).click());
  await flush();
  assert.match(t.host.textContent!, /A message carries up to 10 skills\./);
  assert.equal(t.state.draft, '/skill10');
  assert.equal(document.querySelectorAll('button[aria-label^="Remove skill"]').length, 10);
  // one already carried is no new one
  await t.type('/skill3');
  await act(async () => t.row(/skill3/).click());
  await flush();
  assert.equal(t.state.draft, '');
  await t.done();
});

test('a list that arrives after another chat took over is not kept for it', async () => {
  const waiting: Record<string, (v: unknown) => void> = {};
  const t = await mount({
    answer: (method, p) =>
      method === 'commands.list'
        ? p.chatId === 'c'
          ? new Promise((resolve) => (waiting.c = resolve))
          : { commands: COMMANDS }
        : undefined,
  });
  await t.type('/');
  await t.show('d');
  await flush();
  assert.equal(t.rows().length, 3, 'the new chat read its own list');
  await act(async () => waiting.c({ commands: [{ name: 'ghost', description: '', hint: '', kind: 'command', as: 'text' }] }));
  await flush();
  await t.type('/g');
  assert.deepEqual(t.rows(), [], 'the old chat’s list was not kept');
  assert.deepEqual(
    t.asked('commands.list').map(([, p]) => p.chatId),
    ['c', 'd'],
  );
  await t.done();
});

test('after other text a / lists only skills', async () => {
  const t = await mount();
  await t.type('read this /');
  assert.deepEqual(t.rows(), ['Skill /pdf, Read PDF files']);
  await t.done();
});

test('typing @ lists the chat’s other chats and files after a short pause; a file types @path, a folder @path/, a chat the app’s link', async () => {
  const t = await mount();
  await t.type('see @pr');
  assert.equal(t.asked('mentions.list').length, 0, 'not yet: the person is still typing');
  await wait(200);
  assert.deepEqual(t.asked('mentions.list'), [['mentions.list', { chatId: 'c', query: 'pr' }]]);
  assert.deepEqual(t.rows(), ['Chat Kyoto trip', 'File src/price.ts', 'Folder src']);
  assert.equal(document.querySelector('[role="menu"]')?.getAttribute('aria-label'), 'Chats and files');
  await act(async () => t.row(/price/).click());
  await flush();
  assert.equal(t.state.draft, 'see @src/price.ts ');
  await wait(200);
  assert.deepEqual(t.rows(), [], 'the mention just picked does not open the menu again');
  assert.equal(t.asked('mentions.list').length, 1);
  // a folder, and a chat
  await t.type('@sr');
  await wait(200);
  await act(async () => t.row(/Folder/).click());
  await flush();
  assert.equal(t.state.draft, '@src/ ');
  await t.type('ask @ky');
  await wait(200);
  await act(async () => t.row(/Kyoto/).click());
  await flush();
  assert.equal(t.state.draft, 'ask [Kyoto trip](session://claude%3Aabc) ');
  await click('Send');
  assert.equal(
    t.asked('chat.send')[0][1].text,
    'ask [Kyoto trip](session://claude%3Aabc) ',
    'the message carries the link, as the app’s composer writes it',
  );
  await t.done();
});

test('typing on while a list is on its way shows only the list for what is there now', async () => {
  const waiting: Record<string, (v: unknown) => void> = {};
  const t = await mount({
    answer: (method, p) => (method === 'mentions.list' ? new Promise((resolve) => (waiting[p.query] = resolve)) : undefined),
  });
  await t.type('@a');
  await wait(200);
  assert.match(t.host.textContent!, /Loading…/);
  await t.type('@ab');
  await wait(200);
  await act(async () => waiting.ab({ chats: [], files: [{ path: 'ab.ts', name: 'ab.ts', directory: false }] }));
  await act(async () => waiting.a({ chats: [], files: [{ path: 'a.ts', name: 'a.ts', directory: false }] }));
  await flush();
  assert.deepEqual(t.rows(), ['File ab.ts']);
  await t.done();
});

test('a menu with nothing to list says so, and one that cannot be read says why and keeps the draft', async () => {
  let fail = false;
  const t = await mount({
    answer: (method) => {
      if (method === 'commands.list') return fail ? new Error('Your computer is offline.') : { commands: [] };
      if (method === 'mentions.list') return { chats: [], files: [] };
    },
  });
  await t.type('/');
  assert.match(t.host.textContent!, /No commands here\./);
  await t.type('hello @zzz');
  await wait(200);
  assert.match(t.host.textContent!, /No chats or files match\./);
  fail = true;
  await t.type('');
  await t.type('/');
  assert.match(t.host.textContent!, /Your computer is offline\./);
  assert.doesNotMatch(t.host.textContent!, /No commands here/);
  assert.equal(t.state.draft, '/', 'the draft is untouched');
  await t.done();
});

test('a computer without a menu shows none and is not asked for it; one that did not say is tried', async () => {
  const none = await mount({ methods: ['chat.send'] });
  await none.type('/');
  await none.type('@a');
  await wait(200);
  assert.deepEqual(none.rows(), []);
  assert.equal(none.asked('commands.list').length + none.asked('mentions.list').length, 0);
  assert.equal(document.querySelector('[role="menu"]'), null);
  await none.done();
  const unknown = await mount({ methods: null });
  await unknown.type('/');
  assert.equal(unknown.rows().length, 3);
  await unknown.done();
});

test('another chat has its own menus and skills', async () => {
  const t = await mount();
  await t.type('/pd');
  await act(async () => t.row(/pdf/).click());
  await flush();
  assert.ok(document.querySelector('button[aria-label="Remove skill pdf"]'));
  await t.show('d');
  await flush();
  assert.equal(document.querySelector('button[aria-label="Remove skill pdf"]'), null);
  await t.type('/');
  assert.deepEqual(
    t.asked('commands.list').map(([, p]) => p.chatId),
    ['c', 'd'],
    'the new chat reads its own list',
  );
  await t.done();
});

test('closing and reopening slash retires the old command read even in the same chat', async () => {
  const waiting: ((v: unknown) => void)[] = [];
  const t = await mount({ answer: (method) => (method === 'commands.list' ? new Promise((resolve) => waiting.push(resolve)) : undefined) });
  await t.type('/');
  await t.type('closed');
  await t.type('/');
  assert.equal(waiting.length, 2);
  await act(async () => waiting[1]({ commands: COMMANDS }));
  await flush();
  await act(async () => waiting[0]({ commands: [{ name: 'ghost', kind: 'command', as: 'text' }] }));
  await flush();
  await t.type('/g');
  assert.deepEqual(t.rows(), [], 'a retired read cannot replace the reopened menu cache');
  await t.done();
});

test('closing a menu while capability discovery waits starts no retired command read, and reopening still works', async () => {
  const pending: ((value: unknown) => void)[] = [];
  const t = await mount({ answer: (method) => (method === 'machine.hello' ? new Promise((resolve) => pending.push(resolve)) : undefined) });
  assert.equal(pending.length, 1, 'the screen already has a pending capability read');
  await t.type('/');
  assert.equal(pending.length, 1, 'the menu shares that in-flight read');
  assert.match(t.host.querySelector('[role="menu"]')?.textContent ?? '', /Loading…/);
  await t.type('keep this draft');
  await act(async () => {
    for (const resolve of pending) resolve({ capabilities: { methods: ['commands.list', 'mentions.list'] } });
  });
  await flush();
  assert.equal(t.asked('commands.list').length, 0, 'retired discovery cannot start a command request');
  assert.deepEqual(t.rows(), []);
  assert.equal(t.state.draft, 'keep this draft');
  await t.type('/');
  assert.equal(t.asked('commands.list').length, 1, 'a fresh menu can still read commands');
  assert.ok(t.rows().some((label) => label?.includes('/review')));
  await t.done();
});
