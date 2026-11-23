// The mixed-harness MoMo handoff spec seeds a main-readable Codex login and completed setup before testing confinement.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const options: any[] = [];
const cases: { title: string; run: unknown }[] = [];
const registration = Object.assign((title: string, run: unknown) => cases.push({ title, run }), {
  use: (value: unknown) => options.push(value),
});
const app = mock.module('./e2e/fixtures/app.ts', {
  namedExports: { test: registration, expect: () => assert.fail('registration must not drive the app') },
});
after(() => app.restore());
await import('./e2e/momo-handoff-confine.spec.ts');
const require = createRequire(import.meta.url);
const { readAuth } = require('../electron/identity/accounts/records.cjs');
const { codexInstance } = require('../electron/identity/drivers/codex.cjs');

test('the actual mixed handoff registration supplies both account identity and setup preconditions without launching its journey', (t) => {
  assert.equal(cases.length, 1);
  assert.equal(typeof cases[0].run, 'function');
  assert.equal(options.length, 1);
  const config = options[0];
  assert.equal(config.harnesses, 'both');
  assert.equal(typeof config.seed?.files, 'function', 'native fake status alone is not a main-domain login');
  assert.equal(config.seed.uiState.prefs.momo.onboarding.done, true, 'the handoff case owns a completed-setup precondition');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-handoff-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dirs = Object.fromEntries(['home', 'userData', 'codexHome', 'claudeHome'].map((key) => [key, path.join(dir, key)]));
  for (const value of Object.values(dirs)) fs.mkdirSync(value);
  assert.equal(readAuth(dirs.codexHome), null);
  config.seed.files(dirs);
  const auth = readAuth(dirs.codexHome);
  assert.equal(auth.kind, 'chatgpt');
  assert.equal(auth.email, 'fake-user@example.test');
  assert.equal(auth.chatgptAccountId, 'acct-fake');
  const identity = codexInstance({ ...auth, id: 'default', status: 'ok' }, 'default');
  assert.equal(identity.billing, 'subscription');
  assert.equal(identity.account, 'default');
  assert.equal(identity.active, true);
});
