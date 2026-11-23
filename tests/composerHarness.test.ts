// The composer's shared destination pairs its model and permissions without reusing another ACP session's commands.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { mount } from './support/composer-kit.ts';
import { stubStore } from './support/stubs.ts';

let current: string | null = null;
let session: any = {};
// the frame between a switch to a basic harness and the store catching up: neither id has resolved (#2862)
let unresolved = false;
stubStore({ useStore: (select: any) => select({}), chatBasicHarness: () => current, newChatBasic: () => current });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => session,
    useSessionField: (id: any, pick: any) => pick(((() => session) as (id: any) => any)(id)),
  },
});
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    useComposerFirstTier: () => {
      if (unresolved) return null;
      const target = session.pendingSwitch?.harness;
      return target ? (target.startsWith('acp:') ? null : target) : current ? null : 'codex';
    },
  },
});
const { useComposerHarness } = await import('../src/session/useComposerHarness.ts');
let snapshot: ReturnType<typeof useComposerHarness>;
function Probe({ id }: { id: string | null }) {
  snapshot = useComposerHarness(id);
  return null;
}

test('current and pending basic controls keep command catalogs with their native owner', async () => {
  const commands = [{ name: 'source-only', description: 'A source command' }];
  const m = await mount(createElement(Probe, { id: null }));
  const read = async (id: string | null) => {
    await m.render(createElement(Probe, { id }));
    return snapshot;
  };
  try {
    for (const id of [null, 'chat']) {
      current = null;
      session = {};
      assert.deepEqual(await read(id), { harness: 'codex', basic: null, hint: { kind: 'codex' }, acpCommands: null });
      current = 'kimi';
      assert.equal((await read(id)).acpCommands, null);
      session = { acp: { commands } };
      assert.deepEqual(await read(id), { harness: null, basic: 'kimi', hint: { kind: 'acp:kimi' }, acpCommands: commands });
      session.pendingSwitch = { harness: 'acp:opencode' };
      assert.deepEqual(await read(id), { harness: null, basic: 'opencode', hint: { kind: 'acp:opencode' }, acpCommands: null });
      session.pendingSwitch = { harness: 'codex' };
      assert.deepEqual(await read(id), { harness: 'codex', basic: null, hint: { kind: 'codex' }, acpCommands: null });
      current = null;
      session = { pendingSwitch: { harness: 'acp:opencode' } };
      assert.deepEqual(await read(id), { harness: null, basic: 'opencode', hint: { kind: 'acp:opencode' }, acpCommands: null });
      session = {};
      unresolved = true;
      assert.deepEqual(await read(id), { harness: null, basic: null, hint: undefined, acpCommands: null });
      unresolved = false;
    }
  } finally {
    await m.unmount();
  }
});
