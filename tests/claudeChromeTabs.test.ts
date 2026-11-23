// Claude in Chrome's tab group and the life of an idle Claude Code CLI (electron/harness/claude/chromeTabs.cjs,
// electron/harness/claude/index.cjs): reading what each Claude in Chrome result says the session's group holds, and
// ending an idle CLI gracefully (its input closes, so the CLI's own exit hook closes a group left with
// only blank tabs) after such a turn, when its chat is archived, cleared or deleted, and when the idle
// reaper runs; and the guidance a Claude in Chrome session gets for its first click or typing in a page.
// Run against a fake Agent SDK and a fake Electron; the session code is real.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-chrome-tabs-'));
fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__fakeTabsQuery(args);',
    'export const deleteSession = async (id) => { globalThis.__deleted.push(id); return true; };',
  ].join('\n'),
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});
(globalThis as any).__deleted = [];

/**
 * A CLI process. Each prompt is answered with the messages `reply(text)` gives, then a result. When its
 * input ends it runs its exit hooks and quits (unless `stuck`), the way the real CLI does on stdin EOF;
 * `log` records the order of those steps against the SDK's close().
 */
const queries: any[] = [];
let reply: (text: string) => any[] = () => [];
(globalThis as any).__fakeTabsQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    log: [] as string[],
    stuck: false,
    throwOnClose: false,
    quit: false,
    close() {
      q.log.push('close');
      q.quit = true;
      wake();
      if (q.throwOnClose) throw new Error('already closed');
    },
    async interrupt() {},
    async setPermissionMode() {},
    async enableRemoteControl(on: boolean) {
      return on ? { session_url: 'https://claude.ai/code/session_tabs', bridge_session_id: 'cse_tabs' } : undefined;
    },
    async getSettings() {
      return { applied: {} };
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.quit) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) {
      const text = String(m.message.content);
      // a prompt that holds its turn open answers only when `finish` is called
      const answer = () => {
        out.push(...reply(text), { type: 'result', subtype: 'success' });
        wake();
      };
      if (text === 'hold') q.finish = answer;
      else answer();
    }
    q.log.push('eof');
    if (q.stuck) return;
    q.log.push('exit hooks');
    q.quit = true;
    wake();
  })();
  queries.push(q);
  return q;
};

process.env.MOPILOT_REAPER_TEST = '1';
const require = createRequire(import.meta.url);
const claude = require('../electron/harness/claude/index.cjs').createClaudeHarness();
const { ChromeTabs, tabsOf, BLANK, INPUT_GUIDANCE } = require('../electron/harness/claude/chromeTabs.cjs');
const { toolNamespaceNote } = require('../electron/plugins/contract/vendorSkills.cjs');

const handlers = new Map<string, (...a: any[]) => any>();
const call = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
claude.register({ handle: (name: string, fn: any) => handlers.set(name, fn) }, () => {});
claude.timing.blankGroupMs = 20;
claude.timing.retireMs = 200;

async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what).catch(() => {});
  assert.ok(ok(), `timed out waiting for ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let serial = 0;
/** Sends a chat's message and returns its CLI's query once it answered (a new one when the CLI restarted). */
async function message(key: string, text = 'hi', extra: any = {}) {
  const before = queries.length;
  const sid = key.replace(/^claude:/, '');
  await claude.send(
    key,
    { bin: process.execPath, sessionId: sid, resume: true, cwd: tmp, account: 'default', ...extra },
    { role: 'user', content: text },
  );
  return queries.length > before ? queries[before] : queries.findLast((q: any) => q.options.resume === sid || q.options.sessionId === sid);
}
const newKey = () => `claude:tabs-${++serial}`;
const live = (key: string) => claude.turnApi.isLive(key);

/* ---------- Claude in Chrome results ---------- */

const chromeUse = (id: string, name = 'tabs_context_mcp') => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: `mcp__claude-in-chrome__${name}`, input: {} }] },
});
const result = (id: string, content: any) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const footer = (...urls: string[]) =>
  `\n\nTab Context:\n- Executed on tabId: 1\n- Available tabs:\n${urls.map((u, i) => `  • tabId ${i + 1}: "Tab (${i})" ("${u}")`).join('\n')}`;

test("a result names the tabs of the group: tabs_context_mcp's JSON, or the footer of any other tool", () => {
  assert.deepEqual(tabsOf(JSON.stringify({ availableTabs: [{ tabId: 1, url: 'chrome://newtab/' }, { tabId: 2 }], tabGroupId: 9 })), [
    'chrome://newtab/',
    '',
  ]);
  assert.deepEqual(tabsOf(`Navigated${footer('https://a.test/', 'about:blank')}`), ['https://a.test/', 'about:blank']);
  // a batch repeats the footer: the last one is the group as it is now
  assert.deepEqual(tabsOf(`${footer('https://a.test/')}\n${footer('chrome://newtab/')}`), ['chrome://newtab/']);
  // the last tab closed: the list is empty, and whatever follows it is not a tab
  assert.deepEqual(tabsOf('Closed tab 1. Group is now empty (auto-removed).\n\nTab Context:\n- Available tabs:\n'), []);
  assert.deepEqual(tabsOf(`${footer('chrome://newtab/')}\n<system-reminder>Prefer browser_batch</system-reminder>`), ['chrome://newtab/']);
  // nothing about tabs
  for (const text of ['Clicked on element ref_5', '{"x":1}', 'null', '[1,2]', undefined, 7])
    assert.equal(tabsOf(text as any), null, String(text));
  assert.ok(BLANK.has('chrome://newtab/') && BLANK.has('about:blank'));
  // a reply that looks like JSON but was cut short has no tab list, and is recorded
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  clearIgnored();
  assert.equal(tabsOf(' {"availableTabs": [{"url": "ht'), null);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.context),
    ['read the Claude in Chrome tab list'],
  );
});

test('a session has a group while a Chrome call is under way or its last result listed tabs', () => {
  const t = new ChromeTabs();
  assert.equal(t.hasGroup(), false, 'no call yet');
  t.note(chromeUse('g1'));
  assert.equal(t.hasGroup(), true, 'a call under way may open one');
  t.note(result('g1', footer('chrome://newtab/')));
  assert.equal(t.hasGroup(), true, 'the group holds a tab');
  t.note(chromeUse('g2'));
  t.note(result('g2', 'Done.\n\nAvailable tabs:\n'));
  assert.equal(t.hasGroup(), false, 'the last tab closed');
});

test("only a Claude in Chrome call's result counts, and a group of blank tabs alone is blank-only", () => {
  const t = new ChromeTabs();
  assert.equal(t.blankOnly(), false, 'nothing reported yet');
  t.note(null);
  t.note({ type: 'system' });
  t.note({ type: 'assistant', message: { content: 'text' } });
  // another tool's result that looks like a tab list is not the group
  t.note({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'b1', name: 'Bash' },
        { type: 'text', text: 'hi' },
      ],
    },
  });
  t.note(result('b1', footer('chrome://newtab/')));
  assert.equal(t.tabs, null);
  // the seed tab of a new group (string content)
  t.note(chromeUse('c1'));
  t.note(result('c1', JSON.stringify({ availableTabs: [{ tabId: 1, url: 'chrome://newtab/' }] })));
  assert.equal(t.blankOnly(), true);
  // the same call id again is not a Claude in Chrome result any more
  t.note(result('c1', footer('https://a.test/')));
  assert.equal(t.blankOnly(), true);
  // a page in the group (blocks, with an image and a reminder that say nothing about tabs)
  t.note(chromeUse('c2', 'navigate'));
  t.note(
    result('c2', [
      { type: 'text', text: 'Navigated' },
      { type: 'image' },
      { type: 'text', text: footer('chrome://newtab/', 'https://a.test/') },
      { type: 'text', text: '<system-reminder>x</system-reminder>' },
    ]),
  );
  assert.equal(t.blankOnly(), false);
  // the page's tab closed, the seed tab is left
  t.note(chromeUse('c3', 'tabs_close_mcp'));
  t.note(result('c3', [{ type: 'text', text: `Closed tab 2.${footer('chrome://newtab/')}` }]));
  assert.equal(t.blankOnly(), true);
  // every tab closed: the group is gone, nothing for the CLI to close
  t.note(chromeUse('c4', 'tabs_close_mcp'));
  t.note(result('c4', { not: 'a list' }));
  t.note(result('c4', 'Group is now empty (auto-removed).\n\nTab Context:\n- Available tabs:\n'));
  assert.equal(t.blankOnly(), true, 'a result with content the tracker cannot read changes nothing');
  t.note(chromeUse('c5', 'tabs_close_mcp'));
  t.note(result('c5', 'Group is now empty (auto-removed).\n\nTab Context:\n- Available tabs:\n'));
  assert.deepEqual(t.tabs, []);
  assert.equal(t.blankOnly(), false);
});

/* ---------- the first click or typing in a page ---------- */

test('the guidance: screenshot a loaded page before its first input, then click by ref or from a later screenshot', () => {
  // an undrawn tab gets no press or key events; only a screenshot draws it
  assert.match(INPUT_GUIDANCE, /loses the first clicks and typing in a page it has not drawn since the page loaded/);
  assert.match(INPUT_GUIDANCE, /the tool reports success but the page gets no press or key events/);
  assert.match(INPUT_GUIDANCE, /take a screenshot of it before your first click, typing or key press there/);
  // the first draw applies a non-100% site zoom after that screenshot read the viewport: its coordinates miss
  assert.match(
    INPUT_GUIDANCE,
    /zoom level is not 100% that first draw also rescales the page, so coordinates read from the first screenshot after a load miss/,
  );
  assert.match(
    INPUT_GUIDANCE,
    /click by element ref \(from find or read_page\), or take coordinates only from a later screenshot \(a second screenshot in the same browser_batch works\)/,
  );
  assert.doesNotMatch(
    INPUT_GUIDANCE,
    /it can be the first action of the same browser_batch/,
    'a screenshot batched right after the navigate is the stale one',
  );
  assert.match(INPUT_GUIDANCE, /form_input, find, read_page and get_page_text are not affected/);
  assert.match(INPUT_GUIDANCE, /confirm the change before you report it done/);
});

test("only a session with Claude in Chrome gets the first-input guidance, appended to Claude Code's own prompt", async () => {
  const base = { type: 'preset', preset: 'claude_code', snapshot: true };
  const withChrome = { ...base, append: `${INPUT_GUIDANCE}\n\n${toolNamespaceNote({ nativeChrome: true })}` };
  const without = { ...base, append: toolNamespaceNote({ nativeChrome: false }) };
  assert.deepEqual(claude.buildSessionOptions({ cwd: tmp }, { nativeChrome: true }).systemPrompt, withChrome);
  assert.deepEqual(claude.buildSessionOptions({ cwd: tmp }, { nativeChrome: false }).systemPrompt, without);
  assert.deepEqual(claude.buildSessionOptions({ cwd: tmp }, {}).systemPrompt, without);
  // a chat's CLI: the switch on, the guidance and --chrome go together; off, neither
  reply = () => [];
  claude.setTools({ nativeChrome: () => true, enabled: () => false });
  const on = newKey();
  const oq = await message(on, 'hi');
  assert.deepEqual(oq.options.extraArgs, { chrome: null });
  assert.deepEqual(oq.options.systemPrompt, withChrome);
  claude.setTools({ nativeChrome: () => false, enabled: () => false });
  const off = newKey();
  const fq = await message(off, 'hi');
  assert.deepEqual(fq.options.extraArgs, { 'no-chrome': null });
  assert.deepEqual(fq.options.systemPrompt, without);
  for (const k of [on, off]) await call('claude:control', k, 'close');
});

/* ---------- a turn that leaves only blank tabs ---------- */

const seedOnly = (id: string) => [chromeUse(id), result(id, JSON.stringify({ availableTabs: [{ tabId: 1, url: 'chrome://newtab/' }] }))];
const withPage = (id: string) => [chromeUse(id, 'navigate'), result(id, `Navigated${footer('https://a.test/')}`)];

test('after a turn that leaves only blank tabs, the idle CLI ends gracefully and the next message resumes', async () => {
  claude.setTools({ nativeChrome: () => true, enabled: () => false });
  reply = (text) => (text === 'seed' ? seedOnly('s1') : []);
  const key = newKey();
  const q = await message(key, 'seed', { chatId: 'chat-a' });
  assert.deepEqual(q.options.extraArgs, { chrome: null });
  await until('the CLI to end', () => !live(key) && q.log.includes('close'));
  // stdin closed first and the CLI ran its exit hooks before the SDK closed it
  assert.deepEqual(q.log, ['eof', 'exit hooks', 'close']);
  const next = await message(key, 'again');
  assert.notEqual(next, q);
  assert.equal(next.options.resume, key.replace('claude:', ''));
  // that turn left no blank group: the CLI stays
  await sleep(60);
  assert.equal(live(key), true);
  await call('claude:control', key, 'close');
});

test('a group with a page in it, a session without Claude in Chrome, or a quick follow-up keeps the CLI', async () => {
  claude.setTools({ nativeChrome: () => true, enabled: () => false });
  reply = (text) => (text === 'page' ? withPage('p1') : text === 'seed' ? seedOnly('p2') : []);
  const page = newKey();
  await message(page, 'page');
  // no Claude in Chrome: its results are not read
  claude.setTools({ nativeChrome: () => false, enabled: () => false });
  const plain = newKey();
  const pq = await message(plain, 'seed');
  assert.deepEqual(pq.options.extraArgs, { 'no-chrome': null });
  // a message still unanswered when a turn ends: the CLI waits for its answer too
  claude.setTools({ nativeChrome: () => true, enabled: () => false });
  reply = (text) => (text === 'page' ? withPage('p1') : seedOnly(`p-${text}`));
  const quick = newKey();
  const qq = await message(quick, 'hold');
  await message(quick, 'second');
  await sleep(80);
  assert.equal(live(page), true);
  assert.equal(live(plain), true);
  assert.equal(live(quick), true);
  assert.equal(qq.log.length, 0);
  // the group still holds only its blank tab once both are answered
  qq.finish();
  await until('the CLI to end after both answers', () => qq.log.includes('close'));
  assert.equal(queries.indexOf(qq), queries.length - 1, 'no other CLI started meanwhile');
  // a new message within the delay keeps it
  claude.timing.blankGroupMs = 400;
  try {
    const busy = newKey();
    const bq = await message(busy, 'seed');
    await until('the first answer', () => claude.ownBusy(busy) === false);
    await message(busy, 'hold');
    await sleep(450);
    assert.equal(live(busy), true);
    assert.equal(bq.log.length, 0);
    await call('claude:control', busy, 'close');
  } finally {
    claude.timing.blankGroupMs = 20;
  }
  for (const k of [page, plain]) await call('claude:control', k, 'close');
});

test('a CLI whose Remote Control link is wanted stays after a turn that leaves only blank tabs, one without a link ends', async () => {
  claude.setTools({ nativeChrome: () => true, enabled: () => false });
  reply = () => seedOnly('r1');
  const linked = newKey();
  const lq = await message(linked, 'hold');
  await call('claude:control', linked, 'remoteControl', { on: true });
  const plain = newKey();
  const pq = await message(plain, 'hold');
  lq.finish();
  pq.finish();
  await until('the CLI without a link to end', () => pq.log.includes('close'));
  assert.equal(live(linked), true);
  assert.equal(lq.log.length, 0);
  await call('claude:control', linked, 'close');
});

test('the reaper, hours later, ends an idle CLI but not one whose Remote Control link is wanted', async () => {
  claude.setTools({ nativeChrome: () => false, enabled: () => false });
  reply = () => [];
  const linked = newKey();
  const lq = await message(linked, 'hi');
  await call('claude:control', linked, 'remoteControl', { on: true });
  const plain = newKey();
  const pq = await message(plain, 'hi');
  await until('both turns to settle', () => !claude.ownBusy(linked) && !claude.ownBusy(plain));
  (globalThis as any).__claudeReap(2 * 60 * 60_000);
  await until('the CLI without a link to end', () => pq.log.includes('close'));
  assert.equal(live(linked), true);
  assert.equal(lq.log.length, 0);
  // off, and the same sweep ends it too
  await call('claude:control', linked, 'remoteControl', { on: false });
  (globalThis as any).__claudeReap(2 * 60 * 60_000);
  await until('the CLI to end once its link is off', () => lq.log.includes('close'));
});

test('a side chat, a card left open or background work keeps a CLI whose group is blank', async () => {
  claude.setTools({ nativeChrome: () => true, enabled: () => false });
  reply = (text) =>
    text === 'cron'
      ? [...seedOnly('k1'), { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'k2', name: 'CronCreate', input: {} }] } }]
      : seedOnly('k3');
  const side = newKey();
  await message(side, 'seed', { forkFrom: 'src' });
  const cron = newKey();
  await message(cron, 'cron');
  const card = newKey();
  const cq = await message(card, 'hold');
  // a permission card is up when the turn ends
  const answer = cq.options.canUseTool('Bash', { command: 'ls' }, {});
  cq.finish();
  await sleep(80);
  for (const k of [side, cron, card]) assert.equal(live(k), true, k);
  void answer;
  for (const k of [side, cron, card]) await call('claude:control', k, 'close');
});

/* ---------- retire ---------- */

test('a CLI that does not quit by itself is closed by the SDK after the grace; closing errors are ignored', async () => {
  claude.setTools(null);
  reply = () => [];
  const key = newKey();
  const q = await message(key);
  q.stuck = true;
  q.throwOnClose = true;
  assert.equal(await claude.retire(key, 30), false);
  assert.deepEqual(q.log, ['eof', 'close']);
  assert.equal(live(key), false);
  assert.equal(await claude.retire(key), false, 'nothing left to end');
});

test('a message for a chat whose CLI is still ending starts the next CLI only after it quit', async () => {
  claude.setTools(null);
  reply = () => [];
  const key = newKey();
  const q = await message(key);
  q.stuck = true;
  const ending = claude.retire(key, 60);
  const next = await message(key, 'next');
  assert.ok(q.log.includes('close'), 'the old CLI was closed first');
  assert.notEqual(next, q);
  assert.equal(await ending, false);
  await call('claude:control', key, 'close');
});

test('an archived or cleared chat ends its idle CLIs now and a running one after its turn', async () => {
  claude.setTools(null);
  reply = () => [];
  const idle = newKey();
  const iq = await message(idle, 'hi', { chatId: 'chat-x' });
  const running = newKey();
  const rq = await message(running, 'hold', { chatId: 'chat-x' });
  const side = newKey();
  await message(side, 'hi', { chatId: 'chat-x', forkFrom: 'src' });
  const other = newKey();
  await message(other, 'hi', { chatId: 'chat-y' });
  // a chat with no chat id is known by its key
  const bare = newKey();
  await message(bare);
  assert.equal(claude.retireChat('chat-x'), 1);
  await until('the idle CLI to end', () => iq.log.includes('close'));
  assert.equal(live(running), true);
  rq.finish();
  await until('the running CLI to end after its turn', () => rq.log.includes('close'));
  assert.deepEqual(rq.log, ['eof', 'exit hooks', 'close']);
  assert.equal(live(side), true);
  assert.equal(live(other), true);
  assert.equal(claude.retireChat(bare), 1);
  await until('the CLI known by its key to end', () => !live(bare));
  assert.equal(claude.retireChat('chat-none'), 0);
  for (const k of [side, other]) await call('claude:control', k, 'close');
});

test('a running chat archived with background work keeps its CLI after the turn', async () => {
  claude.setTools(null);
  reply = () => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { delaySeconds: 600 } }] } },
  ];
  const key = newKey();
  const q = await message(key, 'hold', { chatId: 'chat-z' });
  assert.equal(claude.retireChat('chat-z'), 0);
  q.finish();
  await sleep(80);
  assert.equal(live(key), true);
  await call('claude:control', key, 'close');
});

test('the idle reaper ends CLIs idle past an hour gracefully, and only those', async () => {
  claude.setTools(null);
  reply = () => [];
  const old = newKey();
  const oq = await message(old);
  const fresh = newKey();
  await message(fresh);
  const { IDLE_MS } = require('../electron/harness/claude/governor.cjs');
  claude.reap(Date.now() + IDLE_MS - 60_000);
  await sleep(20);
  assert.equal(live(old), true, 'not idle long enough');
  claude.reap(Date.now() + IDLE_MS + 60_000);
  await until('the idle CLIs to end', () => !live(old) && !live(fresh) && oq.log.includes('close'));
  assert.deepEqual(oq.log, ['eof', 'exit hooks', 'close']);
  claude.reap();
});

test('deleting a chat ends its CLI gracefully before the transcript goes', async () => {
  claude.setTools(null);
  reply = () => [];
  const key = newKey();
  const q = await message(key);
  const sid = key.replace('claude:', '');
  assert.equal(await claude.deleteSession(sid), true);
  assert.deepEqual(q.log, ['eof', 'exit hooks', 'close']);
  assert.deepEqual((globalThis as any).__deleted, [sid]);
  // a chat with no CLI is deleted at once
  assert.equal(await claude.deleteSession('gone'), true);
});

test('malformed tab-result text cannot abort the session or hide a valid footer', () => {
  const tabs = new ChromeTabs();
  tabs.note(chromeUse('typed'));
  const content = [
    { type: 'text', text: 42 },
    { type: 'text', text: footer('about:blank') },
  ];
  tabs.note(result('typed', content));
  assert.equal(tabs.blankOnly(), true);
});
