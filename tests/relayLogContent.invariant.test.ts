// What the relay may write to its log: ids, codes, counts and error messages, never content. Every log call in relay/src names its fields here, and the only places that print are the process entry and the process guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/** the folders whose change can break this test without an import edge */
export const GUARDS = ['relay/src/'];

const dir = new URL('../relay/src/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
const source = (f: string) => readFileSync(new URL(f, dir), 'utf8');

/** device and pair ids, the first ten characters of a boot id (checked against its pattern before it is kept: `b_` and base64url), close and error codes, counts, ports and signals, and for a dry run the platform, the kind's fixed title and the size of the payload, and for a push the outcome and the provider's own HTTP status and short reason word (cut to 64 characters): nothing a client sent as content. */
const FIELDS = new Set([
  'device',
  'pair',
  'kind',
  'code',
  'message',
  'error',
  'pairs',
  'port',
  'signal',
  'platform',
  'title',
  'bytes',
  'provider',
  'reason',
  'attempt',
  'sockets',
  'outcome',
  'environment',
  'topic',
  'at',
  'apns',
  'boot',
]);

test('every log call in relay/src names only fields that cannot carry content', () => {
  const seen: string[] = [];
  for (const f of files) {
    const text = source(f);
    for (const m of text.matchAll(/\blog\??\.?\(\s*'(\w+)'\s*,\s*\{([^}]*)\}/g)) {
      const fields = m[2]
        .split(',')
        .map((x) => x.trim().split(':')[0].trim())
        .filter(Boolean);
      seen.push(`${f}: ${m[1]}`);
      for (const field of fields)
        assert.ok(FIELDS.has(field), `${f} logs '${m[1]}' with field '${field}': add it to FIELDS only if it can never hold content`);
    }
  }
  assert.ok(seen.length >= 10, `the scan found ${seen.length} log calls; the pattern no longer matches the code`);
});

test('only the process entry and the process guards print', () => {
  const printing = files.filter((f) => /\bconsole\.(log|error|warn|info|debug)\b/.test(source(f))).sort();
  assert.deepEqual(printing, ['main.mjs', 'processGuards.mjs']);
});

test('errors are logged through messageOf (bounded), never as a raw message or an error object', () => {
  for (const f of files) {
    const text = source(f);
    assert.doesNotMatch(text, /message:\s*String\(/, `${f} logs an unbounded message`);
    assert.doesNotMatch(text, /\blog\??\.?\(\s*'\w+'\s*,\s*\{[^}]*\b(error|message):\s*e\b/, `${f} logs an error object`);
  }
});
