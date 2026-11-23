// A basic harness's prewarm hook (electron/harness/acpPrewarm.cjs, #1664): it warms the harness's ACP process and
// never a session. A process only the prewarm started ends once its composer lets go and no chat uses it; a process
// chats already had, or one a chat opened on meanwhile, is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { acpPrewarm } = createRequire(import.meta.url)('../electron/harness/acpPrewarm.cjs');

/** AcpHost's process table: agent(harness) starts one per harness once, as the real host does. */
function fakeHost() {
  const killed: string[] = [];
  const host: any = {
    agents: new Map<string, Promise<any>>(),
    chats: new Map<string, any>(),
    starting: new Map<string, Promise<void>>(),
    started: 0,
    agent(harness: string) {
      let p = host.agents.get(harness);
      if (!p) {
        host.started++;
        p = Promise.resolve({ harness, kill: () => void killed.push(harness) });
        host.agents.set(harness, p);
      }
      return p;
    },
  };
  return { host, killed };
}

function rig() {
  const { host, killed } = fakeHost();
  const timers: (() => void)[] = [];
  const hook = acpPrewarm({ host, timers: { setTimeout: (fn: () => void) => (timers.push(fn), { unref() {} }) } });
  const fire = async () => {
    for (const fn of timers.splice(0)) fn();
    await new Promise((r) => setImmediate(r));
  };
  return { host, killed, hook, fire };
}

test('one process per harness: the key is the harness, and warming starts it without a session', async () => {
  const { host, hook } = rig();
  assert.equal(hook.key({ kind: 'acp:opencode' }), 'opencode');
  const h = await hook.warm({ kind: 'acp:opencode' });
  assert.equal(h.harness, 'opencode');
  assert.equal(h.started, true);
  assert.equal(host.started, 1);
  assert.equal(host.chats.size, 0);
  assert.equal(hook.claim, undefined, 'a send finds the process through agent() itself');
  assert.equal(hook.valid(h), true);
  // it exited (onAgentExit forgets it): warmed again on the next hint
  host.agents.delete('opencode');
  assert.equal(hook.valid(h), false);
  assert.throws(() => hook.key({ kind: 'acp:' }));
});

test('a process only the prewarm started ends after the grace once no chat uses it', async () => {
  const { host, killed, hook, fire } = rig();
  const h = await hook.warm({ kind: 'acp:opencode' });
  hook.dispose(h);
  assert.deepEqual(killed, [], 'not before the grace');
  await fire();
  assert.deepEqual(killed, ['opencode']);
  assert.equal(host.agents.has('opencode'), false);
});

test('A4: a chat that opened (or is opening) on it within the grace keeps it', async () => {
  const { host, killed, hook, fire } = rig();
  const h = await hook.warm({ kind: 'acp:opencode' });
  hook.dispose(h);
  host.chats.set('acp:opencode:c1', { harness: 'opencode' });
  await fire();
  host.chats.clear();
  const h2 = await hook.warm({ kind: 'acp:kimi' });
  hook.dispose(h2);
  host.starting.set('acp:kimi:c2', Promise.resolve());
  await fire();
  assert.deepEqual(killed, []);
});

test("a process chats already had is theirs, and one that another took the place of isn't ended", async () => {
  const { host, killed, hook, fire } = rig();
  await host.agent('opencode');
  const had = await hook.warm({ kind: 'acp:opencode' });
  assert.equal(had.started, false);
  hook.dispose(had);
  await fire();
  const h = await hook.warm({ kind: 'acp:kimi' });
  hook.dispose(h);
  // the old one exited and a new one started for a chat meanwhile
  host.agents.set('kimi', Promise.resolve({ kill: () => void killed.push('other') }));
  await fire();
  assert.deepEqual(killed, []);
});

test('a kill that throws is noted, not thrown into the timer', async () => {
  const { host, hook, fire } = rig();
  const h = await hook.warm({ kind: 'acp:opencode' });
  const agent = await h.entry;
  agent.kill = () => {
    throw new Error('gone');
  };
  hook.dispose(h);
  await fire();
  assert.equal(host.agents.has('opencode'), false);
});

test('the defaults: a real, unref’d timer', async () => {
  const { host } = fakeHost();
  const hook = acpPrewarm({ host, graceMs: 1 });
  hook.dispose(await hook.warm({ kind: 'acp:opencode' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(host.agents.has('opencode'), false);
});

test('A4: a composer still counting on the process keeps it (the same one back on Home, or another window); the last one lets it go', async () => {
  const { host, killed, hook, fire } = rig();
  const first = await hook.warm({ kind: 'acp:opencode' });
  hook.dispose(first);
  // back on Home within the grace: this prewarm finds the process running
  const again = await hook.warm({ kind: 'acp:opencode' });
  assert.equal(again.started, false);
  await fire();
  assert.deepEqual(killed, [], 'kept while a composer counts on it');
  assert.equal(host.agents.has('opencode'), true);
  // two windows: one lets go, the other still holds it
  const other = await hook.warm({ kind: 'acp:opencode' });
  hook.dispose(again);
  await fire();
  assert.deepEqual(killed, []);
  hook.dispose(other);
  await fire();
  assert.deepEqual(killed, ['opencode'], 'the last composer to let go ends the process a prewarm started');
});
