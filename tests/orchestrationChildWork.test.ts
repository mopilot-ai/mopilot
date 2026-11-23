// electron/session/orchestration/childWork.cjs: a worktree session's git facts join the note its turn leaves (the
// parent's wake waits for them, or for their time limit), its card shows them, and the user's Merge and Open PR act
// on its branch: never while the parent's turn runs in that folder, with a merge noted for the parent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';
import { tick as settle } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { actOnChild, noteFacts, FACTS_MS } = require('../electron/session/orchestration/childWork.cjs');
const { orchestrationView } = require('../electron/app/orchestration.cjs');

const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
/** git answering as a branch "kid" (in the session's worktree, /repo-wt) 2 commits ahead of "main" (in /repo) that changed one file by +3 −1, with no PR. */
function gitRun(over: Record<string, any> = {}) {
  const calls: string[][] = [];
  const answer: Record<string, any> = {
    'rev-parse': (_args: string[], cwd: string) => (cwd === '/repo-wt' ? ok('kid\n') : ok('main\n')),
    'rev-list': ok('2\n'),
    diff: ok('3\t1\ta.ts\0'),
    status: ok(''),
    'merge-tree': ok('tree\n'),
    merge: ok(''),
    push: ok(''),
    ...over,
  };
  return {
    calls,
    git: async (args: string[], cwd: string) => (
      calls.push(args), typeof answer[args[0]] === 'function' ? answer[args[0]](args, cwd) : answer[args[0]]
    ),
    gh: async (args: string[]) => (calls.push(['gh', ...args]), args[1] === 'list' ? ok('[]') : ok('')),
  };
}

/** A parent "top" with one session in its own worktree, branch "kid", the parent idle. */
async function family(over: any = {}) {
  const run = over.run ?? gitRun();
  const h = orchestration({ worktreeInfo: () => ({ branch: 'kid' }), run, ...over });
  h.userTurn();
  const { chat_id: id } = await h.orch.start('top', { background: BACKGROUND, title: 'Fix', prompt: 'p' });
  h.states.set('top', { turn: 'idle' });
  h.flush();
  return { ...h, id, run };
}
const wakes = (h: any) => h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top');

test("a worktree session's note carries git's facts, and the parent's wake waits for them", async () => {
  const h = await family();
  h.orch.finished({ chatId: h.id, inputToken: `pending-${h.journal.child(h.id).driven[0]}`, text: 'Fixed it', completed: true });
  h.flush();
  assert.equal(wakes(h).length, 0, 'no wake while the facts are read');
  assert.equal(h.orch.noting.get('top'), 1);
  await settle();
  await settle();
  h.flush();
  const facts = h.journal.child(h.id).facts;
  assert.deepEqual(
    { ...facts, at: 0 },
    { branch: 'kid', base: 'main', ahead: 2, files: 1, added: 3, removed: 1, uncommitted: 0, pr: null, at: 0 },
  );
  assert.equal(h.orch.noting.has('top'), false);
  const woke = wakes(h);
  assert.equal(woke.length, 1);
  assert.match(woke[0][2].text, /Git \(read by the app\): branch kid, 2 commits ahead of main; 1 file changed \(\+3 -1\)\./);
  // the card reads them from main's view
  assert.equal(orchestrationView(h.journal.data).children[h.id].facts.ahead, 2);
});

test('facts that take too long, fail, or outlive their session are left out, and the wake goes on', async () => {
  // too long: the wake goes without them once the limit passes
  const slow = await family({ factsMs: 5, run: gitRun({ 'rev-parse': () => new Promise(() => {}) }) });
  slow.orch.finished({ chatId: slow.id, inputToken: `pending-${slow.journal.child(slow.id).driven[0]}`, text: 'x', completed: true });
  await new Promise((r) => setTimeout(r, 20));
  slow.flush();
  assert.equal(wakes(slow).length, 1);
  assert.equal(slow.journal.child(slow.id).facts, undefined);
  assert.ok(FACTS_MS >= 10_000);
  // a read that throws is only noted
  const broken = await family({ run: { git: async () => Promise.reject(new Error('spawn failed')), gh: async () => ok('[]') } });
  await noteFacts(broken.orch, broken.id, 'top', 1);
  assert.equal(broken.journal.child(broken.id).facts, undefined);
  // a session deleted while its facts were read keeps nothing
  const gone = await family();
  const reading = noteFacts(gone.orch, gone.id, 'top', 1);
  delete gone.journal.data.children[gone.id];
  await reading;
  assert.equal(gone.orch.noting.has('top'), false);
  // two reads for one parent: the wake waits for both
  const two = await family();
  const a = noteFacts(two.orch, two.id, 'top', 1);
  const b = noteFacts(two.orch, two.id, 'top', 2);
  assert.equal(two.orch.noting.get('top'), 2);
  await Promise.all([a, b]);
  assert.equal(two.orch.noting.has('top'), false);
  // a session sharing its parent's folder has no branch to read
  const shared = orchestration({ worktreeInfo: () => ({ branch: 'kid' }), run: gitRun() });
  shared.userTurn();
  const { chat_id: s } = await shared.orch.start('top', { background: BACKGROUND, title: 'S', prompt: 'p', use_worktree: false });
  await noteFacts(shared.orch, s, 'top', 1);
  assert.equal(shared.journal.child(s).facts, undefined);
});

test("Merge brings the session's branch into the parent's folder and notes it, never while the parent works there", async () => {
  const h = await family();
  h.states.set('top', { turn: 'running' });
  await assert.rejects(actOnChild(h.orch, h.id, 'merge'), (e: any) => e.code === 'parent_busy');
  h.states.set('top', { turn: 'idle' });
  let drained = 0;
  (h.controller as any).drain = () => (drained++, Promise.resolve());
  const merged = await actOnChild(h.orch, h.id, 'merge');
  assert.equal(drained, 1);
  assert.deepEqual(merged, { status: 'merged', into: 'main', commit: 'main' });
  assert.deepEqual(h.journal.child(h.id).merged, { into: 'main', commit: 'main', at: 1000 });
  const note = h.journal.parent('top').notes.at(-1);
  assert.equal(note.wakes, false);
  assert.match(note.body, /The user merged fix's branch kid into main \(commit main\) in your folder\./);
  // a merge that didn't happen leaves no note
  const clash = await family({ run: gitRun({ 'merge-tree': { ok: false, stdout: 'tree\na.ts\n', stderr: '' } }) });
  assert.deepEqual(await actOnChild(clash.orch, clash.id, 'merge'), { status: 'conflicts', into: 'main', files: ['a.ts'] });
  assert.equal(clash.journal.child(clash.id).merged, undefined);
  await assert.rejects(actOnChild(h.orch, h.id, 'rebase'), (e: any) => e.code === 'invalid_action');
});

test('a merge holds the parent until git settles and releases after failure', async () => {
  let finish!: (r: any) => void;
  const run = gitRun({ 'merge-tree': () => new Promise((resolve) => (finish = resolve)) });
  const h = await family({ run });
  const merging = actOnChild(h.orch, h.id, 'merge');
  await settle();
  await settle();
  const { folderMutation } = require('../electron/session/folderMutation.cjs');
  assert.ok(folderMutation(h.controller, 'top'));
  await assert.rejects(actOnChild(h.orch, h.id, 'merge'), (e: any) => e.code === 'parent_busy');
  finish({ ok: false, stdout: '', stderr: 'failed' });
  assert.equal((await merging).status, 'refused');
  assert.equal(folderMutation(h.controller, 'top'), null);
});

test('Open PR pushes and opens the form, then reads the facts again; a session with no worktree has none to bring back', async () => {
  const h = await family();
  assert.deepEqual(await actOnChild(h.orch, h.id, 'pr'), { status: 'opened' });
  assert.ok(h.run.calls.some((c: string[]) => c[0] === 'push'));
  await settle();
  await settle();
  assert.equal(h.journal.child(h.id).facts.branch, 'kid');
  const none = await family({ run: gitRun({ 'rev-parse': ok('HEAD\n') }) });
  await assert.rejects(actOnChild(none.orch, none.id, 'pr'), (e: any) => e.code === 'no_worktree');
  // a branch name made up to read as an option never reaches git or gh
  const forged = await family({
    run: gitRun({ 'rev-parse': (_a: string[], cwd: string) => ok(cwd === '/repo-wt' ? '--receive-pack=evil\n' : 'main\n') }),
  });
  await assert.rejects(actOnChild(forged.orch, forged.id, 'pr'), (e: any) => e.code === 'no_worktree');
  assert.ok(!forged.run.calls.some((c: string[]) => c[0] === 'push'));
  await assert.rejects(actOnChild(none.orch, 'missing', 'merge'), (e: any) => e.code === 'no_worktree');
});
