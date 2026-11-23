// MoMo's brain is never a harness that can't be confined (#2278): admission says which basic harnesses isolate, MoMo's
// kinds keep only those, and MoMo's service refuses another, and any start in a workspace an instructions file loads from.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-brain-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const folder = () => fs.mkdtempSync(path.join(tmp, 'f-'));

test('only a harness whose quirks have isolation isolates', () => {
  const quirks = require('../electron/harness/quirks/index.cjs');
  assert.equal(quirks.isolates('opencode'), true);
  for (const id of ['kimi', 'qwen', 'gemini', 'goose', 'copilot', 'cursor', 'dsh', 'nope']) assert.equal(quirks.isolates(id), false, id);
});

test('admission lists whether each harness isolates; MoMo’s kinds keep only those', () => {
  const { Admission } = require('../electron/harness/admission.cjs');
  const { harnessKinds } = require('../electron/app/momo.cjs');
  const a = new Admission({
    ids: ['opencode', 'kimi'],
    file: path.join(folder(), 'admission.json'),
    quirks: (id: string) => ({ label: id, ...(id === 'opencode' ? { isolation: {} } : {}) }),
    resolveBin: () => null,
  });
  assert.deepEqual(
    a.list().map((h: any) => [h.id, h.isolates]),
    [
      ['opencode', true],
      ['kimi', false],
    ],
  );
  const admitted = { list: () => ['opencode', 'kimi', 'gemini'].map((id) => ({ id, state: 'admitted' })) };
  assert.deepEqual(harnessKinds(admitted), ['claude', 'codex', 'acp:opencode']);
});

test('MoMo refuses a brain it can’t confine', () => {
  const { assertConfinable } = require('../electron/momo/apart.cjs');
  for (const kind of ['claude', 'codex', 'acp:opencode']) assertConfinable(kind, kind, { OPENAI_API_KEY: 'k' });
  assert.throws(() => assertConfinable('acp:kimi', 'Kimi Code'), { code: 'unconfined', message: /^Kimi Code can't be MoMo's brain/ });
});
