// In-memory credential-lifetime fixtures: synthetic transports, no browser, credential store, network or native work.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
export { deferred } from '../support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { Tab } = require('../../electron/capabilities/browser/tab.cjs');
const { CredentialHandoff, requestCredentials } = require('../../electron/capabilities/browser/credentials.cjs');
export const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
export function fixture() {
  const wc: any = new EventEmitter();
  wc.debugger = new EventEmitter();
  wc.isDestroyed = () => false;
  wc.isLoadingMainFrame = () => false;
  const sent: string[] = [];
  wc.debugger.sendCommand = async (method: string) => {
    sent.push(method);
    return {};
  };
  const tab: any = {
    id: 'synthetic',
    wc,
    backend: wc,
    url: 'https://approved.example/login',
    frames: new Map(),
    host: { o: {} },
    attach: async () => {},
    check() {},
    send: Tab.prototype.send,
    agent: async (op: string) =>
      op === 'credentialFields'
        ? { origin: 'https://approved.example', fields: [{ ref: 'f1', kind: 'password', label: 'Password' }] }
        : op === 'credentialFocus'
          ? { ok: true }
          : { length: 1, submitted: true },
  };
  const tabs: any = { run: (_tab: any, fn: any) => fn(), ready: async () => {}, settle: async () => {}, o: {} };
  const handoff = new CredentialHandoff();
  const start = (submit = false, signal?: AbortSignal) =>
    requestCredentials({ tabs, handoff }, tab, { submit }, { chatId: 'synthetic', signal });
  const answer = () => {
    const item = handoff.list()[0];
    assert.ok(item);
    handoff.answer(item.id, { action: 'fill', values: { password: 'NONSECRET_TEST_SENTINEL' } });
  };
  return { wc, tab, tabs, handoff, sent, start, answer };
}
export function actualAgent(h: ReturnType<typeof fixture>, onSend: (method: string, params: any, sid: string) => any = () => undefined) {
  const real = new Tab({ o: {}, emit() {} }, { id: 'synthetic', chatId: 'synthetic', wc: h.wc });
  real.world = 1;
  real.attach = h.tab.attach;
  real.check = h.tab.check;
  h.tab.agent = real.agent.bind(real);
  h.wc.debugger.sendCommand = async (method: string, params: any, sid: string) => {
    h.sent.push(method);
    const response = onSend(method, params, sid);
    if (response !== undefined) return response;
    if (method === 'Runtime.evaluate') {
      assert.ok(!params.expression.includes('NONSECRET_TEST_SENTINEL'));
      const value = params.expression.includes('credentialFields')
        ? { origin: 'https://approved.example', fields: [{ ref: 'f1', kind: 'password', label: 'Password' }] }
        : { ok: true, length: 1, submitted: true };
      return { result: { value: { value } } };
    }
    return {};
  };
  return real;
}
export const moved = (h: ReturnType<typeof fixture>) => h.wc.emit('did-start-navigation', {}, h.tab.url, false, true);
export const clean = (h: ReturnType<typeof fixture>) => {
  for (const event of ['did-start-navigation', 'destroyed', 'render-process-gone']) assert.equal(h.wc.listenerCount(event), 0);
  assert.equal(h.handoff.list().length, 0);
};
