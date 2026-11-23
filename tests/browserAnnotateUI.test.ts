// Browser annotation UI lifecycle and capture use a shared isolated-world fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { appCss } from './support/app-css.ts';
import postcss from 'postcss';
import {
  f,
  mount,
  text,
  button,
  click,
  signal,
  nonce,
  marks,
  note,
  type,
  escape,
  page,
  guest,
  act,
  createElement,
  createRoot,
  AnnotateBar,
  attachToComposer,
  ANNOTATE_KEY,
} from './support/browser-annotate-fixture.ts';
test('mounting installs the overlay in the isolated world through main; mark signals list the marks; Clear asks the page', async () => {
  await mount();
  assert.match(f.scripts[0], /mopilot-annotate/);
  assert.match(f.scripts[0], new RegExp(ANNOTATE_KEY));
  assert.deepEqual(f.ids, [7], 'the pane tab, by its webContents id');
  assert.match(text()!, /^Click an element or drag a region to mark it/);
  assert.equal(button('Add to chat')!.disabled, true);
  assert.equal(button('Clear'), undefined);
  assert.equal(f.pane.querySelector('.browser-annotate-marks'), null);
  await marks(2);
  assert.match(text()!, /^2 marks\. Click or drag to add more\. Click a mark's number to edit its note, × to remove it\./);
  const rows = [...f.pane.querySelectorAll('.browser-annotate-marks li')];
  assert.deepEqual(
    rows.map((r) => [r.querySelector('.browser-annotate-badge')!.textContent, r.querySelector('.browser-annotate-kind')!.textContent]),
    [
      ['1', '<button>'],
      ['2', 'Region'],
    ],
  );
  await marks(1);
  assert.match(text()!, /^1 mark\./);
  // another page's console line, or a forged nonce, changes nothing
  await signal('mopilot-annotate:other:{"type":"exit"}');
  await signal('hello');
  assert.equal(f.exits, 0);
  assert.equal(button('Add to chat')!.disabled, false);
  await click('Clear');
  assert.deepEqual(f.toasts.at(-1), ["Couldn't update the annotations. Try again.", 'error']);
  assert.ok(f.scripts.some((x: string) => x.includes('a.clear()')));
  assert.deepEqual(f.wv.mainWorld, [], 'nothing runs in the page world');
});

test('without notes, Escape in the pane, the exit signal, Cancel and a navigation each leave; unmount removes the overlay', async () => {
  await mount();
  await marks(2);
  const outside = document.createElement('input');
  document.body.append(outside);
  await escape(outside);
  await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })));
  outside.remove();
  await act(async () =>
    f.pane.querySelector('button')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }) as any),
  );
  assert.equal(f.exits, 0);
  await escape();
  assert.equal(f.exits, 1, 'marks without notes are discarded at once');
  await signal(`${nonce()}{"type":"exit"}`);
  assert.equal(f.exits, 2);
  await click('Cancel');
  assert.equal(f.exits, 3);
  await act(async () => f.wv.dispatchEvent(new window.Event('did-navigate')));
  assert.equal(f.exits, 4);
  await act(async () => f.root.unmount());
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(f.scripts.at(-1).includes('a.destroy()'));
  // listeners are gone with it
  await act(async () => f.wv.dispatchEvent(new window.Event('did-navigate')));
  assert.equal(f.exits, 4);
});

test('IAB-12: with a note typed, the first Escape asks "Discard N marks?"; a second Escape or Discard leaves', async () => {
  await mount();
  await marks(2);
  await type(note(1), 'Make this bold');
  assert.equal(note(1).value, 'Make this bold');
  // Escape in the pane (here in the note field): asks instead of leaving
  await escape(note(1));
  assert.equal(f.exits, 0);
  assert.equal(text(), 'Discard 2 marks? Your notes will be lost.');
  assert.equal(f.pane.querySelector('.browser-annotate-text')!.getAttribute('role'), 'alert');
  assert.equal(button('Add to chat'), undefined);
  // Keep editing goes back, with the notes as they were
  await click('Keep editing');
  assert.match(text()!, /^2 marks\./);
  assert.equal(note(1).value, 'Make this bold');
  // Escape in the page (the overlay's exit signal) asks too, and a second one leaves
  await signal(`${nonce()}{"type":"exit"}`);
  assert.match(text()!, /^Discard 2 marks\?/);
  await signal(`${nonce()}{"type":"exit"}`);
  assert.equal(f.exits, 1);
  // (the stand-in pane keeps the bar mounted after leaving)
  await click('Keep editing');
  // typing, or a new mark, puts the question away; Discard leaves
  await escape();
  assert.match(text()!, /^Discard/);
  await type(note(2), 'and this');
  assert.match(text()!, /^2 marks\./);
  await escape();
  await marks(3);
  assert.match(text()!, /^3 marks\./);
  await escape();
  assert.equal(text(), 'Discard 3 marks? Your notes will be lost.');
  await click('Discard');
  assert.equal(f.exits, 2);
  // one mark: singular; a blank note is no note
  await act(async () => f.root.unmount());
  await mount();
  await marks(1);
  await type(note(1), '   ');
  await escape();
  assert.equal(f.exits, 1);
  await type(note(1), 'x');
  await escape();
  assert.equal(text(), 'Discard 1 mark? Your notes will be lost.');
  // a removed mark's note no longer counts
  await marks(0);
  await escape();
  assert.equal(f.exits, 2);
});

test('a click on a mark number in the page focuses its note here; focusing a note selects the mark; × removes it', async () => {
  await mount();
  await marks(2);
  await signal(`${nonce()}{"type":"select","id":2}`);
  assert.equal(document.activeElement, note(2));
  const rows = [...f.pane.querySelectorAll('.browser-annotate-marks li')];
  assert.deepEqual(
    rows.map((r) => r.getAttribute('data-selected')),
    ['false', 'true'],
  );
  // a mark the pane no longer lists: nothing to focus
  await signal(`${nonce()}{"type":"select","id":9}`);
  assert.equal(document.activeElement, note(2));
  // focusing a note highlights its mark in the page
  await act(async () => note(1).focus());
  assert.ok(f.scripts.at(-1).includes('a.select(1)'));
  assert.equal(f.pane.querySelector('li[data-selected="true"] input'), note(1));
  await click('Remove mark 2');
  assert.ok(f.scripts.at(-1).includes('a.remove(2)'));
  // the page answers with the marks left
  await marks(1);
  assert.equal(note(2), null);
  assert.equal(f.pane.querySelectorAll('.browser-annotate-marks li').length, 1);
});

test('a page that refuses the overlay reports it and leaves Annotate mode', async () => {
  await mount({ guest: { install: () => Promise.reject(new Error('no guest')) } });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(f.exits, 1);
  assert.match(f.toasts[0][0], /Couldn't annotate this page/);
});

test('Add to chat: notes joined here by mark id, marked crop, one chip to the open composer; no note ever goes to the page', async () => {
  const collected = page(3);
  delete (collected.marks[2] as any).id; // a mark without an id has no note
  await mount({ guest: { collect: collected } });
  const got: any[] = [];
  const composer = (e: any) => {
    if (e.detail.threadId === 'chat-1') {
      e.detail.handled = true;
      got.push(e.detail.attachment);
    }
  };
  window.addEventListener('composer-add-selection', composer);
  try {
    await marks(3);
    await type(note(1), 'too big');
    await type(note(3), 'secret plan');
    let release!: () => void;
    f.handlers.captureRegion = (...a: any[]) =>
      new Promise((r) => {
        release = () => r('data:image/png;base64,QQ==');
      });
    await click('Add to chat');
    assert.equal(button('Adding…')!.disabled, true);
    assert.equal(button('Cancel')!.disabled, true);
    assert.equal(note(1).readOnly, true);
    const order = f.scripts
      .map((x: string) => (x.includes('a.collect()') ? 'collect' : x.includes('a.capture(true)') ? 'capture' : null))
      .filter(Boolean);
    assert.deepEqual(order, ['collect', 'capture']);
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    });
    assert.deepEqual(f.calls[0], ['captureRegion', 7, { x: 0, y: 0, width: 174, height: 74 }]);
    assert.deepEqual(f.calls[1], ['saveTempImage', 'data:image/png;base64,QQ==']);
    assert.ok(f.scripts.some((x: string) => x.includes('a.capture(false)')));
    assert.equal(got.length, 1);
    assert.equal(got[0].kind, 'image');
    assert.equal(got[0].path, '/tmp/annot.png');
    assert.equal(got[0].previewUrl, 'data:image/png;base64,QQ==');
    assert.equal(got[0].pageUrl, 'https://shop.test/cart');
    assert.match(got[0].text, /\[1\] Region: too big/);
    assert.match(got[0].text, /\[2\] Region\n/);
    assert.match(got[0].text, /\[3\] Region\n/);
    assert.doesNotMatch(got[0].text, /secret plan/);
    assert.deepEqual(f.toasts.at(-1), ['Added 3 marks to the chat', 'success']);
    assert.equal(f.exits, 1);
    assert.deepEqual(f.state.drafts, {});
    // IAB-13: the notes stayed in the pane; no script sent to the page carried one, and none ran in the page world
    for (const s of f.scripts) assert.ok(!s.includes('too big') && !s.includes('secret plan'), s.slice(0, 80));
    assert.deepEqual(f.wv.mainWorld, []);
  } finally {
    window.removeEventListener('composer-add-selection', composer);
  }
});

test('Add to chat with no composer open stores the chip in the chat draft, or the new-chat draft', async () => {
  await mount({
    drafts: { 'chat-1': { text: 'look', attachments: [{ kind: 'file', path: '/a', name: 'a' }], goal: true } },
    guest: { collect: page(1) },
  });
  await marks(1);
  await click('Add to chat');
  const d = f.state.drafts['chat-1'];
  assert.equal(d.text, 'look');
  assert.equal(d.goal, true);
  assert.deepEqual(
    d.attachments.map((a: any) => a.kind),
    ['file', 'image'],
  );
  assert.deepEqual(f.toasts.at(-1), ['Added 1 mark to the chat', 'success']);
  await act(async () => f.root.unmount());
  await mount({ threadId: null, guest: { collect: page(1) } });
  await marks(1);
  await click('Add to chat');
  assert.equal(f.state.drafts.home.text, '');
  assert.equal(f.state.drafts.home.attachments.length, 1);
  attachToComposer('chat-9', { kind: 'image', path: '/x', name: 'x' });
  assert.deepEqual(f.state.drafts['chat-9'], { text: '', attachments: [{ kind: 'image', path: '/x', name: 'x' }] });
});

test('Add to chat keeps browser notes and the retry button when the composer refuses the attachment', async () => {
  await mount({ guest: { collect: page(1) } });
  await marks(1);
  await type(note(1), 'Keep this note');
  const refuse: Parameters<typeof window.addEventListener>[1] = (e) => ((e as unknown as CustomEvent).detail.refused = true);
  window.addEventListener('composer-add-selection', refuse);
  try {
    await click('Add to chat');
    assert.equal(f.exits, 0);
    assert.equal(note(1).value, 'Keep this note');
    assert.equal(button('Add to chat')!.disabled, false);
    assert.deepEqual(f.state.drafts, {});
    assert.ok(!f.toasts.some(([, level]: string[]) => level === 'success'));
  } finally {
    window.removeEventListener('composer-add-selection', refuse);
  }
});

test('Add to chat with marks gone from the page resets the list and adds nothing', async () => {
  for (const collect of [null, page(0)]) {
    await mount({ guest: { collect } });
    await marks(1);
    await click('Add to chat');
    assert.match(text()!, /^Click an element/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.exits, 0);
    await act(async () => f.root.unmount());
  }
});

test('a failed capture or save reports it, restores the page and stays in Annotate mode', async () => {
  const cases = [
    { handlers: { captureRegion: async () => null } },
    {
      handlers: {
        captureRegion: async () => {
          throw new Error('gone');
        },
      },
      guest: { release: () => Promise.reject(new Error('gone')) },
    },
    { handlers: { saveTempImage: async () => null } },
  ];
  for (const o of cases) {
    await mount(o);
    await marks(2);
    await click('Add to chat');
    assert.match(f.toasts.at(-1)[0], /Couldn't add the annotations/);
    assert.ok(f.scripts.some((x: string) => x.includes('a.capture(false)')));
    assert.equal(f.exits, 0);
    assert.equal(button('Add to chat')!.disabled, false);
    await act(async () => f.root.unmount());
  }
});

test('a guest that is not attached yet fails the install like a refusing page', async () => {
  await mount();
  await act(async () => f.root.unmount());
  f.pane.remove();
  f.toasts = [];
  f.exits = 0;
  f.wv = guest();
  f.wv.getWebContentsId = () => {
    throw new Error('not attached');
  };
  f.pane = document.createElement('div');
  f.pane.className = 'browser-pane';
  document.body.append(f.pane);
  f.root = createRoot(f.pane);
  await act(async () =>
    f.root.render(
      createElement(AnnotateBar, {
        webview: { current: f.wv },
        threadId: 'chat-1',
        onExit: () => {
          f.exits++;
        },
      }),
    ),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.equal(f.exits, 1);
  assert.match(f.toasts[0][0], /Couldn't annotate this page/);
});

test('IAB-14: the bar is one fixed box; marks fill a list inside it and never add layout around it', async () => {
  await mount();
  const bar = f.pane.firstElementChild as HTMLElement;
  const head = bar.firstElementChild as HTMLElement;
  assert.equal(f.pane.children.length, 1);
  assert.equal(bar.className, 'browser-annotate-bar');
  assert.equal(head.className, 'browser-annotate-head');
  for (const n of [1, 3, 6]) {
    await marks(n);
    assert.equal(f.pane.children.length, 1, 'nothing but the bar');
    assert.equal(f.pane.firstElementChild, bar, 'the same bar node');
    assert.equal(bar.firstElementChild, head, 'the hint/actions row stays first and fixed');
    assert.equal(bar.children.length, 2);
    assert.equal(bar.querySelectorAll('.browser-annotate-marks li').length, n);
    assert.equal(bar.lastElementChild!.className, 'browser-annotate-marks');
  }
  // the fold button belongs to the head; the list it controls is the marks list
  const fold = button('Hide marks')!;
  assert.equal(fold.parentElement, head);
  assert.equal(fold.getAttribute('aria-controls'), bar.querySelector('.browser-annotate-marks')!.id);
});

test('IAB-14: a new mark scrolls the capped list to its row; fewer marks leave the scroll alone', async () => {
  await mount();
  await marks(2);
  const list = f.pane.querySelector('.browser-annotate-marks') as HTMLElement;
  Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 240 });
  list.scrollTop = 0;
  await marks(6);
  assert.equal(list.scrollTop, 240);
  list.scrollTop = 30;
  await marks(5);
  assert.equal(list.scrollTop, 30);
});

test('IAB-14: the chevron folds the marks list away and back; a mark number clicked in the page opens it on that note', async () => {
  await mount();
  assert.equal(button('Hide marks'), undefined, 'no list, no chevron');
  await marks(3);
  await type(note(2), 'keep me');
  const fold = button('Hide marks')!;
  assert.equal(fold.getAttribute('aria-expanded'), 'true');
  await click('Hide marks');
  assert.equal(f.pane.querySelector('.browser-annotate-marks'), null);
  assert.equal(f.pane.querySelector('.browser-annotate-bar')!.getAttribute('data-collapsed'), 'true');
  assert.equal(fold.getAttribute('aria-expanded'), 'false');
  assert.equal(fold.getAttribute('aria-label'), 'Show marks');
  // the hint and actions stay; a new mark keeps the list folded
  assert.match(text()!, /^3 marks\./);
  assert.ok(button('Add to chat'));
  await marks(4);
  assert.equal(f.pane.querySelector('.browser-annotate-marks'), null);
  assert.match(text()!, /^4 marks\./);
  // Show marks opens it again with the notes as they were, focusing nothing
  const before = document.activeElement;
  await click('Show marks');
  assert.equal(f.pane.querySelectorAll('.browser-annotate-marks li').length, 4);
  assert.equal(note(2).value, 'keep me');
  assert.equal(document.activeElement, before);
  // folded, a click on a mark's number in the page opens the list and focuses that note
  await click('Hide marks');
  await signal(`${nonce()}{"type":"select","id":3}`);
  assert.equal(document.activeElement, note(3));
  assert.equal(button('Hide marks')!.getAttribute('aria-expanded'), 'true');
  assert.equal(f.pane.querySelector('li[data-selected="true"] input'), note(3));
  // a mark this list doesn't have opens it but focuses nothing, then is forgotten
  await click('Hide marks');
  const chevron = button('Show marks')!;
  await act(async () => chevron.focus());
  await signal(`${nonce()}{"type":"select","id":9}`);
  assert.ok(f.pane.querySelector('.browser-annotate-marks'));
  assert.equal(document.activeElement, chevron);
  await click('Hide marks');
  await click('Show marks');
  assert.equal(document.activeElement, chevron);
  // Escape still leaves from the chevron (notes: asks first)
  await escape(chevron);
  assert.match(text()!, /^Discard 4 marks\?/);
  await click('Keep editing');
  // folded with every mark gone: the next marks show again
  await click('Hide marks');
  await marks(0);
  assert.equal(button('Show marks'), undefined);
  await marks(1);
  assert.ok(f.pane.querySelector('.browser-annotate-marks'));
  assert.equal(button('Hide marks')!.getAttribute('aria-expanded'), 'true');
});

test('IAB-14 styles: the bar floats over the page stage with a shadow, takes pointer events only in its box, and caps the list at about 4 rows', () => {
  const css = postcss.parse(appCss());
  const decls = (selector: string) => {
    const out: Record<string, string> = {};
    css.walkRules((rule) => {
      if (rule.selectors.includes(selector))
        rule.walkDecls((d) => {
          out[d.prop] = d.value;
        });
    });
    return out;
  };
  const stage = decls('.browser-stage');
  assert.equal(stage.position, 'relative');
  assert.equal(stage.flex, '1');
  assert.equal(stage['min-height'], '0');
  const bar = decls('.browser-annotate-bar');
  assert.equal(bar.position, 'absolute');
  assert.deepEqual([bar.top, bar.left, bar.right], ['8px', '8px', '8px']);
  assert.ok(Number(bar['z-index']) > 0);
  assert.match(bar['box-shadow'], /rgba/);
  assert.equal(bar['pointer-events'], 'auto');
  assert.equal(bar.bottom, undefined, 'the box ends where its content does');
  assert.equal(bar['border-bottom'], undefined);
  assert.equal(bar.flex, undefined, 'no longer a row in the pane layout');
  assert.equal(decls('.browser-annotate-head').flex, 'none');
  const list = decls('.browser-annotate-marks');
  assert.equal(list['overflow-y'], 'auto');
  // four ~22px rows and three 4px gaps
  assert.equal(list['max-height'], '100px');
  assert.equal(list.gap, '4px');
  const view = decls('.browser-view');
  assert.deepEqual([view.flex, view['min-height'], view.position], ['1', '0', undefined]);
});
