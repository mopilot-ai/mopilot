// A chat on a machine shows the same Full-access warning as This Mac's, driven by the mode picked for that machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
let told: any = null;
let machine: any = { id: 'box', name: 'Box', away: false };
mockSource('src/session/open.ts', { openLink: () => {} });
const realSession = await import('../src/store/session/useSession.ts');
mockSource('src/store/session/useSession.ts', { ...realSession, useSessionField: (_: any, f: any) => f({ permission: told }) });
mockSource('src/lib/chatMachine.ts', { useChatMachine: () => ({ machine, pending: false }) });
const { createElement: h } = await import('react');
const { set } = await import('../src/store/core.ts');
const { FullAccessBanner } = await import('../src/components/composer/ComposerBars.tsx');
const HostFullAccessBanner = (p: { threadId: string | null; basic: string | null }) => h(FullAccessBanner, { harness: null, ...p });
const { useHostPermission } = await import('../src/components/composer/useHostPermission.ts');
function reset() {
  set((s: any) => ({ chatConfig: {}, newChatHost: null, prefs: { ...s.prefs, permission: 'default', hideFullAccessBanner: false } }));
  told = null;
  machine = { id: 'box', name: 'Box', away: false };
}
const pick = (value: string, harness = 'claude') => ({ hostPermission: { hostId: 'box', harness, value } }) as any;

test('a machine chat picked to Full access shows the banner with Learn more', async () => {
  reset();
  set({ chatConfig: { c: pick('full-access') } });
  const m = await mount(h(HostFullAccessBanner, { threadId: 'c', basic: 'host-claude' }));
  try {
    assert.ok($('.fa-banner'));
    assert.match(m.host.textContent!, /Full access is on/);
    assert.match(m.host.textContent!, /Learn more/);
  } finally {
    await m.unmount();
  }
});

test('the banner follows what the Host reported when nothing was picked, and hides for other modes', async () => {
  reset();
  told = 'full-access';
  const m = await mount(h(HostFullAccessBanner, { threadId: 'c', basic: 'host-codex' }));
  try {
    assert.ok($('.fa-banner'));
    told = null;
    await m.render(h(HostFullAccessBanner, { threadId: 'c', basic: 'host-codex' }));
    assert.equal($('.fa-banner'), null, 'the Host default is not Full access');
    set({ chatConfig: { c: pick('full-access', 'claude') } });
    await m.render(h(HostFullAccessBanner, { threadId: 'c', basic: 'host-codex' }));
    assert.equal($('.fa-banner'), null, 'a pick for another agent does not count');
  } finally {
    await m.unmount();
  }
});

test('no banner without a machine or a Host agent, and a new chat reads its draft pick', async () => {
  reset();
  set({ chatConfig: { c: pick('full-access') } });
  machine = null;
  const m = await mount(h(HostFullAccessBanner, { threadId: 'c', basic: 'host-claude' }));
  try {
    assert.equal($('.fa-banner'), null);
    machine = { id: 'box', name: 'Box', away: false };
    await m.render(h(HostFullAccessBanner, { threadId: 'c', basic: null }));
    assert.equal($('.fa-banner'), null);
    await m.render(h(HostFullAccessBanner, { threadId: null, basic: 'host-claude' }));
    assert.equal($('.fa-banner'), null);
    await m.render(h(HostFullAccessBanner, { threadId: 'c', basic: 'acp:other' }));
    assert.equal($('.fa-banner'), null);
  } finally {
    await m.unmount();
  }
  const seen: any[] = [];
  function Probe({ id, host }: { id: string | null; host: string }) {
    seen.push(useHostPermission(id, 'claude', host));
    return null;
  }
  set({ newChatHost: { id: 'box', permission: { hostId: 'box', harness: 'claude', value: 'read-only' } } } as any);
  const p = await mount(h(Probe, { id: null, host: 'box' }));
  try {
    await p.render(h(Probe, { id: null, host: 'other' }));
    assert.deepEqual([seen[0], seen[seen.length - 1]], ['read-only', 'default']);
  } finally {
    await p.unmount();
  }
});
