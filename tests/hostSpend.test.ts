// The Host's spend counter (host/src/spend.mjs, plan U5): totals per chat and per day, unpriced turns, persistence, the check before a turn starts, and the chat's lane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createSpend } from '../host/src/spend.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-spend-'));
const M = 1_000_000;
// 1M input + 1M output of claude-sonnet-4 = $3 + $15
const turn = (extra = {}) => ({ model: 'claude-sonnet-4-5', inputTokens: M, outputTokens: M, ...extra });
const make = (o: any = {}) => {
  const patches: any[] = [];
  let limits: any = o.limits ?? {};
  let t = o.now ?? Date.UTC(2026, 10, 15, 12);
  const spend = createSpend({
    dataDir: o.dataDir,
    limits: () => limits,
    now: () => t,
    state: (chatId: string, patch: any) => patches.push([chatId, patch]),
    report: o.report,
  });
  return { spend, patches, setLimits: (l: any) => (limits = l), setNow: (n: number) => (t = n) };
};

test('a turn is priced at list price into the chat and the day; the status and the lane say so', () => {
  const { spend, patches } = make({ limits: { chatUsd: 100 } });
  spend.record('c1', turn());
  spend.record('c1', turn());
  spend.record('c2', turn());
  assert.deepEqual(spend.status(), { dayUsd: 54, dayLimitUsd: null, unpriced: 0 });
  assert.deepEqual(spend.lane('c1'), { usd: 36, limitUsd: 100 });
  assert.deepEqual(spend.lane('nobody'), { usd: 0, limitUsd: 100 });
  assert.deepEqual(patches.at(-1), ['c2', { spend: { usd: 18, limitUsd: 100 } }]);
});

test('a turn with no usage report, or a model not in the table, adds nothing and is counted unpriced', () => {
  const { spend } = make();
  spend.record('c1', undefined);
  spend.record('c1', turn({ model: 'brand-new-model' }));
  spend.record('c1', turn({ model: undefined }));
  assert.deepEqual(spend.status(), { dayUsd: 0, dayLimitUsd: null, unpriced: 3 });
  spend.check('c1');
});

test('a model the chat asked for prices a turn that names none; the owner can add prices', () => {
  const { spend, setLimits } = make();
  spend.notePick('c1', 'gpt-5-codex');
  spend.notePick('c1', undefined);
  spend.record('c1', { inputTokens: M, outputTokens: M });
  assert.equal(spend.lane('c1').usd, 11.25);
  setLimits({ prices: { 'house-model': { input: 1, output: 1 } } });
  spend.record('c3', { model: 'house-model', inputTokens: M });
  assert.equal(spend.lane('c3').usd, 1);
});

test('totals survive a restart; the day starts again in the owner’s zone; a chat’s own total stays', () => {
  const dataDir = tmp();
  const a = make({ dataDir, limits: { tz: 'America/Los_Angeles' } });
  a.spend.record('c1', turn());
  assert.equal(fs.statSync(path.join(dataDir, 'spend.json')).mode & 0o777, 0o600);
  const b = make({ dataDir, limits: { tz: 'America/Los_Angeles' } });
  assert.equal(b.spend.status().dayUsd, 18);
  assert.equal(b.spend.lane('c1').usd, 18);
  // 12:00 UTC on the 15th is the 15th in Los Angeles; at 07:59 UTC on the 16th it is still the 15th, at 08:00 the 16th
  b.setNow(Date.UTC(2026, 10, 16, 7, 59));
  assert.equal(b.spend.status().dayUsd, 18);
  b.setNow(Date.UTC(2026, 10, 16, 8, 0));
  assert.equal(b.spend.status().dayUsd, 0);
  assert.equal(b.spend.lane('c1').usd, 18, 'the chat’s lifetime total does not roll over');
});

test('a corrupt or foreign store starts again and is reported once', () => {
  const dataDir = tmp();
  const seen: string[] = [];
  fs.writeFileSync(path.join(dataDir, 'spend.json'), '{nope');
  assert.equal(make({ dataDir, report: (m: string) => seen.push(m) }).spend.status().dayUsd, 0);
  assert.equal(seen.length, 1);
  fs.writeFileSync(path.join(dataDir, 'spend.json'), JSON.stringify({ hello: 1 }));
  assert.equal(make({ dataDir, report: (m: string) => seen.push(m) }).spend.status().dayUsd, 0);
  assert.equal(seen.length, 1, 'a file with another shape is not an error to report');
  assert.equal(make({ dataDir: tmp() }).spend.status().dayUsd, 0, 'no file yet is not one either');
});

test('the check refuses the next turn at the day limit, then the chat limit, naming the key, limit and spend', () => {
  const { spend, patches, setLimits } = make({ limits: { dayUsd: 60, chatUsd: 20 } });
  spend.record('c1', turn());
  spend.check('c1');
  spend.record('c1', turn());
  assert.throws(
    () => spend.check('c1'),
    (e: any) =>
      e.code === 'spend_limit' &&
      e.details.key === 'chatUsd' &&
      e.details.limitUsd === 20 &&
      e.details.spentUsd === 36 &&
      /in this chat/.test(e.message),
  );
  assert.deepEqual(patches.at(-1)[1].attention, { kind: 'limit' });
  spend.check('c2');
  spend.record('c2', turn());
  spend.record('c2', turn());
  assert.throws(
    () => spend.check('c3'),
    (e: any) => e.details.key === 'dayUsd' && /today/.test(e.message),
    'the whole Host is over for a chat with nothing spent',
  );
  setLimits({});
  spend.check('c1');
});

test('a limit that holds a chat is remembered, and raising it frees the chat and clears its attention', () => {
  const { spend, patches, setLimits } = make({ limits: { dayUsd: 10 } });
  spend.record('c1', turn());
  assert.equal(spend.holds('c1'), true);
  assert.equal(spend.holds('c2'), true, 'a chat that never ran is held too, and found when the limit is raised');
  assert.deepEqual(spend.reevaluate(), [], 'still over: nothing is freed, attention is told again');
  setLimits({ dayUsd: 50 });
  assert.deepEqual(spend.reevaluate().sort(), ['c1', 'c2']);
  assert.deepEqual(patches.filter(([id]) => id === 'c1').at(-1)[1].attention, null);
  assert.equal(spend.holds('c1'), false);
  assert.deepEqual(spend.reevaluate(), []);
});

test('forget drops a chat’s total, not the day’s; only the newest chats are kept', () => {
  const { spend } = make();
  spend.notePick('c1', 'gpt-5');
  spend.record('c1', turn());
  spend.forget('c1');
  assert.equal(spend.lane('c1').usd, 0);
  assert.equal(spend.status().dayUsd, 18);
  for (let i = 0; i < 5003; i++) spend.record(`k${i}`, { model: 'gpt-5', inputTokens: M });
  assert.equal(spend.lane('k0').usd, 0, 'the oldest total was dropped');
  assert.ok(spend.lane('k5002').usd > 0);
});
