// The epoch of a chat's owner as main reads it (electron/host/machines.cjs epochReader): what the ownership file holds, read again each time; a chat nobody claimed is epoch 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { epochReader } = require('../electron/host/machines.cjs');
const { OwnershipStore } = require('../electron/host/ownership.cjs');

test('epochReader gives the epoch the ownership file holds, read again each time; a chat nobody claimed is epoch 0', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'machines-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const epochOf = epochReader(dir);
  assert.equal(epochOf('c1'), 0);
  new OwnershipStore(path.join(dir, 'host-ownership.json')).set('c1', { hostId: 'h1', ownerHostId: 'h1', epoch: 4, folder: null });
  assert.equal(epochOf('c1'), 4);
});
