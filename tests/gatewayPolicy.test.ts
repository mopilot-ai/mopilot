// The user's rules on the gateway's tools, end to end through main's real tool Registry and the real rules store (electron/gateway/policy.cjs, offer.cjs, rules.cjs, #2999 C3): a block hides the tool from a chat's list and is refused at every call, also when the harness still holds an older list (B6) and under Full access; a rule changed between a listing and the call holds at the call, and one written while the card is up holds for that call; a project rule is decided with the chat's folder at the call (a listing can't know it, so it doesn't hide); Allow once runs once, Always allow writes a rule for that tool in the chat's project; a card that goes away is no answer and stores nothing (B1); unreadable rules make every call ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { gatewayWorld, fakeServer, tick, READ, stdio, gatewayDir } from './support/gatewayWorld.ts';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { GatewayPolicy } = require('../electron/gateway/policy.cjs');
const { RulesStore } = require('../electron/gateway/rules.cjs');

const list = { name: 'list_notes', description: 'List.', inputSchema: READ, annotations: { readOnlyHint: true } };
const add = { name: 'add_note', description: 'Add.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } };
const settled = async () => {
  for (let i = 0; i < 20; i++) await tick();
};

/** A gateway whose tools run under real rules; each chat's harness, mode and folder are the test's. */
async function world(
  o: { ask?: (chatId: string, signal: AbortSignal, card: any) => Promise<any>; projectOf?: (id: string) => Promise<string | null> } = {},
) {
  const rules = new RulesStore({ file: path.join(gatewayDir(), 'rules.json'), now: () => 5 });
  const chats: Record<string, { harness: string; fullAccess: boolean; project: string | null; worktreeOf?: string }> = {
    'chat-1': { harness: 'codex', fullAccess: false, project: '/work/app' },
    'chat-2': { harness: 'claude', fullAccess: false, project: '/work/other' },
    full: { harness: 'claude', fullAccess: true, project: '/work/app' },
  };
  const policy = new GatewayPolicy({
    rules,
    chatOf: (id: string) => chats[id] ?? null,
    projectOf: o.projectOf ?? (async (id: string) => chats[id]?.project ?? null),
  });
  const srv = fakeServer([list, add]);
  const w = gatewayWorld({ servers: { notes: srv }, policy, ...(o.ask ? { ask: o.ask } : {}) });
  // "Always allow" goes through the gateway, as the wiring sends it
  policy.rules = { view: () => rules.view(), add: (r: unknown) => w.gateway.addRule(r) } as any;
  (w.gateway as any).rules = rules;
  const { key } = await w.gateway.add(stdio('notes'));
  await settled();
  const name = (tool: string) => w.registry.list({ chatId: 'chat-1', all: true }).find((t: any) => t.name.endsWith(tool))?.name;
  return { ...w, srv, key, rules, chats, policy, ro: name('list_notes'), rw: name('add_note') };
}
const rule = (key: string, stance: string, scope = 'all', pattern = '*') => ({ connector: key, pattern, stance, scope });
const handlerOf = (w: any, name: string) => w.registry.tools.get(name).handler;
const ctx = (chatId: string) => ({ chatId, signal: new AbortController().signal });

test('no rule: a read-only tool runs, a change asks once per call; Full access runs both with no card', async () => {
  const w = await world();
  assert.equal((await w.call(w.ro, {})).ok, true);
  assert.equal(w.s.cards.length, 0);
  assert.equal((await w.call(w.rw, { text: 'a' })).ok, true);
  assert.equal(w.s.cards.length, 1);
  // the card offers Always allow, in the chat's project
  assert.deepEqual(
    w.s.cards[0].card.choices.map((c: any) => c.label),
    ['Allow once', 'Always allow in this project'],
  );
  assert.equal((await w.call(w.rw, { text: 'b' }, 'full')).ok, true);
  assert.equal(w.s.cards.length, 1);
});

test('a block hides the tool from the chat’s list and refuses the call, under Full access too, even from a list held since', async () => {
  const w = await world();
  const held = handlerOf(w, w.rw);
  await w.rules.add(rule(w.key, 'block', 'all', 'add_*'));
  for (const chatId of ['chat-1', 'full']) {
    assert.ok(!w.names(chatId).includes(w.rw), chatId);
    assert.ok(w.names(chatId).includes(w.ro), chatId);
    await assert.rejects(
      held({ text: 'x' }, ctx(chatId)),
      (e: any) => e.code === 'refused' && /^Blocked by your rule for add_note/.test(e.message),
    );
  }
  assert.equal(w.srv.calls.length, 0);
  assert.equal(w.s.cards.length, 0, 'a block asks nothing');
  // a block scoped to one harness leaves the others
  await w.rules.reset();
  await w.rules.add(rule(w.key, 'block', 'harness:claude'));
  assert.ok(w.names('chat-1').includes(w.rw));
  assert.ok(!w.names('chat-2').includes(w.rw));
});

test('B6: a rule changed between the listing and the call holds at the call; one written while the card is up holds for that call', async () => {
  let release!: (v: any) => void;
  let atCard!: () => void;
  const carded = new Promise<void>((r) => (atCard = r));
  const w = await world({ ask: () => (atCard(), new Promise((r) => (release = r))) });
  // listed as allowed (read-only), then blocked before the call
  assert.ok(w.names('chat-1').includes(w.ro));
  const held = handlerOf(w, w.ro);
  const blockRead = await w.rules.add(rule(w.key, 'block', 'all', 'list_notes'));
  // a harness that lists again doesn't see it, and the Registry refuses it; one that kept its list is refused by the rule
  assert.ok(!w.names('chat-1').includes(w.ro));
  assert.equal((await w.call(w.ro, {})).error.code, 'unavailable');
  await assert.rejects(held({}, ctx('chat-1')), (e: any) => e.code === 'refused' && /\(list_notes, every chat\)/.test(e.message));
  await w.rules.remove(blockRead.id);
  // a block written while the card waits: the Allow that comes after runs nothing
  const p = w.call(w.rw, { text: 'x' });
  await carded;
  await w.rules.add(rule(w.key, 'block', 'project:/work'));
  release({ decision: 'allow', choice: 'once' });
  const after = await p;
  assert.equal(after.error.code, 'refused');
  assert.equal(w.srv.calls.length, 0);
});

test('a project rule is decided with the chat’s folder at the call: listed for every chat, refused only in that project', async () => {
  const w = await world();
  await w.rules.add(rule(w.key, 'block', 'project:/work/app'));
  // the list can't know the folder: shown (the call decides)
  assert.ok(w.names('chat-1').includes(w.rw));
  assert.equal((await w.call(w.rw, {}, 'chat-1')).error.code, 'refused');
  const other = await w.call(w.rw, {}, 'chat-2');
  assert.equal(other.ok, true, JSON.stringify(other));
  // a deeper folder's allow wins over a shallower block; an allow at the same folder ties, and block wins a tie
  await w.rules.add(rule(w.key, 'allow', 'project:/work/app', 'add_note'));
  assert.equal((await w.call(w.rw, {}, 'chat-1')).error.code, 'refused');
  await w.rules.reset();
  await w.rules.add(rule(w.key, 'block', 'project:/work'));
  await w.rules.add(rule(w.key, 'allow', 'project:/work/app', 'add_note'));
  assert.equal((await w.call(w.rw, {}, 'chat-1')).ok, true);
  assert.equal((await w.call(w.rw, {}, 'chat-2')).error.code, 'refused');
  const blind = await world({
    projectOf: async () => {
      throw new Error('unreadable');
    },
  });
  // an ask for the project: under Full access the answer turns on whether the chat is in it
  await blind.rules.add(rule(blind.key, 'ask', 'project:/work/app'));
  // a folder that can't be read: a project rule might apply, so the call asks (fail closed), and offers no Always allow
  assert.equal((await blind.call(blind.ro, {}, 'full')).ok, true);
  assert.match(blind.s.cards[0].card.message, /can’t read this chat’s folder/);
  assert.deepEqual(
    blind.s.cards[0].card.choices.map((c: any) => c.id),
    ['once'],
  );
  // a block for every chat still holds
  await blind.rules.add(rule(blind.key, 'block', 'all'));
  assert.equal((await blind.call(blind.ro, {}, 'full')).error.code, 'refused');
});

test('an ask rule asks for a read-only tool and offers no Always allow (the user’s own rule isn’t overridden from a card)', async () => {
  const w = await world({ ask: async () => ({ decision: 'allow', choice: 'always' }) });
  await w.rules.add(rule(w.key, 'ask', 'all', 'list_*'));
  assert.equal((await w.call(w.ro, {})).ok, true);
  assert.match(w.s.cards[0].card.message, /Your rule for this tool asks before each use\./);
  assert.deepEqual(
    w.s.cards[0].card.choices.map((c: any) => c.id),
    ['once'],
  );
  // an "always" answer anyway (an old card, a crafted answer) writes nothing
  assert.equal(w.rules.view().rules.length, 1);
  await w.call(w.ro, {});
  assert.equal(w.s.cards.length, 2, 'still asks');
});

test('Always allow writes a rule for that tool, the chat’s harness and its project; other harnesses and projects still ask', async () => {
  const w = await world({ ask: async () => ({ decision: 'allow', choice: 'always' }) });
  w.chats['chat-3'] = { harness: 'claude', fullAccess: false, project: '/work/app' };
  assert.equal((await w.call(w.rw, {})).ok, true);
  const saved = w.rules.view().rules[0];
  assert.deepEqual(
    [saved.connector, saved.pattern, saved.stance, saved.scope, saved.harness],
    [w.key, 'add_note', 'allow', 'project:/work/app', 'codex'],
  );
  assert.equal((await w.call(w.rw, {})).ok, true);
  assert.equal(w.s.cards.length, 1, 'allowed by the rule now');
  // the same folder on another harness, and another folder on this one, still ask
  await w.call(w.rw, {}, 'chat-3');
  w.chats['chat-1'].project = '/work/elsewhere';
  await w.call(w.rw, {}, 'chat-1');
  assert.equal(w.s.cards.length, 3);
  // two Always allows at once keep one rule
  w.chats['chat-1'].project = '/work/app';
  await w.rules.reset();
  await Promise.all([w.call(w.rw, {}), w.call(w.rw, {})]);
  assert.equal(w.rules.view().rules.length, 1);
  // a chat whose folder couldn't be read (null): Allow once only, so no rule ever reaches every chat or another project
  w.chats['chat-1'].project = null;
  await w.rules.reset();
  await w.call(w.rw, {}, 'chat-1');
  assert.deepEqual(w.rules.view().rules, []);
  assert.deepEqual(
    w.s.cards.at(-1).card.choices.map((c: any) => c.id),
    ['once'],
  );
});

test('Always allow in one harness’s chat never outranks a block the user wrote for another harness in the same folder', async () => {
  const w = await world({ ask: async () => ({ decision: 'allow', choice: 'always' }) });
  w.chats['codex-full'] = { harness: 'codex', fullAccess: true, project: '/work/app' };
  w.chats['claude-1'] = { harness: 'claude', fullAccess: false, project: '/work/app' };
  await w.rules.add(rule(w.key, 'block', 'harness:codex', 'add_*'));
  // the Claude chat asks (no rule for it) and the user always-allows there
  assert.equal((await w.call(w.rw, {}, 'claude-1')).ok, true);
  assert.equal(w.rules.view().rules.length, 2);
  // the Codex chat in the same folder, under Full access: still blocked and still hidden
  assert.ok(!w.names('codex-full').includes(w.rw));
  await assert.rejects(handlerOf(w, w.rw)({}, ctx('codex-full')), (e: any) => e.code === 'refused');
  assert.equal(w.srv.calls.length, 1, 'only the Claude chat’s call ran');
});

test('a managed worktree’s chat is in its project: the project’s rules hold there, and Always allow is for the project', async () => {
  const w = await world({ ask: async () => ({ decision: 'allow', choice: 'always' }) });
  w.chats['wt'] = { harness: 'codex', fullAccess: true, project: '/Users/me/.mopilot/worktrees/app-1', worktreeOf: '/work/app' } as any;
  await w.rules.add(rule(w.key, 'block', 'project:/work/app', 'add_*'));
  assert.equal((await w.call(w.rw, {}, 'wt')).error.code, 'refused');
  await w.rules.reset();
  w.chats['wt'].fullAccess = false;
  await w.call(w.rw, {}, 'wt');
  assert.equal(w.rules.view().rules[0].scope, 'project:/work/app');
});

test('folders: a symlink is the same folder; a Windows path is written with `/`; one that can’t be resolved is as written', async () => {
  const realDir = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gw-folder-')));
  const link = `${realDir}-link`;
  fs.symlinkSync(realDir, link);
  const w = await world();
  w.chats['linked'] = { harness: 'codex', fullAccess: true, project: link };
  await w.rules.add(rule(w.key, 'block', `project:${realDir}`));
  assert.equal((await w.call(w.rw, {}, 'linked')).error.code, 'refused');
  // a rule added through the gateway is kept under the folder's real path
  await w.rules.reset();
  await w.gateway.addRule(rule(w.key, 'block', `project:${link}`));
  assert.equal(w.rules.view().rules[0].scope, `project:${realDir}`);
  fs.rmSync(link);
  fs.rmSync(realDir, { recursive: true, force: true });
  const { realFolder } = require('../electron/gateway/policy.cjs');
  const gone = () => {
    throw new Error('ENOENT');
  };
  assert.equal(realFolder('C:\\Work\\App', { platform: 'win32', realpath: () => 'C:\\Work\\App' }), 'C:/Work/App');
  assert.equal(realFolder('C:\\Work\\..\\App', { platform: 'win32', realpath: gone }), 'C:/App');
  assert.equal(realFolder('/a/./b', { platform: 'darwin', realpath: gone }), '/a/b');
  assert.equal(realFolder('/tmp'), fs.realpathSync.native('/tmp'));
  // a rule's folder, however it was typed: Windows case, separators, a trailing / and a network share; others as they are
  const { canonicalScope } = require('../electron/gateway/policy.cjs');
  assert.equal(canonicalScope('project:c:\\Work\\App\\', { platform: 'win32', realpath: gone }), 'project:C:/Work/App');
  assert.equal(canonicalScope('project:\\\\srv\\share\\app', { platform: 'win32', realpath: (p: string) => p }), 'project://srv/share/app');
  assert.equal(canonicalScope('project:relative/dir', { platform: 'darwin' }), 'project:relative/dir');
  assert.equal(canonicalScope('harness:codex'), 'harness:codex');
  assert.equal(canonicalScope(5), 5);
  // through the gateway: kept as its real path, a trailing / gone
  await w.gateway.addRule(rule(w.key, 'ask', `project:${require('node:os').tmpdir()}/`));
  assert.equal(w.rules.view().rules.at(-1).scope, `project:${fs.realpathSync.native(require('node:os').tmpdir())}`);
});

test('a folder its harness couldn’t read (chatProject answers null) asks where a project rule might apply; a block still holds', async () => {
  const w = await world({ projectOf: async () => null });
  await w.rules.add(rule(w.key, 'block', 'project:/work/app'));
  // Full access would run it; the folder is unknown, so it asks instead of skipping the project's block
  const r = await w.call(w.rw, {}, 'full');
  assert.equal(r.ok, true);
  assert.equal(w.s.cards.length, 1);
  assert.match(w.s.cards[0].card.message, /can’t read this chat’s folder/);
  assert.deepEqual(
    w.s.cards[0].card.choices.map((c: any) => c.id),
    ['once'],
  );
  // no project rule at all: nothing to be unsure of, the chat's mode decides
  const plain = await world({ projectOf: async () => null });
  assert.equal((await plain.call(plain.rw, {}, 'full')).ok, true);
  assert.equal(plain.s.cards.length, 0);
  // a project rule that would give the same stance (an allow elsewhere, under Full access) doesn't make it ask
  await plain.rules.add(rule(plain.key, 'allow', 'project:/elsewhere'));
  assert.equal((await plain.call(plain.rw, {}, 'full')).ok, true);
  assert.equal(plain.s.cards.length, 0);
});

test('a managed worktree’s chat is decided by its project’s folder alone: a rule on the worktrees folder doesn’t reach it', async () => {
  const w = await world();
  w.chats['wt'] = {
    harness: 'codex',
    fullAccess: false,
    project: '/Users/me/.mopilot/worktrees/secret-1',
    worktreeOf: '/work/secret',
  } as any;
  await w.rules.add(rule(w.key, 'allow', 'project:/Users/me/.mopilot/worktrees'));
  await w.rules.add(rule(w.key, 'block', 'project:/work/secret'));
  assert.equal((await w.call(w.rw, {}, 'wt')).error.code, 'refused');
});

test('B1: a card that goes away, a denial or Allow once stores no rule; a failed Always allow write still runs the call it allowed', async () => {
  for (const answer of [null, { decision: 'deny' }, { decision: 'allow', choice: 'once' }]) {
    const w = await world({ ask: async () => answer });
    await w.call(w.rw, {});
    assert.deepEqual(w.rules.view().rules, [], JSON.stringify(answer));
  }
  const w = await world({ ask: async () => ({ decision: 'allow', choice: 'always' }) });
  fs.mkdirSync(path.dirname(w.rules.file), { recursive: true });
  fs.writeFileSync(w.rules.file, 'torn');
  const r = await w.call(w.rw, {});
  // the file can't be read: the card says so, the allowed call runs, and the file is left as it was
  assert.match(w.s.cards[0].card.message, /can’t read your gateway rules/);
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(w.rules.file, 'utf8'), 'torn');
});

test('unreadable rules: every call asks (read-only and Full access too) and nothing is hidden', async () => {
  const w = await world({ ask: async () => ({ decision: 'deny' }) });
  fs.mkdirSync(path.dirname(w.rules.file), { recursive: true });
  fs.writeFileSync(w.rules.file, 'torn');
  assert.ok(w.names('full').includes(w.rw));
  for (const chatId of ['chat-1', 'full']) assert.equal((await w.call(w.ro, {}, chatId)).error.code, 'denied');
  assert.equal(w.s.cards.length, 2);
  // a chat main can't read the settings of is not Full access
  const r = await w.call(w.ro, {}, 'unknown-chat');
  assert.equal(r.error.code, 'denied');
});
