// The composer's popups (src/components/composer/ComposerPopups.tsx): the "@" list of chats and files, the "/"
// menu, and the keyboard events the composer forwards to them.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $$, flush, mount, mouse } from './support/composer-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

let fixture: any;
const navigated: any[] = [];
stubStore({
  useStore: Object.assign((f: any) => f(fixture.state), { getState: () => fixture.state }),
  currentCwdForNewChat: () => '/repo',
  threadTitle: (t: any) => t.title,
  searchThreads: (q: string) => fixture.remote(q),
  navigate: (r: any) => navigated.push(r),
  toastFailure: () => () => {},
});
installNativeStub({ search: { files: (cwd: string, q: string) => fixture.files(cwd, q) } });
const { createElement: h, act, useState, Profiler } = await import('react');
// the "Browser tabs" section (src/components/composer/BrowserTabMentions.tsx has its own tests): rows 0…n-1
mock.module('../src/components/composer/BrowserTabMentions.tsx', {
  namedExports: {
    useBrowserTabMentions: () => fixture.tabs,
    BrowserTabRows: ({ tabs, index, onPick }: any) =>
      tabs.map((t: any, i: number) =>
        h('div', { key: t.key, className: 'menu-item ' + (i === index ? 'kbd-active' : ''), onMouseDown: () => onPick(t) }, t.title),
      ),
  },
});
const { MentionPopup, SlashPopup, highlight } = await import('../src/components/composer/ComposerPopups.tsx');

const t = (id: string, title: string, updatedAt: number, extra = {}) => ({ id, title, updatedAt, cwd: '/repo', ...extra });
const files = (n = 12) => Array.from({ length: n }, (_, i) => ({ path: `/repo/file${i}`, file_name: `file${i}`, indices: null }));
beforeEach(() => {
  navigated.length = 0;
  const chats = [
    t('old', 'Older Claude conversation', 1),
    t('self', 'Current conversation', 99),
    t('recent', 'Recent Codex conversation', 30),
    t('acp', 'ACP conversation', 20),
    t('arch', 'Archived', 50),
    t('temp', 'Temporary', 60, { ephemeral: true }),
    t('side', 'Side conversation', 70, { parentThreadId: 'self' }),
  ];
  fixture = {
    state: {
      threads: Object.fromEntries(chats.map((c) => [c.id, c])),
      threadOrder: [...chats.map((c) => c.id), 'gone'],
      claudeArchived: { arch: 1 },
    },
    files: async () => ({ files: files() }),
    remote: async () => ({}),
    tabs: [],
  };
});

// The popup's owner keeps the highlighted index, as the composer does.
function Owner({ C, initial, props, out }: any) {
  const [index, setIndex] = useState(initial);
  out.index = index;
  return h(C, { ...props, index, setIndex });
}

async function mountMention(query = '', props: any = {}) {
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const picked: string[] = [];
  const out: any = {};
  const el = () =>
    h(Owner, {
      C: MentionPopup,
      initial: 0,
      out,
      props: {
        anchor,
        threadId: 'self',
        query,
        onPick: (path: string, dir: boolean) => picked.push(path + (dir ? '/' : '')),
        onPickChat: (c: any) => picked.push(c.id),
        onPickTab: (t: any) => picked.push(`tab:${t.key}`),
        onClose() {},
        ...props,
      },
    });
  const r = await mount(el());
  await flush(130);
  return {
    picked,
    anchor,
    get index() {
      return out.index;
    },
    rows: () => $$('.composer-popup .menu-item'),
    set: async (q: string, p: any = {}) => {
      query = q;
      props = { ...props, ...p };
      await r.render(el());
    },
    key: (key: string, owner: any = anchor) =>
      act(
        async () =>
          void window.dispatchEvent(new (window as any).CustomEvent('composer-popup-key', { cancelable: true, detail: { key, owner } })),
      ),
    close: async () => {
      await r.unmount();
      anchor.remove();
    },
  };
}

test('bare @ immediately offers recent conversations before a full page of file results', async () => {
  const m = await mountMention();
  try {
    assert.deepEqual(
      m
        .rows()
        .slice(0, 3)
        .map((r) => r.textContent),
      ['Recent Codex conversation', 'ACP conversation', 'Older Claude conversation'],
    );
    assert.equal(m.rows().length, 15);
    assert.equal(m.rows()[0].classList.contains('kbd-active'), true);
    assert.doesNotMatch(document.body.textContent!, /Current conversation|Archived|Temporary|Side conversation/);
  } finally {
    await m.close();
  }
});

test('Enter and arrows pick the displayed conversation, then cross correctly into file results', async () => {
  const m = await mountMention();
  try {
    await m.key('Enter');
    await m.key('ArrowDown');
    await m.key('Enter');
    await m.key('ArrowDown');
    await m.key('ArrowDown');
    await m.key('Enter');
    await m.key('ArrowUp');
    await m.key('x');
    await m.key('Enter');
    assert.deepEqual(m.picked, ['recent', 'acp', '/repo/file0', 'old']);
    // keys aimed at another composer are ignored
    await m.key('Enter', document.body);
    assert.equal(m.picked.length, 4);
  } finally {
    await m.close();
  }
});

test('typing a title filters chats and mouse selection uses the same visible item', async () => {
  const m = await mountMention('Older Claude');
  try {
    assert.equal(m.rows()[0].textContent, 'Older Claude conversation');
    await mouse(m.rows()[0], 'mousedown');
    assert.deepEqual(m.picked, ['old']);
    await mouse(m.rows()[1], 'mousemove');
    assert.equal(m.index, 1);
    await mouse(m.rows()[0], 'mousemove');
    assert.equal(m.index, 0);
  } finally {
    await m.close();
  }
});

test('file-only queries preserve first-item keyboard selection when no conversation matches', async () => {
  const m = await mountMention('file');
  try {
    assert.equal(m.rows().length, 12);
    await m.key('Enter');
    assert.deepEqual(m.picked, ['/repo/file0']);
  } finally {
    await m.close();
  }
});

test('remote chats join the list; folders are marked and picked as folders; matches are bold', async () => {
  fixture.remote = async (q: string) => ({ codex: [t('far', `Remote ${q}`, 5)] });
  fixture.files = async (cwd: string, q: string) => ({
    files: [
      { path: `${cwd}/src`, file_name: 'src', match_type: 'directory', indices: [6] },
      { path: '/repo/x.ts', file_name: 'x.ts', indices: [] },
    ].filter(() => q === 'remote'),
  });
  const m = await mountMention('remote');
  try {
    assert.deepEqual(
      m.rows().map((r) => r.querySelector('.mention-name')!.textContent),
      ['Remote remote', 'src', 'x.ts'],
    );
    assert.equal(m.rows()[1].querySelector('.mention-name b')!.textContent, 's');
    assert.equal(m.rows()[1].querySelector('.mention-path')!.textContent, '/repo/src');
    await mouse(m.rows()[1], 'mousemove');
    assert.equal(m.index, 1);
    await mouse(m.rows()[1], 'mousedown');
    await mouse(m.rows()[2], 'mousedown');
    await m.key('Enter');
    assert.deepEqual(m.picked, ['/repo/src/', '/repo/x.ts', '/repo/src/']);
    // a new query drops the old remote results until its own arrive; they never do here, so however late the
    // search timer fires on a busy machine, nothing can fill the list before it is checked
    fixture.remote = () => new Promise(() => {});
    await m.set('remote2');
    assert.equal(m.rows().length, 0);
  } finally {
    await m.close();
  }
});

test('the chat folder is searched; failed searches show nothing; an emptied list resets the selection', async () => {
  const seen: string[] = [];
  fixture.state.threads.self.cwd = '/proj';
  fixture.files = async (cwd: string) => {
    seen.push(cwd);
    throw new Error('no index');
  };
  fixture.remote = () => Promise.reject(new Error('offline'));
  const m = await mountMention('zzz');
  try {
    assert.deepEqual(seen, ['/proj']);
    assert.equal(m.rows().length, 0);
    await m.key('Enter');
    assert.deepEqual(m.picked, []);
  } finally {
    await m.close();
  }
  // without a known chat the new-chat folder is used, and a high index falls back to the top
  fixture.files = async (cwd: string) => (seen.push(cwd), { files: files(2) });
  fixture.remote = async () => ({});
  const m2 = await mountMention('file', { threadId: null });
  try {
    assert.equal(seen.at(-1), '/repo');
    await m2.key('ArrowDown');
    assert.equal(m2.index, 1);
    fixture.files = async () => ({ files: files(1) });
    await m2.set('file0');
    await flush(130);
    assert.equal(m2.index, 0);
  } finally {
    await m2.close();
  }
});

test('results arriving after the popup closed are dropped', async () => {
  let resolveFiles!: (v: any) => void, rejectFiles!: (e: any) => void;
  fixture.files = () =>
    new Promise((res, rej) => {
      resolveFiles = res;
      rejectFiles = rej;
    });
  let resolveRemote!: (v: any) => void;
  fixture.remote = () =>
    new Promise((res) => {
      resolveRemote = res;
    });
  const m = await mountMention('q');
  await m.close();
  resolveFiles({ files: files(1) });
  resolveRemote({});
  await flush();
  const m2 = await mountMention('q');
  await m2.close();
  rejectFiles(new Error('late'));
  await flush();
  assert.equal($$('.composer-popup').length, 0);
});

test('browser tabs lead the menu, and the keyboard order runs tabs, then chats, then files', async () => {
  fixture.tabs = [
    { key: 'app:t1', title: 'Preview' },
    { key: 'chrome:9', title: 'Mail' },
  ];
  const m = await mountMention();
  try {
    assert.deepEqual(
      m
        .rows()
        .slice(0, 3)
        .map((r) => r.textContent),
      ['Preview', 'Mail', 'Recent Codex conversation'],
    );
    assert.equal(m.rows()[0].classList.contains('kbd-active'), true);
    await m.key('Enter');
    await m.key('ArrowDown');
    await m.key('Enter');
    await m.key('ArrowDown');
    await m.key('Enter');
    for (let i = 0; i < 3; i++) await m.key('ArrowDown');
    await m.key('Enter');
    assert.deepEqual(m.picked, ['tab:app:t1', 'tab:chrome:9', 'recent', '/repo/file0']);
    // rows after the tabs keep their own place for the mouse and the highlight
    assert.equal(m.rows()[5].classList.contains('kbd-active'), true);
    await mouse(m.rows()[2], 'mousemove');
    assert.equal(m.rows()[2].classList.contains('kbd-active'), true);
    await mouse(m.rows()[6], 'mousemove');
    assert.equal(m.rows()[6].classList.contains('kbd-active'), true);
    // a tab row picks its tab by mouse too
    await mouse(m.rows()[1], 'mousedown');
    assert.equal(m.picked.at(-1), 'tab:chrome:9');
  } finally {
    await m.close();
  }
});

test('highlight bolds the matched letters of a name', () => {
  assert.equal(highlight('abc', null, 0), 'abc');
  assert.equal(highlight('abc', [], 0), 'abc');
  const parts = highlight('abc', [4], 3) as any[];
  assert.deepEqual(
    parts.map((p) => `${p.type}:${p.props.children}`),
    ['span:a', 'b:b', 'span:c'],
  );
  // main's matcher gives UTF-16 offsets: an emoji before the match is two of them, not one
  const shape = (name: string, indices: number[], offset = 0) =>
    (highlight(name, indices, offset) as any[]).map((p) => `${p.type}:${p.props.children}`).join(' ');
  assert.equal(shape('😀İx.ts', [3]), 'span:😀 span:İ b:x span:. span:t span:s');
  assert.equal(shape('🙂todo.md', [2, 3, 4, 5]), 'span:🙂 b:t b:o b:d b:o span:. span:m span:d');
  // an offset into the emoji itself bolds the emoji
  assert.equal(shape('a🙂b', [2]), 'span:a b:🙂 span:b');
});

// ---------------------------------------------------------------------------------------------------
async function mountSlash(items: any[], props: any = {}) {
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const log: string[] = [];
  let query = props.query ?? '';
  const out: any = {};
  // the popup hands the picked item back; the composer runs it (applyComposerSlashItem), as here
  // each commit of the popup (a new query must not commit a frame that still shows the old menu)
  const commits = () => (out.commits = (out.commits ?? 0) + 1);
  const el = () =>
    h(
      Profiler,
      { id: 'slash', onRender: commits },
      h(Owner, {
        C: SlashPopup,
        initial: props.index ?? 0,
        out,
        props: {
          anchor,
          query,
          items,
          footer: props.footer,
          onDone: (item: any) => {
            log.push('done');
            item.run?.();
          },
          onClose: () => log.push('close'),
        },
      }),
    );
  const r = await mount(el());
  return {
    log,
    anchor,
    commits: () => out.commits as number,
    get index() {
      return out.index;
    },
    rows: () => $$('.slash-panel .add-panel-item'),
    titles: () => $$('.slash-panel .add-panel-title').map((x) => x.textContent),
    setQuery: async (q: string) => {
      query = q;
      await r.render(el());
    },
    key: (key: string) =>
      act(
        async () =>
          void window.dispatchEvent(
            new (window as any).CustomEvent('composer-popup-key', { cancelable: true, detail: { key, owner: anchor } }),
          ),
      ),
    close: async () => {
      await r.unmount();
      anchor.remove();
    },
  };
}

test('slash menu: filters by id, title and alias; shows icon, description, check, scope and submenu marks', async () => {
  const ran: string[] = [];
  const items = [
    {
      id: 'model',
      title: 'Model',
      icon: h('i', null, 'I'),
      desc: 'Pick one',
      sub: () => [{ id: 'm-a', title: 'A', run: () => ran.push('a') }],
    },
    { id: 'skill:x', title: 'Ship It', aliases: ['ship-it'], checked: true, scope: 'Personal', run: () => ran.push('ship') },
    { id: 'init', title: '/init (/setup)', disabled: 'Not here', run: () => ran.push('init') },
  ];
  const m = await mountSlash(items, { footer: 'Some commands are hidden' });
  try {
    assert.deepEqual(m.titles(), ['Model', 'Ship It', '/init (/setup)']);
    const [model, ship, init] = m.rows();
    assert.equal(model.querySelector('.add-panel-icon')!.textContent, 'I');
    assert.equal(model.querySelector('.add-panel-desc')!.textContent, 'Pick one');
    assert.ok(model.querySelector('.add-panel-chevron'));
    assert.ok(ship.querySelector('.add-panel-check'));
    assert.equal(ship.querySelector('.add-panel-scope')!.textContent, 'Personal');
    assert.ok(!ship.querySelector('.add-panel-icon'));
    assert.match(init.className, /disabled/);
    assert.equal(init.title, 'Not here');
    await m.setQuery('ship');
    assert.deepEqual(m.titles(), ['Ship It']);
    await m.setQuery('ini');
    assert.deepEqual(m.titles(), ['/init (/setup)']);
    await mouse(m.rows()[0], 'mousedown');
    assert.deepEqual(ran, []);
    await m.setQuery('nothing');
    assert.equal(m.rows().length, 0);
  } finally {
    await m.close();
  }
});

test('slash menu: a submenu opens in place, its items run and finish; a new query leaves it', async () => {
  const ran: string[] = [];
  const items = [
    {
      id: 'model',
      title: 'Model',
      sub: async () => [
        { id: 'm-a', title: 'A', run: () => ran.push('a') },
        { id: 'm-b', title: 'B' },
      ],
    },
    { id: 'plan', title: 'Plan', run: () => ran.push('plan') },
  ];
  const m = await mountSlash(items, { footer: 'Hidden ones' });
  try {
    await m.key('Enter');
    await flush();
    assert.deepEqual(m.titles(), ['A', 'B']);
    assert.equal($$('.add-panel-footer').length, 0, 'the footer belongs to the top level');
    await m.key('ArrowDown');
    await m.key('Enter');
    assert.deepEqual(m.log.slice(-1), ['done']);
    await mouse(m.rows()[0], 'mousedown');
    assert.deepEqual(ran, ['a']);
    await m.setQuery('p');
    assert.deepEqual(m.titles(), ['Plan']);
    await mouse(m.rows()[0], 'mousedown');
    assert.deepEqual(ran, ['a', 'plan']);
  } finally {
    await m.close();
  }
});

test('slash menu: the footer leads to the harness settings', async () => {
  const m = await mountSlash([{ id: 'a', title: 'A' }], { footer: 'Some are hidden' });
  try {
    await mouse($$('.add-panel-footer')[0], 'mousedown');
    assert.deepEqual(m.log, ['close']);
    assert.deepEqual(navigated, [{ name: 'settings', section: 'harnesses' }]);
  } finally {
    await m.close();
  }
});

test('slash menu: the highlight follows real mouse moves, clamps to the list, and scrolls into view', async () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, title: `C${i}` }));
  const proto = (window as any).HTMLElement.prototype;
  const orig = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('slash-panel')) return { top: 100, bottom: 200, left: 0, right: 10, width: 10, height: 100 };
    const i = [...(this.parentElement?.children ?? [])].indexOf(this);
    return { top: 60 + i * 40, bottom: 100 + i * 40, left: 0, right: 10, width: 10, height: 40 };
  };
  try {
    const m = await mountSlash(items, { index: 9 });
    try {
      assert.equal(m.index, 3);
      const panel = $$('.slash-panel')[0];
      assert.equal(panel.scrollTop, 0 + (100 + 3 * 40 - 200));
      await mouse(m.rows()[0], 'mousemove');
      assert.equal(m.index, 3, 'a mouse that did not move does not steal the highlight');
      await mouse(m.rows()[0], 'mousemove', { movementX: 1 });
      assert.equal(m.index, 0);
      // row 0 starts 40px above the panel: scrolled up by that much (happy-dom doesn't clamp)
      assert.equal(panel.scrollTop, 20 - 40);
      await mouse(m.rows()[1], 'mousemove', { movementY: 1 });
      assert.equal(m.index, 1);
    } finally {
      await m.close();
    }
  } finally {
    proto.getBoundingClientRect = orig;
  }
});

test('remote matches for the active chat do not consume one of the eight chat suggestions', async () => {
  fixture.files = async () => ({ files: [] });
  const peers = Array.from({ length: 10 }, (_, index) => t(`peer-${index}`, `Target ${index}`, 100 - index));
  for (const source of ['codex', 'claude', 'sage']) {
    fixture.remote = async () => ({ [source]: [t('self', 'Target self', 999), ...peers] });
    const m = await mountMention('Target');
    try {
      assert.deepEqual(
        m.rows().map((row) => row.textContent),
        peers.slice(0, 8).map((peer) => peer.title),
      );
      await m.key('Enter');
      assert.deepEqual(m.picked, ['peer-0']);
    } finally {
      await m.close();
    }
  }
});

test('remote chat suggestions remain capped at eight without an active-chat match', async () => {
  fixture.files = async () => ({ files: [] });
  const peers = Array.from({ length: 10 }, (_, index) => t(`peer-${index}`, `Target ${index}`, 100 - index));
  fixture.remote = async () => ({ codex: peers });
  for (const threadId of ['self', null]) {
    const m = await mountMention('Target', { threadId });
    try {
      assert.deepEqual(
        m.rows().map((row) => row.textContent),
        peers.slice(0, 8).map((peer) => peer.title),
      );
    } finally {
      await m.close();
    }
  }
});

test('slash submenu failures stay visible and allow a successful retry', async () => {
  for (const error of [new Error('offline'), 'plain failure', null])
    for (const sync of [false, true]) {
      let failed = true;
      const child = { id: 'loaded', title: 'Loaded', run: () => {} };
      const m = await mountSlash([
        {
          id: 'model',
          title: 'Model',
          sub: () => {
            if (!failed) return [child];
            if (sync) throw error;
            return Promise.reject(error);
          },
        },
      ]);
      try {
        await mouse(m.rows()[0], 'mousedown');
        await flush();
        const alert = document.querySelector('[role="alert"]');
        assert.match(alert?.textContent ?? '', /Could not load Model/);
        assert.ok((alert?.textContent ?? '').includes(error instanceof Error ? error.message : String(error)));
        assert.deepEqual(m.titles(), ['Model']);
        failed = false;
        await mouse(m.rows()[0], 'mousedown');
        await flush();
        assert.equal(document.querySelector('[role="alert"]'), null);
        assert.deepEqual(m.titles(), ['Loaded']);
        await mouse(m.rows()[0], 'mousedown');
        assert.deepEqual(m.log, ['done']);
      } finally {
        await m.close();
      }
    }
});

test('superseded slash submenu responses and errors cannot replace the current menu', async () => {
  for (const change of ['query', 'newer', 'pick', 'close', 'late-failure']) {
    let resolve!: (items: any[]) => void, reject!: (error: Error) => void;
    const pending = new Promise<any[]>((r, f) => {
      resolve = r;
      reject = f;
    });
    const m = await mountSlash([
      { id: 'model', title: 'Model', sub: () => pending },
      { id: 'other', title: 'Other', run: () => {} },
      { id: 'next', title: 'Next', sub: () => [{ id: 'latest', title: 'Latest' }] },
    ]);
    let closed = false;
    try {
      await mouse(m.rows()[0], 'mousedown');
      if (change === 'query' || change === 'late-failure') await m.setQuery('other');
      if (change === 'newer') await mouse(m.rows()[2], 'mousedown');
      if (change === 'pick') await mouse(m.rows()[1], 'mousedown');
      if (change === 'close') {
        await m.close();
        closed = true;
      }
      await act(async () => {
        if (change === 'late-failure') reject(new Error('stale failure'));
        else resolve([{ id: 'stale', title: 'Stale' }]);
      });
      await flush();
      assert.equal(document.querySelector('[role="alert"]'), null);
      assert.deepEqual(
        m.titles(),
        change === 'close' ? [] : change === 'newer' ? ['Latest'] : change === 'pick' ? ['Model', 'Other', 'Next'] : ['Other'],
      );
    } finally {
      resolve([]);
      if (!closed) await m.close();
    }
  }
});

test('slash menu: a submenu still loading for a query typed over is dropped, even when that query is typed again', async () => {
  let resolve!: (items: any[]) => void;
  const pending = new Promise<any[]>((r) => {
    resolve = r;
  });
  const m = await mountSlash([
    { id: 'model', title: 'Model', sub: () => pending },
    { id: 'more', title: 'More', run: () => {} },
  ]);
  try {
    await mouse(m.rows()[0], 'mousedown');
    await m.setQuery('m');
    await m.setQuery('');
    await act(async () => resolve([{ id: 'stale', title: 'Stale' }]));
    await flush();
    assert.deepEqual(m.titles(), ['Model', 'More']);
  } finally {
    await m.close();
  }
});

test('slash menu: a new query shows the filtered commands, not the open submenu, and its error is gone', async () => {
  const m = await mountSlash([
    { id: 'model', title: 'Model', sub: () => [{ id: 'm-a', title: 'A' }] },
    { id: 'broken', title: 'Broken', sub: () => Promise.reject(new Error('offline')) },
  ]);
  try {
    await mouse(m.rows()[0], 'mousedown');
    await flush();
    assert.deepEqual(m.titles(), ['A']);
    const before = m.commits();
    await m.setQuery('b');
    assert.deepEqual(m.titles(), ['Broken']);
    assert.equal(m.commits() - before, 1, 'no frame shows the submenu under the new query');
    await mouse(m.rows()[0], 'mousedown');
    await flush();
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Could not load Broken/);
    await m.setQuery('');
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.deepEqual(m.titles(), ['Model', 'Broken']);
  } finally {
    await m.close();
  }
});

test('slash menu: a highlight past a list that got shorter scrolls to no row, not to the footer', async () => {
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, title: `C${i}` }));
  const proto = (window as any).HTMLElement.prototype;
  const orig = proto.getBoundingClientRect;
  const measured: string[] = [];
  proto.getBoundingClientRect = function () {
    if (this.classList.contains('slash-panel')) return { top: 100, bottom: 200, left: 0, right: 10, width: 10, height: 100 };
    measured.push(this.className);
    const i = [...(this.parentElement?.children ?? [])].indexOf(this);
    return { top: 60 + i * 40, bottom: 100 + i * 40, left: 0, right: 10, width: 10, height: 40 };
  };
  try {
    const m = await mountSlash(items, { index: 1, footer: 'Some commands are hidden' });
    try {
      measured.length = 0;
      // 'c1' leaves one row, so the footer is the panel's second child; the highlight (1) is clamped to the row
      // in an effect after the layout pass
      await m.setQuery('c1');
      assert.equal(m.index, 0);
      assert.ok(!measured.some((c) => c.includes('add-panel-footer')), 'the footer is never scrolled to');
      assert.ok(
        measured.some((c) => c.includes('add-panel-item')),
        'the clamped row is',
      );
    } finally {
      await m.close();
    }
  } finally {
    proto.getBoundingClientRect = orig;
  }
});
