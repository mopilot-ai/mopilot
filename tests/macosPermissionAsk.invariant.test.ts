// Guard for #2528: a place that asks macOS for a privacy permission can only ask once (a refusal is never shown again), so each one either waits for the user to turn the switch on in System Settings (shared/grantWatch.cjs) or is named here with the reason it need not. A new asker fails this test until it does one or the other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
/** A call that shows macOS's prompt for Calendar, Reminders, Screen Recording, Accessibility, Input Monitoring or Speech Recognition. */
const ASKS = /helper\.requestPermission\(|'eventkit\.request'|\.speechRequest\(|'permissions\.request'/;

/** The files that ask without a wait of their own, each with why that is right. */
const NO_WAIT: Record<string, string> = {
  'electron/capabilities/computer.cjs': 'the helper client: it defines the calls; computerUse.cjs and the IPC around it wait',
  'electron/capabilities/tools/computerPermissions.cjs':
    'a model-driven tool call (shared by computer_* and desktop_*): a refusal raises the permission card, whose Request and Open System Settings buttons go through computerUse.cjs (waited); the call itself waits, bounded, in waitForPermission',
  'electron/momo/sources/eventKit.cjs': 'the EventKit client: ipc.cjs (momoSources:connect) opens the pane and waits',
  'electron/app/ipc/accounts.cjs': 'dictation status and request for the composer: the user presses the microphone again after answering',
  'electron/platform/voice.cjs':
    'a clip recorded while macOS asks ends at once with SPEECH_ASKED; a denied answer names the exact Speech Recognition list and the next clip works once it is on',
};

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('every place that asks macOS for a permission waits for the switch or says why it need not', () => {
  const files = walk(path.join(ROOT, 'electron'))
    .filter((f) => f.endsWith('.cjs'))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'))
    .filter((f) => ASKS.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const unwaited = files.filter(
    (f) => !/GrantWatch|createPermissionWatch/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')) && !(f in NO_WAIT),
  );
  assert.deepEqual(unwaited, [], 'wait for the grant with shared/grantWatch.cjs, or name the file in NO_WAIT with the reason');
  // a reason that no longer matches a file is stale
  assert.deepEqual(
    Object.keys(NO_WAIT).filter((f) => !files.includes(f)),
    [],
  );
});

test('the two askers that open a pane themselves wait for it', () => {
  for (const f of ['electron/momo/sources/ipc.cjs', 'electron/capabilities/computerUse.cjs'])
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /new GrantWatch\(|createPermissionWatch\(/, f);
});
