// The directory tools (electron/capabilities/tools/directoryTools.cjs): a folder is granted only after the user picked it or
// approved the exact path, what was approved must still be what the path names, the model is told whether its harness has the
// folder now, a session's working directory is never claimed to have moved, and the branch question reaches the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerDirectoryTools, validBranch } = require('../electron/capabilities/tools/directoryTools.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'directory-tools-')));
const project = path.join(root, 'project');
const other = path.join(root, 'other');
const file = path.join(root, 'file.txt');
fs.mkdirSync(project);
fs.mkdirSync(other);
fs.writeFileSync(file, 'x');
fs.symlinkSync(other, path.join(root, 'other-link'));

function setup(
  over: {
    answer?: any;
    picked?: string | null;
    grant?: any;
    git?: any;
    folders?: string[];
    worktree?: { branch: string | null } | null;
    onAsk?: (card: any) => void;
  } = {},
) {
  const r = new Registry();
  r.setApprover(async () => true);
  const cards: any[] = [];
  const grants: any[] = [];
  const dispose = registerDirectoryTools(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    sessionFolders: { folders: async () => over.folders ?? [project] },
    grant: async (chatId: string, dir: string) => (grants.push([chatId, dir]), over.grant ?? { status: 'granted', note: null }),
    ask: async (chatId: string, signal: any, card: any) => {
      assert.ok(signal === null || signal instanceof AbortSignal);
      cards.push([chatId, card]);
      over.onAsk?.(card);
      return over.answer === undefined ? { decision: 'allow', choice: card.choices[0].id } : over.answer;
    },
    pickFolder: async () => (over.picked === undefined ? null : over.picked),
    git: over.git ?? (async () => ({ ok: true, stdout: 'main\n' })),
    worktreeInfo: () => over.worktree ?? null,
  });
  const call = async (tool: string, args: any, chat = 'c') => {
    const res = await r.invoke(chat, 'seg', tool, args);
    return res.ok ? res.content[0].text : `ERROR ${res.error.code}: ${res.error.message}`;
  };
  return { r, call, cards, grants, dispose };
}

test('the tools are registered under their Claude Desktop names, and a call from a segment no chat owns is refused', async () => {
  const t = setup();
  assert.deepEqual(
    t.r.list().map((x: any) => [x.name, x.policy]),
    [
      ['request_directory', 'act'],
      ['change_directory', 'act'],
      ['propose_branch', 'act'],
    ],
  );
  assert.match(String((await t.r.invoke('c', 'other', 'request_directory', {})).error?.message), /does not own/);
  t.dispose();
  assert.deepEqual(t.r.list(), []);
});

test('request_directory with a path: the user approves that exact folder, then it is granted and the model hears which path to use', async () => {
  const t = setup();
  const text = await t.call('request_directory', { path: other });
  assert.equal(t.cards.length, 1);
  assert.deepEqual(t.cards[0][1], {
    title: 'Folder access',
    message: 'Give this session access to this folder?',
    details: [other],
    choices: [{ id: 'allow', label: 'Allow' }],
  });
  assert.deepEqual(t.grants, [['c', other]]);
  assert.match(
    text,
    new RegExp(`^Folder access granted: ${other}\n\nUse this exact absolute path when reading or writing files there\\.$`),
  );
  // a link names the same folder: the card and the grant carry the real path
  const linked = setup();
  await linked.call('request_directory', { path: path.join(root, 'other-link') });
  assert.deepEqual(linked.grants, [['c', other]]);
  assert.deepEqual(linked.cards[0][1].details, [other]);
});

test('request_directory: a folder the session already has needs no card; a decline grants nothing and says not to ask again', async () => {
  const t = setup();
  assert.match(await t.call('request_directory', { path: path.join(project) }), /Folder access granted/);
  assert.deepEqual(t.cards, []);
  const declined = setup({ answer: { decision: 'deny' } });
  const text = await declined.call('request_directory', { path: other });
  assert.match(text, /^ERROR denied: The user declined to give access to that folder/);
  assert.match(text, /Do not ask for it again/);
  assert.deepEqual(declined.grants, []);
  // a card that went away unanswered (the call was stopped) is a no as well
  assert.match(await setup({ answer: null }).call('request_directory', { path: other }), /^ERROR denied/);
});

test('request_directory: what was approved must still be what the path names when the answer comes', async () => {
  const swap = path.join(root, 'swap');
  fs.symlinkSync(other, swap);
  const t = setup({
    onAsk: () => {
      // while the card waits, the path is pointed at another folder
      fs.rmSync(swap);
      fs.symlinkSync(project, swap);
    },
  });
  assert.match(await t.call('request_directory', { path: swap }), /^ERROR changed: The directory changed while approval was pending/);
  assert.deepEqual(t.grants, []);
});

test('request_directory without a path opens the picker: the choice is the approval, a cancel is not an error', async () => {
  const t = setup({ picked: other });
  assert.match(await t.call('request_directory', {}), /Folder access granted/);
  assert.deepEqual(t.cards, [], 'the user picked it themselves');
  assert.deepEqual(t.grants, [['c', other]]);
  assert.equal(await setup({ picked: null }).call('request_directory', {}), 'Directory selection was cancelled by the user.');
  assert.equal(await setup({ picked: null }).call('request_directory', { path: '   ' }), 'Directory selection was cancelled by the user.');
});

test('request_directory refuses a path that is not an absolute existing folder, and the filesystem root', async () => {
  const t = setup();
  assert.match(await t.call('request_directory', { path: 'relative/dir' }), /^ERROR invalid_args: `path` must be an absolute folder path/);
  assert.match(await t.call('request_directory', { path: path.join(root, 'nope') }), /^ERROR not_found: No folder at/);
  assert.match(await t.call('request_directory', { path: file }), /^ERROR invalid_args: .* is a file, not a folder/);
  assert.match(
    await t.call('request_directory', { path: path.parse(root).root }),
    /^ERROR invalid_args: The filesystem root can not be granted/,
  );
  assert.deepEqual(t.cards, []);
  // ~ is the home folder
  const home = setup({ onAsk: (card) => assert.deepEqual(card.details, [fs.realpathSync(os.homedir())]) });
  await home.call('request_directory', { path: '~' });
  assert.equal(home.cards.length, 1);
});

test('what the model is told follows what the grant did: the harness note, a chat that is gone, a grant that could not be saved', async () => {
  const later = setup({ grant: { status: 'saved', note: 'It applies from the next turn.' } });
  const text = await later.call('request_directory', { path: other });
  assert.match(
    text,
    /Folder access granted: .*\n\nUse this exact absolute path when reading or writing files there\.\n\nIt applies from the next turn\.$/,
  );
  assert.match(
    await setup({ grant: { status: 'gone', note: null } }).call('request_directory', { path: other }),
    /^ERROR gone: This session is no longer available/,
  );
  assert.match(
    await setup({ grant: { status: 'unsaved', note: null } }).call('request_directory', { path: other }),
    /^ERROR failed: Failed to grant folder access/,
  );
});

test('change_directory needs a path, grants the folder after the card, and says the working directory stays where it is', async () => {
  const t = setup();
  assert.match(await t.call('change_directory', {}), /^ERROR bad_args: missing argument: path/);
  assert.match(await t.call('change_directory', { path: '  ' }), /^ERROR invalid_args: change_directory requires `path`/);
  assert.equal(t.cards.length, 0, 'no picker for a move');
  const text = await t.call('change_directory', { path: other });
  assert.equal(t.cards[0][1].message, 'Move this session to this folder?');
  assert.deepEqual(t.grants, [['c', other]]);
  assert.match(text, /Use this exact absolute path from now on\./);
  assert.match(text, /can't move a running session's working directory, so it stays where it is/);
  // a decline moves nothing
  assert.match(await setup({ answer: { decision: 'deny' } }).call('change_directory', { path: other }), /^ERROR denied/);
});

test('propose_branch asks the user and tells the model what to do: stay, a new branch with the suggested name, or none picked', async () => {
  const t = setup({ answer: { decision: 'allow', choice: 'stay' } });
  assert.match(
    await t.call('propose_branch', { suggested: 'fix/canada-tax' }),
    /^The user wants the changes on the branch that is currently checked out\. Do not create or switch branches\.$/,
  );
  assert.deepEqual(t.cards[0][1], {
    title: 'Branch',
    message: 'Where should the changes go?',
    details: ['New branch: fix/canada-tax', 'Current branch: main'],
    choices: [
      { id: 'new', label: 'New branch' },
      { id: 'stay', label: 'Stay on main' },
    ],
  });
  const fresh = setup({ answer: { decision: 'allow', choice: 'new' } });
  assert.equal(
    await fresh.call('propose_branch', { suggested: 'fix/canada-tax' }),
    'The user wants the changes on a new branch named fix/canada-tax. Create it and switch to it (git switch -c) before editing, and keep the original branch untouched.',
  );
  // dismissed: the suggestion stands, as in Claude Desktop's unanswered case
  assert.match(
    await setup({ answer: null }).call('propose_branch', { suggested: 'fix/a' }),
    /^No branch was picked, so put the changes on a new branch named fix\/a\./,
  );
});

test('propose_branch: a suggestion that is not a safe branch name is dropped; a detached HEAD says so; a folder that is not a repository has no question', async () => {
  const none = setup({ answer: { decision: 'allow', choice: 'new' }, git: async () => ({ ok: true, stdout: 'HEAD\n' }) });
  assert.equal(
    await none.call('propose_branch', { suggested: '../evil' }),
    'The user wants the changes on a new branch. Create one with a short descriptive name and switch to it before editing.',
  );
  assert.deepEqual(none.cards[0][1].details, ['A new branch', 'Current branch: HEAD']);
  assert.equal(none.cards[0][1].choices[1].label, 'Stay here');
  assert.match(
    await setup({ git: async () => ({ ok: false, stdout: '' }) }).call('propose_branch', { suggested: 'a' }),
    /^ERROR not_a_repo: .*not a Git repository/,
  );
  assert.match(await setup({ folders: [] }).call('propose_branch', { suggested: 'a' }), /^ERROR not_a_repo/);
});

test('propose_branch in a managed worktree asks nothing and tells the model to edit there, with or without a branch name', async () => {
  const named = setup({ worktree: { branch: 'mopilot/6a89' }, git: async () => assert.fail('no git call needed') });
  assert.equal(
    await named.call('propose_branch', { suggested: 'fix/a' }),
    "This session already runs in its own worktree on branch mopilot/6a89, so the changes are isolated from the user's main checkout. Do not create or switch branches; edit here.",
  );
  assert.deepEqual(named.cards, []);
  assert.match(await setup({ worktree: { branch: null } }).call('propose_branch', { suggested: 'a' }), /own worktree, so the changes/);
});

test('validBranch accepts the names git and the card can show, and nothing with dots, dashes or empty parts at the wrong end', () => {
  for (const ok of ['fix/canada-tax', 'a', 'feature_1.2', 'a/b/c']) assert.equal(validBranch(ok), true, ok);
  for (const bad of ['', '-x', '/a', 'a//b', 'a/.hidden', 'a..b', 'a.', 'a.lock', 'a/b.lock', 'x'.repeat(101), 'a b', 5, undefined])
    assert.equal(validBranch(bad), false, String(bad));
});
