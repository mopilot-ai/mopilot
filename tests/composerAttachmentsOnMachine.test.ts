// Machine attachment admission prevents file reads and stale async delivery while preserving local attachment behavior.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire } from './support/composer-kit.ts';
import { fx, last, mountComposer, reset, settle, dragEvent, store } from './support/composer-setup.ts';
beforeEach(() => reset());
const row = (title: string) => $$('.add-panel-item').find((x) => x.querySelector('.add-panel-title')?.textContent === title)!;
const away = () =>
  (fx.attachmentTarget = {
    why: 'Only images can be attached to a chat on box. Other files and local skills are unavailable.',
    read: () => ({ key: 'box', blocked: true }),
  });
test('machine add menu explains unavailable files, history, skill recording and sketch; no file dialog opens', async () => {
  away();
  let dialogs = 0;
  fx.openFiles = async () => {
    dialogs++;
    return [];
  };
  let catalogs = 0;
  fx.plugins = async () => {
    catalogs++;
    return { marketplaces: [] };
  };
  const m = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    for (const title of ['Computer History', 'Record a skill']) {
      assert.equal(row(title).getAttribute('aria-disabled'), 'true');
      assert.match(row(title).textContent!, /Only images.*box/g);
      await click(row(title));
    }
    assert.equal(row('Files and folders').getAttribute('aria-disabled'), 'false');
    assert.equal(
      $$('.add-panel-item').some((x) => x.querySelector('.add-panel-title')?.textContent === 'Images'),
      false,
    );
    assert.equal(row('Sketch').getAttribute('aria-disabled'), 'false');
    assert.equal(dialogs, 0);
    assert.equal(catalogs, 0);
  } finally {
    await m.unmount();
  }
});
test('files dropped or pasted on a machine attach as chips without reading a preview; Skills Try now cannot attach', async () => {
  away();
  fx.paths['one.txt'] = '/one.txt';
  const m = await mountComposer({ threadId: null });
  try {
    await fire(window, new CustomEvent('insert-skill', { detail: { name: 'local', path: '/local/SKILL.md' } }));
    await fire(window, new CustomEvent('insert-mention', { detail: { name: 'plugin', path: 'plugin://local' } }));

    const W = window as any;
    const data = new W.DataTransfer();
    data.items.add(new W.File(['x'], 'one.txt', { type: 'text/plain' }));

    fx.readImageDataUrl = () => assert.fail('must not read a local preview');
    await fire($('.composer'), dragEvent('drop', data));
    await fire(m.editor(), new W.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    await settle();
    assert.equal($$('.attachment').length, 2, 'a dropped and a pasted file are chips like on This Mac');
    assert.match(last('toast')?.[1] ?? '', /Only images.*box/g);
  } finally {
    await m.unmount();
  }
});
test('an image preview started locally cannot attach after the destination changes to a machine', async () => {
  let current = { key: 'local', blocked: false };
  fx.attachmentTarget = { why: null, read: () => current };
  let resolve!: (v: string) => void;
  fx.readImageDataUrl = () => new Promise<string>((r) => (resolve = r));
  const m = await mountComposer({ threadId: null });
  try {
    await click($('[aria-label="Add files and more"]'));
    fx.openFiles = async () => ['/one.png'];
    await click(row('Files and folders'));
    current = { key: 'box', blocked: true };
    away();
    await m.rerender();
    resolve('data:image/png;base64,x');
    await settle();
    assert.equal($$('.attachment').length, 0);
    assert.match(last('toast')?.[1] ?? '', /Only images|destination changed/);
  } finally {
    await m.unmount();
  }
});

test('a machine skills menu reports why and a local skill command cannot be sent as unsupported text', async () => {
  away();
  fx.skills = async () => assert.fail('machine composer must not read this Mac skill list');
  fx.provider = { label: 'Claude Code' };
  fx.nativeCmds = [{ name: 'local-skill' }];
  fx.registry = () => ({ menu: [{ name: 'local-skill', source: 'skill', dispatch: 'passthrough' }], hidden: [] });
  fx.resolve = () => ({ kind: 'passthrough', command: { name: 'local-skill', source: 'skill', dispatch: 'passthrough' } });
  const m = await mountComposer({ threadId: null });
  try {
    await m.type('/local-skill');
    const skill = row('/local-skill');
    assert.equal(skill.getAttribute('aria-disabled'), 'true');
    await m.key('Escape');
    await m.key('Enter');
    await settle();
    assert.equal(last('send'), undefined);
    assert.match(last('toast')?.[1] ?? '', /Only images/);
    assert.equal(m.text, '/local-skill');
  } finally {
    await m.unmount();
  }
});

test('a machine ACP skills-only menu explains unavailability without local skill entries', async () => {
  away();
  store.set({ basicOf: { c: 'kimi' } });
  const m = await mountComposer({ threadId: 'c' });
  try {
    await m.type('$');
    assert.match(row('Skills').textContent!, /Only images.*box/g);
    assert.equal(row('Skills').getAttribute('aria-disabled'), 'true');
  } finally {
    await m.unmount();
  }
});
