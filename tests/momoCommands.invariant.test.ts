// Every composer command stays out of a MoMo chat unless shared/momoCommands.mjs names it (Feedback): each command
// MoPilot runs (SLASH_COMMANDS, the app's typed commands, /plan) typed in a MoMo chat goes out as plain text, an
// allowed one opens the bug report and nothing else, and every "/" menu goes through MoMo's filter. A new command is
// therefore excluded from MoMo by default.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import './support/dom.ts';
import { all, events, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';

export const GUARDS = ['src/', 'shared/momoCommands.mjs', 'electron/session/state.cjs'];

const { SLASH_COMMANDS } = await import('../src/components/composer/ComposerCommands.ts');
const { MOMO_COMMANDS, MOMO_MENU, momoSessionPatch } = await import('../shared/momoCommands.mjs');
const { CLIENT_KEYS } = createRequire(import.meta.url)('../electron/session/state.cjs');
const appSource = readFileSync(new URL('../src/harness/commands.ts', import.meta.url), 'utf8');
const app = appSource.slice(
  appSource.indexOf('export const APP_COMMANDS'),
  appSource.indexOf('];', appSource.indexOf('export const APP_COMMANDS')),
);
const appNames = [...app.matchAll(/name: '([\w-]+)'(?:, aliases: \[([^\]]*)\])?/g)].flatMap((m) => [
  m[1],
  ...(m[2] ?? '')
    .split(',')
    .map((a) => a.trim().replace(/'/g, ''))
    .filter(Boolean),
]);
const NAMES = [...new Set([...SLASH_COMMANDS.map((c) => c.name), ...appNames, 'plan'])];

beforeEach(() => reset());

test('the app commands were read (the APP_COMMANDS table is where this test looks)', () => {
  for (const n of ['new', 'clear', 'model', 'permissions', 'feedback', 'bug']) assert.ok(NAMES.includes(n), n);
  for (const n of [...MOMO_COMMANDS, ...MOMO_MENU]) assert.ok(NAMES.includes(n), `${n} is a command MoPilot runs`);
});

test('every command typed in a MoMo chat is sent as text, except MoMo’s own, which open the bug report alone', async () => {
  store.set({ momoChats: { t1: 'main' } });
  const reports: any[] = [];
  const onReport = (e: any) => reports.push(e.detail);
  window.addEventListener('open-bug-report', onReport);
  const m = await mountComposer({ threadId: 't1' });
  try {
    for (const name of NAMES) {
      events.length = 0;
      reports.length = 0;
      await m.type(`/${name}`);
      await m.key('Enter');
      await settle();
      const allowed = MOMO_COMMANDS.includes(name);
      assert.deepEqual(
        all('send').map((e) => e[2]),
        allowed ? [] : [`/${name}`],
        `/${name}`,
      );
      assert.equal(reports.length, allowed ? 1 : 0, `/${name} report`);
      assert.equal(last('navigate'), undefined, `/${name} navigates nowhere`);
      assert.equal(last('toast'), undefined, `/${name} says nothing`);
      assert.equal(store.get().sessions?.t1?.plan ?? false, false, `/${name} leaves plan mode off`);
    }
  } finally {
    window.removeEventListener('open-bug-report', onReport);
    await m.unmount();
  }
});

test('every "/" menu a composer draws goes through MoMo’s filter', () => {
  const files = execFileSync('git', ['grep', '-l', '<SlashPopup', '--', 'src/components'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files, ['src/components/composer/Composer.tsx'], 'a new "/" menu applies momoMenu too');
  const composer = readFileSync(new URL('../src/components/composer/Composer.tsx', import.meta.url), 'utf8');
  assert.match(composer, /<SlashPopup[\s\S]*?items=\{composerSlashItems\(momoMenu\(momo, /);
});

/**
 * What a window may write to a MoMo chat's session, for every key a window may write (electron/session/state.cjs
 * CLIENT_KEYS): a new key fails here until it is placed. `{ set, clear }`: whether a window's value is kept.
 */
const MOMO_WINDOW_KEYS: Record<string, { set: unknown; clear: unknown; kept: [boolean, boolean] }> = {
  plan: { set: true, clear: false, kept: [false, true] },
  goal: { set: { objective: 'x' }, clear: null, kept: [false, true] },
  // only MoMo's brain change, in main, sets these (electron/momo/mainChat.cjs reconcile)
  permission: { set: 'full-access', clear: null, kept: [false, false] },
  pendingSwitch: { set: { harness: 'codex' }, clear: null, kept: [false, false] },
  // the voice-or-text modality and a scheduled run's settings are the same in a MoMo chat
  modality: { set: 'voice', clear: null, kept: [true, true] },
  scheduled: { set: { unattended: true }, clear: null, kept: [true, true] },
};

test('every key a window may write to a session is placed for MoMo chats, and momoSessionPatch keeps exactly those', () => {
  assert.deepEqual([...CLIENT_KEYS].sort(), Object.keys(MOMO_WINDOW_KEYS).sort(), 'place a new window-written key here');
  for (const [key, { set, clear, kept }] of Object.entries(MOMO_WINDOW_KEYS)) {
    assert.equal(key in momoSessionPatch({ [key]: set }), kept[0], `${key} set`);
    assert.equal(key in momoSessionPatch({ [key]: clear }), kept[1], `${key} cleared`);
  }
});
