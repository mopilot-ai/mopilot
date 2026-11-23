// Settings › MoMo › Pause and Reset (src/components/momo/settings/PauseReset.tsx): Pause and Resume saved through main; Reset only once "MoMo" is typed exactly, the confirmation focused and Escape cancelling; main's reset told as it ended, in a toast and in the Reset row (done, done except what this build can't reach, or what failed, kept for a retry); a page closed mid-reset still hears how it ended.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act } from 'react';
import { render, click, byText, flush, fakeStore } from './support/shell-chrome-kit.ts';
import { mockSource, popoverStubs, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const store = fakeStore<any>({ prefs: {} });
const toasts: any[] = [];
const saves: any[] = [];
const routes: any[] = [];
stubStore({
  toast: (text: string, kind: string) => toasts.push([text, kind]),
  navigate: (r: any) => routes.push(r),
});
let saveOk = true;
mockSource('src/lib/ignored.ts', { errorText: (e: any) => e.message });
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => {
    const { readMomoPrefs } = (globalThis as any).__momoPrefs;
    return readMomoPrefs(store.useStore((s: any) => s.prefs.momo));
  },
  saveMomoPref: async (key: string, value: unknown) => (saves.push([key, value]), saveOk),
});
(globalThis as any).__momoPrefs = await import('../shared/momoPrefs.mjs');
let runs = 0;
let answer: () => Promise<any> = async () => ({ reset: [], notReset: [] });
installNativeStub({ momoReset: { run: () => (runs++, answer()) } });
mockSource('src/components/ui/Popover.tsx', popoverStubs());

const { PauseResetSettings, resetNote } = await import('../src/components/momo/settings/PauseReset.tsx');

const btn = (root: HTMLElement, text: string, sel?: string) => byText(root, text, sel) as HTMLButtonElement;
const input = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[aria-label="Type MoMo to confirm"]')!;
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value);
    el.dispatchEvent(new (globalThis as any).window.Event('input', { bubbles: true }));
  });
}
const reset = (host: HTMLElement) => btn(host, 'Reset', 'button.danger');
async function confirmReset(host: HTMLElement) {
  await click(byText(host, 'Reset…'));
  await type(input(host), 'MoMo');
  await click(reset(host));
  await flush();
}
const part = (id: string, label: string) => ({ id, label });
const ALL = {
  reset: [part('memory', "MoMo's memory"), part('settings', 'its settings')],
  notReset: [] as any[],
};

test('Pause and Resume are saved through main; the row says it is paused', async () => {
  store.setState({ prefs: {} });
  const { host, unmount } = await render(h(PauseResetSettings));
  assert.match(host.textContent!, /Routines and background reads wait until you resume\./);
  assert.match(host.textContent!, /Deletes everything MoMo keeps on this Mac\. Your accounts and coding chats stay\./);
  await click(byText(host, 'Pause'));
  assert.deepEqual(saves.at(-1), ['paused', true]);
  await act(async () => store.setState({ prefs: { momo: { paused: true } } }));
  assert.match(host.textContent!, /Pause MoMoPaused/);
  await click(byText(host, 'Resume'));
  assert.deepEqual(saves.at(-1), ['paused', false]);
  await unmount();
});

test('Reset: the confirmation takes focus, only "MoMo" typed exactly runs it, Escape and Cancel leave everything', async () => {
  runs = 0;
  toasts.length = 0;
  answer = async () => ALL;
  const { host, unmount } = await render(h(PauseResetSettings));
  await click(byText(host, 'Reset…'));
  assert.equal((globalThis as any).document.activeElement, input(host));
  assert.equal(reset(host).disabled, true);
  for (const wrong of ['momo', 'MoMo ', 'MOMO', '']) {
    await type(input(host), wrong);
    assert.equal(reset(host).disabled, true, JSON.stringify(wrong));
  }
  await act(
    async () =>
      void input(host).dispatchEvent(
        new (globalThis as any).window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
  );
  assert.equal(input(host), null, 'Escape cancels');
  await click(byText(host, 'Reset…'));
  await click(byText(host, 'Cancel'));
  assert.equal(input(host), null);
  assert.equal(runs, 0);
  await click(byText(host, 'Reset…'));
  assert.equal(input(host).value, '', 'a new form starts empty');
  await type(input(host), 'MoMo');
  await click(reset(host));
  await flush();
  assert.equal(runs, 1);
  assert.deepEqual(toasts, [['MoMo was reset', 'info']]);
  assert.equal(input(host), null, 'done: the form closes');
  assert.equal(host.querySelector('[role="status"]')?.textContent, 'MoMo was reset', 'the row still says so once the toast is gone');
  await click(byText(host, 'Reset…'));
  assert.equal(host.querySelector('[role="status"]'), null, 'a new Reset starts without the last one’s result');
  assert.match(host.textContent!, /Deletes everything MoMo keeps on this Mac/);
  await click(byText(host, 'Cancel'));
  await unmount();
});

test('Reset: what this build can’t reach is said, never "MoMo was reset" alone; what failed keeps the form for a retry', async () => {
  const absent = {
    ...ALL,
    notReset: [
      { ...part('routines', 'its routines'), reason: 'absent' },
      { ...part('audit', 'the audit log'), reason: 'absent' },
    ],
  };
  assert.deepEqual(resetNote(absent as any), {
    text: "MoMo was reset, except its routines, the audit log: this build can't reach them.",
    tone: 'info',
    retry: false,
  });
  toasts.length = 0;
  answer = async () => ({
    reset: [],
    notReset: [
      { ...part('memory', "MoMo's memory"), reason: 'failed' },
      { ...part('routines', 'its routines'), reason: 'absent' },
      { ...part('settings', 'its settings'), reason: 'failed' },
    ],
  });
  const { host, unmount } = await render(h(PauseResetSettings));
  await confirmReset(host);
  assert.deepEqual(toasts, [["Couldn't delete MoMo's memory, its settings. MoMo stays paused; try again.", 'error']]);
  assert.equal(input(host).value, 'MoMo', 'kept for a retry');
  assert.match(host.querySelector('[role="status"]')!.textContent!, /^Couldn't delete MoMo's memory/);
  assert.equal(reset(host).disabled, false);
  // main refused (MoMo off, or it couldn't be paused): told in its words, kept for a retry
  let hold: (v: any) => void = () => {};
  answer = () => new Promise((_r, reject) => (hold = reject));
  await click(reset(host));
  assert.equal(host.querySelector('[role="status"]'), null, 'nothing stale while it runs again');
  await act(async () => hold(Object.assign(new Error("Couldn't pause MoMo, so nothing was reset."), { code: 'save_failed' })));
  await flush();
  assert.deepEqual(toasts.at(-1), ["Couldn't pause MoMo, so nothing was reset.", 'error']);
  assert.equal(host.querySelector('[role="status"]')!.textContent, "Couldn't pause MoMo, so nothing was reset.");
  assert.ok(input(host));
  // and once it all went
  answer = async () => absent;
  await click(reset(host));
  await flush();
  assert.deepEqual(toasts.at(-1), ["MoMo was reset, except its routines, the audit log: this build can't reach them.", 'info']);
  assert.equal(input(host), null);
  await unmount();
});

test('Reset: busy while it runs, Escape doing nothing then; the page closed meanwhile still hears how it ended', async () => {
  toasts.length = 0;
  let release: (r: any) => void = () => {};
  answer = () => new Promise((r) => (release = r));
  const { host, unmount } = await render(h(PauseResetSettings));
  await confirmReset(host);
  assert.equal(btn(host, 'Resetting…').disabled, true);
  assert.equal(input(host).readOnly, true, 'read-only, keeping the keyboard');
  assert.equal(btn(host, 'Cancel').disabled, true);
  const pauseBtn = [...host.querySelectorAll('button')].find((b) => /^(Pause|Resume)$/.test(b.textContent!))!;
  assert.equal(pauseBtn.disabled, true, 'MoMo stays paused while its data goes');
  await act(
    async () => void input(host).dispatchEvent(new (globalThis as any).window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  );
  assert.ok(input(host), 'not while it runs');
  await unmount();
  await act(async () => release(ALL));
  await flush();
  assert.deepEqual(toasts, [['MoMo was reset', 'info']]);
});

test('Setup opens again on the MoMo page (its one screen, even when an older build saved a later step); not when the change wasn’t saved', async () => {
  store.setState({ prefs: { momo: { onboarding: { done: true, step: 0 } } } });
  const { host, unmount } = await render(h(PauseResetSettings));
  assert.match(host.textContent!, /Go through name, color and connections again/);
  await click(byText(host, 'Open setup'));
  assert.deepEqual(saves.at(-1), ['onboarding', { done: false, step: 0 }]);
  assert.deepEqual(routes, [{ name: 'momo' }]);
  saveOk = false;
  await click(byText(host, 'Open setup'));
  assert.equal(routes.length, 1);
  // clicked twice before the first is saved: one save, one move
  saveOk = true;
  saves.length = 0;
  await act(async () => {
    byText(host, 'Open setup').click();
    byText(host, 'Open setup').click();
  });
  await flush();
  assert.equal(saves.length, 1);
  assert.equal(routes.length, 2);
  saveOk = true;
  await unmount();
});
