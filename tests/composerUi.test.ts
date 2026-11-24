// The composer box (src/components/composer/Composer.tsx): drafts, events from other parts of the app, the
// @ and / popups, attachments, the running/voice buttons and Escape (history: composerHistory.test.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire, mouse } from './support/composer-kit.ts';
import { all, dragEvent, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import { act } from 'react';
import { defined } from './support/defined.ts';

beforeEach(() => reset());
const W = window as any;
(globalThis as any).FileReader = W.FileReader;
const emit = (name: string, detail?: any) => fire(window, new W.CustomEvent(name, { detail }));

test('a chat restores its draft, saves edits shortly after, and saves what is pending on leaving', async () => {
  store.set({
    drafts: { t1: { text: 'saved draft', attachments: [{ kind: 'file', path: '/a.txt', name: 'a.txt' }] }, t2: { text: 'other' } },
  });
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal(m.text, 'saved draft');
    assert.equal($('.attachment-name').textContent, 'a.txt');
    assert.ok(document.activeElement === m.editor(), 'the editor takes focus');
    await m.type('edited');
    await settle(210);
    assert.deepEqual(last('draft'), [
      'draft',
      't1',
      { text: 'edited', attachments: [{ kind: 'file', path: '/a.txt', name: 'a.txt' }], goal: false },
    ]);
    await m.type('pending');
    await m.rerender({ threadId: 't2' });
    assert.deepEqual(
      all('draft')
        .filter((d) => d[1] === 't1')
        .at(-1),
      ['draft', 't1', { text: 'pending', attachments: [{ kind: 'file', path: '/a.txt', name: 'a.txt' }], goal: false }],
    );
    assert.equal(m.text, 'other');
    await m.rerender({ threadId: 't3' });
    assert.equal(m.text, '');
  } finally {
    await m.unmount();
  }
});

test('switching drafts leaves the keyboard with a field the user is typing in', async () => {
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.ok(document.activeElement === input);
  } finally {
    await m.unmount();
    input.remove();
  }
  // unmounted before the frame: nothing to focus
  const m2 = await mountComposer({ threadId: 't1' });
  await m2.rerender({ threadId: 't9' });
  await m2.unmount();
  await settle(5);
});

test('focus, insert and add-selection events reach the right composer', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    (document.activeElement as any)?.blur?.();
    await emit('focus-composer');
    assert.ok(document.activeElement === m.editor());
    await emit('composer-insert', 'first');
    assert.equal(m.text, 'first');
    await emit('composer-insert', { text: 'second', threadId: 't1' });
    assert.equal(m.text, 'first\nsecond');
    await emit('composer-insert', { text: 'nope', threadId: 't2' });
    await m.type('ends\n');
    await emit('composer-insert', { text: 'x', threadId: 't1' });
    assert.equal(m.text, 'ends\nx');
    // files given back with the text (a cancelled held message) are attached too
    await emit('composer-insert', { text: 'y', threadId: 't1', attachments: [{ kind: 'file', path: '/b.txt', name: 'b.txt' }] });
    assert.deepEqual(
      [...document.querySelectorAll('.attachment-name')].map((e) => e.textContent),
      ['b.txt'],
    );
    await emit('composer-add-selection', { text: 'picked', threadId: 't2' });
    await emit('composer-add-selection', { text: 'picked', threadId: 't1' });
    await emit('composer-add-selection', { text: 'again', threadId: 't1', comment: '  why?  ' });
    // a comment stays with its selection as an annotation; the draft text is left alone
    assert.equal(m.text, 'ends\nx\ny');
    assert.equal($('.selection-chip-label').textContent, '2 annotations');
    await m.type('');
    await emit('composer-add-selection', { text: 'third', threadId: 't1', comment: 'note' });
    assert.equal(m.text, '');
    await m.type('line\n');
    await emit('composer-add-selection', { text: 'fourth', threadId: 't1', comment: 'more' });
    assert.equal(m.text, 'line\n');
    await emit('composer-add-selection', { text: 'fifth', threadId: 't1', comment: '   ' });
    await click($('.selection-chip-remove'));
    assert.ok(!$('.selection-chip'));
  } finally {
    await m.unmount();
  }
});

test('a side-chat composer ignores app-wide focus and string inserts', async () => {
  const m = await mountComposer({ threadId: 't1', inPane: true });
  try {
    (document.activeElement as any)?.blur?.();
    await emit('focus-composer');
    assert.ok(document.activeElement !== m.editor());
    await emit('composer-insert', 'not here');
    assert.equal(m.text, '');
  } finally {
    await m.unmount();
  }
});

test('@ opens the mention list; a file or a chat is inserted at the query', async () => {
  fx.files = [
    { path: '/home/src', file_name: 'src', match_type: 'directory', indices: null },
    { path: '/home/a.ts', file_name: 'a.ts', indices: null },
  ];
  store.set({ threads: { c2: { id: 'c2', title: 'Other chat', updatedAt: 5, cwd: '/home' } }, threadOrder: ['c2'] });
  const m = await mountComposer({ threadId: null });
  try {
    await m.type('see @a');
    await settle(130);
    // "a" also matches the other chat's title
    assert.deepEqual(
      $$('.composer-popup .mention-name').map((x) => x.textContent),
      ['Other chat', 'src', 'a.ts'],
    );
    await mouse($$('.composer-popup .menu-item')[2], 'mousedown');
    await settle(5);
    assert.equal(m.text, 'see @/home/a.ts ');
    await m.type('dir @s');
    await settle(130);
    await m.key('Enter');
    await settle(5);
    assert.equal(m.text, 'dir @/home/src/ ');
    // a chat
    const inserted: string[] = [];
    (document as any).execCommand = (_c: string, _u: boolean, html: string) => (inserted.push(html), true);
    await m.type('ask @');
    await settle(130);
    assert.equal($$('.composer-popup .mention-name')[0].textContent, 'Other chat');
    await mouse($$('.composer-popup .menu-item')[0], 'mousedown');
    assert.match(inserted[0], /data-session-token/);
    // Escape closes the list (the popover layer takes the key)
    await m.type('@');
    await settle(130);
    await m.key('Escape');
    assert.ok(!$('.composer-popup'));
    // an outside press closes it too
    await m.type('x @');
    await settle(130);
    await mouse(document.body, 'mousedown');
    assert.ok(!$('.composer-popup'));
  } finally {
    await m.unmount();
  }
});

test('/ opens the command menu; arrows, Tab and Enter drive it; picking clears the box', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/sk');
    assert.deepEqual(
      $$('.slash-panel .add-panel-title').map((x) => x.textContent),
      ['Sketch'],
    );
    await m.key('ArrowDown');
    await m.key('ArrowUp');
    let sketched = 0;
    const onSketch = () => sketched++;
    window.addEventListener('open-sketch', onSketch);
    await m.key('Tab');
    window.removeEventListener('open-sketch', onSketch);
    assert.equal(sketched, 1);
    assert.equal(m.text, '');
    // Enter with Shift is a newline, not a pick
    await m.type('/st');
    assert.equal(await m.key('Enter', { shiftKey: true }), false);
    // a query matching nothing shows no menu; Escape drops the menu state and Enter then sends
    await m.type('/zzz');
    assert.ok(!$('.slash-panel'));
    assert.equal(await m.key('Escape'), true);
    await m.key('Enter');
    await settle();
    assert.equal(defined(last('send'))[2], '/zzz');
    // an outside press closes the menu
    await m.type('/');
    await mouse(document.body, 'mousedown');
    assert.ok(!$('.slash-panel'));
  } finally {
    await m.unmount();
  }
});

test('a harness command typed in full is sent by Enter instead of picked; the hidden-commands footer opens settings', async () => {
  fx.nativeCmds = [{ name: 'usage' }];
  fx.provider = { label: 'Claude Code' };
  fx.registry = (p: any, caps: any) => ({
    menu: [{ name: 'usage', dispatch: 'passthrough', source: 'harness' }],
    hidden: caps ? ['x'] : [],
  });
  fx.resolve = (v: string) =>
    v.trim() === '/usage'
      ? { kind: 'passthrough', command: { name: 'usage' } }
      : v.trim() === '/goal'
        ? { kind: 'passthrough', command: { name: 'goal' } }
        : { kind: 'none' };
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/usage');
    assert.ok($('.slash-panel'));
    await m.key('Enter');
    await settle();
    assert.equal(defined(last('send'))[2], '/usage');
    // /goal keeps Sage's menu entry even typed in full
    await m.type('/goal');
    await m.key('Enter');
    // Goal turns on goal mode (a chip) instead of typing /goal
    assert.equal(m.text, '');
    assert.ok($('.goal-chip'), 'goal mode is on');
    await click($('.goal-chip'));
    assert.ok(!$('.goal-chip'), 'cleared');
    await m.type('/us');
    await mouse($('.add-panel-footer'), 'mousedown');
    assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'harnesses' }]);
    assert.ok(!$('.slash-panel'));
    await m.type('/usage x');
    assert.ok(!$('.slash-panel'));
  } finally {
    await m.unmount();
  }
});

test('running: Stop interrupts, Escape interrupts, and a second Escape offers to stop background tasks', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  setSessionState('t1', {
    tasks: [
      { id: 'bg', ambient: false, status: 'running' },
      { id: 'amb', ambient: true, status: 'running' },
      { id: 'done', ambient: false, status: 'completed' },
    ],
  });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('[aria-label="Stop"]'));
    assert.deepEqual(last('interrupt'), ['interrupt', 't1']);
    assert.equal(await m.key('Escape'), true);
    assert.equal(all('interrupt').length, 2);
    assert.equal(await m.key('Escape'), true);
    assert.equal($('.stub-strip').dataset.confirm, 'true');
    assert.equal(await m.key('Escape'), true);
    assert.equal($('.stub-strip').dataset.confirm, 'false');
    await m.key('Escape');
    await m.key('Escape');
    assert.equal(await m.key('Enter'), true);
    assert.deepEqual(last('stopAllTasks'), ['stopAllTasks', 't1']);
    // with text typed, the send button queues or steers
    await m.type('more');
    await mouse($('[aria-label="Send"]').parentElement!, 'mouseover');
    await settle(460);
    assert.equal($('.tooltip').textContent, 'Queue message⌘⏎');
    await mouse($('[aria-label="Send"]').parentElement!, 'mouseout');
    store.set((s: any) => ({ prefs: { ...s.prefs, followUp: 'steer' } }));
    await m.rerender();
    await mouse($('[aria-label="Send"]').parentElement!, 'mouseover');
    await settle(460);
    assert.equal($('.tooltip').textContent, 'Steer⏎');
  } finally {
    await m.unmount();
  }
});

test('the round button plays its morph for each change it makes, and none when it first shows', async () => {
  const m = await mountComposer({ threadId: 't1' });
  const morph = () => $('.send-btn').dataset.morph;
  try {
    assert.equal($('.send-btn').getAttribute('aria-label'), 'Voice conversation');
    assert.equal(morph(), undefined);
    await m.type('hi');
    assert.equal(morph(), 'voice-to-send');
    await m.rerender();
    assert.equal(morph(), 'voice-to-send', 'a re-render keeps the transition it is playing');
    store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
    await m.rerender();
    // sent while running: the box empties and the button becomes Stop
    await m.key('Enter');
    await settle();
    assert.equal($('.send-btn').getAttribute('aria-label'), 'Stop');
    assert.equal(morph(), 'to-stop');
    await m.type('x');
    assert.equal(morph(), 'stop-to-send');
    store.set({ runtime: {} });
    await m.rerender();
    await m.key('Enter');
    await settle();
    assert.equal($('.send-btn').getAttribute('aria-label'), 'Voice conversation');
    assert.equal(morph(), 'to-voice');
    // the transition ends with its longest animation (the wobble, not the glyph's fade), so a glyph swapped
    // later without a change of state (voice on and off) does not replay it
    const ended = (name: string) => {
      const e = new (window as any).Event('animationend', { bubbles: true });
      Object.defineProperty(e, 'animationName', { value: name });
      return fire($('.send-btn > svg'), e);
    };
    await ended('send-glyph-in');
    assert.equal(morph(), 'to-voice');
    await ended('send-wobble-to-voice');
    assert.equal(morph(), undefined);
  } finally {
    await m.unmount();
  }
});

test('idle with background tasks: the first Escape keeps the focus so a second one offers Stop all', async () => {
  setSessionState('t1', { tasks: [{ id: 'bg', ambient: false, status: 'running' }] });
  const m = await mountComposer({ threadId: 't1' });
  try {
    m.editor().focus();
    assert.equal(await m.key('Escape'), true);
    assert.equal(document.activeElement, m.editor());
    assert.equal(all('interrupt').length, 0);
    assert.equal(await m.key('Escape'), true);
    assert.equal($('.stub-strip').dataset.confirm, 'true');
  } finally {
    await m.unmount();
  }
});

test('idle without background tasks, Escape still blurs the editor', async () => {
  setSessionState('t1', { tasks: [{ id: 'amb', ambient: true }] });
  const m = await mountComposer({ threadId: 't1' });
  try {
    m.editor().focus();
    assert.equal(await m.key('Escape'), true);
    assert.notEqual(document.activeElement, m.editor());
  } finally {
    await m.unmount();
  }
});

test('a new chat has no turn to stop: Escape and the confirm do nothing to tasks', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await m.key('Escape');
    await m.key('Escape');
    assert.equal(all('interrupt').length, 0);
    assert.ok(!$('.stub-strip'));
  } finally {
    await m.unmount();
  }
});

test('the Stop tooltip mentions background tasks only when there are some', async () => {
  store.set({ runtime: { t1: { activeTurnId: 'turn' } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await mouse($('[aria-label="Stop"]').parentElement!, 'mouseover');
    await settle(460);
    assert.equal($('.tooltip').textContent, 'StopEsc');
  } finally {
    await m.unmount();
  }
  setSessionState('t1', { tasks: [{ id: 'bg', status: 'running' }] });
  const m2 = await mountComposer({ threadId: 't1' });
  try {
    await mouse($('[aria-label="Stop"]').parentElement!, 'mouseover');
    await settle(460);
    assert.match($('.tooltip').textContent!, /^Stop this turn and pause the goal/);
  } finally {
    await m2.unmount();
  }
});

test('attachments: images show a preview, files a name; each can be removed', async () => {
  store.set({
    drafts: {
      home: {
        text: '',
        attachments: [
          { kind: 'image', path: '/p.png', name: 'p.png', previewUrl: 'data:x' },
          { kind: 'image', path: '/q.png', name: 'q.png' },
          { kind: 'file', path: '/r.txt', name: 'r.txt' },
          { kind: 'skill', path: '/s', name: 's' },
          { kind: 'selection', path: '', name: 'Selection' },
        ],
      },
    },
  });
  const m = await mountComposer({ threadId: null });
  try {
    assert.equal($('.attachment img').getAttribute('alt'), 'p.png');
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['q.png', 'r.txt'],
    );
    await click($$('.attachment-remove')[1]);
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['r.txt'],
    );
    await click($$('.attachment-remove')[1]);
    await click($$('.attachment-remove')[0]);
    assert.equal($('.selection-chip-label').textContent, '1 selection');
    await click($('.selection-chip-remove'));
    assert.ok(!$('.attachments'), 'a skill alone shows no tray');
  } finally {
    await m.unmount();
  }
});

test('annotations in the tray can be commented on or deleted one at a time', async () => {
  store.set({
    drafts: {
      home: {
        text: '',
        attachments: [
          { kind: 'selection', path: '', name: 'Selection', text: 'first passage' },
          { kind: 'selection', path: '', name: 'Selection', text: 'second passage', annotation: 'old', annotationId: 'keep' },
        ],
      },
    },
  });
  const m = await mountComposer({ threadId: null });
  try {
    await click($('.selection-chip-trigger'));
    await click($('[aria-label="Edit annotation 1"]'));
    const field = $('[aria-label="Annotation comment"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(W.HTMLInputElement.prototype, 'value')!.set!.call(field, '  explain this  ');
      field.dispatchEvent(new W.Event('input', { bubbles: true }));
    });
    await fire(field.form!, new W.Event('submit', { bubbles: true, cancelable: true }));
    assert.ok(document.activeElement === m.editor(), 'the editor takes focus, so a second Enter sends');
    assert.equal($('.selection-chip-label').textContent, '2 annotations');
    assert.deepEqual(
      $$('.selection-pop-item .selection-pop-text').map((x) => x.textContent),
      ['first passage', 'explain this', 'second passage', 'old'],
    );
    await click($('[aria-label="Delete annotation 2"]'));
    assert.equal($('.selection-chip-label').textContent, '1 annotation');
    assert.deepEqual(
      $$('.selection-pop-item .selection-pop-text').map((x) => x.textContent),
      ['first passage', 'explain this'],
    );
    await settle(210);
    const saved = all('draft').at(-1)![2];
    assert.deepEqual(
      saved.attachments.map((a: any) => [a.text, a.annotation]),
      [['first passage', 'explain this']],
    );
    assert.ok(saved.attachments[0].annotationId, 'a commented selection gets a stable id');
  } finally {
    await m.unmount();
  }
});

test('a chat reference in the draft opens that chat, and in a chat can be sent a message', async () => {
  const token = sessionToken('other-chat', 'Other chat');
  store.set({ drafts: { t1: { text: `Ask ${token}`, attachments: [] }, home: { text: `Ask ${token}`, attachments: [] } } });
  const composing: any[] = [];
  const onCompose = (e: any) => composing.push(e.detail);
  window.addEventListener('mopilot:peer-compose', onCompose);
  const m = await mountComposer({ threadId: 't1' });
  try {
    const chip = () => m.editor().querySelector('[data-session-token]') as HTMLElement;
    await mouse(chip(), 'click');
    assert.deepEqual(last('navigate'), ['navigate', { name: 'thread', id: 'other-chat' }]);
    await mouse(chip(), 'contextmenu', { clientX: 4, clientY: 4 });
    await click([...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent === 'Send message'));
    assert.deepEqual(composing, [{ sourceChatId: 't1', targetChatId: 'other-chat' }]);
  } finally {
    await m.unmount();
    window.removeEventListener('mopilot:peer-compose', onCompose);
  }
  // a new chat has no chat to send from: no menu
  const home = await mountComposer({ threadId: null });
  try {
    await mouse(home.editor().querySelector('[data-session-token]')!, 'contextmenu', { clientX: 4, clientY: 4 });
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally {
    await home.unmount();
  }
});

test('paste: files by path, pasted images saved to a temp file, other types as files, failures said', async () => {
  const m = await mountComposer({ threadId: null });
  const paste = async (files: any[]) => {
    const dt = new W.DataTransfer();
    for (const f of files) dt.items.add(f);
    const ev = new W.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    await fire(m.editor(), ev);
    await settle(5);
    return ev.defaultPrevented;
  };
  try {
    fx.paths = { 'doc.txt': '/docs/doc.txt', 'pic.png': '/pics/nopreview.png' };
    assert.equal(
      await paste([new W.File(['x'], 'doc.txt', { type: 'text/plain' }), new W.File(['x'], 'pic.png', { type: 'image/png' })]),
      true,
    );
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['doc.txt', 'nopreview.png'],
    );
    fx.saved = '/tmp/pasted.png';
    await paste([new W.File(['img'], 'clip', { type: 'image/png' })]);
    assert.equal($$('.attachment img').at(-1)!.getAttribute('alt'), 'Pasted image');
    fx.saved = '/tmp/pasted.svg';
    await paste([new W.File(['<svg/>'], 'clip2', { type: 'image/svg+xml' })]);
    assert.equal($$('.attachment-name').at(-1)!.textContent, 'pasted.svg');
    fx.saved = null;
    await paste([new W.File(['img'], 'clip3', { type: 'image/png' })]);
    assert.deepEqual(last('toast'), ['toast', "Couldn't attach the pasted image", 'error']);
    // a file with no path that isn't an image is skipped
    const before = $$('.attachment').length;
    await paste([new W.File(['?'], 'blob.bin', { type: 'application/octet-stream' })]);
    assert.equal($$('.attachment').length, before);
    // text paste is left to the editor
    (document as any).execCommand = () => true;
    const dt = new W.DataTransfer();
    dt.setData('text/plain', 'words');
    const ev = new W.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    await fire(m.editor(), ev);
    assert.equal(ev.defaultPrevented, true);
  } finally {
    await m.unmount();
  }
});

test('drag and drop attaches dropped files; a press on the box focuses the editor', async () => {
  fx.paths = { 'a.jpg': '/d/a.jpg', none: '' };
  const m = await mountComposer({ threadId: null });
  try {
    const box = $('.composer');
    const dt = new W.DataTransfer();
    dt.items.add(new W.File(['x'], 'a.jpg', { type: 'image/jpeg' }));
    dt.items.add(new W.File(['x'], 'none', { type: 'text/plain' }));
    await fire(box, dragEvent('dragover', dt));
    assert.match(box.className, /drag-over/);
    await fire(box, new W.DragEvent('dragleave', { bubbles: true }));
    assert.doesNotMatch(box.className, /drag-over/);
    await fire(box, dragEvent('dragover', dt));
    await fire(box, dragEvent('drop', dt));
    await settle(5);
    assert.doesNotMatch(box.className, /drag-over/);
    assert.equal($('.attachment img').getAttribute('src'), 'data:/d/a.jpg');
    (document.activeElement as any)?.blur?.();
    const ev = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await fire($('.composer-footer'), ev);
    assert.equal(ev.defaultPrevented, true);
    assert.ok(document.activeElement === m.editor());
    const onButton = new W.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await fire($('.stub-dictate'), onButton);
    assert.equal(onButton.defaultPrevented, false);
  } finally {
    await m.unmount();
  }
});

test("a dropped image whose preview can't be read is attached all the same", async () => {
  fx.paths = { 'a.png': '/d/a.png' };
  fx.readImageDataUrl = async () => {
    throw new Error('unreadable');
  };
  const m = await mountComposer({ threadId: null });
  try {
    const dt = new W.DataTransfer();
    dt.items.add(new W.File(['x'], 'a.png', { type: 'image/png' }));
    await fire($('.composer'), dragEvent('drop', dt));
    await settle(5);
    assert.equal($$('.attachment').length, 1);
    assert.equal($('.attachment img'), null);
  } finally {
    await m.unmount();
  }
});

test('dictated text is appended', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await click($('.stub-dictate'));
    assert.equal(m.text, 'spoken words');
    await click($('.stub-dictate'));
    assert.equal(m.text, 'spoken words spoken words');
  } finally {
    await m.unmount();
  }
});

test('Try now from the Skills and plugin pages attaches to a new Codex chat only', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await emit('insert-skill', { name: 'ship', path: '/s/SKILL.md', displayName: 'Ship' });
    assert.match(m.editor().textContent, /Ship/);
    await emit('insert-mention', { name: 'gh', path: 'plugin://gh' });
    await emit('insert-mention', { name: 'gh', path: 'plugin://gh' });
    assert.deepEqual(
      $$('.attachment-name').map((x) => x.textContent),
      ['gh'],
    );
  } finally {
    await m.unmount();
  }
  store.set({ newHarness: 'claude' });
  const m2 = await mountComposer({ threadId: null });
  try {
    await emit('insert-skill', { name: 'ship', path: '/s', displayName: 'Ship' });
    await emit('insert-mention', { name: 'gh', path: 'plugin://gh' });
    assert.deepEqual(
      all('toast').map((e) => e[1]),
      ['That is a Codex plugin or skill. Start a Codex chat to use it.', 'That is a Codex plugin or skill. Start a Codex chat to use it.'],
    );
  } finally {
    await m2.unmount();
  }
  // in a chat the events are not for this composer
  const m3 = await mountComposer({ threadId: 't1' });
  try {
    await emit('insert-mention', { name: 'gh', path: 'plugin://gh' });
    assert.ok(!$('.attachments'));
  } finally {
    await m3.unmount();
  }
});

test('plan mode: the chip turns it off; a blocked harness refuses to turn it on', async () => {
  setSessionState('t1', { plan: true });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('.plan-chip'));
    assert.deepEqual(last('session'), ['session', 't1', { plan: false }]);
    assert.ok(!$('.plan-chip'));
    fx.blocked.plan = 'No plan mode here';
    await m.type('/plan');
    await m.key('Enter');
    assert.deepEqual(last('toast'), ['toast', 'No plan mode here', 'error']);
  } finally {
    await m.unmount();
  }
  // a new chat keeps plan mode in the draft and sends it along
  const m2 = await mountComposer({ threadId: null });
  try {
    fx.blocked = {};
    await m2.type('/plan');
    await m2.key('Enter');
    assert.ok($('.plan-chip'));
    await m2.type('go');
    await m2.key('Enter');
    await settle();
    assert.deepEqual(defined(last('send'))[4], { plan: true, human: true });
  } finally {
    await m2.unmount();
  }
});

test('"Edit message" on a queued follow-up puts its text and attachments back ahead of the draft', async () => {
  const queued = {
    id: 'q1',
    text: 'queued text',
    attachments: [{ kind: 'file', path: '/q.txt', name: 'q.txt' }],
    opts: {},
    origin: null,
    queuedAt: 0,
  };
  fx.queuedEdit = queued;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('.stub-queued'));
    await settle(5);
    assert.equal(m.text, 'queued text');
    assert.deepEqual(
      $$('.attachment-name').map((e) => e.textContent),
      ['q.txt'],
    );
    assert.ok(document.activeElement === m.editor(), 'the editor takes focus');
    await m.type('mine');
    await click($('.stub-queued'));
    assert.equal(m.text, 'queued text\nmine');
    assert.deepEqual(
      $$('.attachment-name').map((e) => e.textContent),
      ['q.txt', 'q.txt'],
    );
  } finally {
    await m.unmount();
  }
});

test('switching composer drafts stops dictation while ordinary rerenders preserve it', async () => {
  let stops = 0;
  fx.dictationStopped = () => stops++;
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('first chat draft');
    await m.rerender({ threadId: 't1' });
    assert.equal(stops, 0);
    await m.rerender({ threadId: 't2' });
    assert.equal(stops, 1);
    assert.equal(m.text, '');
    await click($('.stub-dictate'));
    assert.equal(m.text, 'spoken words');
    await m.rerender({ threadId: null });
    assert.equal(stops, 2);
    assert.equal(m.text, '');
    await m.rerender({ threadId: 't1' });
    assert.equal(stops, 3);
    assert.equal(m.text, 'first chat draft');
  } finally {
    await m.unmount();
  }
});

test('delayed image attachments stay with their original draft after switching or closing', async () => {
  for (const route of ['drop', 'paste'])
    for (const change of ['switch', 'close', 'missing-draft']) {
      reset();
      store.set({ drafts: { t1: { text: 'original', attachments: [], goal: true }, t2: { text: 'second draft', attachments: [] } } });
      let release!: (value: string) => void;
      const pending = new Promise<string>((resolve) => {
        release = resolve;
      });
      fx.readImageDataUrl = () => pending;
      fx.saveTempImage = () => pending;
      fx.paths = route === 'drop' ? { 'late.png': '/late.png' } : {};
      const m = await mountComposer({ threadId: 't1' });
      let closed = false;
      try {
        const dt = new W.DataTransfer();
        dt.items.add(new W.File(['image'], 'late.png', { type: 'image/png' }));
        if (route === 'drop') await fire($('.composer'), dragEvent('drop', dt));
        else {
          await fire(m.editor(), new W.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          await settle(5);
        }
        if (change === 'switch') {
          await m.rerender({ threadId: 't2' });
          await m.type('new text');
          await act(async () => {
            store.set((s: any) => ({
              drafts: {
                ...s.drafts,
                t1: { text: 'revised original', goal: false, attachments: [{ kind: 'file', path: '/existing.txt', name: 'existing.txt' }] },
              },
            }));
          });
        } else {
          await m.unmount();
          closed = true;
          if (change === 'missing-draft') store.set({ drafts: {} });
        }
        await act(async () => release(route === 'drop' ? 'data:preview' : '/pasted.png'));
        await settle();
        if (change === 'switch') {
          assert.equal(m.text, 'new text');
          assert.equal($$('.attachment').length, 0);
        }
        const saved = store.get().drafts.t1;
        assert.equal(saved.text, change === 'missing-draft' ? '' : change === 'switch' ? 'revised original' : 'original');
        if (change !== 'missing-draft') assert.equal(saved.goal, change !== 'switch');
        assert.equal(saved.attachments.length, change === 'switch' ? 2 : 1);
        if (change === 'switch') assert.equal(saved.attachments[0].path, '/existing.txt');
        assert.equal(saved.attachments.at(-1).path, route === 'drop' ? '/late.png' : '/pasted.png');
      } finally {
        release('unused');
        if (!closed) await m.unmount();
      }
    }
});

test('after a turn that used desktop control, the placeholder suggests the next step and Tab takes it into the input', async () => {
  const newDoc = {
    id: 'i1',
    type: 'mcpToolCall',
    tool: 'desktop_app_menu',
    arguments: { app: 'TextEdit', path: ['File', 'New'] },
    status: 'completed',
  };
  store.set({ runtime: { t1: { activeTurnId: 'turn', turns: [{ id: 'turn', items: [newDoc] }] } } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    // still running: no suggestion
    assert.equal(m.editor().dataset.placeholder, '⏎ to send, ⌘⏎ to queue for later');
    await act(async () => store.set({ runtime: { t1: { activeTurnId: null, turns: [{ id: 'turn', items: [newDoc] }] } } }));
    assert.equal(m.editor().dataset.placeholder, 'Close the new TextEdit document without saving');
    assert.equal(m.text, '', 'the placeholder only: nothing in the input');
    // Shift+Tab is not it
    assert.equal(await m.key('Tab', { shiftKey: true }), false);
    assert.equal(m.text, '');
    assert.equal(await m.key('Tab'), true);
    assert.equal(m.text, 'Close the new TextEdit document without saving');
    // typed text: Tab is the editor's again
    assert.equal(await m.key('Tab'), false);
  } finally {
    await m.unmount();
  }
});
