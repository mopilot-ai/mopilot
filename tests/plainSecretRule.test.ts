// The plain-secret lint guard (lint/rules/plain-secret.grit): a sign-in, key, token, password or credential file
// written straight to disk warns; a store's own (already encrypted) file and unrelated files do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFixtures } from '../scripts/biome-fixtures.mjs';

test('a secret file written as it is warns; writeSecret, a store’s own file and other files stay valid', () => {
  for (const [input, expected] of [
    ["writePrivate(path.join(home, 'auth.json'), text);", 1],
    ["fs.writeFileSync(path.join(dir, 'claude-api-key'), key);", 1],
    ["writeAtomic(path.join(userData, 'gateway_token.txt'), t);", 1],
    ['fs.appendFileSync(`${dir}/passwords.log`, line);', 1],
    ["await fsp.writeFile(path.join(d, 'credentials.json'), body);", 1],
    ["fs.appendFile(path.join(d, 'SECRET'), v, done);", 1],
    ["writeSecret(path.join(userData, 'claude-api-key.json'), key, safe);", 0],
    ['writePrivate(this.file, JSON.stringify(list));', 0],
    ['writePrivate(path.join(home, PLAIN), text);', 0],
    ["fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = \"file\"');", 0],
    ["writeAtomic(path.join(userData, 'ui-state.json'), s);", 0],
  ] as const) {
    const report = lintFixtures({ 'electron/store.cjs': `${input}\n` });
    const hits = report.diagnostics.filter((d) => d.message.includes('[plain-secret]'));
    assert.equal(hits.length, expected, input);
  }
});
