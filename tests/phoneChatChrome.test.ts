// A chat's chrome: the header (glass Back, title, laptop with its state dot, the ⋯ menu and its sheets), a pushed screen's header, and the bubbles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click, flush } from './support/phone/component-kit';

const headerPath = '../mobile/src/components/ChatHeader';
const bubblePath = '../mobile/src/components/MessageBubble';
const clientPath = '../mobile/src/remote/client';
const linkPath = '../mobile/src/macLink';
const hookPath = '../mobile/src/remote/useChatControls';
const { ChatHeader: Bare, ScreenHeader, changesValue } = await import(headerPath);
const { useChatControls } = await import(hookPath);
/** The header as Thread draws it: its controls read by the shared hook. */
const ChatHeader = (props: any) => {
  const s = useChatControls(props.request, props.chatId);
  return createElement(Bare, { ...props, controls: s.controls, reload: s.reload });
};
const { ownedRequest } = await import(clientPath);
const { MacLinkProvider } = await import(linkPath);
const { MessageBubble } = await import(bubblePath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
/** The entries the open ⋯ menu offers (iOS's own menu, anchored to the button). */
const entries = (host: HTMLElement) =>
  [...host.querySelectorAll('[data-menu="Chat menu"] [role="menuitem"]')].map((n) => n.getAttribute('aria-label'));

const OPTIONS = {
  harnessId: 'claude',
  harness: 'Claude Code',
  models: [],
  permission: {
    value: 'default',
    rows: [
      { id: 'read-only', label: 'Plan', detail: 'Read and plan only' },
      { id: 'default', label: 'Manual', detail: 'Ask before edits and commands' },
      { id: 'auto-review', label: 'Auto', detail: 'Decide on its own', disabled: 'Turned off on your Mac' },
      { id: 'full-access', label: 'Skip all approvals', detail: 'Never ask' },
    ],
  },
};
/** A Mac answering the header's reads; `caps` is what its hello says, `answers` what each method returns (an Error is thrown). */
function macOf(caps: Record<string, unknown>, answers: Record<string, unknown> = {}) {
  const calls: [string, any][] = [];
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      const given =
        method in answers ? answers[method] : method === 'machine.hello' ? { capabilities: caps } : method === 'options.get' ? OPTIONS : {};
      if (given instanceof Error) throw given;
      return given;
    },
  };
  return { request: ownedRequest(runtime), calls };
}
const ALL = {
  methods: ['options.get', 'options.set', 'chats.pin', 'chats.rename', 'chats.archive'],
  renameChats: true,
  archiveChats: true,
  permissionCeiling: 'auto-review',
};
const item = (host: HTMLElement, label: string) => host.querySelector(`[role="menuitem"][aria-label="${label}"]`) as HTMLElement | null;

test('the header names the chat, goes back, shows where it runs, and its ⋯ offers the chat’s screens and settings', async () => {
  const calls: string[] = [];
  const mac = macOf(ALL, {
    'chats.rename': { title: 'Fix the login' },
    'chats.archive': { archived: true },
    'chats.pin': { pinned: true },
  });
  const v = await mount(
    createElement(ChatHeader, {
      request: mac.request,
      chatId: 'c',
      title: 'Fix login',
      subtitle: 'Claude Code · App',
      back: () => calls.push('back'),
      review: () => calls.push('changes'),
      terminal: () => calls.push('terminal'),
      lines: { added: 4, removed: 2, files: 1 },
      changed: () => calls.push('changed'),
      archived: () => calls.push('archived'),
      where: () => calls.push('where'),
    }),
  );
  assert.match(v.host.textContent!, /Fix login/);
  assert.match(v.host.textContent!, /Claude Code · App/);
  await click('Back to chats');
  await click('Runs on Computer, Connected');
  await click('Chat menu');
  assert.deepEqual(entries(v.host), ['Changes  +4 −2', 'Terminal', 'Permissions  Manual', 'Pin', 'Rename', 'Archive']);
  assert.equal(item(v.host, 'Archive')!.getAttribute('data-role'), 'destructive');
  assert.equal(v.host.querySelectorAll('[data-menu="Chat menu"] [data-section]').length, 3, 'three sections');
  await click('Changes  +4 −2');
  await click('Chat menu');
  await click('Terminal');
  await click('Chat menu');
  await click('Pin');
  assert.deepEqual(mac.calls.at(-1), ['chats.pin', { chatId: 'c', pinned: true }]);
  await click('Chat menu');
  await click('Archive');
  assert.deepEqual(mac.calls.at(-1), ['chats.archive', { chatId: 'c', archived: true }]);
  assert.deepEqual(calls, ['back', 'where', 'changes', 'terminal', 'changed', 'archived']);
  await v.done();
});

test('Rename asks for the new name in a sheet and keeps the title the Mac returns', async () => {
  const changed: string[] = [];
  const mac = macOf(ALL, { 'chats.rename': { title: 'Fix the login' } });
  const v = await mount(
    createElement(ChatHeader, { request: mac.request, chatId: 'c', title: 'Fix login', back: () => {}, changed: () => changed.push('x') }),
  );
  await click('Chat menu');
  await click('Rename');
  assert.match(v.host.textContent!, /Rename chat/);
  const field = v.host.querySelector('input[aria-label="Chat name"]') as HTMLInputElement;
  assert.equal(field.value, 'Fix login');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '  Fix   the login ');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Save name');
  assert.deepEqual(mac.calls.at(-1), ['chats.rename', { chatId: 'c', title: 'Fix   the login' }]);
  assert.doesNotMatch(v.host.textContent!, /Rename chat/, 'the sheet closes');
  assert.deepEqual(changed, ['x']);
  await v.done();
});

test('Permissions lists the Mac’s own modes with the current one checked, says which only the Mac can set, and sets another', async () => {
  const mac = macOf(ALL);
  const v = await mount(createElement(ChatHeader, { request: mac.request, chatId: 'c', title: 'T', back: () => {} }));
  await click('Chat menu');
  await click('Permissions  Manual');
  assert.match(v.host.textContent!, /PermissionsPlanRead and plan onlyManualAsk before edits and commands/);
  assert.match(v.host.textContent!, /AutoTurned off on your Mac/, 'a mode the Mac switched off says why');
  assert.match(v.host.textContent!, /Skip all approvals is only available on your Mac\./);
  assert.equal(v.host.querySelector('button[aria-label="Auto"]'), null, 'a mode turned off cannot be picked');
  await click('Manual');
  assert.ok(!mac.calls.some(([m]) => m === 'options.set'), 'the current mode is not set again');
  await click('Chat menu');
  await click('Permissions  Manual');
  await click('Plan');
  assert.deepEqual(
    mac.calls.find(([m]) => m === 'options.set'),
    ['options.set', { chatId: 'c', value: 'read-only' }],
  );
  assert.equal(mac.calls.filter(([m]) => m === 'options.get').length, 2, 'the menu reads the chat again after a change');
  await v.done();
});

test('the current mode only the Mac can set is named', async () => {
  const mac = macOf(ALL, { 'options.get': { ...OPTIONS, permission: { ...OPTIONS.permission, value: 'full-access' } } });
  const v = await mount(createElement(ChatHeader, { request: mac.request, chatId: 'c', back: () => {} }));
  assert.match(v.host.textContent!, /^.*Chat/, 'an untitled chat is "Chat"');
  await click('Chat menu');
  await click('Permissions  Skip all approvals');
  assert.match(v.host.textContent!, /Now: Skip all approvals, which only your Mac can set\./);
  await click('Dismiss');
  assert.doesNotMatch(v.host.textContent!, /Now: Skip/);
  await v.done();
});

test('an older Mac greys out what it cannot do and says to update it; a failure shows its message', async () => {
  const old = macOf({ methods: ['options.get'] });
  const v = await mount(createElement(ChatHeader, { request: old.request, chatId: 'c', title: 'T', back: () => {}, pinned: true }));
  await click('Chat menu');
  assert.deepEqual(entries(v.host), ['Permissions  Manual', 'Unpin', 'Rename', 'Archive']);
  // what the Mac cannot do yet sits under the one line that says how to get it
  assert.match(
    v.host.querySelector('[data-section="Update MoPilot on your Mac"]')!.textContent!,
    /^Update MoPilot on your MacRenameArchive$/,
  );
  for (const label of ['Permissions  Manual', 'Unpin', 'Rename', 'Archive']) {
    assert.equal(item(v.host, label)!.getAttribute('aria-disabled'), 'true', label);
    await act(async () => item(v.host, label)!.click());
  }
  assert.deepEqual(
    old.calls.map(([m]) => m),
    ['machine.hello', 'options.get'],
    'nothing is asked of the Mac',
  );
  await v.done();
  // a Mac too old to list the controls at all: every setting is greyed, quietly
  const ancient = macOf({ methods: [] });
  const w = await mount(createElement(ChatHeader, { request: ancient.request, chatId: 'c', back: () => {} }));
  await click('Chat menu');
  assert.equal(item(w.host, 'Permissions')!.getAttribute('aria-disabled'), 'true');
  assert.equal(w.host.querySelector('[role="alert"]'), null);
  await w.done();
  // a read that fails for another reason greys the entries too, and the chat says nothing of a read nobody asked for
  const broken = macOf(ALL, { 'options.get': new Error('Your computer is busy.') });
  const x = await mount(createElement(ChatHeader, { request: broken.request, chatId: 'c', back: () => {} }));
  assert.doesNotMatch(x.host.textContent!, /busy/);
  await click('Chat menu');
  assert.equal(item(x.host, 'Pin')!.getAttribute('aria-disabled'), 'true');
  await x.done();
  // a refused action shows the Mac's words as they are
  const refusing = macOf(ALL, { 'chats.archive': Object.assign(new Error('Stop the chat first'), { code: 'failed' }) });
  const y = await mount(
    createElement(ChatHeader, { request: refusing.request, chatId: 'c', back: () => {}, archived: () => assert.fail('not archived') }),
  );
  await click('Chat menu');
  await click('Archive');
  assert.match(y.host.querySelector('[role="alert"]')!.textContent!, /Stop the chat first/);
  await y.done();
});

test('the laptop greys out while the Mac is away', async () => {
  const state = { phase: 'offline', selectedPair: 'p', pairs: [{ pairId: 'p', name: 'Studio' }], presence: {} };
  const mac = macOf(ALL);
  const v = await mount(
    createElement(MacLinkProvider, { state }, createElement(ChatHeader, { request: mac.request, chatId: 'c', back: () => {} })),
  );
  assert.ok(v.host.querySelector('button[aria-label="Runs on Studio, Offline"]'));
  assert.ok(v.host.querySelector('[data-symbol="laptopcomputer.slash"]'));
  await click('Runs on Studio, Offline');
  await v.done();
});

test('off iOS the ⋯ is a small list under the capsule, closed by picking an entry or a second tap', async () => {
  (globalThis as any).__phonePlatform = 'android';
  try {
    const calls: string[] = [];
    const mac = macOf(ALL);
    const v = await mount(
      createElement(ChatHeader, { request: mac.request, chatId: 'c', back: () => {}, terminal: () => calls.push('terminal') }),
    );
    const items = () => [...v.host.querySelectorAll('[role="menuitem"]')].map((n) => n.getAttribute('aria-label'));
    assert.deepEqual(items(), []);
    await click('Chat menu');
    assert.deepEqual(items(), ['Terminal', 'Permissions  Manual', 'Pin', 'Rename', 'Archive']);
    await click('Chat menu');
    assert.deepEqual(items(), [], 'a second tap closes it');
    await click('Chat menu');
    await act(async () => item(v.host, 'Terminal')!.click());
    assert.deepEqual(calls, ['terminal']);
    assert.deepEqual(items(), [], 'picking closes it');
    await v.done();
    // an entry the Mac cannot do is greyed and does nothing
    const old = macOf({ methods: ['options.get'] });
    const w = await mount(createElement(ChatHeader, { request: old.request, chatId: 'c', back: () => {} }));
    await click('Chat menu');
    assert.match(w.host.textContent!, /Update MoPilot on your MacRenameArchive/);
    const rename = item(w.host, 'Rename')!;
    assert.equal(JSON.parse(rename.getAttribute('data-style')!).opacity, 0.4);
    await act(async () => rename.click());
    assert.ok(item(w.host, 'Rename'), 'the menu stays open');
    await w.done();
  } finally {
    (globalThis as any).__phonePlatform = undefined;
  }
});

test('a pushed screen’s header names it and the chat under it, and goes back to the chat', async () => {
  const calls: string[] = [];
  const v = await mount(createElement(ScreenHeader, { title: 'Terminal', subtitle: 'Fix login', back: () => calls.push('back') }));
  assert.match(v.host.textContent!, /TerminalFix login/);
  await click('Back to chat');
  assert.deepEqual(calls, ['back']);
  await v.done();
  assert.equal(changesValue(null), null);
  assert.equal(changesValue({ added: 0, removed: 0, files: 0 }), 'None yet');
  assert.equal(changesValue({ added: 0, removed: 0, files: 1 }), '1 file');
  assert.equal(changesValue({ added: 0, removed: 0, files: 3 }), '3 files');
  assert.equal(changesValue({ added: 1, removed: 3, files: 2 }), '+1 −3');
});

test('every row says who it is from to a screen reader, with no visible caption; unknown rows read as activity', async () => {
  const v = await mount(
    createElement(
      'div',
      null,
      ['user', 'assistant', 'preview', 'liveUser', 'live', 'activity', 'tool'].map((role) =>
        createElement(MessageBubble, { key: role, role, text: `text ${role}` }),
      ),
    ),
  );
  const labels = [...v.host.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label'));
  assert.deepEqual(labels, [
    'You: text user',
    'You, live: text liveUser',
    'Live activity: text live',
    'Activity: text activity',
    'Activity: text tool',
  ]);
  // as in Claude's transcript, nothing names who a row is from on screen, live or not
  assert.doesNotMatch(v.host.textContent!, /Live reply|You, live|MoPilot|Activity/);
  await v.done();
});

test('Rename on an untitled chat starts empty and Dismiss closes it; a mode with no description and a nameless Mac-only mode still read', async () => {
  const mac = macOf(ALL, {
    'options.get': {
      ...OPTIONS,
      permission: {
        value: 'default',
        rows: [
          { id: 'read-only', label: 'Plan', detail: '' },
          { id: 'default', label: 'Manual', detail: 'Ask first' },
          { id: 'full-access' },
        ],
      },
    },
  });
  const v = await mount(createElement(ChatHeader, { request: mac.request, chatId: 'c', back: () => {} }));
  await click('Chat menu');
  await click('Rename');
  assert.equal((v.host.querySelector('input[aria-label="Chat name"]') as HTMLInputElement).value, '');
  assert.equal(
    v.host.querySelector('button[aria-label="Save name"]')!.getAttribute('aria-disabled'),
    'true',
    'an empty name cannot be saved',
  );
  await click('Dismiss');
  assert.doesNotMatch(v.host.textContent!, /Rename chat/);
  await click('Chat menu');
  await click('Permissions  Manual');
  assert.match(v.host.textContent!, /PlanManualAsk first/, 'a mode without a description is just its name');
  assert.match(v.host.textContent!, /full-access is only available on your Mac\./, 'a mode without a name is named by its id');
  await v.done();
});
