// File-dialog, preview and clipboard completions must recheck their original target before attaching or touching the next file.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
let target: any,
  why: any,
  attachments: any[],
  notices: any[],
  drafts: any,
  fs: any,
  files: any,
  api: any,
  onAttach: (() => void) | undefined;
const current = { current: 'home' },
  input = { current: {} as any };
const setAttachments = (value: any) => {
  attachments = typeof value === 'function' ? value(attachments) : value;
  onAttach?.();
};
mockSource('src/session/useAttachmentTarget.ts', { useAttachmentTarget: () => ({ why, read: () => target }) });
mockSource('src/store/core.ts', {
  get: () => ({ drafts }),
  setDraft: (k: string, d: any) => (drafts[k] = d),
  toast: (...a: any[]) => notices.push(a),
});
installNativeStub({
  fs: { readImageDataUrl: (p: string) => fs.image(p), pathForFile: (f: any) => f.path ?? '', saveTempImage: (s: any) => fs.save(s) },
  dialog: { openFiles: () => files() },
});
mockSource('src/lib/ignored.ts', { noteIgnored: () => undefined });
const { useComposerAttachments } = await import('../src/components/composer/useComposerAttachments.ts');
function Probe() {
  api = useComposerAttachments({ draftKey: 'home', currentDraftKey: current, taRef: input, setAttachments, attachments, threadId: null });
  return h('i');
}
beforeEach(() => {
  target = { key: 'local', blocked: false };
  why = null;
  attachments = [];
  notices = [];
  onAttach = undefined;
  drafts = {};
  current.current = 'home';
  input.current = {};
  fs = { image: async () => 'data:x', save: async () => '/saved.png' };
  files = async () => ['/file.txt'];
});
const paste = (list: any[]) => api.onPaste({ clipboardData: { files: list }, preventDefault() {} });
test('machine admission attaches files without reading them and refuses incoming skills', async () => {
  why = 'No skills on Box';
  target.blocked = true;
  fs.image = () => assert.fail('must not read');
  const m = await mount(h(Probe));
  try {
    await api.addFiles(['/a.txt']);
    await paste([{ path: '/a.txt', type: 'text/plain' }]);
    api.setIncoming([{ kind: 'skill' }]);
    assert.deepEqual(
      attachments.map((a) => [a.kind, a.name]),
      [
        ['file', 'a.txt'],
        ['file', 'a.txt'],
      ],
    );
    assert.deepEqual(
      notices.map((n) => n[0]),
      ['No skills on Box'],
    );
  } finally {
    await m.unmount();
  }
});
test('preview and dialog completions refuse changed targets, including a second file after a pending first preview', async () => {
  const m = await mount(h(Probe));
  try {
    let finish!: (v: string) => void;
    fs.image = () => new Promise((r) => (finish = r));
    const pending = api.addFiles(['/one.png', '/two.txt']);
    target = { key: 'other-local', blocked: false };
    finish('data:x');
    await pending;
    assert.equal(attachments.length, 0);
    assert.match(notices.at(-1)[0], /destination changed/);
    target = { key: 'local', blocked: false };
    let choose!: (v: string[]) => void;
    files = () => new Promise((r) => (choose = r));
    const dialog = api.pickFiles();
    target = { key: 'machine', blocked: true };
    choose(['/file.txt']);
    await dialog;
    assert.equal(attachments.length, 0);
    assert.match(notices.at(-1)[0], /destination changed/);
  } finally {
    await m.unmount();
  }
});
test('a final preview completion cannot append to a different local target; a retired local draft retains its own files', async () => {
  const m = await mount(h(Probe));
  try {
    let finish!: (v: string) => void;
    fs.image = () => new Promise((r) => (finish = r));
    const pending = api.addFiles(['/one.png']);
    target = { key: 'other-local', blocked: false };
    finish('data:x');
    await pending;
    assert.equal(attachments.length, 0);
    target = { key: 'local', blocked: false };
    current.current = 'other';
    input.current = null;
    await api.addFiles(['/one.txt']);
    assert.equal(drafts.home.attachments[0].name, 'one.txt');
    drafts.home.text = 'keep';
    await api.addFiles(['/two.txt']);
    assert.equal(drafts.home.text, 'keep');
    assert.equal(drafts.home.attachments.length, 2);
  } finally {
    await m.unmount();
  }
});
test('clipboard read errors and stale completions never save or append to another destination', async (t) => {
  const original = globalThis.FileReader;
  let reader: any;
  class Reader {
    result = 'data:x';
    onload: any;
    onerror: any;
    constructor() {
      reader = this;
    }
    readAsDataURL() {}
  }
  globalThis.FileReader = Reader as any;
  t.after(() => (globalThis.FileReader = original));
  const m = await mount(h(Probe));
  try {
    const failed = paste([{ type: 'image/png' }]);
    reader.onerror();
    await failed;
    assert.match(notices.at(-1)[0], /Couldn't read/);
    const stale = paste([{ type: 'image/png' }]);
    target = { key: 'remote', blocked: true };
    reader.onload();
    await stale;
    assert.equal(attachments.length, 0);
    target = { key: 'local', blocked: false };
    let save!: (v: string) => void;
    fs.save = () => new Promise((r) => (save = r));
    const pending = paste([{ type: 'image/png' }]);
    reader.onload();
    await Promise.resolve();
    target = { key: 'other-local', blocked: false };
    save('/saved.png');
    await pending;
    assert.equal(attachments.length, 0);
  } finally {
    await m.unmount();
  }
});

test('a machine keeps image file, clipboard and external image attachments working', async () => {
  target = { key: 'box', blocked: true };
  why = 'Only images can be attached on Box';
  const m = await mount(h(Probe));
  try {
    files = async () => ['/one.png'];
    await api.pickFiles();
    assert.equal(attachments[0].kind, 'image');
    await paste([{ type: 'image/png', path: '/two.png' }]);
    api.setIncoming((a: any[]) => [...a, { kind: 'image', path: '/three.png', name: 'third' }]);
    assert.equal(attachments.length, 3);
    assert.equal(
      attachments.every((a) => a.kind === 'image'),
      true,
    );
    assert.deepEqual(notices, []);
  } finally {
    await m.unmount();
  }
});

test('a two-path clipboard paste retires the whole batch when the first preview changes target', async () => {
  const m = await mount(h(Probe));
  try {
    let first!: (v: string) => void;
    const reads: string[] = [];
    fs.image = (p: string) => {
      reads.push(p);
      return new Promise<string>((r) => (first = r));
    };
    const pending = paste([
      { type: 'image/png', path: '/one.png' },
      { type: 'image/png', path: '/two.png' },
    ]);
    target = { key: 'changed', blocked: false };
    first('data:first');
    await pending;
    assert.deepEqual(reads, ['/one.png']);
    assert.deepEqual(attachments, []);
    assert.match(notices.at(-1)[0], /destination changed/);
  } finally {
    await m.unmount();
  }
});

test('unknown ownership still admits explicit images and quotes while local files wait', async () => {
  target = { key: 'pending', blocked: true, pending: true };
  why = 'Checking where this chat runs.';
  const m = await mount(h(Probe));
  try {
    assert.equal(api.admit({ kind: 'image' }), true);
    assert.equal(api.admit({ kind: 'selection', text: 'a quote' }), true);
    assert.equal(api.admit({ kind: 'file' }), false);
    await api.addFiles(['/one.png']);
    assert.equal(attachments[0].kind, 'image');
  } finally {
    await m.unmount();
  }
});

test('a stale sketch save cannot attach to the new target; missing display metadata still has a clear refusal', async () => {
  const m = await mount(h(Probe));
  try {
    let save!: (v: string) => void;
    fs.save = () => new Promise((r) => (save = r));
    const pending = api.addSketch('data:sketch');
    target = { key: 'elsewhere', blocked: true };
    save('/saved.png');
    assert.equal(await pending, false);
    assert.deepEqual(attachments, []);
    target = { key: 'box', blocked: true };
    why = null;
    api.setIncoming([{ kind: 'skill' }]);
    assert.match(notices.at(-1)[0], /Only images, files, folders and selected text/);
  } finally {
    await m.unmount();
  }
});

test('a local pasted non-image without a native path is ignored without a false attachment', async () => {
  const m = await mount(h(Probe));
  try {
    await paste([{ type: 'text/plain' }]);
    assert.deepEqual(attachments, []);
    assert.deepEqual(notices, []);
  } finally {
    await m.unmount();
  }
});

test('a navigation triggered by the first clipboard append retires remaining pathless images', async (t) => {
  const original = globalThis.FileReader;
  class Reader {
    result = 'data:x';
    onload: any;
    readAsDataURL() {
      this.onload();
    }
  }
  globalThis.FileReader = Reader as any;
  t.after(() => (globalThis.FileReader = original));
  let saves = 0;
  fs.save = async () => {
    saves++;
    return '/saved.png';
  };
  onAttach = () => {
    target = { key: 'other-chat', blocked: false };
  };
  const m = await mount(h(Probe));
  try {
    await paste([{ type: 'image/png' }, { type: 'image/png' }]);
    assert.equal(saves, 1);
    assert.equal(attachments.length, 1);
    assert.match(notices.at(-1)[0], /destination changed/);
  } finally {
    await m.unmount();
  }
});
