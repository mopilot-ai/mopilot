// IPC for MoMo's gate (electron/app/ipc/momo.cjs): the windows read main's answer, false until the gate opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { register } = require('../electron/app/ipc/momo.cjs');
const access = require('../electron/momo/access.cjs');

test('momo:access answers what the gate says now', async () => {
  const handlers = new Map<string, () => unknown>();
  register({ handle: (ch: string, fn: () => unknown) => void handlers.set(ch, fn) });
  assert.deepEqual([...handlers.keys()], ['momo:access']);
  const ask = handlers.get('momo:access')!;
  assert.equal(await ask(), false, 'closed before the gate opens');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ipc-'));
  const gate = access.openMomoAccess({ file: path.join(dir, 'a.json'), refresh: () => {} });
  access.updateMomoAccess({ signedIn: true, user: { id: 'u1', features: ['momo'] }, checkedAt: Date.now() });
  assert.equal(await ask(), true);
  access.updateMomoAccess({ signedIn: false, user: null });
  assert.equal(await ask(), false);
  gate.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});
