// Settings › MoMo › Brain › Name and style (src/components/momo/settings/NameStyle.tsx, personaStyle.ts; moved out of setup by #2527): the name saved when the field is left (MoMo by default), the style as one line of MoMo's persona in memory with the rest of it kept, read again when memory changes, failures told.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, flush, fakeStore } from './support/shell-chrome-kit.ts';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';

const { readMomoPrefs, setMomoPref } = await import('../shared/momoPrefs.mjs');
const store = fakeStore<any>({ prefs: {} });
const saves: any[] = [];
const toasts: string[] = [];
let refuse = false;
/** main's merge and its broadcast back to this window, or a refusal */
const save = async (key: string, value: unknown) => {
  saves.push([key, value]);
  if (refuse) return false;
  const r = setMomoPref(store.getState().prefs.momo, key, value);
  if (!r.ok) throw new Error(r.error);
  await act(async () => store.setState({ prefs: { momo: r.momo } }));
  return true;
};
stubStore({
  useStore: store.useStore,
  toastFailure: (what: string) => (e: any) => toasts.push(`${what}: ${e.message}`),
  toast: (t: string) => toasts.push(t),
});
/** MoMo's memory (#2159) as far as this uses it: the persona document. */
let memory: any = null;
function fakeMemory(persona: string) {
  const listeners = new Set<() => void>();
  const m = {
    persona,
    writes: [] as string[],
    readFails: false,
    writeFails: false,
    files: async () => (m.readFails ? { ok: false, error: 'locked' } : { ok: true, persona: m.persona, aboutYou: '' }),
    writeFile: async (name: string, text: string) => {
      if (m.writeFails) return { ok: false, error: 'Encryption is off' };
      m.writes.push(`${name}=${text}`);
      m.persona = text;
      return { ok: true };
    },
    onChanged: (cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)),
    changed: () => act(async () => listeners.forEach((l) => l())),
  };
  return m;
}
mockSource('src/lib/momoBridges.ts', { momoMemoryBridge: () => memory });
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => readMomoPrefs(store.useStore((s: any) => s.prefs.momo)),
  saveMomoPref: save,
});
mockSource('src/components/ui/Popover.tsx', popoverStubs());
const { NameStyleSettings } = await import('../src/components/momo/settings/NameStyle.tsx');

async function typeIn(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
    el.dispatchEvent(new (globalThis as any).window.Event('input', { bubbles: true }));
  });
}
const leave = (el: HTMLElement) =>
  act(async () => void el.dispatchEvent(new (globalThis as any).window.FocusEvent('focusout', { bubbles: true })));

test('name: MoMo until changed, saved when the field is left; an empty one goes back; the same name saves nothing; Enter saves; a refused one goes back', async () => {
  memory = null;
  store.setState({ prefs: {} });
  const { host, unmount } = await render(h(NameStyleSettings));
  const name = host.querySelector<HTMLInputElement>('input[aria-label=Name]')!;
  assert.equal(name.value, 'MoMo');
  assert.deepEqual(
    [...host.querySelectorAll('.settings-row-title')].map((t) => t.textContent),
    ['Name', 'Style'],
  );
  await typeIn(name, '  Mo  ');
  await leave(name);
  assert.deepEqual(saves.at(-1), ['persona.name', 'Mo']);
  const n = saves.length;
  await typeIn(name, '   ');
  await leave(name);
  assert.equal(name.value, 'Mo');
  await leave(name);
  assert.equal(saves.length, n);
  refuse = true;
  await typeIn(name, 'Momo2');
  await leave(name);
  assert.equal(name.value, 'Mo', 'a refused name goes back to the saved one');
  refuse = false;
  name.focus();
  await typeIn(name, 'Mona');
  await act(async () => void name.dispatchEvent(new (globalThis as any).window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await flush();
  assert.deepEqual(saves.at(-1), ['persona.name', 'Mona']);
  // a name saved in another window shows here
  await act(async () => store.setState({ prefs: { momo: { persona: { name: 'Elsewhere' } } } }));
  assert.equal(name.value, 'Elsewhere');
  assert.match(host.textContent!, /Comes with MoMo’s memory, not in this build/, 'no memory here: no style to pick');
  await unmount();
});

test('style: one line of MoMo’s persona in memory, the rest of it kept; read again when memory changes; failures told', async () => {
  const { personaStyle, withPersonaStyle } = await import('../src/components/momo/settings/personaStyle.ts');
  assert.equal(personaStyle('Likes tea\nstyle: WARM \n'), 'warm');
  assert.equal(personaStyle('Style: loud'), null);
  assert.equal(personaStyle(''), null);
  assert.equal(withPersonaStyle('Likes tea\nStyle: warm', 'detailed'), 'Likes tea\nStyle: detailed');
  assert.equal(withPersonaStyle('Likes tea', 'warm'), 'Style: warm\nLikes tea');
  assert.equal(withPersonaStyle('  ', 'warm'), 'Style: warm');

  memory = fakeMemory('Style: warm\nLikes tea');
  toasts.length = 0;
  const { host, unmount } = await render(h(NameStyleSettings));
  await flush();
  const pressed = () => host.querySelector('[aria-pressed=true]')?.textContent;
  assert.equal(pressed(), 'Warm');
  await click(byText(host, 'Detailed'));
  await flush();
  assert.deepEqual(memory.writes, ['persona=Style: detailed\nLikes tea']);
  assert.equal(pressed(), 'Detailed');
  // the Memory tab changed the persona: read again
  memory.persona = 'Likes tea';
  await memory.changed();
  await flush();
  assert.equal(pressed(), 'Concise', 'no style line: the default');
  // a write or a read that fails is told, and what is shown stays
  memory.writeFails = true;
  await click(byText(host, 'Warm'));
  await flush();
  assert.deepEqual(toasts, ["Couldn't save MoMo's style: Encryption is off"]);
  assert.equal(pressed(), 'Concise');
  memory.writeFails = false;
  memory.readFails = true;
  await memory.changed();
  await flush();
  assert.deepEqual(toasts.at(-1), "Couldn't read MoMo's persona: locked");
  await unmount();
  // gone: a late change reads nothing
  memory.readFails = false;
  await memory.changed();
  memory = null;
});
