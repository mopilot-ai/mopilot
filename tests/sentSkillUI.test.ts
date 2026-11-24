// Starting a skill, as the thread draws it (Claude Code's transcript): a sent "/fix-bug tidy up" is the skill's chip and
// the words after it when the chat's harness lists fix-bug as a skill, and the Skill tool call is a "Loaded skill /name"
// row with the skill glyph whose details are its arguments and "Successfully loaded skill", not the tool's JSON.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, stubComponent, render, settle, setStore, impl, resetStore, callsTo } from './support/thread-kit.ts';

mockStore();
autoMock('src/components/markdown/Markdown.tsx', 'md', { Markdown: stubComponent('Markdown'), CodeBlock: stubComponent('CodeBlock') });
autoMock('src/components/ui/Presence.tsx', 'presence', { Collapse: ({ open, children }: any) => (open ? children : null) });
autoMock('src/components/ui/Popover.tsx', 'popover', { Tooltip: ({ children }: any) => children });
autoMock('src/components/thread/PeerMessages.tsx', 'peer', { PeerContext: (await import('react')).createContext([]) });
// the chat's command list, as the harness reported it (its own tests are claudeCatalog's)
autoMock('src/session/harness/claude.ts', 'claude', {
  useCommandProvider: (...a: any[]) => impl['claude:useCommandProvider']?.(...a) ?? null,
});
// where the chat's skills are on this Mac, and what a click on one opens
autoMock('src/store/panes.ts', 'panes');
autoMock('src/session/open.ts', 'open');
const { claudeCommands } = await import('../src/harness/commands.ts');
const { StepRow } = await import('../src/components/thread/items/StepRow.tsx');
const { ActivityChat } = await import('../src/components/thread/turnTokens.tsx');
const { UserMessage } = await import('../src/components/thread/view/UserMessage.tsx');

const provider = claudeCommands(
  [{ name: 'fix-bug', description: 'Fix a bug' }, { name: 'compact', description: 'Compact', builtin: true } as any],
  {
    skills: ['fix-bug'],
  },
);
let asked: any[] = [];
beforeEach(() => {
  resetStore();
  setStore({ threads: { c1: { id: 'c1', cwd: '/repo' } } });
  asked = [];
  impl['claude:useClaudeSkillFiles'] = () => null;
  impl['claude:useCommandProvider'] = (...a: any[]) => (asked.push(a), provider);
});

const message = (text: string, threadId = 'c1') =>
  h(UserMessage, {
    threadId,
    turnId: 't1',
    userIndex: 0,
    canEdit: false,
    item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text }] },
  } as any);

test("a sent skill is its chip and the words after it, looked up in the chat's own folder", async () => {
  let v = await render(message('/fix-bug tidy the login'));
  const chip = v.$('.user-bubble .bubble-skill') as HTMLElement;
  assert.equal(chip.textContent, '/fix-bug');
  assert.equal(chip.title, 'Skill /fix-bug');
  assert.ok(chip.querySelector('svg'), 'the skill glyph');
  assert.equal(v.$('.user-bubble')?.textContent, '/fix-bug tidy the login');
  // until main has said whether Host exists the folder is asked with none; the chat's own folder follows
  assert.deepEqual(asked.at(-1), ['c1', '/repo']);
  await v.unmount();
  // a line break after the name stays one
  v = await render(message('/fix-bug\nstep one'));
  assert.equal(v.$('.user-bubble')?.textContent, '/fix-bug\nstep one');
  await v.unmount();
  // a skill on its own is the chip alone
  v = await render(message('/fix-bug'));
  assert.equal(v.$('.user-bubble')?.textContent, '/fix-bug');
  await v.unmount();
  // a command and plain text stay as they were typed; a chat not in the list asks with no folder
  for (const text of ['/compact', 'please run /fix-bug']) {
    v = await render(message(text, 'gone'));
    assert.equal(v.$('.bubble-skill'), null, text);
    assert.equal(v.$('.user-bubble')?.textContent, text);
    await v.unmount();
  }
  assert.deepEqual(asked.at(-1), ['gone', '']);
});

const skillStep = (extra: any = {}) =>
  ({
    kind: 'tool',
    item: {
      type: 'mcpToolCall',
      id: 'k1',
      server: '',
      tool: 'Skill',
      arguments: { skill: 'fix-bug', args: 'tidy the login' },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'Launching skill: fix-bug' }] },
      error: null,
      ...extra,
    },
  }) as any;

test('a Skill call is a "Loaded skill" row with the skill glyph, its arguments and Claude Code\'s result in its details', async () => {
  const v = await render(h(StepRow, { step: skillStep(), cwd: '/repo' }));
  assert.equal(v.$('.step-text')?.textContent, 'Loaded skill /fix-bug');
  assert.ok(v.$('.step-icon svg path[d^="m12 2"]'), 'the skill glyph, not the plug');
  assert.ok(!v.$('.step.failed'));
  await settle(() => v.$('.step-row-hit')!.click());
  const blocks = [...v.$$('.step-body [data-stub="CodeBlock"]')].map((b) => b.dataset.code);
  assert.deepEqual(blocks, ['tidy the login', 'Successfully loaded skill']);
  assert.equal(v.$('.step-body .shell-head')?.textContent, 'Skill · /fix-bug');
  await v.unmount();
});

test('a running skill shimmers its name; one that failed reads so and keeps the reason; no arguments, no block', async () => {
  let v = await render(h(StepRow, { step: skillStep({ status: 'inProgress', result: null }), cwd: '/repo' }));
  assert.equal(v.$('.step-text .shimmer')?.textContent, 'Running skill');
  assert.equal(v.$('.step-text')?.textContent, 'Running skill /fix-bug');
  await v.unmount();
  v = await render(
    h(StepRow, {
      step: skillStep({ status: 'failed', result: null, error: { message: 'Unknown skill' }, arguments: { skill: 'fix-bug' } }),
      cwd: '/repo',
    }),
  );
  assert.equal(v.$('.step-text')?.textContent, 'Couldn’t load skill /fix-bug');
  assert.ok(v.$('.step.failed'));
  await settle(() => v.$('.step-row-hit')!.click());
  assert.deepEqual(
    [...v.$$('.step-body [data-stub="CodeBlock"]')].map((b) => b.dataset.code),
    ['Unknown skill'],
  );
  await v.unmount();
});

test('a skill Stop cut off only started; one whose result is an error, or that was declined, is a failed row', async () => {
  const { TurnTimingContext } = await import('../src/components/thread/items/turnTiming.ts');
  let v = await render(
    h(
      TurnTimingContext.Provider,
      { value: { timeOf: () => undefined, interrupted: true } } as any,
      h(StepRow, { step: skillStep({ status: 'inProgress', result: null, cutOff: true }), cwd: '/repo' }),
    ),
  );
  assert.equal(v.$('.step-text .shimmer'), null);
  assert.equal(v.$('.step-text')?.textContent, 'Started skill /fix-bug · Interrupted');
  assert.ok(!v.$('.step.failed'));
  await v.unmount();
  v = await render(h(StepRow, { step: skillStep({ error: { message: 'Unknown skill' } }), cwd: '/repo' }));
  assert.equal(v.$('.step-text')?.textContent, 'Couldn’t load skill /fix-bug');
  assert.ok(v.$('.step.failed'), 'failed by its error, though its status says completed');
  await v.unmount();
  v = await render(h(StepRow, { step: skillStep({ status: 'declined', result: null }), cwd: '/repo' }));
  assert.equal(v.$('.step-text')?.textContent, 'Declined skill /fix-bug');
  await v.unmount();
});

test('another tool keeps its own row: an MCP server\'s "Skill" is called, not loaded', async () => {
  const v = await render(h(StepRow, { step: skillStep({ server: 'acme' }), cwd: '/repo' }));
  assert.equal(v.$('.step-text')?.textContent, 'Called acme Skill');
  await v.unmount();
});

test("a forked skill's long answer is shown cut to its first 20000 characters", async () => {
  const v = await render(
    h(StepRow, { step: skillStep({ result: { content: [{ type: 'text', text: 'x'.repeat(20005) }] } }), cwd: '/repo' }),
  );
  await settle(() => v.$('.step-row-hit')!.click());
  const out = v.$$('.step-body [data-stub="CodeBlock"]').at(-1)!.dataset.code!;
  assert.equal(out, `${'x'.repeat(20000)}\n…`);
  await v.unmount();
});

const FILE = { path: '/c/fix-bug/SKILL.md', description: 'Fix a bug properly', scope: 'personal' };
const filesFor =
  (seen: any[] = []) =>
  (...a: any[]) => (seen.push(a), { 'fix-bug': FILE });

test('a sent skill whose SKILL.md is known is a link that opens the skill pane; with the modifier, the file', async () => {
  const seen: any[] = [];
  impl['claude:useClaudeSkillFiles'] = filesFor(seen);
  const v = await render(message('/fix-bug tidy the login'));
  const chip = v.$('.user-bubble .bubble-skill') as HTMLElement;
  assert.equal(chip.tagName, 'A');
  assert.equal(chip.getAttribute('href'), FILE.path);
  assert.equal(chip.title, 'Fix a bug properly');
  assert.equal(chip.textContent, '/fix-bug');
  assert.ok(chip.querySelector('svg'), 'the skill glyph stays');
  assert.equal(v.$('.user-bubble')?.textContent, '/fix-bug tidy the login');
  // looked up in this chat's own folder
  assert.deepEqual(seen.at(-1), ['c1', '/repo']);
  const tabs = callsTo('panes:openPaneTab').length;
  const files = callsTo('open:openPath').length;
  const click = async (mod: boolean) => {
    const e = new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: mod, ctrlKey: mod });
    await settle(() => void chip.dispatchEvent(e));
    return e.defaultPrevented;
  };
  // a plain click opens the pane and not the file; the link itself never navigates
  assert.equal(await click(false), true);
  assert.deepEqual(callsTo('panes:openPaneTab').at(-1), ['skill', { path: FILE.path, title: 'fix-bug' }]);
  assert.deepEqual([callsTo('panes:openPaneTab').length, callsTo('open:openPath').length], [tabs + 1, files]);
  // with the modifier it opens the file and not the pane
  assert.equal(await click(true), true);
  assert.deepEqual(callsTo('open:openPath').at(-1), [FILE.path]);
  assert.deepEqual([callsTo('panes:openPaneTab').length, callsTo('open:openPath').length], [tabs + 1, files + 1]);
  await v.unmount();
});

test('a skill with no description keeps the title it had; one the catalog does not know stays plain text', async () => {
  impl['claude:useClaudeSkillFiles'] = () => ({ 'fix-bug': { ...FILE, description: '' } });
  let v = await render(message('/fix-bug'));
  assert.equal((v.$('.bubble-skill') as HTMLElement).title, 'Skill /fix-bug');
  assert.equal(v.$('a.bubble-skill')?.tagName, 'A');
  await v.unmount();
  impl['claude:useClaudeSkillFiles'] = () => ({});
  v = await render(message('/fix-bug'));
  assert.equal(v.$('a.bubble-skill'), null);
  assert.equal(v.$('span.bubble-skill')?.getAttribute('title'), 'Skill /fix-bug');
  await v.unmount();
  // a chat on another harness has no catalog (null), or sits on a machine: no path either
  impl['claude:useClaudeSkillFiles'] = () => null;
  v = await render(message('/fix-bug', 'gone'));
  assert.equal(v.$('a.bubble-skill'), null);
  await v.unmount();
});

test('a listed skill named like an Object.prototype member, with no file, stays plain text', async () => {
  impl['claude:useCommandProvider'] = () =>
    claudeCommands([{ name: 'constructor', description: 'odd' } as any], { skills: ['constructor'] });
  impl['claude:useClaudeSkillFiles'] = () => ({});
  let v = await render(message('/constructor go'));
  assert.equal(v.$('a.bubble-skill'), null);
  assert.equal(v.$('span.bubble-skill')?.textContent, '/constructor');
  await v.unmount();
  const step = skillStep({ arguments: { skill: 'constructor' } });
  v = await render(h(ActivityChat.Provider, { value: 'c1' }, h(StepRow, { step, cwd: '/repo' })));
  assert.equal(v.$('.step-text button'), null);
  await v.unmount();
});

test('"Loaded skill /name" opens the skill pane through the same lookup, its text unchanged', async () => {
  impl['claude:useClaudeSkillFiles'] = filesFor();
  const v = await render(h(ActivityChat.Provider, { value: 'c1' }, h(StepRow, { step: skillStep(), cwd: '/repo' })));
  assert.equal(v.$('.step-text')?.textContent, 'Loaded skill /fix-bug');
  const name = v.$('.step-text button') as HTMLElement;
  assert.equal(name.textContent, '/fix-bug');
  const tabs = callsTo('panes:openPaneTab').length;
  const files = callsTo('open:openPath').length;
  await settle(() => name.click());
  assert.deepEqual(callsTo('panes:openPaneTab').at(-1), ['skill', { path: FILE.path, title: 'fix-bug' }]);
  assert.deepEqual([callsTo('panes:openPaneTab').length, callsTo('open:openPath').length], [tabs + 1, files], 'the pane, not the file');
  // the row stays closed: the name is not the row's toggle
  assert.equal(v.$('.step-body'), null);
  await settle(() => name.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true, ctrlKey: true })));
  assert.deepEqual(callsTo('open:openPath').at(-1), [FILE.path]);
  assert.deepEqual([callsTo('panes:openPaneTab').length, callsTo('open:openPath').length], [tabs + 1, files + 1], 'the file, not the pane');
  await v.unmount();
  // no chat in scope, or a skill that is not found: the name is text
  for (const files of [{}, null]) {
    impl['claude:useClaudeSkillFiles'] = () => files;
    const plain = await render(h(ActivityChat.Provider, { value: 'c1' }, h(StepRow, { step: skillStep(), cwd: '/repo' })));
    assert.equal(plain.$('.step-text button'), null);
    assert.equal(plain.$('.step-text .step-em')?.textContent, '/fix-bug');
    await plain.unmount();
  }
  const none = await render(h(StepRow, { step: skillStep(), cwd: '/repo' }));
  assert.equal(none.$('.step-text button'), null);
  await none.unmount();
});
