// The fake window.native.momoSources and a mount of Settings › MoMo › Sources shared by tests/momoSourcesSectionUI.test.ts and tests/momoSourcesConnectUI.test.ts: the sources as main lists them, the calls recorded in `f.calls`, and the card helpers (a card by its name, its status line, state and chips).
import { window } from './dom.ts';
import { installNativeStub } from './ports/native.ts';

const React = await import('react');
const { act, createElement } = React;
const { createRoot } = await import('react-dom/client');

export const f: any = { calls: [], listeners: new Set() };
export const ok = (x: object = {}) => ({ ok: true, ...x });
const rec =
  (name: string, answer: string) =>
  async (...args: any[]) => (f.calls.push([name, ...args]), f[answer](...args));
f.native = {
  momoSources: {
    list: () => (f.calls.push(['list']), f.listAnswer()),
    detail: rec('detail', 'detailAnswer'),
    connect: rec('connect', 'connectAnswer'),
    disconnect: rec('disconnect', 'okAnswer'),
    setLevel: rec('setLevel', 'okAnswer'),
    addFolder: rec('addFolder', 'okAnswer'),
    removeFolder: rec('removeFolder', 'okAnswer'),
    openPrivacy: rec('openPrivacy', 'okAnswer'),
    cancelConnect: rec('cancelConnect', 'okAnswer'),
    recheck: rec('recheck', 'recheckAnswer'),
    onChanged: (cb: () => void) => {
      f.listeners.add(cb);
      return () => f.listeners.delete(cb);
    },
  },
};
installNativeStub(f.native);
const { SourcesSection } = await import('../../src/components/momo/SourcesSection.tsx');
const { ASK_LINE_DELAY_MS, WAITING_LINE, ALLOW_LINE, NEEDS_BADGE, needsLine, stalledLine, lostLine } = await import(
  '../../src/components/momo/sourceConnect.ts'
);
const { SOURCE_COPY, PAUSED_LINE, NO_FOLDERS_LINE, KEEPS, KEEPS_ASK } = await import('../../src/components/momo/sourceCopy.ts');

export const T = new Date(new Date().getFullYear(), 0, 2, 15, 30).getTime();
export function reset() {
  f.calls = [];
  f.sources = [
    { id: 'calendar', label: 'Calendar', connected: true, connectedAt: T, level: 'read' },
    { id: 'reminders', label: 'Reminders', connected: false },
    { id: 'files', label: 'Files', connected: true, connectedAt: T, level: 'read', folders: ['/Users/me/Docs'] },
  ];
  f.available = true;
  f.listAnswer = async () => ok({ sources: f.sources, available: f.available });
  f.detailAnswer = async (id: string) => ok({ items: id === 'calendar' ? ['Work', 'Home'] : id === 'files' ? ['~/Docs'] : [] });
  f.connectAnswer = async () => ok({ connected: true, grant: 'granted' });
  f.okAnswer = async () => ok();
  f.recheckAnswer = async () => ok({ connected: false });
}
export const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

export async function mount() {
  const host = window.document.createElement('div');
  window.document.body.appendChild(host as any);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(SourcesSection)));
  await flush();
  const all = (sel: string, el: any = host) => [...el.querySelectorAll(sel)];
  /** a source's card, by its name */
  const row = (title: string) => all('section[aria-label]').find((r: any) => r.getAttribute('aria-label') === title);
  const button = (label: string, el: any = host) =>
    all('button', el).find((b: any) => b.textContent.trim() === label || b.getAttribute('aria-label') === label);
  const click = async (el: any) => {
    await act(async () => el.click());
    await flush();
  };
  const alerts = () => all('[role="alert"]').map((a: any) => a.textContent);
  const close = () => act(async () => root.unmount());
  return { host, all, row, button, click, alerts, close };
}

export const statusOf = (v: any, title: string) => v.row(title).querySelector('[data-status]').textContent.trim();
export const stateOf = (v: any, title: string) => v.row(title).getAttribute('data-state');
export const chips = (v: any, title: string) => v.all('.hp-badge', v.row(title)).map((b: any) => b.textContent.trim());
export const factsOf = (v: any, title: string) => v.row(title).querySelector('dl').textContent;
export const lastCall = (name: string) => f.calls.filter((c: any) => c[0] === name).at(-1);
export const focus = () => act(async () => window.dispatchEvent(new window.Event('focus')));
export const refresh = async (v: any) => {
  await act(async () => f.listeners.forEach((cb: any) => cb()));
  await flush();
};

export {
  act,
  window,
  ASK_LINE_DELAY_MS,
  WAITING_LINE,
  ALLOW_LINE,
  NEEDS_BADGE,
  needsLine,
  stalledLine,
  lostLine,
  SOURCE_COPY,
  PAUSED_LINE,
  NO_FOLDERS_LINE,
  KEEPS,
  KEEPS_ASK,
};
