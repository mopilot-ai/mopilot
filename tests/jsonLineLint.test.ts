// The newline-loop guard flags growing-prefix scans and accepts linear scans and one-off lookups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('the JSON-line lint guard catches both quote forms and preserves safe offset scans', () => {
  const report = lintFixtures({
    'electron/input.cjs': String.raw`
      let buf = '', i;
      input.on('data', chunk => { buf += chunk; while ((i = buf.indexOf('\n')) >= 0) { buf = buf.slice(i + 1); } });
      function bad(chunk) { this.buf += chunk; while ((i = this.buf.indexOf("\n")) >= 0) { this.buf = this.buf.slice(i + 1); } }
      function good(chunk) { let at = 0; while ((i = chunk.indexOf('\n', at)) >= 0) { at = i + 1; } }
      const first = buf.indexOf('\n');
      while ((i = buf.indexOf('x')) >= 0) { buf = buf.slice(i + 1); }
    `,
  });
  const findings = report.diagnostics.filter((d) => String(d.message).includes('[json-line-rescan]'));
  assert.equal(findings.length, 2, JSON.stringify(report));
});
