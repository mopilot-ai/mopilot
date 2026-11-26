// A chat opened from a machine's list (#5576, "By machine") is a chat of that machine like any other: a Claude Code or Codex chat whose agent is signed out there gets the sign-in card with its action above the composer and Send waits ("Sign in first"); one whose agent is ready is not held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

let machines: any[] = [];
const owner = 'box';
mockSource('src/lib/host.ts', { useHostAccess: () => true });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
mockSource('src/lib/hostOwner.ts', { useChatOwner: () => ({ ownerId: owner, known: true, refresh: () => undefined }) });
mockSource('src/store/core.ts', { toast: () => undefined, useStore: (sel: (s: object) => unknown) => sel({}) });
mockSource('src/store/projects.ts', { newChatHostPick: () => null });
mockSource('src/store/panes.ts', { navigate: () => undefined });
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => null });
const { createElement } = await import('react');
const { HostSigninCard } = await import('../src/components/composer/HostSigninCard.tsx');
const { useSendBlock } = await import('../src/session/useHostSigninNeed.ts');

const box = (claude: string, codex: string) => ({
  id: 'box',
  name: 'Build box',
  status: 'attention',
  note: '',
  agents: [
    { id: 'claude', label: 'Claude Code', state: claude, reason: '' },
    { id: 'codex', label: 'Codex', state: codex, reason: '' },
  ],
});

test('an opened Claude Code or Codex chat waits for its sign-in on the machine, and shows the card with the action; a ready one is not held', async () => {
  installNative(fakeNative());
  let seen: string | null | undefined;
  const Probe = ({ threadId, agent }: { threadId: string; agent: string }) => ((seen = useSendBlock(threadId, agent)), null);
  const probe = async (threadId: string, agent: string) => {
    const m = await mount(createElement(Probe, { threadId, agent }));
    await m.unmount();
    return seen;
  };
  machines = [box('signin', 'ready')];
  assert.equal(await probe('acp:host-claude:abc', 'host-claude'), 'Sign in first', 'Claude Code signed out there');
  assert.equal(await probe('acp:host-codex:abc', 'host-codex'), null, 'Codex ready there');
  machines = [box('ready', 'signin')];
  assert.equal(await probe('acp:host-claude:abc', 'host-claude'), null);
  assert.equal(await probe('acp:host-codex:abc', 'host-codex'), 'Sign in first', 'Codex signed out there');

  machines = [box('signin', 'ready')];
  const m = await mount(createElement(HostSigninCard, { threadId: 'acp:host-claude:abc', agent: 'host-claude' }));
  try {
    assert.match($('.host-signin-card').textContent ?? '', /Claude Code/);
    assert.ok($('.host-signin-card .host-signin-act'), 'the action is in the card');
    await click($('.host-signin-card .host-signin-act'));
  } finally {
    await m.unmount();
  }
});
