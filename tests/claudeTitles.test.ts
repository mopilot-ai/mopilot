// A new Claude Code chat's title (electron/harness/claude/title.cjs): written once, never over a user's name; by the
// login's warm title CLI at send (#3413), else by the chat's own CLI (#2150), else by the helper query once the chat's
// turn shows output (#1651).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { createRequire } from 'node:module';
import { CHAT, ref, tick, setup, item, msg } from './support/claude-adapter.ts';

const { LIVE_TITLE_MS } = createRequire(import.meta.url)('../electron/harness/claude/title.cjs');

/** A title writer for the fallback helper query only: the warm title CLI (o.helper) answers nothing. */
const fallbackOnly =
  (fn: (...args: any[]) => Promise<string>) =>
  async (...args: any[]) =>
    args[5]?.helper ? null : fn(...args);

test('the first message names the chat: a title from the cheap model, unless it is named already', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'), 1);
  await tick();
  assert.deepEqual(t.renamed, [['s1', 'A short title']]);
  const named = t.events.find(([e]) => e.kind === 'threadName')![0];
  assert.equal(named.name, 'A short title');
  assert.equal(named.provisional, 'fix the login bug');
  const u = setup({ userTitle: 'Mine' });
  u.adapter.registerSession(CHAT);
  await u.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'), 1);
  await tick();
  assert.deepEqual(u.renamed, []);
  // a side chat or a later segment is not titled
  const v = setup();
  v.adapter.registerSession(CHAT, { ephemeral: true });
  await v.adapter.startTurn(CHAT, ref(CHAT), item('x'), 1);
  await tick();
  assert.deepEqual(v.renamed, []);
});

test('Claude titles only the first prompt, without blocking a follow-up while the helper runs', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  let finish!: (title: string) => void;
  const prompts: string[] = [];
  t.api.title = async (...args: any[]) => {
    prompts.push(args[0]);
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  };
  await t.adapter.startTurn(CHAT, ref(CHAT), item('修复登录问题'));
  await tick();
  await t.adapter.startTurn(CHAT, ref(CHAT), item('also add tests'));
  await tick();
  assert.deepEqual(prompts, ['修复登录问题']);
  assert.equal(t.sent.length, 2);
  finish('“修复登录问题。”');
  await tick();
  assert.deepEqual(t.renamed, [['s1', '修复登录问题']]);
});

test('Claude leaves resumed chats, forks, and empty first prompts alone', async () => {
  for (const session of [null, { forkFrom: 'parent' }, {}]) {
    const t = setup();
    if (session) t.adapter.registerSession(CHAT, session);
    await t.adapter.startTurn(CHAT, ref(CHAT), item(session && !('forkFrom' in session) ? '  ' : 'follow up'));
    await tick();
    assert.deepEqual(t.renamed, []);
  }
});

test('Claude preserves a manual rename made while generating the title', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  let named = false;
  t.api.userTitle = async () => (named ? 'My title' : null);
  t.api.title = fallbackOnly(async () => {
    named = true;
    return 'Generated title';
  });
  await t.adapter.startTurn(CHAT, ref(CHAT), item('first prompt'));
  await tick();
  assert.deepEqual(t.renamed, []);
  assert.equal(t.kinds().includes('threadName'), false);
});

test('Claude falls back on generation failure and only publishes titles that were saved', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  t.api.title = async () => {
    throw new Error('offline');
  };
  await t.adapter.startTurn(CHAT, ref(CHAT), item('first prompt'));
  await tick();
  assert.deepEqual(t.renamed, [['s1', 'first prompt']]);

  const u = setup();
  u.adapter.registerSession(CHAT);
  u.api.rename = async () => {
    throw new Error('save failed');
  };
  await u.adapter.startTurn(CHAT, ref(CHAT), item('first prompt'));
  await tick();
  assert.equal(u.kinds().includes('threadName'), false);
  assert.equal(u.adapter.titling.size, 0);
});

test('Claude does not overwrite an unknown name when its name cannot be read', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  t.api.userTitle = async () => {
    throw new Error('unavailable');
  };
  await t.adapter.startTurn(CHAT, ref(CHAT), item('first prompt'));
  await tick();
  assert.deepEqual(t.renamed, []);
});

test("the fallback title helper starts only once the chat's own turn shows output (#1651)", async () => {
  for (const output of ['stream_event', 'assistant', 'result', 'closed', 'error'] as const) {
    const t = setup({ silent: true });
    t.adapter.registerSession(CHAT);
    let asked = 0;
    t.api.title = fallbackOnly(async () => (asked++, 'A short title'));
    await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
    await tick();
    // the CLI's init and other keys' output do not count
    t.adapter.observe(msg('system', { subtype: 'init' }));
    t.adapter.observe({ ...msg('stream_event'), key: 'claude:other' });
    t.adapter.observe({ key: CHAT, kind: 'permission' });
    await tick();
    assert.equal(asked, 0, output);
    t.adapter.observe(output === 'closed' || output === 'error' ? { key: CHAT, kind: output } : msg(output));
    await tick();
    assert.equal(asked, 1, output);
    assert.deepEqual(t.renamed, [['s1', 'A short title']]);
  }
});

test('a first turn that never reaches the CLI releases its title hold', async () => {
  const t = setup({ failSend: true });
  t.adapter.registerSession(CHAT);
  assert.equal((await t.adapter.startTurn(CHAT, ref(CHAT), item('first prompt'))).started, false);
  assert.equal(t.adapter.firstOutput.held.size, 0);
  assert.deepEqual(t.renamed, []);
});

test("the chat's own CLI writes the title at send, before the turn shows any output (#2150)", async () => {
  const t = setup({ silent: true });
  t.adapter.registerSession(CHAT);
  let helper = 0;
  t.api.title = fallbackOnly(async () => (helper++, 'Helper title'));
  t.api.control = async (k: string, m: string, a?: unknown) => (
    t.controls.push([k, m, a]), m === 'generateTitle' ? 'Login bug' : undefined
  );
  await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
  await tick();
  assert.deepEqual(
    t.controls.filter(([, m]) => m === 'generateTitle'),
    [[CHAT, 'generateTitle', 'fix the login bug']],
  );
  assert.deepEqual(t.renamed, [['s1', 'Login bug']]);
  assert.equal(helper, 0, 'no helper CLI is started');
  const named = t.events.find(([e]) => e.kind === 'threadName')![0];
  assert.equal(named.provisional, 'fix the login bug');
});

test('a CLI that fails, answers nothing or is not live leaves the title to the helper', async () => {
  for (const kind of ['rejects', 'blank', 'notLive'] as const) {
    const t = setup();
    t.adapter.registerSession(CHAT);
    t.api.control = async (_k: string, m: string) => {
      if (m !== 'generateTitle') return undefined;
      if (kind === 'rejects') throw new Error('Unknown control request');
      return '  ';
    };
    if (kind === 'notLive') t.api.isLive = () => false;
    await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
    await tick();
    assert.deepEqual(t.renamed, [['s1', 'A short title']], kind);
  }
});

test("a CLI that doesn't answer in time leaves the title to the helper", async () => {
  // tick() waits on setTimeout, which the mock holds: flush the microtasks and immediates instead
  const flush = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const t = setup();
    t.adapter.registerSession(CHAT);
    t.api.control = (_k: string, m: string) => (m === 'generateTitle' ? new Promise(() => {}) : Promise.resolve(undefined));
    await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
    await flush();
    assert.deepEqual(t.renamed, []);
    mock.timers.tick(LIVE_TITLE_MS);
    await flush();
    assert.deepEqual(t.renamed, [['s1', 'A short title']]);
  } finally {
    mock.timers.reset();
  }
});

test("a rename while the CLI writes the title keeps the user's name", async () => {
  const t = setup({ silent: true });
  t.adapter.registerSession(CHAT);
  let named = false;
  t.api.userTitle = async () => (named ? 'Mine' : null);
  t.api.control = async (_k: string, m: string) => {
    if (m !== 'generateTitle') return undefined;
    named = true;
    return 'Login bug';
  };
  await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
  await tick();
  assert.deepEqual(t.renamed, []);
  assert.equal(t.kinds().includes('threadName'), false);
});

test('the native live title request receives the human question, without panel handoff metadata', async () => {
  const { browserHandoffMessage } = await import('../shared/chromeHandoff.mjs');
  const t = setup();
  t.adapter.registerSession(CHAT);
  const prompts: string[] = [];
  t.api.isLive = () => true;
  t.api.control = async (_key: string, _method: string, text?: unknown) => {
    prompts.push(String(text));
    return 'Booking refund';
  };
  await t.adapter.startTurn(
    CHAT,
    ref(CHAT),
    item(browserHandoffMessage('Use tab 123.', 'Refund this booking\n\n[Chrome tab: https://example.org/]')),
  );
  await tick();
  assert.deepEqual(prompts, ['Refund this booking']);
  assert.deepEqual(t.renamed, [['s1', 'Booking refund']]);
});

/** Holds the CLI's acceptance of each message until `accept()` (or `refuse()`), as a CLI still starting does. */
function holdSends(t: any) {
  const send = t.adapter.sendTo;
  let release!: (ok: boolean) => void;
  const gate = new Promise<boolean>((r) => (release = r));
  t.adapter.sendTo = async (...args: any[]) => {
    if (!(await gate)) throw new Error('Claude Code is not installed');
    return send(...args);
  };
  return { accept: () => release(true), refuse: () => release(false) };
}
const names = (t: any) => t.events.filter(([e]: any) => e.kind === 'threadName').map(([e]: any) => [e.name, e.provisional]);

test("the login's warm title CLI names the chat at once, while its CLI still starts, and the title is saved once that CLI took the message (#3413)", async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  const asked: any[] = [];
  t.api.title = async (...args: any[]) => (asked.push(args), args[5]?.helper ? '“Login bug.”' : 'Fallback title');
  const held = holdSends(t);
  const turn = t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
  await tick();
  // shown before the CLI took the message, cleaned like any generated title; nothing is saved yet
  assert.deepEqual(names(t), [['Login bug', 'fix the login bug']]);
  assert.deepEqual(t.renamed, []);
  assert.deepEqual(
    asked.map((a) => [a[0], a[5]]),
    [['fix the login bug', { helper: true }]],
  );
  held.accept();
  assert.equal((await turn).started, true);
  await tick();
  assert.deepEqual(t.renamed, [['s1', 'Login bug']]);
  assert.deepEqual(names(t).at(-1), ['Login bug', 'fix the login bug']);
  // the chat's own CLI and the fallback are not asked
  assert.deepEqual(
    t.controls.filter(([, m]: any) => m === 'generateTitle'),
    [],
  );
  assert.equal(asked.length, 1);
  assert.equal(t.adapter.titling.size, 0);
});

test('a first message the CLI never took takes the shown title back and saves nothing', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  t.api.title = async (...args: any[]) => (args[5]?.helper ? 'Login bug' : 'Fallback title');
  const held = holdSends(t);
  const turn = t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
  await tick();
  held.refuse();
  assert.equal((await turn).started, false);
  await tick();
  assert.deepEqual(names(t), [
    ['Login bug', 'fix the login bug'],
    // named after its first words again, unless the chat was renamed meanwhile (the renderer checks the name it replaces)
    ['fix the login bug', 'Login bug'],
  ]);
  assert.deepEqual(t.renamed, []);
  assert.equal(t.adapter.titling.size, 0);
});

test('without a warm title, a first message the CLI never took asks nothing more and takes nothing back', async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  const held = holdSends(t);
  const turn = t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
  await tick();
  held.refuse();
  await turn;
  await tick();
  assert.deepEqual(names(t), []);
  assert.deepEqual(
    t.controls.filter(([, m]: any) => m === 'generateTitle'),
    [],
  );
  assert.equal(t.adapter.titling.size, 0);
});

test("a rename while the warm title CLI writes keeps the user's name: the shown title is not saved or taken back", async () => {
  const t = setup();
  t.adapter.registerSession(CHAT);
  let named = false;
  t.api.userTitle = async () => (named ? 'Mine' : null);
  t.api.title = async (...args: any[]) => ((named = true), args[5]?.helper ? 'Login bug' : 'Fallback title');
  await t.adapter.startTurn(CHAT, ref(CHAT), item('fix the login bug'));
  await tick();
  assert.deepEqual(t.renamed, []);
  assert.deepEqual(names(t), [['Login bug', 'fix the login bug']]);
});
