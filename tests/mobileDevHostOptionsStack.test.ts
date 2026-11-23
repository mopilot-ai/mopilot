// The dev host's `momo-options` on a real phone runtime (issue #5021): the question reaches the phone's MoMo chat as an assistant row with `options` and no line in its text, and `off` takes it out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-options-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a question with answer chips reaches the phone’s MoMo chat with its options, and off removes it', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'one'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr, 'Test iPhone');
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await host.scenarios.run('momo', ['on']);
  const asked = async () => (await phone.ask('momo.chat.follow', { items: 20 })).items.filter((r: any) => r.options);
  assert.match(await host.scenarios.run('momo-options'), /three answers/);
  const [row] = await asked();
  assert.deepEqual([row.role, row.text, row.options], ['assistant', 'Shall I move your 3 pm?', ['Yes', 'No', 'Not now']]);
  assert.match(await host.scenarios.run('momo-options', ['off']), /1 question/);
  assert.equal((await asked()).length, 0);
});
