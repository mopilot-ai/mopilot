// Pull request review comments in the Changes pane (src/components/panels/useReviewThreads.tsx, ReviewThreadNote.tsx):
// in the Branch scope each thread goes under its line, resolved ones fold, Next unresolved comment walks them, Answer
// asks the chat, a comment posts to GitHub for files without uncommitted edits, and a failed read says so with Retry.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { store, calls, native, git, DIFF, act, mount, one, settle } from './support/diff-panel-ui/fixture.ts';

const thread = (id: string, path: string, line: number | null, resolved = false, body = `about ${id}`) => ({
  id,
  path,
  line,
  diffSide: 'RIGHT',
  isResolved: resolved,
  isOutdated: line === null,
  comments: {
    pageInfo: { hasNextPage: false },
    nodes: [{ id: `${id}-c`, author: { login: 'ana' }, body: `${body}\nmore`, url: `https://github.com/o/r/pull/7#${id}` }],
  },
});
let threads: unknown[] = [];
let head = 'head1';
let limited = false;
let threadsFail: string | null = null;
let postFails = false;
let edited: string[] = [];
const ghCalls: string[][] = [];
beforeEach(() => {
  threads = [thread('T1', 'src/a.ts', 2), thread('T2', 'src/a.ts', 1, true), thread('T3', 'new.py', null)];
  head = 'head1';
  limited = false;
  threadsFail = null;
  postFails = false;
  edited = [];
  ghCalls.length = 0;
  (native.git as any).gh = async (_cwd: string, args: string[]) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'diff') return { ok: true, code: 0, stderr: '', stdout: DIFF };
    if (args[0] === 'pr' && args.includes('headRefOid,state'))
      return { ok: true, code: 0, stderr: '', stdout: JSON.stringify({ headRefOid: head, state: 'OPEN' }) };
    if (args[0] === 'pr')
      return { ok: true, code: 0, stderr: '', stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'OPEN' }) };
    if (args[1] === 'graphql') {
      if (threadsFail) return { ok: false, code: 1, stdout: '', stderr: threadsFail };
      const data = {
        data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { pageInfo: { hasNextPage: limited }, nodes: threads } } } },
      };
      return { ok: true, code: 0, stderr: '', stdout: JSON.stringify(data) };
    }
    return postFails ? { ok: false, code: 1, stdout: '', stderr: 'Validation Failed' } : { ok: true, code: 0, stderr: '', stdout: '{}' };
  };
  const run = git.run;
  git.run = (args) => (args[0] === 'rev-parse' && args[1] === 'HEAD' ? { ok: true, code: 0, stderr: '', stdout: head } : run(args));
  (native.git as any).status = async () => ({ files: edited.map((path) => ({ code: ' M', path })) });
});
const notes = (host: HTMLElement, path: string) =>
  [...host.querySelectorAll(`[data-inline="${path}"] [data-note-line]`)]
    .filter((n) => n.querySelector('.cp-review-thread'))
    .map((n) => `${n.getAttribute('data-note-line')}:${n.textContent}`);

test('Branch scope shows each thread under its line; a resolved one folds to a line, and opens', async () => {
  const r = await mount({ scope: 'branch' });
  await settle(act);
  // a resolved thread shows its first line only, an open one each comment in full
  assert.deepEqual(notes(r.host, 'src/a.ts'), ['2:anaabout T1\nmore', '1:ana Resolvedabout T2']);
  assert.deepEqual(notes(r.host, 'new.py'), ['0:anaNot on these lines any moreabout T3\nmore']);
  await act(async () => one(r.host, '.cp-review-toggle').click());
  assert.ok(one(r.host, '[data-thread="T2"]').textContent!.includes('about T2\nmore'));
  await act(async () => one(r.host, '.cp-review-toggle').click());
  assert.equal(one(r.host, '.cp-review-toggle').getAttribute('aria-expanded'), 'false');
  await act(async () => one(r.host, '[data-thread="T1"] [aria-label="Open on GitHub"]').click());
  assert.deepEqual(calls.at(-1), ['openUrl', 'https://github.com/o/r/pull/7#T1']);
  await r.unmount();
});

test('the bar counts the unresolved threads, walks them in order and asks the chat to answer them', async () => {
  const frames: FrameRequestCallback[] = [];
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => (frames.push(cb), 0);
  try {
    const r = await mount({ scope: 'branch' });
    await settle(act);
    assert.equal(one(r.host, '.cp-review-bar span').textContent, '2 unresolved review comments on #7');
    await act(async () => one(r.host, '.cp-review-bar button', 'Next unresolved comment').click());
    assert.ok(one(r.host, '[data-thread="T3"]').classList.contains('focused'), 'one GitHub no longer places comes first');
    frames.splice(0).forEach((cb) => cb(0));
    await act(async () => one(r.host, '.cp-review-bar button', 'Next unresolved comment').click());
    assert.ok(one(r.host, '[data-thread="T1"]').classList.contains('focused'));
    frames.splice(0).forEach((cb) => cb(0));
    await act(async () => one(r.host, '.cp-review-bar button', 'Answer 2 review comments').click());
    assert.deepEqual(store.calls.at(-1), [
      'answerReviewComments',
      't1',
      { owner: 'o', name: 'r', number: 7, url: 'https://github.com/o/r/pull/7' },
    ]);
    await r.unmount();
  } finally {
    globalThis.requestAnimationFrame = raf;
  }
});

test('one unresolved thread is said in the singular; with none, or without a chat, the bar or Answer stays away', async () => {
  threads = [thread('T1', 'src/a.ts', 2)];
  let r = await mount({ scope: 'branch' });
  await settle(act);
  assert.equal(one(r.host, '.cp-review-bar span').textContent, '1 unresolved review comment on #7');
  assert.ok(one(r.host, '.cp-review-bar button', 'Answer 1 review comment'));
  await r.unmount();
  r = await mount({ scope: 'branch' }, null);
  await settle(act);
  assert.equal([...r.host.querySelectorAll('.cp-review-bar button')].length, 1, 'no chat to answer in');
  await r.unmount();
  threads = [thread('T2', 'src/a.ts', 1, true)];
  r = await mount({ scope: 'branch' });
  await settle(act);
  assert.equal(r.host.querySelector('.cp-review-bar'), null);
  await r.unmount();
});

test('other scopes read no review comments', async () => {
  const r = await mount({ scope: 'uncommitted' });
  await settle(act);
  assert.equal(ghCalls.length, 0);
  assert.equal(r.host.querySelector('.cp-review-thread'), null);
  await r.unmount();
});

test('a comment posts to GitHub on the PR head for a file without uncommitted edits, and says when it failed', async () => {
  edited = ['new.py'];
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.equal(r.host.querySelector('[data-post="new.py"]'), null, 'its lines are not the PR’s');
  await act(async () => one(r.host, '[data-post="src/a.ts"]').click());
  await settle(act);
  assert.deepEqual(
    calls.findLast((c) => c[0] === 'posted'),
    ['posted', true],
  );
  const post = ghCalls.find((a) => a[1]?.endsWith('/comments'))!;
  assert.ok(post.includes('commit_id=head1') && post.includes('body=on github') && post.includes('line=2'));
  assert.ok(store.calls.some((c) => c[0] === 'toast' && c[1] === 'Comment posted on GitHub'));
  postFails = true;
  await act(async () => one(r.host, '[data-post="src/a.ts"]').click());
  await settle(act);
  assert.deepEqual(
    calls.findLast((c) => c[0] === 'posted'),
    ['posted', false],
  );
  assert.ok(store.calls.some((c) => c[0] === 'toast' && String(c[1]).startsWith('Could not post the comment to GitHub.')));
  await r.unmount();
});

test('review comments that cannot be read say so, and Retry reads them again', async () => {
  threadsFail = 'HTTP 502';
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(one(r.host, '.cp-review-bar[role="alert"]').textContent!, /review comments: HTTP 502/);
  threadsFail = null;
  await act(async () => one(r.host, '.cp-review-bar button', 'Retry').click());
  await settle(act);
  assert.equal(r.host.querySelector('.cp-review-bar[role="alert"]'), null);
  assert.ok(r.host.querySelector('.cp-review-thread'));
  await r.unmount();
});

test('an older read answering after a newer one is dropped', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const real = (native.git as any).gh;
  let first = true;
  (native.git as any).gh = async (cwd: string, args: string[]) => {
    if (args[1] === 'graphql' && first) {
      first = false;
      await gate;
      return {
        ok: true,
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }),
      };
    }
    return real(cwd, args);
  };
  const r = await mount({ scope: 'branch' });
  await act(async () => void window.dispatchEvent(new (window as any).Event('focus')));
  await settle(act);
  assert.ok(r.host.querySelector('[data-thread="T1"]'), 'the newer read');
  release();
  await settle(act);
  assert.ok(r.host.querySelector('[data-thread="T1"]'), 'the older, empty answer changed nothing');
  await r.unmount();
});

test('a failed refresh retains the loaded comments and offers Retry instead of posting against unknown status', async () => {
  const r = await mount({ scope: 'branch' });
  await settle(act);
  (native.git as any).status = async () => null;
  await act(async () => {
    window.dispatchEvent(new window.Event('focus'));
  });
  await settle(act);
  assert.ok(r.host.querySelector('[data-thread="T1"]'));
  assert.match(one(r.host, '.cp-review-bar[role="alert"]').textContent!, /local changes/);
  assert.equal(r.host.querySelector('[data-post]'), null);
  await r.unmount();
});

test('a GitHub authentication failure is visible and Retry can recover', async () => {
  const real = (native.git as any).gh;
  (native.git as any).gh = async () => ({ ok: false, stdout: '', stderr: 'Sign in to GitHub', code: 1 });
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(one(r.host, '.cp-review-bar[role="alert"]').textContent!, /Sign in to GitHub/);
  (native.git as any).gh = real;
  await act(async () => one(r.host, '.cp-review-bar button', 'Retry').click());
  await settle(act);
  assert.ok(r.host.querySelector('[data-thread="T1"]'));
  await r.unmount();
});

test('an unresolved thread on a file absent from the diff remains visible and reachable', async () => {
  threads = [thread('missing-file', 'removed.ts', 2)];
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(one(r.host, '.cp-review-unanchored').textContent!, /removed.ts/);
  await act(async () => one(r.host, '.cp-review-bar button', 'Next unresolved comment').click());
  assert.ok(one(r.host, '[data-thread="missing-file"]').classList.contains('focused'));
  await r.unmount();
});

test('multiple authors and an absent comment URL render without losing the thread', async () => {
  const value = thread('multi', 'src/a.ts', 2);
  value.comments.nodes[0].url = '';
  value.comments.nodes.push({ id: 'reply', author: { login: 'ben' }, body: 'second reply', url: '' });
  threads = [value];
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(one(r.host, '[data-thread="multi"]').textContent!, /bensecond reply/);
  assert.equal(r.host.querySelector('[aria-label="Open on GitHub"]'), null);
  await r.unmount();
});

test('Next clears a file filter so the selected thread can be read', async () => {
  const { typeInto } = await import('./support/shell-panels-kit.ts');
  threads = [thread('filtered', 'src/a.ts', 2)];
  const r = await mount({ scope: 'branch' });
  await settle(act);
  await act(async () => typeInto(one(r.host, '.cp-files input') as HTMLInputElement, 'new.py'));
  assert.equal(r.host.querySelector('[data-thread="filtered"]'), null);
  await act(async () => one(r.host, '.cp-review-bar button', 'Next unresolved comment').click());
  assert.ok(one(r.host, '[data-thread="filtered"]').classList.contains('focused'));
  await r.unmount();
});

test('finishing an old repository post cannot supersede a newer repository read', async () => {
  const { h, DiffPanel } = await import('./support/diff-panel-ui/fixture.ts');
  const real = (native.git as any).gh;
  let finishPost!: () => void;
  let finishRead!: () => void;
  const postGate = new Promise<void>((resolve) => {
    finishPost = resolve;
  });
  const readGate = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const reads: string[] = [];
  (native.git as any).gh = async (cwd: string, args: string[]) => {
    if (args[0] === 'api' && args[1]?.endsWith('/comments')) await postGate;
    if (args[0] === 'pr' && args[1] === 'view') reads.push(cwd);
    if (cwd === '/b' && args[1] === 'graphql') await readGate;
    return real(cwd, args);
  };
  const r = await mount({ scope: 'branch' });
  await settle(act);
  await act(async () => one(r.host, '[data-post="src/a.ts"]').click());
  await settle(act);
  const before = reads.filter((cwd) => cwd === '/repo').length;
  threads = [thread('B', 'src/a.ts', 2)];
  await r.rerender(h(DiffPanel, { cwd: '/b', threadId: 't2' }));
  await settle(act);
  await act(async () => finishPost());
  await settle(act);
  assert.equal(reads.filter((cwd) => cwd === '/repo').length, before, 'retired load never starts');
  await act(async () => finishRead());
  await settle(act);
  assert.ok(r.host.querySelector('[data-thread="B"]'));
  await r.unmount();
});

test('a stale head refusal refreshes the review so the retained comment can be retried', async () => {
  const r = await mount({ scope: 'branch' });
  await settle(act);
  head = 'head2';
  await act(async () => one(r.host, '[data-post="src/a.ts"]').click());
  await settle(act);
  assert.deepEqual(
    calls.findLast((c) => c[0] === 'posted'),
    ['posted', false],
  );
  await act(async () => one(r.host, '[data-post="src/a.ts"]').click());
  await settle(act);
  assert.deepEqual(
    calls.findLast((c) => c[0] === 'posted'),
    ['posted', true],
  );
  assert.equal(ghCalls.filter((a) => a[1]?.endsWith('/comments')).length, 1);
  threads = [thread('fresh', 'src/a.ts', 2)];
  await act(async () => one(r.host, '[aria-label="Refresh"]').click());
  await settle(act);
  assert.ok(r.host.querySelector('[data-thread="fresh"]'));
  await r.unmount();
});

test('truncated reads qualify the displayed count and link to the complete review', async () => {
  limited = true;
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(one(r.host, '.cp-review-bar span').textContent!, /^Loaded:/);
  await act(async () => one(r.host, '.cp-review-bar button', 'More comments on GitHub').click());
  assert.deepEqual(calls.at(-1), ['openUrl', 'https://github.com/o/r/pull/7']);
  await r.unmount();
});

test('a non-Git folder has no PR review and does not report its expected null status as a review failure', async () => {
  (native.git as any).status = async () => null;
  native.git.info = async () => null;
  (native.git as any).gh = async () => ({ ok: false, code: 1, stderr: 'not a git repository', stdout: '' });
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(r.host.textContent!, /not a git repository/);
  assert.equal(r.host.querySelector('.cp-review-bar'), null);
  assert.equal(r.host.querySelector('[data-post]'), null);
  await r.unmount();
});

test('an unreadable review with no error text still exposes a reason and Retry', async () => {
  (native.git as any).gh = async () => {
    throw new Error('');
  };
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.match(one(r.host, '.cp-review-bar').textContent!, /Couldn’t read review comments/);
  assert.equal(one(r.host, '.cp-review-bar button', 'Retry').textContent, 'Retry');
  await r.unmount();
});

test('a limited read with no loaded unresolved threads disables Next and offers the complete review', async () => {
  limited = true;
  threads = [thread('done', 'src/a.ts', 1, true)];
  const r = await mount({ scope: 'branch' });
  await settle(act);
  assert.equal((one(r.host, '.cp-review-bar button', 'Next unresolved comment') as HTMLButtonElement).disabled, true);
  assert.ok(one(r.host, '.cp-review-bar button', 'More comments on GitHub'));
  assert.equal(
    [...r.host.querySelectorAll('.cp-review-bar button')].some((b) => b.textContent?.startsWith('Answer')),
    false,
  );
  await r.unmount();
});

test('resolved threads on files that left the diff still expand and fold', async () => {
  threads = [thread('missing', 'removed.ts', null, true)];
  const r = await mount({ scope: 'branch' });
  await settle(act);
  const note = one(r.host, '.cp-review-unanchored');
  assert.equal(note.querySelectorAll('.cp-review-comment').length, 0);
  await act(async () => one(note as HTMLElement, 'button', 'Resolved').click());
  assert.equal(note.querySelectorAll('.cp-review-comment').length, 1);
  await act(async () => one(note as HTMLElement, 'button', 'Resolved').click());
  assert.equal(note.querySelectorAll('.cp-review-comment').length, 0);
  await r.unmount();
});
