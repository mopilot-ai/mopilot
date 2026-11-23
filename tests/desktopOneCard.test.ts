// One card per foreground task (#1926, as Claude Desktop asks): desktop_request_access with screenControl asks for the apps and the mouse and keyboard on the same card, so the first screen input needs no second card; without it, the just-in-time card stays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES, MAIL, rig, resolveEntry } from './support/desktop-kit.ts';

const { accessSentence } = await import('../src/components/thread/approvalLogic.ts');

test('screenControl: one card grants the apps and the mouse and keyboard; the first click asks nothing more', async () => {
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'type a note', screenControl: true });
  assert.deepEqual(
    r.asks.map((a: any) => [a.kind, a.params.screenControl]),
    [['computerAccessSet', true]],
  );
  assert.equal(out.screenControl, true);
  await r.call('desktop_screenshot');
  await r.call('desktop_left_click', { coordinate: [100, 50] });
  const kinds = () => r.asks.map((a: any) => a.kind).filter((k: string) => k !== 'computerConfirm');
  assert.deepEqual(kinds(), ['computerAccessSet'], 'no mouse-and-keyboard card');
  // asked again later in the chat: nothing more to ask
  await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r', screenControl: true });
  assert.deepEqual(kinds(), ['computerAccessSet']);
});

test('screenControl: unchecked or denied keeps the just-in-time card; not asked for, nothing changes', async () => {
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  r.helper.resolved.set('Mail', resolveEntry(MAIL));
  r.answers.computerAccessSet = { decision: 'allow', screenControl: false };
  const off = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r', screenControl: true });
  assert.equal(off.screenControl, false);
  await r.call('desktop_screenshot');
  await r.call('desktop_left_click', { coordinate: [100, 50] });
  assert.deepEqual(
    r.asks.map((a: any) => a.kind).filter((k: string) => k !== 'computerConfirm'),
    ['computerAccessSet', 'computerTakeover'],
  );
  // a chat that never asks for it: the card carries no screen line
  const plain = rig();
  plain.helper.resolved.set('Mail', resolveEntry(MAIL));
  const p = await plain.json('desktop_request_access', { apps: ['Mail'], reason: 'r' });
  assert.equal(plain.asks[0].params.screenControl, false);
  assert.equal(p.screenControl, false);
  // denied: nothing granted
  const denied = rig();
  denied.helper.resolved.set('Notes', resolveEntry(NOTES));
  denied.answers.computerAccessSet = { decision: 'deny' };
  const d = await denied.json('desktop_request_access', { apps: ['Notes'], reason: 'r', screenControl: true });
  assert.equal(d.screenControl, false);
});

test('screenControl alone, for apps the chat already has: one card asks only for the mouse and keyboard', async () => {
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
  const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r', screenControl: true });
  assert.deepEqual(
    r.asks.map((a: any) => [a.kind, a.params.apps.length, a.params.screenControl]),
    [
      ['computerAccessSet', 1, false],
      ['computerAccessSet', 0, true],
    ],
  );
  assert.equal(out.screenControl, true);
});

test('the card asks one question: the mouse and keyboard in the apps, with any extras', () => {
  const app = (name: string) => ({ bundleId: name, name, tier: 'full' as const });
  assert.equal(
    accessSentence('Claude', {
      kind: 'computerAccessSet',
      harness: 'claude',
      apps: [app('TextEdit'), app('Calculator')],
      screenControl: true,
    }),
    'Allow Claude to use your mouse and keyboard in TextEdit and Calculator?',
  );
  assert.equal(
    accessSentence('Codex', {
      kind: 'computerAccessSet',
      harness: 'codex',
      apps: [app('Notes')],
      screenControl: true,
      clipboardRead: true,
    }),
    'Allow Codex to use your mouse and keyboard in Notes and read the clipboard?',
  );
  assert.equal(
    accessSentence('opencode', { kind: 'computerAccessSet', harness: 'acp:opencode', screenControl: true }),
    'Allow opencode to use your mouse and keyboard?',
  );
});
