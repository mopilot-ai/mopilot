// The React binding for the Live Activity controller: it shows the controller's state and follows its changes until unmounted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
const hookPath = '../mobile/src/push/useLiveActivityUi';
const { useLiveActivityUi } = await import(hookPath);

test('the hook reads the controller, follows its changes and stops following when unmounted', async () => {
  let ui: any = { prefs: { enabled: false, titles: false }, status: 'off', failed: false };
  const listeners = new Set<() => void>();
  const activity: any = {
    ui: () => ui,
    subscribe: (f: () => void) => (listeners.add(f), () => void listeners.delete(f)),
  };
  const seen: string[] = [];
  const Probe = () => {
    const current = useLiveActivityUi(activity);
    seen.push(`${current.status}/${current.prefs.enabled}`);
    return createElement('span', null, current.status);
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  await flush();
  assert.equal(host.textContent, 'off');
  assert.equal(listeners.size, 1);
  await act(async () => {
    ui = { prefs: { enabled: true, titles: false }, status: 'on', failed: false };
    listeners.forEach((f) => f());
  });
  assert.equal(host.textContent, 'on');
  assert.ok(seen.includes('on/true'));
  await act(async () => root.unmount());
  assert.equal(listeners.size, 0);
  host.remove();
});
