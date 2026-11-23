// The composer's note for a new chat in a folder on a machine (HostAgentNote): what is offered and said comes from the machine's readiness, and Sign in goes to that machine.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const PICK = { id: 'ssh:mini', name: 'mini', path: '/Users/u/app' };
const sets: any[] = [];
const toasts: unknown[][] = [];
let view: any = null;
mockSource('src/store/core.ts', { set: (p: any) => void sets.push(p), toast: (...a: unknown[]) => void toasts.push(a) });
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => view });
const { createElement } = await import('react');
const { HostAgentNote } = await import('../src/components/composer/HostAgentNote.tsx');

const agent = (id: string, label: string, state: string, reason = '') => ({ id, label, state, reason });
const _claudeReady = agent('claude', 'Claude Code', 'ready');
const _codexOut = agent('codex', 'Codex', 'signin', 'Sign in on mini');

beforeEach(() => {
  sets.length = 0;
  toasts.length = 0;
  view = null;
});

test("the note says why the blocked agent can't run and never signs in itself: the sign-in card above the composer does", async () => {
  const fake = fakeNative({ host: { signin: async () => ({}) } });
  installNative(fake);
  const machine = { id: PICK.id, name: 'mini', signin: 'claude' };
  const m = await mount(
    createElement(HostAgentNote, {
      view: { machine, choice: { note: 'Claude Code: Sign in on mini; new chats start in Codex', blocked: { id: 'claude' } } } as any,
    }),
  );
  try {
    assert.match(m.host.textContent!, /Claude Code: Sign in on mini; new chats start in Codex/);
    assert.equal(m.host.querySelector('button'), null);
    assert.deepEqual(fake.callsTo('host.signin'), []);
    // nothing stands in for the signed-out agent: the card above the composer speaks for it, so the note is not drawn
    await m.render(
      createElement(HostAgentNote, {
        view: {
          machine,
          choice: {
            harness: null,
            note: 'Claude Code: Sign in on mini. No agent is ready on mini',
            blocked: { id: 'claude', state: 'signin' },
          },
        },
      } as any),
    );
    assert.equal(m.host.textContent, '');
    // another agent stands in: the card says new chats start in it meanwhile, so the note is not drawn either (no second line saying the same)
    await m.render(
      createElement(HostAgentNote, {
        view: {
          machine,
          choice: {
            harness: 'codex',
            note: 'Claude Code: Sign in on mini; new chats start in Codex',
            blocked: { id: 'claude', state: 'signin' },
          },
        },
      } as any),
    );
    assert.equal(m.host.textContent, '');
    // one that only lacks an install keeps its note
    await m.render(
      createElement(HostAgentNote, {
        view: { machine, choice: { harness: null, note: 'Codex: Not installed on mini', blocked: { id: 'codex', state: 'missing' } } },
      } as any),
    );
    assert.match(m.host.textContent!, /Not installed on mini/);
  } finally {
    await m.unmount();
  }
});
