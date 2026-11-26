// The harness MoMo's phone screen tests share: mounts MomoPhone over the fixture home, taps and types like a person.
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './component-kit';
import { after } from 'node:test';
import { fakeDraft } from './drafts';

const phonePath = '../../../mobile/src/screens/momoPhone/MomoPhone';
const storePath = '../../../mobile/src/momoPhone/store';
const fxPath = '../../../mobile/src/momoPhone/fixtures';
export const { MomoPhone } = await import(phonePath);
export const { createMomoStore } = await import(storePath);
export const { createFixtureTransport, fixtureView } = await import(fxPath);
export { act, createElement, createRoot, flush };

export type Any = any;
const mounted: { root: { unmount(): void }; host: HTMLElement }[] = [];
export async function mount(edit: (v: Any, p: Any) => void = () => undefined, over: object = {}, props: Any = {}) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const view = fixtureView(over);
  edit(view.view, view);
  const transport = createFixtureTransport(view);
  const sent: Any[] = [];
  const send = transport.send.bind(transport);
  transport.send = async (intent: Any) => (sent.push(intent), send(intent));
  const store = createMomoStore(transport, {
    newId: (() => {
      let n = 0;
      return () => `t${++n}`;
    })(),
    now: () => view.now,
  });
  const drafts = fakeDraft();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const backs: string[] = [];
  const draw = async (extra: Any = {}) => {
    await act(async () =>
      root.render(createElement(MomoPhone, { store, back: () => backs.push('back'), drafts, clock: () => view.now, ...props, ...extra })),
    );
    await flush();
  };
  await draw();
  return { host, store, transport, sent, backs, drafts, view, rerender: draw, text: () => host.textContent ?? '' };
}
export const find = (label: string) =>
  [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').startsWith(label)) as
    | HTMLElement
    | undefined;
export const tap = async (label: string) => {
  const el = find(label);
  assert.ok(el, `button ${label}`);
  await act(async () => el.click());
  await flush();
};
export const typeInto = async (label: string, value: string) => {
  const el = document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
  assert.ok(el, `field ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
export const flip = async (label: string) => {
  const el = document.querySelector(`button[role="switch"][aria-label="${label}"]`) as HTMLElement;
  assert.ok(el, `switch ${label}`);
  await act(async () => el.click());
  await flush();
};
export const homeIs =
  (state: string, extra: object = {}) =>
  (v: Any) =>
    Object.assign(v.home, { state, stateSince: new Date(2026, 10, 24, 13, 12).getTime(), ...extra });
export const kinds = (m: { sent: Any[] }) => m.sent.map((i) => i.kind);

export const ref = (machineId: string, name: string) => ({ machineId, name });

// a screen left drawn would keep its clock running: every file closes what it mounted
/** Takes down every screen mounted so far, so a button is found only on the screen under test. */
export async function unmountAll() {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
}
after(unmountAll);

/** What the composer's empty field says. */
export const placeholder = () => (document.querySelector('input[placeholder]') as HTMLInputElement | null)?.placeholder ?? '';
