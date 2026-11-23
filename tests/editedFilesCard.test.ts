import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appCss } from './support/app-css.ts';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss from 'postcss';
import './support/dom.ts';
import { iconStubs, mockSource, popoverStubs } from './support/stubs.ts';

const menuCalls: unknown[][] = [];
mockSource('src/components/ui/icons.tsx', iconStubs());
mockSource('src/components/ui/Popover.tsx', popoverStubs());
mockSource('src/session/open.ts', { revealPath: (p: string) => menuCalls.push(['reveal', p]) });
mockSource('src/session/clipboard.ts', { copyText: (t: string) => menuCalls.push(['copy', t]) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditedFilesCard } = await import('../src/components/thread/EditedFilesCard.tsx');
const files = Array.from({ length: 5 }, (_, i) => ({ path: `/repo/file${i}.ts`, label: `file${i}.ts`, added: i + 1, removed: i }));
const defaults = { files, undone: false, busy: false, expanded: false, onExpand() {}, onView() {}, onUndo() {} };
const render = (props = {}) => renderToStaticMarkup(createElement(EditedFilesCard, { ...defaults, ...props }));
async function mount(overrides: Record<string, any> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const selected: (string | undefined)[] = [];
  let undo = 0;
  let props = {
    files,
    undone: false,
    busy: false,
    expanded: false,
    onExpand: (expanded: boolean) => {
      props = { ...props, expanded };
      render();
    },
    onView: (path?: string) => selected.push(path),
    onUndo: () => undo++,
    ...overrides,
  };
  function render() {
    root.render(createElement(EditedFilesCard, props));
  }
  await act(render);
  return {
    host,
    selected,
    undo: () => undo,
    rows: () => [...host.querySelectorAll<HTMLButtonElement>('.edited-file')],
    button: (label: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label,
      )!,
    click: async (button: HTMLButtonElement) => {
      await act(() => button.click());
    },
    rightClick: async (el: Element) => {
      await act(async () => {
        el.dispatchEvent(new (window as any).MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      });
    },
    menuItem: (label: string) =>
      [...host.querySelectorAll('[role=menuitem]')].find((n) => n.textContent?.trim() === label) as HTMLButtonElement,
    update: async (patch: Record<string, any>) => {
      props = { ...props, ...patch };
      await act(render);
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('compact totals include all files; expansion and either collapse control restore three rows', async () => {
  const m = await mount();
  try {
    assert.match(m.host.textContent!, /Edited 5 files\+15 -10/);
    assert.equal(m.rows().length, 3);
    assert.equal(m.button('Show 2 more files').getAttribute('aria-expanded'), 'false');
    await m.click(m.button('Show 2 more files'));
    assert.equal(m.rows().length, 5);
    const collapse = () => [...m.host.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === 'Show less');
    assert.equal(collapse().length, 2);
    await m.click(collapse()[0]);
    assert.equal(m.rows().length, 3);
    await m.click(m.button('Show 2 more files'));
    await m.click(collapse()[1]);
    assert.equal(m.rows().length, 3);
  } finally {
    await m.close();
  }
});

test('large lists mount at most 20 rows, retain paths and totals, and reset after collapsing', async () => {
  const many = Array.from({ length: 267 }, (_, i) => ({ path: `/repo/file${i}.ts`, label: `file${i}.ts`, added: 1, removed: 2 }));
  const m = await mount({ files: many });
  try {
    assert.match(m.host.textContent!, /Edited 267 files\+267 -534/);
    await m.click(m.button('Show 264 more files'));
    assert.equal(m.rows().length, 20);
    assert.equal(m.button('Previous files').disabled, true);
    assert.match(m.host.textContent!, /1–20 of 267 files/);
    const firstList = m.host.querySelector('.edited-file-list');
    await m.click(m.button('Next files'));
    assert.notEqual(m.host.querySelector('.edited-file-list'), firstList);
    assert.equal(m.rows().length, 20);
    await m.click(m.rows()[0]);
    assert.deepEqual(m.selected, ['/repo/file20.ts']);
    await m.click(m.button('Previous files'));
    assert.match(m.host.textContent!, /1–20 of 267 files/);
    for (let i = 0; i < 13; i++) await m.click(m.button('Next files'));
    assert.equal(m.rows().length, 7);
    assert.equal(m.button('Next files').disabled, true);
    assert.match(m.host.textContent!, /261–267 of 267 files/);
    await m.click(m.button('Show less'));
    assert.equal(m.rows().length, 3);
    await m.click(m.button('Show 264 more files'));
    assert.match(m.host.textContent!, /1–20 of 267 files/);
    await m.click(m.button('Next files'));
    await m.update({ files: many.slice(0, 4) });
    assert.equal(m.rows().length, 4);
    assert.equal(m.rows()[0].title, 'file0.ts');
    assert.equal(m.host.querySelector('.edited-pagination'), null);
  } finally {
    await m.close();
  }
});

test('empty and single-file cards have no expansion or pagination; four files use singular more-file wording', async () => {
  const m = await mount({ files: [] });
  try {
    assert.equal(m.rows().length, 0);
    assert.equal(m.host.querySelector('.edited-expand'), null);
    await m.update({ files: files.slice(0, 1) });
    assert.match(m.host.textContent!, /Edited 1 file/);
    assert.equal(m.host.querySelector('.edited-expand'), null);
    await m.update({ files: files.slice(0, 4) });
    await m.click(m.button('Show 1 more file'));
    assert.equal(m.rows().length, 4);
  } finally {
    await m.close();
  }
});

test('overview, view button, file paths, undo and disabled redo stay independent of expansion', async () => {
  const m = await mount();
  try {
    await m.click(m.rows()[0]);
    await m.click(m.button('View changes to 5 files'));
    await m.click(m.button('View changes'));
    assert.deepEqual(m.selected, ['/repo/file0.ts', undefined, undefined]);
    await m.click(m.button('Undo'));
    assert.equal(m.undo(), 1);
    await m.update({ undone: true, busy: true });
    assert.match(m.host.textContent!, /Undid changes to 5 files/);
    assert.equal(m.button('Redo').disabled, true);
    await m.click(m.button('Redo'));
    assert.equal(m.undo(), 1);
    await m.update({ busy: false });
    await m.click(m.button('Redo'));
    assert.equal(m.undo(), 2);
  } finally {
    await m.close();
  }
});

test('the compact card shows three files while totals include all edits', () => {
  const html = render();
  assert.match(html, /Edited 5 files/);
  assert.match(html, /\+15/);
  assert.match(html, /-10/);
  for (let i = 0; i < 3; i++) assert.match(html, new RegExp(`file${i}\\.ts`));
  assert.doesNotMatch(html, /file3\.ts|file4\.ts/);
  assert.match(html, /Show 2 more files/);
  assert.match(html, /aria-expanded="false"/);
});

test('expansion shows every file and collapse restores the compact list', async () => {
  const html = render({ expanded: true });
  for (const file of files) assert.ok(html.includes(file.label));
  assert.match(html, /Show less/);
  const toggles: boolean[] = [];
  for (const expanded of [false, true]) {
    const m = await mount({ expanded, onExpand: (value: boolean) => toggles.push(value) });
    try {
      await m.click(m.host.querySelector<HTMLButtonElement>('.edited-expand')!);
    } finally {
      await m.close();
    }
  }
  assert.deepEqual(toggles, [true, false]);
});

test('single-file cards use singular wording without an expand control', () => {
  const html = render({ files: files.slice(0, 1) });
  assert.match(html, /Edited 1 file</);
  assert.doesNotMatch(html, /Show .*more|edited-expand/);
});

test('one file beyond the compact three is offered in the singular', () => {
  assert.match(render({ files: files.slice(0, 4) }), /Show 1 more file</);
});

test('file rows select the original path; overview and button open all changes', async () => {
  const m = await mount();
  try {
    await m.click(m.host.querySelector<HTMLButtonElement>('.edited-file')!);
    await m.click(m.host.querySelector<HTMLButtonElement>('.edited-overview')!);
    await m.click(m.host.querySelector<HTMLButtonElement>('.btn-pill:not(.ghost)')!);
    assert.deepEqual(m.selected, ['/repo/file0.ts', undefined, undefined]);
  } finally {
    await m.close();
  }
});

test('busy undo is disabled and undone cards offer redo independently of viewing', async () => {
  const m = await mount({ busy: true, undone: true });
  try {
    const control = () => m.host.querySelector<HTMLButtonElement>('.btn-pill.ghost')!;
    assert.equal(control().disabled, true);
    await m.update({ busy: false });
    await m.click(control());
    assert.equal(m.undo(), 1);
  } finally {
    await m.close();
  }
  const html = render({ undone: true, busy: true });
  assert.match(html, /Undid changes to 5 files/);
  assert.match(html, /Redo/);
});

const css = postcss.parse(appCss());
function visibility(selector: string) {
  let value: string | undefined;
  css.walkRules((rule) => {
    if (
      rule.selector
        .split(',')
        .map((s) => s.trim())
        .includes(selector)
    )
      rule.walkDecls('visibility', (decl) => {
        value = decl.value;
      });
  });
  return value;
}
test('hover and keyboard focus replace the counts with a view-changes hint', () => {
  assert.equal(visibility('.edited-view-hint'), 'hidden');
  for (const state of ['hover', 'focus-visible']) {
    assert.equal(visibility(`.edited-overview:${state} .edited-stats`), 'hidden');
    assert.equal(visibility(`.edited-overview:${state} .edited-view-hint`), 'visible');
  }
});

test('a file row keeps viewing its diff as the click and reaches Reveal in Finder by a right-click', async () => {
  menuCalls.length = 0;
  const m = await mount({ files: [{ path: 'src/a.ts', label: 'src/a.ts', added: 1, removed: 0 }], cwd: '/repo' });
  try {
    const row = m.rows()[0];
    assert.equal(row.getAttribute('aria-haspopup'), 'menu');
    await m.click(row);
    assert.deepEqual(m.selected, ['src/a.ts'], 'the row still opens the diff');
    assert.deepEqual(menuCalls, [], 'and reveals nothing on its own');
    await m.rightClick(row);
    await m.click(m.menuItem('Reveal in Finder'));
    assert.deepEqual(menuCalls, [['reveal', '/repo/src/a.ts']], 'the chat folder makes the row path absolute');
    await m.rightClick(row);
    await m.click(m.menuItem('Copy path'));
    assert.deepEqual(menuCalls.at(-1), ['copy', '/repo/src/a.ts']);
  } finally {
    await m.close();
  }
});

test('an absolute row path is revealed as it stands, with or without a chat folder', async () => {
  menuCalls.length = 0;
  for (const cwd of [undefined, '/elsewhere']) {
    const m = await mount({ cwd });
    try {
      await m.rightClick(m.rows()[0]);
      await m.click(m.menuItem('Reveal in Finder'));
      assert.deepEqual(menuCalls.at(-1), ['reveal', '/repo/file0.ts']);
    } finally {
      await m.close();
    }
  }
});
