// Vision fallback consent on disk and in the chat, and the locate answer that finds nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { VisionFallback, VisionConsent, gatedBackend } = require('../electron/capabilities/vision/index.cjs');

test('VisionConsent: "always" is kept on disk and read back; a file without the list is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-vision-'));
  const file = path.join(dir, 'sub', 'vision.json');
  const c = new VisionConsent({ file });
  assert.equal(c.get('c', 'OpenAI'), 'unasked');
  c.set('c', 'OpenAI', 'always');
  assert.equal(c.get('other', 'OpenAI'), 'granted');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { always: ['OpenAI'] });
  assert.equal(new VisionConsent({ file }).get('x', 'OpenAI'), 'granted');
  fs.writeFileSync(file, '{}');
  assert.equal(new VisionConsent({ file }).get('x', 'OpenAI'), 'unasked');
  // an answer that isn't one of the three changes nothing
  c.set('c', 'Google', 'maybe');
  assert.equal(c.get('c', 'Google'), 'unasked');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('VisionConsent: without storage Always allow reports failure and stays unasked', () => {
  const c = new VisionConsent();
  assert.throws(() => c.set('c', 'OpenAI', 'always'), { code: 'save_failed' });
  assert.equal(c.get('d', 'OpenAI'), 'unasked');
});

test('VisionFallback.allow: a refusal is remembered for the chat and not asked again', async () => {
  const asked: any[] = [];
  const broker = { ask: async (...a: any[]) => (asked.push(a), { decision: 'deny' }) };
  const v = new VisionFallback({ backendFor: () => null, read: async () => '', broker });
  const backend = { vendor: 'OpenAI', model: 'gpt', crossVendor: true };
  assert.equal(await v.allow('c', backend, { harness: 'h', app: 'a' }), null);
  assert.equal(await v.allow('c', backend, { harness: 'h', app: 'a' }), null);
  assert.equal(asked.length, 1);
});

test('VisionFallback.locate: "found": false is no point', async () => {
  const v = new VisionFallback({ backendFor: () => null, read: async () => '{"found": false}', broker: {} });
  assert.deepEqual(await v.locate({}, { png: 'p', width: 10, height: 10 }, 'Save'), { text: '{"found": false}', point: null });
  assert.equal(
    await gatedBackend(
      () => false,
      () => ({}),
    )('c'),
    null,
  );
  assert.equal(
    await gatedBackend(
      () => true,
      (id: string) => id,
    )('c'),
    'c',
  );
});
