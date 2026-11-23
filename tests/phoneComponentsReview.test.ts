// Read-only review on the phone: scoped change lists, paged word-marked diffs and file text, with loading, empty, binary, paging and error states.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
const modulePath = '../mobile/src/screens/Review';
const { Review } = await import(modulePath);

const mounted: any[] = [];
async function mount(runtime: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  let backs = 0;
  await act(async () => root.render(createElement(Review, { runtime, chatId: 'c', back: () => backs++ })));
  await flush();
  return { host, root, backs: () => backs };
}
const has = (host: HTMLElement, re: RegExp) => assert.match(host.textContent!, re);
// a button is named by its text or its accessible label, whole or by its leading words ("View diff" for "View diff src/a.ts")
const buttons = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('button')].filter((b) => {
    const label = b.getAttribute('aria-label') ?? '';
    return b.textContent === title || label === title || label.startsWith(`${title} `);
  });
const rows = [
  { k: 'hunk', t: '@@ -1 +1 @@' },
  { k: 'ctx', t: 'keep' },
  { k: 'del', t: 'const a = 1;', w: [10, 11] },
  { k: 'add', t: 'const a = 2;', w: [10, 11], cut: true },
  { k: 'meta', t: 'No newline at end of file' },
];

test('the review follows the chat, lists changes by scope, pages a word-marked diff and opens a file', async () => {
  const { runtime, calls } = scripted((m, p) => {
    if (m === 'diff.list')
      return {
        files: [
          { path: 'src/a.ts', status: 'modified', binary: false, added: 1, removed: 1 },
          { path: 'new.ts', oldPath: 'old.ts', status: 'renamed', binary: false, added: 0, removed: 0 },
          { path: 'gone.ts', status: 'deleted', binary: false, added: 0, removed: 3 },
        ],
        total: 3,
        omitted: 2,
        truncated: true,
      };
    if (m === 'diff.read')
      return p.from === 0
        ? { binary: false, rows, next: 5, total: 6 }
        : { binary: false, rows: [{ k: 'add', t: 'tail' }], next: null, total: 6 };
    if (m === 'file.read')
      return p.offset === 0
        ? { text: 'file ', size: 9, offset: 0, bytes: 5, truncated: true }
        : { text: 'body', size: 9, offset: 5, bytes: 4, truncated: false };
    return undefined;
  });
  const { host, backs } = await mount(runtime);
  assert.deepEqual(
    calls.slice(0, 2).map((c) => c[0]),
    ['machine.hello', 'chat.follow'],
  );
  has(host, /a\.tssrc\//);
  has(host, /a\.tssrc\/\+1 −1/);
  has(host, /new\.ts from old\.tsrenamed/);
  has(host, /Showing 3 of 5 changed files/);
  assert.equal(buttons(host, 'Open file').length, 0, 'a file opens from its diff');
  await click('Branch');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'diff.list').map((c) => c[1].scope),
    ['uncommitted', 'branch'],
  );
  await click('Uncommitted');
  await act(async () => buttons(host, 'View diff')[0].click());
  await flush();
  has(host, /−const a = 1;/);
  has(host, /\+const a = 2;/);
  has(host, /\(line cut\)/);
  has(host, /No newline at end of file/);
  const marked = [...host.querySelectorAll('span span')].filter((n) => n.textContent === '1' || n.textContent === '2');
  assert.equal(marked.length, 2);
  has(host, /Load more \(5 of 6 rows\)/);
  await click('Load more (5 of 6 rows)');
  has(host, /\+tail/);
  assert.equal(buttons(host, 'Load more (6 of 6 rows)').length, 0);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'diff.read').map((c) => [c[1].path, c[1].from, c[1].scope]),
    [
      ['src/a.ts', 0, 'uncommitted'],
      ['src/a.ts', 5, 'uncommitted'],
    ],
  );
  await click('Back to changes');
  await click('View diff');
  await click('Open file');
  await flush();
  has(host, /file /);
  await click('Load more (1 of 1 KB)');
  has(host, /file body/);
  await click('Back to changes');
  await click('Back to chat');
  assert.equal(backs(), 1);
});

test('leaving the review unfollows the chat after it followed', async () => {
  const { runtime, calls } = scripted(() => undefined);
  const { root } = await mount(runtime);
  await act(async () => root.unmount());
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0].startsWith('chat.')).map((c) => c[0]),
    ['chat.follow', 'chat.unfollow'],
  );
});

test('an empty list, a Mac without the methods, a refused follow and failed reads are shown honestly with retry', async () => {
  const empty = await mount(scripted((m) => (m === 'diff.list' ? { files: [] } : undefined)).runtime);
  has(empty.host, /No changes here yet/);
  const old = await mount(scripted((m) => (m === 'machine.hello' ? { capabilities: { methods: ['chat.send'] } } : undefined)).runtime);
  has(old.host, /Update MoPilot on your computer to review changes/);
  let refuse = true;
  const follow = await mount(
    scripted((m) => {
      if (m === 'chat.follow' && refuse) throw new Error('That chat is not on this Mac.');
      return m === 'diff.list' ? { files: [{ path: 'x.ts' }] } : undefined;
    }).runtime,
  );
  has(follow.host, /not on this Mac/);
  refuse = false;
  await click('Retry');
  has(follow.host, /x.ts/);
});

test('binary, empty, unreadable and failing pages say what to do', async () => {
  let page: any;
  let failMore = true;
  const { runtime } = scripted((m, p) => {
    if (m === 'diff.list') return { files: [{ path: 'bin' }, { path: 'none' }, { path: 'long' }] };
    if (m === 'diff.read') {
      if (p.path === 'long') {
        if (p.from === 0) return { rows, next: 5, total: 9 };
        if (failMore) throw new Error('Computer is offline');
        return { rows: [], next: null, total: 9 };
      }
      return p.path === 'bin' ? { binary: true, rows: [], next: null } : { rows: [], next: null };
    }
    return page;
  });
  const { host } = await mount(runtime);
  const open = async (n: number) => {
    await act(async () => buttons(host, 'View diff')[n].click());
    await flush();
  };
  await open(0);
  has(host, /binary file/);
  page = { text: '', size: 0, truncated: false };
  await click('Open file');
  await flush();
  has(host, /file is empty/);
  await click('Back to changes');
  await open(1);
  has(host, /no text diff/);
  await click('Back to changes');
  await open(2);
  await click('Load more (5 of 9 rows)');
  has(host, /offline or asleep/);
  failMore = false;
  await click('Retry');
  assert.equal(buttons(host, 'Retry').length, 0);
});

test('file paging failures keep the text shown and retry the page', async () => {
  let fail = true;
  const { runtime } = scripted((m, p) => {
    if (m === 'diff.list') return { files: [{ path: 'f.ts' }] };
    if (m !== 'file.read') return undefined;
    if (p.offset === 0) return { text: 'top', size: 4096, offset: 0, bytes: 3, truncated: true };
    if (fail) throw new Error('Computer is offline');
    return { text: ' end', size: 4096, offset: 3, bytes: 4, truncated: false };
  });
  const { host } = await mount(runtime);
  await click('View diff');
  await click('Open file');
  await flush();
  await click('Load more (1 of 4 KB)');
  has(host, /top/);
  has(host, /offline or asleep/);
  fail = false;
  await click('Retry');
  has(host, /top end/);
});

test('binary files are marked in the list, and a failed unfollow on leaving is ignored', async () => {
  const { runtime, calls } = scripted((m) => {
    if (m === 'chat.unfollow') throw new Error('Computer is offline');
    return m === 'diff.list' ? { files: [{ path: 'logo.png', binary: true }] } : undefined;
  });
  const { host, root } = await mount(runtime);
  has(host, /binary/);
  await act(async () => root.unmount());
  await flush();
  assert.ok(calls.some((c) => c[0] === 'chat.unfollow'));
});

test('a file that changed under the reader can be reloaded from the start, and so can a diff', async () => {
  let stale = true;
  const { runtime, calls } = scripted((m, p) => {
    if (m === 'diff.list') return { files: [{ path: 'f.ts' }] };
    if (m === 'file.read') {
      if (p.offset === 0) return { text: stale ? 'old ' : 'new ', size: 4096, offset: 0, bytes: 4, truncated: true };
      if (stale) throw new Error('That file changed. Read it again.');
      return { text: 'tail', size: 4096, offset: 4, bytes: 4, truncated: false };
    }
    if (m === 'diff.read') {
      if (p.from === 0) return { rows: [{ k: 'add', t: stale ? 'v1' : 'v2' }], next: 1, total: 2 };
      if (stale) throw new Error('That diff changed. Read it again.');
      return { rows: [{ k: 'add', t: 'more' }], next: null, total: 2 };
    }
    return undefined;
  });
  const { host } = await mount(runtime);
  await click('View diff');
  await click('Open file');
  await flush();
  await click('Load more (1 of 4 KB)');
  has(host, /That file changed/);
  stale = false;
  await click('Start over');
  has(host, /new /);
  assert.doesNotMatch(host.textContent!, /old /);
  assert.equal(calls.filter((c) => c[0] === 'file.read').at(-1)![1].offset, 0);
  stale = true;
  await click('Back to changes');
  await act(async () => buttons(host, 'View diff')[0].click());
  await flush();
  await click('Load more (1 of 2 rows)');
  has(host, /That diff changed/);
  stale = false;
  await click('Start over');
  has(host, /\+v2/);
  assert.doesNotMatch(host.textContent!, /v1/);
});

/** A scripted runtime whose events the test sends. */
function eventful(handler: (m: string, p: any) => unknown) {
  const s = scripted(handler);
  const listeners = new Set<(e: any) => void>();
  s.runtime.onEvent = (f: (e: any) => void) => (listeners.add(f), () => listeners.delete(f));
  const send = async (e: any) => {
    await act(async () => listeners.forEach((f) => f(e)));
    await flush();
  };
  const tick = async (ms: number) => {
    await act(async () => mock.timers.tick(ms));
    await flush();
  };
  return { ...s, send, tick };
}
const changed = (chatId = 'c') => ({ ev: 'review.changed', chatId, turnId: 't1', live: true, removed: false });
const listCalls = (calls: any[]) => calls.filter((c) => c[0] === 'diff.list').length;

test('a diff that changes on the Mac reloads the list once after a burst, ignoring other chats and events', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = eventful((m) => (m === 'diff.list' ? { files: [{ path: 'a.ts' }] } : undefined));
    const { host } = await mount(r.runtime);
    assert.equal(listCalls(r.calls), 1);
    await r.send(changed('other'));
    await r.send({ ev: 'something.else', chatId: 'c' });
    await r.tick(5000);
    assert.equal(listCalls(r.calls), 1);
    await r.send(changed());
    await r.send(changed());
    await r.send({ ...changed(), live: false });
    await r.tick(1000);
    assert.equal(listCalls(r.calls), 1);
    await r.tick(600);
    assert.equal(listCalls(r.calls), 2);
    has(host, /a.ts/);
    await r.send({ ...changed(), removed: true });
    await r.tick(1500);
    assert.equal(listCalls(r.calls), 3);
  } finally {
    mock.timers.reset();
  }
});

test('an open diff or file says it changed and reloads from the start only when asked', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = eventful((m, p) => {
      if (m === 'diff.list') return { files: [{ path: 'a.ts' }] };
      if (m === 'diff.read') return { rows: [{ k: 'add', t: p.from === 0 ? 'one' : 'more' }], next: null, total: 1 };
      if (m === 'file.read') return { text: 'body', size: 4, offset: 0, bytes: 4, truncated: false };
      return undefined;
    });
    const { host } = await mount(r.runtime);
    await act(async () => buttons(host, 'View diff')[0].click());
    await flush();
    assert.doesNotMatch(host.textContent!, /changed on your computer/);
    await r.send(changed());
    await r.tick(1500);
    has(host, /This changed on your computer/);
    assert.equal(r.calls.filter((c) => c[0] === 'diff.read').length, 1);
    await click('Reload');
    assert.equal(r.calls.filter((c) => c[0] === 'diff.read').length, 2);
    assert.doesNotMatch(host.textContent!, /changed on your computer/);
    await click('Back to changes');
    await click('View diff');
    await click('Open file');
    await flush();
    await r.send(changed());
    await r.tick(1500);
    has(host, /This changed on your computer/);
    await click('Reload');
    assert.equal(r.calls.filter((c) => c[0] === 'file.read').length, 2);
    // the list was not reloaded behind the open pages, only when it was shown again
    assert.equal(listCalls(r.calls), 2);
    await click('Back to changes');
    has(host, /a.ts/);
    assert.equal(listCalls(r.calls), 3);
  } finally {
    mock.timers.reset();
  }
});

test('leaving the review drops a pending reload', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = eventful((m) => (m === 'diff.list' ? { files: [] } : undefined));
    const { root } = await mount(r.runtime);
    await r.send(changed());
    await act(async () => root.unmount());
    await r.tick(5000);
    assert.equal(listCalls(r.calls), 1);
  } finally {
    mock.timers.reset();
  }
});

test('a change is a row with its name, folder and counts; the bar names Changes and the chat, and goes back to it', async () => {
  const calls: string[] = [];
  const { runtime } = scripted((m) =>
    m === 'diff.list' ? { files: [{ path: 'src/deep/a.ts', status: 'modified', add: 2, del: 1 }] } : undefined,
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(Review, {
        runtime,
        chatId: 'c',
        back: () => calls.push('back'),
        title: 'Fix login',
        subtitle: 'Claude Code · App',
        mirrors: { terminal: () => calls.push('terminal'), live: () => calls.push('live') },
      }),
    ),
  );
  await flush();
  assert.match(host.textContent!, /ChangesFix login/, 'the bar names the screen and the chat under it');
  assert.match(host.textContent!, /a\.ts/);
  assert.match(host.textContent!, /src\/deep\//);
  assert.equal(host.querySelector('button[aria-label="Chat menu"]'), null, 'Changes has no menu of its own');
  await act(async () => (host.querySelector('button[aria-label="Back to chat"]') as HTMLElement).click());
  assert.deepEqual(calls, ['back']);
  await act(async () => root.unmount());
  host.remove();
});
