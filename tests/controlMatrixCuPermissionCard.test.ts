// Control-matrix case for the in-chat permission card (group H, capability health): a Request or Try again
// that leaves the macOS permission off says so and names the next step, for a Claude Code or Codex chat
// (edge3 cu-not-running, E-C3: a stale grant for an older helper build shows no prompt and nothing changed).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { window } from './support/dom.ts';
import * as react from 'react';
import { iconStubs, mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

export const GUARDS = ['src/'];

const fx = {
  harness: 'Claude Code',
  calls: [] as string[],
  granted: false,
};
stubStore({ chatHarnessLabel: () => fx.harness });
installNativeStub({
  computer: {
    status: async () => (fx.calls.push('status'), { permissions: { accessibility: true, screenRecording: fx.granted } }),
    requestPermission: async () => (fx.calls.push('requestPermission'), fx.granted),
    recheck: async () => (fx.calls.push('recheck'), fx.granted),
    openSettings: async () => true,
    onChanged: () => () => {},
  },
});
mockSource('src/components/ui/icons.tsx', iconStubs());
const { act, createElement } = react;
const { createRoot } = await import('react-dom/client');
const { ComputerPermissionCard } = await import('../src/components/thread/ComputerPermissionCard.tsx');
const { copy } = await import('../src/harness/copy.ts');
const { onboarding } = createRequire(import.meta.url)('../electron/capabilities/tools/desktopUtil.cjs');

let root: any = null;
let container: HTMLElement;
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = null;
  container?.remove();
  fx.calls = [];
  fx.granted = false;
});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function click(el: Element | null | undefined) {
  assert.ok(el, 'element exists');
  const e = new window.MouseEvent('click', { bubbles: true, cancelable: true }) as any;
  Object.defineProperty(e, 'isTrusted', { value: true });
  await act(async () => {
    el!.dispatchEvent(e);
  });
  await flush();
}
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label);

const STILL_OFF =
  'macOS still reports Screen Recording unavailable to "MoPilot". Already on? It may still belong to an older copy of "MoPilot": in Screen Recording, select "MoPilot", remove it with −, add it again with +, then try again. If access is still unavailable, restart your Mac before trying again.';

test('CM-H18: an enabled switch with unavailable effective access gets the same recovery in model and UI guidance', () => {
  for (const [permission, label] of [
    ['accessibility', 'Accessibility'],
    ['screenRecording', 'Screen Recording'],
    ['inputMonitoring', 'Input Monitoring'],
  ]) {
    const ui = copy('computerUse', 'permissionStillOff', { Permission: label });
    const model = onboarding(permission);
    assert.match(ui, new RegExp(`macOS still reports ${label} unavailable`));
    assert.match(ui, /Already on\?/);
    assert.match(ui, /select "MoPilot", remove it with −, add it again with \+/);
    assert.match(ui, /restart your Mac before trying again/);
    assert.ok(model.includes(ui), 'the model receives the recovery shown to the user');
    assert.doesNotMatch(model, /has not given/);
    assert.doesNotMatch(ui, /Still off/);
  }
});

test('CM-H18: a Request or Try again on the permission card that leaves the permission off says so and names the next step, in a Claude Code or Codex chat', async () => {
  for (const harness of ['Claude Code', 'Codex', 'ACP']) {
    fx.harness = harness;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(ComputerPermissionCard, { threadId: 't1', permission: 'screenRecording' })));
    await flush();
    const card = container.querySelector('.cu-permission')!;
    assert.match(card.textContent!, new RegExp(`^Allow Screen Recording so ${harness} can see the screen\\.`));
    assert.equal(
      card.querySelector('.cu-guide-text > div')!.textContent,
      `Allow Screen Recording so ${harness} can see the screen.`,
      'the first card does not offer a competing, unnamed remove-app instruction',
    );
    const before = card.textContent;
    const hint = () => card.querySelector('.cu-permission-still')?.textContent;
    assert.equal(hint(), undefined);
    // every offered action does something visible: Request and Try again that change nothing explain why
    for (const label of ['Request', 'Try again']) {
      fx.calls = [];
      await click(button(label));
      assert.ok(fx.calls.includes('recheck'), `${harness}: ${label} looks again`);
      assert.notEqual(card.textContent, before, `${harness}: ${label} changed something visible`);
      assert.equal(hint(), STILL_OFF, `${harness}: ${label}`);
    }
    // once the permission is on, no hint (main takes the card down)
    fx.granted = true;
    await click(button('Try again'));
    assert.equal(hint(), undefined);
    await act(async () => root.unmount());
    root = null;
    container.remove();
    fx.granted = false;
  }
});
