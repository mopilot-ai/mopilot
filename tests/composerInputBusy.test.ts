// The composer's editor while it is busy (src/components/composer/ComposerInput.tsx, #5402): plain keys are refused, and so is what an input method composes, which beforeinput cannot cancel.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ComposerInput } = await import('../src/components/composer/ComposerInput.tsx');
const { setRendererSink } = await import('../src/lib/rendererNote.ts');
const { COMPOSITION_OPEN_MS } = await import('../src/lib/composerComposition.ts');

async function mount(value: string, disabled: boolean, busyWhy: 'locked' | 'preparing' | 'starting' | null = null) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let el: any = null;
  const state = { value };
  const changes: string[] = [];
  const render = () =>
    root.render(
      createElement(ComposerInput, {
        ref: (n: any) => {
          el = n;
        },
        value: state.value,
        attachments: [],
        placeholder: 'Do anything',
        disabled,
        busyWhy,
        hidden: false,
        onKeyDown() {},
        onPaste() {},
        onSelect() {},
        onChange(next: string) {
          changes.push(next);
          state.value = next;
          render();
        },
      } as any),
    );
  await act(async () => render());
  return {
    changes,
    state,
    get el() {
      return el;
    },
    async compose(text: string) {
      await act(async () => void el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
      el.append(document.createTextNode(text));
      await act(async () => void el.dispatchEvent(new window.InputEvent('input', { bubbles: true })));
      await act(async () => void el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    },
    refuses(key: string) {
      const event = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: key });
      el.dispatchEvent(event as any);
      return event.defaultPrevented;
    },
    async close() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('a busy editor takes no input-method text either: what composes meanwhile is drawn away, and the draft stays', async () => {
  const m = await mount('kept', true);
  try {
    m.el.focus();
    assert.equal(m.refuses(','), true, 'a plain key is refused');
    await m.compose('中文');
    assert.equal(m.changes.length, 0, 'the composed text is not taken');
    assert.equal(m.el.textContent, 'kept', 'and it is gone from the editor, like the keys that were refused');
    assert.equal(m.state.value, 'kept');
  } finally {
    await m.close();
  }
});

test('an editor that is not busy takes composed text and plain keys alike', async () => {
  const m = await mount('kept', false);
  try {
    m.el.focus();
    assert.equal(m.refuses(','), false);
    await m.compose('中文');
    assert.equal(m.state.value, 'kept中文');
  } finally {
    await m.close();
  }
});

test('what a busy editor refuses is noted for the record as a count of one kind of input, never as what was typed', async () => {
  const noted: any[] = [];
  setRendererSink((line) => noted.push(line));
  const m = await mount('kept', true, 'preparing');
  try {
    m.el.focus();
    for (const key of ['a', ',', 'b']) m.refuses(key);
    await m.compose('中文');
    await m.close();
    assert.deepEqual(
      noted.map((n) => n.what),
      ['composerRefused', 'composerRefused'],
      'the composition is its own line, the plain keys another',
    );
    const plain = noted.find((n) => n.inputType === 'insertText');
    assert.deepEqual({ count: plain.count, why: plain.why }, { count: 3, why: 'preparing' });
    assert.equal(noted.find((n) => n.inputType === 'insertCompositionText').why, 'preparing');
    assert.ok(!JSON.stringify(noted).includes('中文') && !JSON.stringify(noted).includes('kept'));
  } finally {
    setRendererSink(null);
  }
});

test('a busy editor looks busy: aria-disabled says so', async () => {
  const busy = await mount('kept', true, 'starting');
  const free = await mount('kept', false);
  try {
    assert.equal(busy.el.getAttribute('aria-disabled'), 'true');
    assert.equal(free.el.getAttribute('aria-disabled'), 'false');
  } finally {
    await busy.close();
    await free.close();
  }
});

test('a composition left open past three seconds is noted once, and one that ends is not', async () => {
  const noted: any[] = [];
  setRendererSink((line) => noted.push(line));
  const m = await mount('', false);
  try {
    mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    mock.timers.tick(COMPOSITION_OPEN_MS - 1);
    assert.equal(noted.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(noted, [{ what: 'composerComposition', ms: COMPOSITION_OPEN_MS }]);
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    // a composition that ends in time is never noted, and a new one starts its own clock
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    mock.timers.tick(1000);
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    mock.timers.tick(COMPOSITION_OPEN_MS);
    assert.equal(noted.length, 1);
  } finally {
    mock.timers.reset();
    setRendererSink(null);
    await m.close();
  }
});

test('an input the editor refuses without a kind is noted as a plain input', async () => {
  const noted: any[] = [];
  setRendererSink((line) => noted.push(line));
  const m = await mount('kept', true, 'starting');
  try {
    m.el.focus();
    const event = new window.InputEvent('beforeinput', { bubbles: true, cancelable: true });
    m.el.dispatchEvent(event as any);
    assert.equal(event.defaultPrevented, true);
    await m.close();
    assert.deepEqual(noted, [{ what: 'composerRefused', inputType: 'input', count: 1, why: 'starting' }]);
  } finally {
    setRendererSink(null);
  }
});

test('a busy editor leaves an open composition alone: what the input method composes stays in place until it ends, then is drawn away', async () => {
  const m = await mount('kept', true, 'starting');
  try {
    m.el.focus();
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true })));
    const composed = document.createTextNode('中文');
    m.el.append(composed);
    await act(async () => void m.el.dispatchEvent(new window.InputEvent('input', { bubbles: true })));
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionupdate', { bubbles: true })));
    // the editor is not redrawn under the candidate window while the composition is open
    assert.equal(composed.isConnected, true);
    assert.equal(m.el.textContent, 'kept中文');
    await act(async () => void m.el.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true })));
    assert.equal(composed.isConnected, false, 'once it ends, the refused text is drawn away');
    assert.equal(m.el.textContent, 'kept');
  } finally {
    await m.close();
  }
});
