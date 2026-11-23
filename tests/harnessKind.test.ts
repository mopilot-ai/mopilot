// shared/harnessKind.mjs: the one shared reader of a harness kind's spelling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKind } from '../shared/harnessKind.mjs';

test('kinds parse to their family, and a basic harness to its id (a thread suffix ignored)', () => {
  assert.deepEqual(parseKind('codex'), { family: 'codex', basic: null });
  assert.deepEqual(parseKind('claude'), { family: 'claude', basic: null });
  assert.deepEqual(parseKind('acp:kimi'), { family: 'acp', basic: 'kimi' });
  assert.deepEqual(parseKind('acp:kimi:thread-1'), { family: 'acp', basic: 'kimi' });
  for (const k of [null, undefined, '', 'codexx', 'Claude', 'gemini']) assert.equal(parseKind(k), null);
});
