// The browser pane's Annotate bar (src/components/panels/BrowserAnnotate.tsx): it installs the
// overlay in the pane tab's isolated Annotate world (through main, never the page's own world),
// follows the overlay's signals, lists the marks with their notes (typed here, never in the page),
// removes marks, confirms before Esc discards notes, leaves on Esc / Cancel / navigation, and
// "Add to chat" captures the marked region and adds one page chip to the pane chat's composer (an
// open composer through its selection event, else the stored draft). The overlay and the mark model
// are the real modules; main and the store are stubbed.
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './dom.ts';
import { iconStubs, mockSource, stubStore } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';

const f: any = { state: { drafts: {} }, calls: [], toasts: [], handlers: {} };
stubStore({
  getState: () => f.state,
  setDraft: (k: string, d: unknown) => {
    f.state.drafts[k] = d;
  },
  toast: (...a: unknown[]) => f.toasts.push(a),
});
mockSource('src/lib/hostChats.ts', { onMachineNow: () => !!f.remote });
mockSource('src/store/projects.ts', { newChatHostPick: () => f.draftMachine ?? null });
mockSource('src/components/ui/icons.tsx', iconStubs(undefined, { ChevronDown: () => 'v', ChevronUp: () => '^' }));
installNativeStub({
  browser: {
    captureRegion: (...a: any[]) => {
      f.calls.push(['captureRegion', ...a]);
      return f.handlers.captureRegion(...a);
    },
    annotate: (...a: any[]) => {
      f.scripts.push(a[1]);
      f.ids.push(a[0]);
      return f.handlers.annotate(a[1]);
    },
  },
  fs: {
    saveTempImage: (...a: any[]) => {
      f.calls.push(['saveTempImage', ...a]);
      return f.handlers.saveTempImage(...a);
    },
  },
});
const react = await import('react');
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { AnnotateBar } = await import('../../src/components/panels/BrowserAnnotate.tsx');
const { attachToComposer } = await import('../../src/session/composerAttach.ts');
const { ANNOTATE_KEY } = await import('../../src/lib/annotateOverlay.ts');

const page = (marks = 2) => ({
  url: 'https://shop.test/cart',
  title: 'Cart',
  scrollX: 0,
  scrollY: 0,
  width: 800,
  height: 600,
  marks: Array.from({ length: marks }, (_, i) => ({
    id: i + 1,
    n: i + 1,
    kind: 'region',
    rect: { x: 10 + i * 50, y: 20, width: 40, height: 30 },
  })),
});
const summary = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, n: i + 1, kind: i ? 'region' : 'element', label: i ? 'region' : 'button' }));

/** Main's isolated-world runner: overlay scripts are recognised by what they call. */
const isolated =
  (o: any = {}) =>
  (script: string) => {
    if (script.includes('function annotateOverlay')) return o.install ? o.install() : Promise.resolve(true);
    if (script.includes('a.collect()')) return Promise.resolve(o.collect === undefined ? page() : o.collect);
    if (script.includes('a.capture(false)')) return o.release ? o.release() : Promise.resolve(true);
    if (script.includes('a.destroy()')) return Promise.reject(new Error('page gone'));
    if (script.includes('a.clear()')) return Promise.reject(new Error('page gone'));
    return Promise.resolve(true);
  };

/** A stand-in <webview>; its own executeJavaScript is the page's world and must never be used. */
function guest() {
  const el: any = document.createElement('div');
  el.mainWorld = [] as string[];
  el.executeJavaScript = (script: string) => {
    el.mainWorld.push(script);
    return Promise.resolve(null);
  };
  el.getWebContentsId = () => 7;
  el.getZoomFactor = () => 1;
  return el;
}

async function mount(o: any = {}) {
  f.state = { drafts: o.drafts ?? {} };
  f.calls = [];
  f.toasts = [];
  f.scripts = [];
  f.ids = [];
  f.exits = 0;
  f.handlers = {
    captureRegion: async () => 'data:image/png;base64,QQ==',
    saveTempImage: async () => '/tmp/annot.png',
    annotate: isolated(o.guest),
    ...o.handlers,
  };
  f.wv = guest();
  f.pane = document.createElement('div');
  f.pane.className = 'browser-pane';
  document.body.append(f.pane);
  f.root = createRoot(f.pane);
  await act(async () =>
    f.root.render(
      createElement(AnnotateBar, {
        webview: { current: f.wv },
        threadId: o.threadId === undefined ? 'chat-1' : o.threadId,
        onExit: () => {
          f.exits++;
        },
      }),
    ),
  );
}
const text = () => f.pane.querySelector('.browser-annotate-text')!.textContent;
const button = (label: string) =>
  [...f.pane.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as
    | HTMLButtonElement
    | undefined;
async function click(label: string) {
  const b = button(label);
  assert.ok(b, label);
  await act(async () => {
    b.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function signal(message: string) {
  await act(async () => f.wv.dispatchEvent(Object.assign(new window.Event('console-message'), { message })));
}
const nonce = () => JSON.parse(/\(window, (\{[^}]*\}), /.exec(f.scripts[0])![1]).signal;
const marks = (n: number) => signal(`${nonce()}${JSON.stringify({ type: 'marks', marks: summary(n) })}`);
const note = (n: number) => f.pane.querySelector(`input[aria-label="Note for mark ${n}"]`) as HTMLInputElement;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
}
async function escape(target: Element = f.pane.querySelector('button')!) {
  await act(async () => target.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any));
}
afterEach(async () => {
  if (f.root) await act(async () => f.root.unmount());
  f.pane?.remove();
});

export {
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
  isolated,
  guest,
  react,
  act,
  createElement,
  createRoot,
  AnnotateBar,
  attachToComposer,
  ANNOTATE_KEY,
};
