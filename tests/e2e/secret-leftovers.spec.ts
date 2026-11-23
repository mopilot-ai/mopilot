// #2144 follow-up: a plain Claude API key written beside the encrypted one (a downgrade, then the key entered again)
// is taken, encrypted and deleted at the next start, and an interrupted write's .mopilot-*.tmp in an added Codex
// account's folder is removed when the vault seals what it finds.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { twoCodexAccounts } from './fixtures/codexAccounts';

const FIRST = 'sk-ant-fake-leftover-1111';
const AGAIN = 'sk-ant-fake-leftover-2222';

test.describe('secret leftovers', () => {
  test.use({
    seed: {
      files: (d) => {
        twoCodexAccounts(d);
        fs.writeFileSync(path.join(d.userData, 'claude-api-key'), `${FIRST}\n`, { mode: 0o644 });
      },
    },
  });

  test('a plain key beside the encrypted one and a leftover temp file are gone after an upgrade', async ({ harness }) => {
    const userData = path.join(harness.dir, 'userData');
    const plain = path.join(userData, 'claude-api-key');
    const sealed = path.join(userData, 'claude-api-key.json');
    await expect.poll(() => fs.existsSync(plain)).toBe(false);
    expect(fs.existsSync(sealed)).toBe(true);
    await harness.quit();

    // what an older version leaves: the key entered again in plain text (newer than the encrypted one), and a
    // temp file of a write it never finished
    fs.writeFileSync(plain, `${AGAIN}\n`, { mode: 0o644 });
    const later = new Date(fs.statSync(sealed).mtimeMs + 5000);
    fs.utimesSync(plain, later, later);
    const tmp = path.join(userData, 'accounts', 'second', '.mopilot-auth.json.1234.tmp');
    fs.writeFileSync(tmp, '{"tokens":{"access_token":"leftover"}}');

    await harness.relaunch();
    expect(fs.existsSync(tmp), 'the temp file goes when the vault seals at start').toBe(false);
    // the newer, re-entered key is the one used, and only its encrypted copy stays
    const claude = await harness.page.evaluate(() => (window as any).native.claude.apiKey());
    expect(claude.hint).toBe('2222');
    expect(fs.existsSync(plain)).toBe(false);
    expect(JSON.parse(fs.readFileSync(sealed, 'utf8')).enc).toBe('safe');
    expect(fs.readFileSync(sealed, 'utf8')).not.toContain(AGAIN);
  });
});
