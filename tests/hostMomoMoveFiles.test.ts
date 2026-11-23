// What a move carries (S6/S7): the day record, the push record, the scheduler's ticks, the taint list and the prefs are sealed with MoMo's own data key, the one a move hands to the new Host, so every one of them opens on the target; and no MoMo store but the Host's own files is sealed with the Host's key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createMomoDaily, dailySettingsOf } from '../host/src/momoDaily.mjs';
// @ts-ignore
import { pushWiringFor } from '../host/src/pushWiring.mjs';
// @ts-ignore
import { createPolicy } from '../host/src/policy.mjs';
// @ts-ignore
import { moveHome } from '../shared/momoMove.mjs';
import { A, B, host, studio } from './support/host/momoMoveWorld.ts';

const require = createRequire(import.meta.url);
const { SealedJson } = require('../electron/gateway/sealedFile.cjs');

const open = (h: any, name: string) =>
  new SealedJson({ file: path.join(h.momoDir, name), safeStorage: h.home.data.safeStorage, shape: (v: any) => v });

test('the day, push and prefs records a Host wrote open on the Host a move hands the home to', async (t) => {
  const a = await studio(t);
  const b = await host(t, B);
  const home = a.home;
  // prefs
  await home.prefs.change({ paused: false, quietHours: null, notify: { previews: true } });
  // the day: a brief delivered leaves the day record
  const daily = createMomoDaily({
    home,
    settings: () => dailySettingsOf(home.prefs.forRoutines()),
    now: a.clock.now,
    report: () => undefined,
    seams: { build: () => ({ text: 'plain' }), deliver: () => undefined },
  });
  await daily.briefNow();
  // push: a held or sent push leaves the push record
  const dir = a.dir;
  const sent: any[] = [];
  const relay = {
    pushTargets: () => [{ hostId: 'h1', pairId: 'pair1' }],
    push: async (_h: string, req: any) => (sent.push(req), 'sent'),
  };
  const wiring = pushWiringFor({ policy: createPolicy({ dataDir: dir }), relay, machineName: () => 'studio', now: a.clock.now });
  const notify = wiring.momoNotify(home);
  await notify({ kind: 'needsYou', chatId: 'claude:00000000-0000-4000-8000-0000000000c1', card: { requestId: 'r1' } });
  assert.equal(sent.length, 1);
  for (const name of ['daily.json', 'push.json', 'prefs.json']) assert.ok(fs.existsSync(path.join(a.momoDir, name)), `${name} is written`);

  const r = await moveHome({ moveId: 'move-0001', from: a.side, to: b.side, target: B, fromName: A.name });
  assert.equal(r.ok, true);
  // each opens with the key the target now holds
  assert.equal(b.home.prefs.get().notify.previews, true);
  for (const name of ['daily.json', 'push.json', 'prefs.json']) assert.ok(open(b, name).read(), `${name} opens on the target`);
  assert.deepEqual(Object.keys(open(b, 'daily.json').read().briefs).length, 1);
});

test('no MoMo store that travels is sealed with the Host’s own key', () => {
  // the Host's own files stay (grant, home, chats, stamps); everything else a MoMo module writes is MoMo's and goes with the home
  const dir = path.join(import.meta.dirname, '..', 'host', 'src');
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir).filter((n) => /^(momo.*|pushWiring)\.mjs$/.test(n))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/new SealedJson\(\{[^}]*?file[^}]*?\}/gs)) {
      const body = m[0];
      if (!/safeStorage:\s*(home\.storage|storage)\.safeStorage/.test(body)) continue;
      // momoChats' registry (chats.json) and momoHome's grant/home files are the Host's own
      if (
        /chats\.json|registry/.test(src.slice(Math.max(0, m.index - 120), m.index + body.length)) ||
        (f === 'momoHome.mjs' && /\bname\b/.test(body))
      )
        continue;
      offenders.push(`${f}: ${body.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
