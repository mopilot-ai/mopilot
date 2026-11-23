// The permission a composer shows as running is the mode the harness last confirmed, never a saved choice (#4648): a pick waits as
// "applies to your next message" until the harness reports it, and only the harness's own reports write the session's mode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { effectivePermission } from '../shared/effectivePermission.mjs';

export const GUARDS = ['electron/', 'src/'];

const CONFIRMED: Record<string, string> = {
  dontAsk: 'read-only',
  default: 'default',
  acceptEdits: 'default',
  auto: 'auto-review',
  bypassPermissions: 'full-access',
};
const SAVED = ['read-only', 'default', 'auto-review', 'full-access'];

test('a confirmed native mode is what is shown, whatever was saved for the next message', () => {
  for (const [native, shown] of Object.entries(CONFIRMED))
    for (const saved of SAVED) {
      assert.equal(effectivePermission({ permission: saved }, saved, { permission: native }), shown, `${native} confirmed, ${saved} saved`);
    }
});

test('a plan report is shown as the confirmed mode too, and a pending switch shows the pick of the side it goes to', () => {
  assert.equal(effectivePermission({ permission: 'full-access' }, 'full-access', { permission: 'plan' }), 'plan');
  assert.equal(
    effectivePermission({ permission: 'full-access' }, 'default', { permission: 'dontAsk', pendingSwitch: { harness: 'codex' } }),
    'full-access',
  );
});

/** Every file under `dir` whose name ends in one of `ends`, tests and generated output left out. */
function sources(dir: string, ends: string[]): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sources(full, ends);
    return ends.some((end) => e.name.endsWith(end)) && !/\.test\./.test(e.name) ? [full] : [];
  });
}

/** The only code that writes a chat's running permission into its session state, and what each writes from. */
const WRITERS: Record<string, string> = {
  'electron/session/controllerEvents.cjs': "Claude Code's own init and status reports",
  'electron/harness/codexRunPermission.cjs': 'the permission a Codex turn starts with (Codex has no report to wait for)',
  'electron/harness/codexTurns.cjs': 'the permission a Codex turn starts with (Codex has no report to wait for)',
  'electron/app/ipc/host.cjs': "a Host's own report of the mode a chat on it runs in",
};

test('only the harness-confirmation writers set the session permission, and no window does', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const writes = (file: string) =>
    /\.patch\([^)]*\{[^}]*\bpermission\s*:|\bsetSession\([^)]*\{[^}]*\bpermission\s*:/.test(fs.readFileSync(file, 'utf8'));
  const found = [...sources(path.join(root, 'electron'), ['.cjs']), ...sources(path.join(root, 'src'), ['.ts', '.tsx'])]
    .filter(writes)
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(
    found,
    Object.keys(WRITERS).sort(),
    'a new writer of the running permission must be added here with what it writes from',
  );
});
