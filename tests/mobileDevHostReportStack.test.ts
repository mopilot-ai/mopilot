// The dev host's `momo-report` on a real phone runtime (#4822): the routine report and the setup greeting reach the phone's MoMo chat as the user-role rows the Mac sends, and `off` takes them out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';
import { authoredCard } from '../shared/authoredEnvelope.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-report-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a routine report and the setup greeting reach the phone’s MoMo chat as cards’ source rows, and off removes them', async () => {
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
  const reports = async () =>
    (await phone.ask('momo.chat.follow', { items: 20 })).items.filter((r: any) => r.role === 'user' && authoredCard(r.text));
  assert.match(await host.scenarios.run('momo-report'), /finished/);
  assert.match(await host.scenarios.run('momo-report', ['setup']), /setup greeting/);
  assert.deepEqual(
    (await reports()).map((r: any) => authoredCard(r.text)?.kind),
    ['routine', 'marked'],
  );
  assert.match(await host.scenarios.run('momo-report', ['off']), /2 reports removed/);
  assert.equal((await reports()).length, 0);
});
