// Search results, errors and selectable rows belong to the displayed query and file project.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act } from 'react';
import { click, type, press, flush } from './support/shell-chrome-kit.ts';
import { searchPaletteKit, thread } from './support/search-palette-kit.ts';

const kit = await searchPaletteKit();
const { store, calls, reset, open, debounce, input, items, item, alert, mount } = kit;

test('audit: changed file query immediately retires selectable previous hits', async () => {
  reset();
  const { host, unmount } = await mount();
  try {
    await open('files');
    kit.fileHits = { files: [{ path: 'src/old.ts', file_name: 'old.ts', root: '/cwd' }] };
    await type(input(host), 'old');
    await debounce();
    assert.deepEqual(items(host), ['old.ts']);
    await type(input(host), 'new');
    assert.deepEqual(items(host), [], 'old query must not remain selectable during the replacement debounce');
    await press(input(host), 'Enter');
    assert.equal(
      calls.some((c) => c[0] === 'openFile'),
      false,
    );
  } finally {
    await unmount();
  }
});

test('audit: project change retires delayed file results and starts current project search', async () => {
  reset();
  const { host, unmount } = await mount();
  let release!: () => void;
  try {
    await open('files');
    kit.filesHeld = new Promise<void>((r) => (release = r));
    kit.fileHits = { files: [{ path: 'src/old.ts', file_name: 'old.ts', root: '/cwd' }] };
    await type(input(host), 'file');
    await debounce();
    await act(async () => store.setState({ newChatCwd: '/new-project' }));
    await act(async () => release());
    await flush();
    assert.deepEqual(items(host), [], 'late old-project result must not publish');
    await debounce();
    assert.ok(calls.some((c) => c[0] === 'files' && c[1] === '/new-project'));
  } finally {
    release?.();
    await unmount();
  }
});

test('audit: changed chat query retires prior remote transcript hits immediately', async () => {
  reset();
  const { host, unmount } = await mount();
  try {
    await open();
    kit.byQuery.old = { codex: [thread('old-remote', 'Unrelated transcript hit')], claude: [], sage: [] };
    await type(input(host), 'old');
    await debounce();
    assert.ok(items(host).includes('Unrelated transcript hit'));
    await type(input(host), 'zzz-new');
    assert.deepEqual(items(host), [], 'old transcript match must not be offered for new query');
  } finally {
    await unmount();
  }
});

test('audit: changed query retires prior error while its replacement is pending', async () => {
  reset();
  const { host, unmount } = await mount();
  try {
    await open('files');
    kit.filesFail = true;
    await type(input(host), 'old');
    await debounce();
    assert.match(alert(host)!, /no index/);
    kit.filesFail = false;
    await type(input(host), 'new');
    assert.equal(alert(host), undefined, 'failure belongs to prior query');
  } finally {
    await unmount();
  }
});

test('project replacement suppresses an obsolete failure and opens only the new root', async () => {
  reset();
  const { host, unmount } = await mount();
  let release!: () => void;
  try {
    await open('files');
    kit.filesHeld = new Promise<void>((r) => (release = r));
    kit.filesFail = true;
    await type(input(host), 'same');
    await debounce();
    await act(async () => store.setState({ newChatCwd: '/new-project' }));
    kit.filesHeld = null;
    kit.filesFail = false;
    kit.fileHits = { files: [{ path: 'new.ts', file_name: 'new.ts', root: '/new-project' }] };
    await debounce();
    await act(async () => release());
    await flush();
    assert.deepEqual(items(host), ['new.ts']);
    assert.equal(alert(host), undefined);
    await click(item(host, 'new.ts'));
    assert.deepEqual(calls.at(-1), ['openFile', '/new-project/new.ts']);
  } finally {
    release?.();
    await unmount();
  }
});

test('close and reopen with the same query cannot revive retired results', async () => {
  reset();
  const { host, unmount } = await mount();
  let release!: () => void;
  try {
    await open('files');
    kit.filesHeld = new Promise<void>((r) => (release = r));
    kit.fileHits = { files: [{ path: 'old.ts', file_name: 'old.ts', root: '/cwd' }] };
    await type(input(host), 'same');
    await debounce();
    await press(input(host), 'Escape');
    await open('files');
    kit.filesHeld = null;
    kit.fileHits = { files: [{ path: 'fresh.ts', file_name: 'fresh.ts', root: '/cwd' }] };
    await type(input(host), 'same');
    await debounce();
    await act(async () => release());
    await flush();
    assert.deepEqual(items(host), ['fresh.ts']);
  } finally {
    release?.();
    await unmount();
  }
});

for (const failed of [false, true]) {
  test(`A to B to A does not revive a retired completed snapshot (failed=${failed})`, async () => {
    reset();
    const { host, unmount } = await mount();
    let release!: () => void;
    try {
      await open('files');
      kit.filesFail = failed;
      kit.fileHits = { files: [{ path: 'old.ts', file_name: 'old.ts', root: '/cwd' }] };
      await type(input(host), 'A');
      await debounce();
      if (failed) assert.match(alert(host)!, /no index/);
      else assert.deepEqual(items(host), ['old.ts']);
      kit.filesFail = false;
      kit.fileHits = { files: [{ path: 'fresh.ts', file_name: 'fresh.ts', root: '/cwd' }] };
      kit.filesHeld = new Promise<void>((r) => (release = r));
      await type(input(host), 'B');
      await type(input(host), 'A');
      assert.deepEqual(items(host), []);
      assert.equal(alert(host), undefined);
      await debounce();
      assert.deepEqual(items(host), []);
      await act(async () => release());
      await flush();
      assert.deepEqual(items(host), ['fresh.ts']);
    } finally {
      release?.();
      await unmount();
    }
  });
}
