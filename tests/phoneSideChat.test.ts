// Start a side chat from a selection (#4837): the menu entry is offered, greyed with the reason (an older Mac, an agent without a fork, a chat on a machine), or absent until the Mac has said; starting asks the Mac for the fork and opens it with the quote in its composer; a refusal is said in the Mac's words.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { act, createElement, createRoot } from './support/phone/component-kit';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const g = globalThis as any;
function FakeNative(props: any) {
  (g.__nativeRuns ??= []).push(props);
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}
mock.module(require.resolve('expo'), { namedExports: { requireNativeView: () => FakeNative } });
const nativePath = '../mobile/src/platform/selectableTextNative';
const flagPath = '../mobile/src/platform/inPlaceSelection';
const bubblePath = '../mobile/src/components/MessageBubble';
const sidePath = '../mobile/src/sideChat';
const controlsPath = '../mobile/src/remote/controls';
const linksPath = '../mobile/src/chatLinks';
const draftsPath = '../mobile/src/presentation/drafts';
await import(nativePath);
const { setInPlaceSelection } = await import(flagPath);
const { MessageBubble } = await import(bubblePath);
const { SelectionActions, sideChatMenu } = await import(sidePath);
const { startDraft } = await import(draftsPath);
const { ChatLinkContext } = await import(linksPath);
const { sideChat, UPDATE } = await import(controlsPath);

const WHY = { machine: 'Not for chats on a machine', agent: 'Not for this agent', nested: 'Not inside a side chat' };
const start = () => undefined;
/** The controls of a chat the Mac read: what the menu decision looks at. */
const controls = (over: any = {}) => ({ harness: { id: 'claude', label: 'Claude Code' }, methods: { sideChat: true }, ...over });

test('the entry is absent until the Mac has said, and then offered or greyed with the reason it cannot be', () => {
  assert.equal(sideChatMenu(null, undefined, WHY, start), null);
  assert.deepEqual(sideChatMenu(controls(), undefined, WHY, start), { start });
  assert.deepEqual(sideChatMenu(controls({ harness: { id: 'codex', label: 'Codex' } }), undefined, WHY, start), { start });
  // an agent the Mac did not name is tried: the Mac refuses it in its own words if it has no fork
  assert.deepEqual(sideChatMenu(controls({ harness: null }), undefined, WHY, start), { start });
  assert.deepEqual(sideChatMenu(controls({ methods: { sideChat: false } }), undefined, WHY, start), { why: UPDATE.menu });
  assert.equal(UPDATE.menu, 'Update MoPilot on your Mac');
  assert.deepEqual(sideChatMenu(controls({ harness: { id: 'acp:kimi', label: 'Kimi' } }), undefined, WHY, start), { why: WHY.agent });
  assert.deepEqual(sideChatMenu(controls({ harness: { id: 'kimi', label: 'Kimi' } }), undefined, WHY, start), { why: WHY.agent });
  // a chat on a machine: the Host has no side chats, whatever else is true
  assert.deepEqual(sideChatMenu(controls(), 'host-1', WHY, start), { why: WHY.machine });
  assert.deepEqual(sideChatMenu(controls({ machine: { name: 'Box', current: 'claude' } }), undefined, WHY, start), { why: WHY.machine });
  // an older Mac says so before the agent matters
  assert.deepEqual(
    sideChatMenu(controls({ methods: { sideChat: false }, harness: { id: 'acp:kimi', label: 'Kimi' } }), undefined, WHY, start),
    {
      why: UPDATE.menu,
    },
  );
});

test('the request names the chat and answers the new chat’s id; an answer with none is an error', async () => {
  const asked: any[] = [];
  const ask = (answer: unknown) => async (method: string, params: any) => (asked.push([method, params]), answer);
  assert.equal(await sideChat(ask({ chatId: 'side-1' }), 'c1'), 'side-1');
  assert.deepEqual(asked, [['chat.sideChat', { chatId: 'c1' }]]);
  await assert.rejects(sideChat(ask({}), 'c1'), /Could not read the side chat/);
  await assert.rejects(sideChat(ask(null), 'c1'), /Could not read the side chat/);
});

/** A chat's replies with their selection actions, the Mac's answers scripted. */
async function mount(request: any, ctl: any, opts: { usable?: boolean; hostId?: string; open?: any; chatId?: string } = {}) {
  g.__nativeRuns = [];
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draft = { text: 'typed', get: () => draft.text, set: (t: string) => void (draft.text = t) };
  // `open: null` is a chat with no app around it to open one in
  const open = 'open' in opts ? opts.open : () => undefined;
  await act(async () =>
    root.render(
      createElement(
        ChatLinkContext.Provider,
        { value: open },
        createElement(
          SelectionActions,
          { drafts: draft, request, chatId: opts.chatId ?? 'c1', hostId: opts.hostId, controls: ctl, usable: opts.usable ?? true },
          createElement(MessageBubble, { role: 'assistant', text: 'Hello world' }),
        ),
      ),
    ),
  );
  return { draft, run: () => (g.__nativeRuns as any[]).at(-1), done: () => act(async () => root.unmount()) };
}

test('the menu lists Ask, Start a side chat and Copy message; tapping it asks the Mac, then opens the fork with the quote in its composer', async () => {
  setInPlaceSelection(true);
  try {
    const asked: any[] = [];
    const opened: any[] = [];
    const request = async (method: string, params: any) => (asked.push([method, params]), { chatId: 'side-1' });
    const v = await mount(request, controls(), { open: (id: string, draft: string) => opened.push([id, draft]) });
    const entries = v.run().menuEntries;
    assert.deepEqual(
      entries.map((e: any) => e.id),
      ['ask', 'sideChat', 'copyMessage', 'selectText'],
    );
    assert.deepEqual(
      entries[1],
      { id: 'sideChat', title: 'Start a side chat', selection: '1' },
      'no `first`: it goes after the system’s entries',
    );
    await act(async () => v.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'world\nmore' } }));
    assert.deepEqual(asked, [['chat.sideChat', { chatId: 'c1' }]]);
    assert.deepEqual(opened, [['side-1', 'world\nmore']]);
    assert.equal(v.draft.text, 'typed', 'this chat’s own draft is not touched');
    await v.done();
    // the chat the Mac made is a side chat: it is not forked again (the Mac does not either), and says why
    const inside = await mount(request, controls(), { chatId: 'side-1' });
    assert.deepEqual(
      inside.run().menuEntries.find((e: any) => e.id === 'sideChat'),
      {
        id: 'sideChat',
        title: 'Start a side chat',
        selection: '1',
        off: '1',
        why: 'Not inside a side chat',
      },
    );
    await inside.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('where it cannot start the entry is greyed with the reason and does nothing when tapped; where the Mac has not said it is absent', async () => {
  setInPlaceSelection(true);
  try {
    let asked = 0;
    const request = async () => void (asked += 1);
    for (const [ctl, hostId, why] of [
      [controls({ methods: { sideChat: false } }), undefined, 'Update MoPilot on your Mac'],
      [controls({ harness: { id: 'acp:kimi', label: 'Kimi' } }), undefined, 'Not for this agent'],
      [controls(), 'host-1', 'Not for chats on a machine'],
    ] as const) {
      const v = await mount(request, ctl, { hostId });
      const entry = v.run().menuEntries.find((e: any) => e.id === 'sideChat');
      assert.deepEqual(entry, { id: 'sideChat', title: 'Start a side chat', selection: '1', off: '1', why });
      await act(async () => v.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'x' } }));
      await v.done();
    }
    assert.equal(asked, 0);
    const unknown = await mount(request, null);
    assert.deepEqual(
      unknown.run().menuEntries.map((e: any) => e.id),
      ['ask', 'copyMessage', 'selectText'],
    );
    // a stray tap on an entry that is not there does nothing (and does not copy the message either)
    await act(async () => unknown.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'x' } }));
    assert.equal(asked, 0);
    await unknown.done();
    // no app around the chat to open one in: no entry
    const lone = await mount(request, controls(), { open: null });
    assert.deepEqual(
      lone.run().menuEntries.map((e: any) => e.id),
      ['ask', 'copyMessage', 'selectText'],
    );
    await lone.done();
    // a chat that is gone offers neither Reply nor a side chat; one with nowhere to open it (no app around it) no side chat
    const gone = await mount(request, controls(), { usable: false });
    assert.deepEqual(
      gone.run().menuEntries.map((e: any) => e.id),
      ['copyMessage', 'selectText'],
    );
    await gone.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('a fork the Mac refuses or cannot make is said in the Mac’s words, and no chat opens', async () => {
  setInPlaceSelection(true);
  try {
    g.__alerts = [];
    const opened: any[] = [];
    const request = async () => {
      throw new Error("Side chats aren't available for this agent.");
    };
    const v = await mount(request, controls(), { open: (...a: any[]) => opened.push(a) });
    await act(async () => v.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'x' } }));
    assert.deepEqual(g.__alerts, [{ title: 'Couldn’t start a side chat', message: "Side chats aren't available for this agent." }]);
    assert.deepEqual(opened, []);
    // an error that is not an Error is still said
    const odd = await mount(async () => Promise.reject('offline'), controls());
    await act(async () => odd.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'x' } }));
    assert.equal(g.__alerts.at(-1).message, 'offline');
    await odd.done();
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});

test('a chat opened with selected words quotes them under what its composer holds; with none, the composer is left as it is', () => {
  const held = { text: '', get: () => held.text, set: (t: string) => void (held.text = t) };
  startDraft(held as any);
  assert.equal(held.text, '');
  startDraft(held as any, 'one\ntwo');
  assert.equal(held.text, '> one\n> two\n\n');
  // the side chat asked for again is the same one: the next quote stacks after the first, above what was typed
  held.text = '> one\n> two\n\nmy question';
  startDraft(held as any, 'three');
  assert.equal(held.text, '> one\n> two\n\n> three\n\nmy question');
});

test('a second tap while the Mac is still forking starts nothing more, and a tap after it ends starts again', async () => {
  setInPlaceSelection(true);
  try {
    let release: (v: unknown) => void = () => undefined;
    const asked: string[] = [];
    const request = (m: string) => (asked.push(m), new Promise((resolve) => (release = resolve)));
    const v = await mount(request, controls(), { open: () => undefined });
    await act(async () => v.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'a' } }));
    await act(async () => v.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'b' } }));
    assert.deepEqual(asked, ['chat.sideChat']);
    await act(async () => release({ chatId: 'side-9' }));
    await act(async () => v.run().onMenuAction({ nativeEvent: { id: 'sideChat', text: 'c' } }));
    assert.deepEqual(asked, ['chat.sideChat', 'chat.sideChat']);
    await v.done();
  } finally {
    setInPlaceSelection(false);
  }
});
