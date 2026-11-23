// The Chrome side panel's + menu (electron/chrome-extension/src/panelAttach.mjs and its use in sidePanel.mjs): a screenshot of the tab taken by the background, files the user picks, their chips, Send waiting for an upload, and the ids going with the message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelAttach, MAX_FILES } = await import('../electron/chrome-extension/src/panelAttach.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

/** The + menu on a fake document and Chrome; the background answers a capture, MoPilot each attach with the next id. */
function plus(o: { capture?: (m: any) => any; attach?: (p: any) => any; tab?: any } = {}) {
  const els: Record<string, any> = {};
  const document = { getElementById: (id: string) => (els[id] ??= el()), createElement: (tag: string) => el(tag) };
  let clicked = 0;
  els.files = Object.assign(el('input'), { click: () => clicked++, files: [] });
  // hidden until opened, as in sidepanel.html
  els['plus-menu'] = Object.assign(el(), { hidden: true });
  const asked: any[] = [];
  const chrome = {
    runtime: {
      sendMessage: async (m: any) => {
        asked.push(m);
        return o.capture ? o.capture(m) : { dataUrl: 'data:image/png;base64,c2hvdA==' };
      },
    },
  };
  const sent: any[] = [];
  let n = 0;
  const errors: string[] = [];
  let changes = 0;
  const a = new PanelAttach({
    document,
    chrome,
    request: async (method: string, params: any) => {
      sent.push([method, params]);
      if (o.attach) return o.attach(params);
      return { id: `${++n}`.padStart(16, '0'), name: params.name, kind: params.name.endsWith('.png') ? 'image' : 'file' };
    },
    tab: () => ('tab' in o ? o.tab : { id: 7 }),
    read: async (f: any) => {
      if (f.bad) throw new Error(`Couldn't read ${f.name}.`);
      return `data:text/plain;base64,${f.name}`;
    },
    onError: (t: string) => errors.push(t),
    onChange: () => changes++,
  });
  const chips = () => els.attached.children.map((c: any) => c.textContent);
  return { a, els, asked, sent, errors, chips, clicked: () => clicked, changes: () => changes };
}

test('a screenshot of the tab: the background takes it, with no permission to ask for, and it shows as a chip', async () => {
  const p = plus();
  p.els.plus.listeners.click();
  assert.equal(p.els['plus-menu'].hidden, false);
  // the + menu closes the other menus
  assert.equal(p.els['model-menu'].hidden, true);
  p.els.shot.listeners.click();
  await tick();
  await tick();
  assert.deepEqual(p.asked, [{ type: 'capture', tabId: 7 }]);
  assert.equal(p.els['plus-menu'].hidden, true);
  assert.deepEqual(p.sent, [['attach', { dataUrl: 'data:image/png;base64,c2hvdA==', name: 'Screenshot.png' }]]);
  // named plainly, never after the page's own title
  assert.deepEqual(p.chips(), ['Screenshot.png×']);
  assert.equal(p.els.attached.hidden, false);
  assert.deepEqual(p.a.ids, ['0000000000000001']);
  // its × takes it off
  p.els.attached.children[0].children[1].listeners.click();
  assert.deepEqual(p.a.ids, []);
  assert.equal(p.els.attached.hidden, true);
});

test('no screenshot: no web page in front, a page the background can’t take, or MoPilot refusing the file', async () => {
  const none = plus({ tab: null });
  await none.a.shot();
  assert.deepEqual(none.errors, ['Open a web page to add a screenshot of it.']);
  assert.deepEqual(none.asked, []);
  const kept = plus({ capture: () => ({ error: "MoPilot can't take a screenshot of this page." }) });
  await kept.a.shot();
  assert.deepEqual(kept.errors, ["MoPilot can't take a screenshot of this page."]);
  assert.deepEqual(kept.sent, []);
  // a background with no answer at all
  const silent = plus({ capture: () => undefined });
  await silent.a.shot();
  assert.deepEqual(silent.errors, ["MoPilot can't take a screenshot of this page."]);
  const refused = plus({ attach: () => Promise.reject(new Error('That file is larger than 20 MB.')) });
  await refused.a.shot();
  assert.deepEqual(refused.errors, ['That file is larger than 20 MB.']);
  assert.deepEqual(refused.a.ids, []);
});

test('files the user picks: each kept, one unreadable says so, and no more than a message carries', async () => {
  const p = plus();
  p.els.pick.listeners.click();
  assert.equal(p.clicked(), 1);
  p.els.files.files = [{ name: 'notes.txt' }, { name: 'broken.bin', bad: true }];
  p.els.files.listeners.change();
  // while they are added: a chip says so
  assert.equal(p.a.busy, 2);
  p.a.render();
  assert.deepEqual(p.chips(), ['Adding…']);
  await tick();
  await tick();
  assert.equal(p.a.busy, 0);
  assert.deepEqual(p.chips(), ['notes.txt×']);
  assert.deepEqual(p.errors, ["Couldn't read broken.bin."]);
  assert.equal(p.els.files.value, '');
  // a change with nothing picked
  p.els.files.files = null;
  p.els.files.listeners.change();
  for (let i = 0; i < MAX_FILES; i++) await p.a.add(async () => 'data:,x', `f${i}.txt`);
  assert.equal(p.a.ids.length, MAX_FILES);
  assert.equal(p.errors.at(-1), `Add up to ${MAX_FILES} files.`);
  // a message sent: only its files go; one added while it was on its way stays for the next
  const [first, ...rest] = p.a.ids;
  p.a.clear([first]);
  assert.deepEqual(p.a.ids, rest);
  p.a.clear(rest);
  assert.deepEqual(p.a.ids, []);
  assert.ok(p.changes() > 0);
});

test('the page: Send waits for a file being added; the ids go with the first message and a follow-up, then the chips go', async () => {
  let release: () => void = () => undefined;
  const p = panelPage({
    reply: (m: any) => {
      if (m.type === 'capture') return { dataUrl: 'data:image/png;base64,eA==' };
      if (m.type !== 'panel') return { status: 'connected' };
      if (m.method === 'harnesses') return { status: 'connected', result: { harnesses: [{ id: 'claude', label: 'Claude Code' }] } };
      if (m.method === 'attach')
        return new Promise((r) => {
          release = () => r({ status: 'connected', result: { id: 'f'.repeat(16), name: m.params.name, kind: 'image' } });
        });
      if (m.method === 'start') return { status: 'connected', result: { chatId: 'claude:9' } };
      return { status: 'connected', result: {} };
    },
  });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.text.value = 'What is on this page?';
  p.els.text.listeners.input();
  p.els.shot.listeners.click();
  await tick();
  await tick();
  assert.equal(p.els.send.disabled, true);
  // Enter while it uploads sends nothing
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  assert.equal(p.sent().filter((m: any) => m.method === 'start').length, 0);
  release();
  await tick();
  await tick();
  assert.equal(p.els.send.disabled, false);
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  await tick();
  const start = p.sent().find((m: any) => m.method === 'start');
  assert.deepEqual(start.params.attachments, ['f'.repeat(16)]);
  assert.equal(p.els.attached.hidden, true);
  // a follow-up with a file of its own
  p.els.shot.listeners.click();
  await tick();
  await tick();
  release();
  await tick();
  await tick();
  p.els.text.value = 'and this?';
  p.els.text.listeners.input();
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  await tick();
  const send = p.sent().find((m: any) => m.method === 'send');
  assert.deepEqual(send.params.attachments, ['f'.repeat(16)]);
  assert.equal(p.els.attached.hidden, true);
  // a follow-up with none carries none
  p.els.text.value = 'thanks';
  p.els.text.listeners.input();
  p.els.composer.listeners.submit({ preventDefault() {} });
  await tick();
  await tick();
  assert.equal(
    p
      .sent()
      .filter((m: any) => m.method === 'send')
      .at(-1).params.attachments,
    undefined,
  );
});

test('the page: a picked file is read as a data: URL in the panel', async () => {
  const p = panelPage();
  class FakeReader {
    result = '';
    onload: () => void = () => undefined;
    onerror: () => void = () => undefined;
    readAsDataURL(f: any) {
      if (f.bad) return queueMicrotask(() => this.onerror());
      this.result = `data:text/plain;base64,${f.name}`;
      queueMicrotask(() => this.onload());
    }
  }
  p.g.FileReader = FakeReader;
  p.els.files = Object.assign(el('input'), { click: () => undefined });
  await startSidePanel(p.g).ready;
  await tick();
  p.els.files.files = [{ name: 'a.txt' }, { name: 'b.bin', bad: true }];
  p.els.files.listeners.change();
  await tick();
  await tick();
  await tick();
  const attaches = p.sent().filter((m: any) => m.method === 'attach');
  assert.deepEqual(
    attaches.map((m: any) => m.params),
    [{ dataUrl: 'data:text/plain;base64,a.txt', name: 'a.txt' }],
  );
  assert.equal(p.els.error.textContent, "Couldn't read b.bin.");
});

test('an image pasted into the message box becomes a chip; a paste with text, or with no image, is left to the box', async () => {
  const p = plus();
  const paste = (files: any[], text = '') => {
    let prevented = 0;
    p.els.text.listeners.paste({ clipboardData: { files, getData: () => text }, preventDefault: () => prevented++ });
    return prevented;
  };
  // a screenshot and a copied image: attached, named by what they are, and the paste is taken
  assert.equal(
    paste([
      { type: 'image/png', name: 'image.png' },
      { type: 'image/jpeg', name: 'x' },
    ]),
    1,
  );
  await tick();
  await tick();
  assert.deepEqual(
    p.sent.map(([method, params]: any) => [method, params.name]),
    [
      ['attach', 'Pasted image.png'],
      ['attach', 'Pasted image.jpg'],
    ],
  );
  // text beside the picture (cells from a sheet), a file that is no picture, and a paste of only text: the box's own paste
  assert.equal(paste([{ type: 'image/png', name: 'a.png' }], 'a\tb'), 0);
  assert.equal(paste([{ type: 'application/pdf', name: 'a.pdf' }]), 0);
  assert.equal(paste([{ type: 'image/svg+xml', name: 'a.svg' }]), 0);
  assert.equal(paste([]), 0);
  p.els.text.listeners.paste({ clipboardData: null, preventDefault: () => assert.fail('nothing to take') });
  await tick();
  assert.equal(p.sent.length, 2);
});

test('a paste past the file limit says so, and an unreadable pasted image says why', async () => {
  const p = plus();
  const paste = (files: any[]) =>
    p.els.text.listeners.paste({ clipboardData: { files, getData: () => '' }, preventDefault: () => undefined });
  paste([{ type: 'image/png', bad: true, name: 'bad' }]);
  await tick();
  await tick();
  assert.deepEqual(p.errors, ["Couldn't read bad."]);
  assert.deepEqual(p.sent, []);
  paste(Array.from({ length: MAX_FILES + 1 }, () => ({ type: 'image/png', name: 'i' })));
  await tick();
  await tick();
  assert.equal(p.a.ids.length, MAX_FILES);
  assert.equal(p.errors.at(-1), `Add up to ${MAX_FILES} files.`);
});
