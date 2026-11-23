// Shared actual panel-card DOM fixture with trusted events, controlled hold timers and per-test teardown.
import { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './dom.ts';
import type { Element } from 'happy-dom';
import { PanelCards, HOLD_MS } from '../../electron/chrome-extension/src/panelCards.mjs';
const live: any[] = [];
afterEach(() => {
  for (const f of live) f.view.render(null, []);
  live.length = 0;
  window.document.body.replaceChildren();
});
export const trusted = (event: any) => Object.defineProperty(event, 'isTrusted', { value: true });
export function fixture() {
  const document = window.document;
  const container = document.createElement('div');
  document.body.append(container);
  const calls: any[] = [],
    errors: string[] = [],
    timeouts = new Map<number, () => void>();
  let id = 0,
    answer: (p: any) => any = () => ({}),
    reads = 0;
  const timers = {
    setTimeout(fn: () => void, ms: number) {
      assert.equal(ms, HOLD_MS);
      timeouts.set(++id, fn);
      return id;
    },
    clearTimeout(i: number) {
      timeouts.delete(i);
    },
  };
  const view = new PanelCards({
    document,
    container,
    timers,
    onError: (s: string) => errors.push(s),
    onOpen: (s: string) => calls.push(['open', s]),
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      return answer(params);
    },
    onAnswered: async () => {
      reads++;
    },
  });
  const result = {
    view,
    container,
    calls,
    errors,
    timeouts,
    reply(fn: (p: any) => any) {
      answer = fn;
    },
    reads: () => reads,
  };
  live.push(result);
  return result;
}
export const card = (extra: any = {}) => ({
  id: 'request',
  version: 'v1',
  title: 'Choose',
  choices: [
    { key: 'submit', label: 'Send' },
    { key: 'deny', label: 'Deny', deny: true },
  ],
  ...extra,
});
export const click = (b: Element) => b.dispatchEvent(trusted(new window.MouseEvent('click', { bubbles: true })));
export const tick = () => new Promise((r) => setImmediate(r));
