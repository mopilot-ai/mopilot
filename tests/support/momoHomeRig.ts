// The rig MoMo's home UI tests share (tests/momoHomeUI.test.ts, tests/momoHomeScreensUI.test.ts): the happy-dom window, the recorded navigate, the screens loaded against it and mount(scenario, tab) with its clicking helpers.
import assert from 'node:assert/strict';
import { window } from './dom.ts';
import { installNativeStub } from './ports/native.ts';
import { mockSource } from './stubs.ts';

export { window };
const React = await import('react');
export const { act, createElement } = React;
export const { createRoot } = await import('react-dom/client');
export const nav: any[] = [];
mockSource('src/store/panes.ts', { navigate: (r: any) => nav.push(r) });
installNativeStub({});
export const { MomoHomePage } = await import('../../src/components/momo/home/MomoHomePage.tsx');
export const { advanceMove, failMove } = await import('../../src/components/momo/home/homeReducer.ts');
export const { createFixtureSeam, setMomoHomeSeam, momoHomeSeam } = await import('../../src/components/momo/home/homeSeam.ts');
export const { resetMomoHomeStore, useMomoAct } = await import('../../src/components/momo/home/useMomoHome.ts');
export const { fixtureView, scenarioView, FIXTURE_NOW } = await import('../../src/components/momo/home/homeFixtures.ts');
export const { momoHomeScenario } = await import('../../src/components/momo/home/homeSwitch.ts');
export const { pillText } = await import('../../src/components/momo/home/WhereRuns.tsx');
export const { clock, shortDay, minutesSince, count } = await import('../../src/components/momo/home/homeCopy.ts');

export const NOW = FIXTURE_NOW;
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

export async function mount(
  scenario: string | null,
  tab: any = 'chat',
  refuse?: string | { cause: string; fix: { label: string; intent: unknown } },
) {
  const seam = createFixtureSeam(scenarioView(scenario), () => NOW);
  if (refuse) seam.act = async () => (typeof refuse === 'string' ? { ok: false, cause: refuse } : { ok: false, ...refuse });
  setMomoHomeSeam(seam);
  resetMomoHomeStore();
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(MomoHomePage, { tab, now: NOW })));
  await flush();
  const body = window.document.body as any;
  const text = () => body.textContent as string;
  const btn = (label: string | RegExp) =>
    [...body.querySelectorAll('button')].find((b: any) =>
      typeof label === 'string' ? b.textContent.trim() === label : label.test(b.textContent.trim()),
    ) as any;
  const click = async (label: string | RegExp) => {
    const b = btn(label);
    assert.ok(b, `no button ${label}`);
    await act(async () => b.click());
    await flush();
  };
  const clickLast = async (label: string) => {
    const all = [...body.querySelectorAll('button')].filter((b: any) => b.textContent.trim() === label) as any[];
    await act(async () => all[all.length - 1].click());
    await flush();
  };
  const type = async (sel: string, value: string) => {
    const el = body.querySelector(sel) as any;
    assert.ok(el, `no ${sel}`);
    const proto =
      el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT'
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  };
  const blur = async (sel: string, value: string) => {
    const el = body.querySelector(sel) as any;
    el.value = value;
    await act(async () => el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })));
    await act(async () => el.dispatchEvent(new window.Event('blur')));
  };
  const submit = async (sel: string) => {
    await act(async () => body.querySelector(sel).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
  };
  const close = async () => {
    await act(async () => root.unmount());
    host.remove();
    body.innerHTML = '';
  };
  return { body, text, btn, click, clickLast, type, blur, submit, close, seam };
}
