// Approval card rules: keys 1/2/3, Esc, the ⌘↩ hold, who is asking, and the denial note.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalKey,
  approvesOnEnter,
  cardOwnsKey,
  denialWith,
  endsHold,
  isTypingTarget,
  sandboxEntryLine,
  scopeChord,
  scopeCopy,
  sourceLabel,
  sourceSegment,
  HOLD_MS,
  UNFOCUSED_PANE,
  viewOwnsKey,
} from '../src/components/thread/approvalLogic.ts';
import { reviewTargetLabel } from '../src/components/thread/reviewTarget.ts';

const card = { choices: 2, destructive: false };

test('1, 2, 3 pick a choice that exists; Esc denies', () => {
  assert.deepEqual(approvalKey({ key: '1' }, card), { type: 'choose', index: 0 });
  assert.deepEqual(approvalKey({ key: '2' }, card), { type: 'choose', index: 1 });
  assert.equal(approvalKey({ key: '3' }, card), null); // only two choices
  assert.equal(approvalKey({ key: '4' }, { choices: 5, destructive: false }), null);
  assert.deepEqual(approvalKey({ key: '3' }, { choices: 5, destructive: false }), { type: 'choose', index: 2 });
  assert.deepEqual(approvalKey({ key: 'Escape' }, card), { type: 'deny' });
});

test('synthetic keys are ignored', () => {
  assert.equal(approvalKey({ key: '1', isTrusted: false }, card), null);
  assert.equal(approvalKey({ key: 'Escape', isTrusted: false }, card), null);
});

test('an action that cannot be undone ignores 1/2/3 and starts a hold on a fresh ⌘↩', () => {
  const d = { choices: 3, destructive: true };
  assert.equal(approvalKey({ key: '1' }, d), null);
  assert.deepEqual(approvalKey({ key: 'Enter', metaKey: true }, d), { type: 'holdStart' });
  assert.equal(approvalKey({ key: 'Enter', metaKey: true, repeat: true }, d), null); // key repeat does not restart it
  assert.equal(approvalKey({ key: 'Enter' }, d), null);
  assert.deepEqual(approvalKey({ key: 'Escape' }, d), { type: 'deny' });
  assert.equal(HOLD_MS, 1000);
  assert.ok(endsHold('Enter') && endsHold('Meta') && !endsHold('a'));
});

test('typing in a field keeps its keys', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('Enter approves only from outside a control: on a focused Deny or chevron the button takes it', () => {
  const el = (tagName: string, role: string | null = null) => ({ tagName, getAttribute: (n: string) => (n === 'role' ? role : null) });
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('BODY') }), true);
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('BUTTON') }), false);
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('A') }), false);
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('DIV', 'menuitem') }), false);
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('BODY'), repeat: true }), false);
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('BODY'), isTrusted: false }), false);
  assert.equal(approvesOnEnter({ key: 'Enter', target: el('BODY'), metaKey: true }), false);
  assert.equal(approvesOnEnter({ key: '1', target: el('BODY') }), false);
});

test('with two cards on screen, one key press reaches one card: the focused one, else the first', () => {
  const mine = { contains: (n: any) => n === mine };
  const other = { contains: (n: any) => n === other };
  const inside = (card: unknown) => ({ closest: () => card });
  const body = { closest: () => null };
  assert.equal(cardOwnsKey({ defaultPrevented: false, target: body }, mine), true);
  assert.equal(cardOwnsKey({ defaultPrevented: true, target: body }, mine), false); // another card took it
  assert.equal(cardOwnsKey({ defaultPrevented: false, target: inside(mine) }, mine), true);
  assert.equal(cardOwnsKey({ defaultPrevented: false, target: inside(other) }, mine), false);
  // a key aimed at no card skips the cards of a pane that isn't focused, and is taken in the focused one
  const inPane = (focused: boolean) => ({
    contains: () => false,
    closest: (selector: string) => (selector === UNFOCUSED_PANE && !focused ? {} : null),
  });
  assert.equal(cardOwnsKey({ defaultPrevented: false, target: body }, inPane(false)), false);
  assert.equal(cardOwnsKey({ defaultPrevented: false, target: body }, inPane(true)), true);
  assert.equal(cardOwnsKey({ defaultPrevented: false, target: body }, null), true);
});

test("a window key moves the view holding focus, else the focused pane's view, never a side pane's or an unfocused one's", () => {
  const view = (focused?: boolean) => ({ closest: (sel: string) => (sel === UNFOCUSED_PANE && focused === false ? {} : null) }) as any;
  const mine = view(true);
  const at = (v: any) => ({ closest: () => v }) as any;
  assert.equal(viewOwnsKey(at(mine), mine, false), true);
  assert.equal(viewOwnsKey(at(view()), mine, false), false);
  assert.equal(viewOwnsKey(at(null), mine, false), true);
  assert.equal(viewOwnsKey(null, view(), false), true);
  assert.equal(viewOwnsKey(null, mine, true), false);
  assert.equal(viewOwnsKey(null, view(false), false), false);
  assert.equal(viewOwnsKey(null, null, false), true);
});

const segs = [
  { harness: 'codex', nativeId: 'thr-1', start: 0, count: 2, model: null, handoff: null },
  { harness: 'claude', nativeId: 'claude:abc', start: 2, count: null, model: null, handoff: null },
] as any;
const label = (s: any) => s.harness;

test('the label names the segment that asked, not the chat current harness', () => {
  assert.equal(sourceSegment({ threadId: 'thr-1' }, segs)?.harness, 'codex');
  assert.equal(sourceSegment({ sessionId: 'abc' }, segs)?.harness, 'claude');
  assert.equal(sourceLabel({ threadId: 'thr-1' }, segs, label, 'Claude Code'), 'codex');
  assert.equal(sourceLabel({ threadId: 'other' }, segs, label, 'Claude Code'), 'Claude Code');
  assert.equal(sourceLabel({}, undefined, label, 'Codex'), 'Codex');
});

test('a denial carries the note only where the harness can take it', () => {
  assert.deepEqual(denialWith({ decision: 'decline' }, '  use rg  ', true), { decision: 'decline', reason: 'use rg' });
  assert.deepEqual(denialWith({ decision: 'decline' }, 'use rg', false), { decision: 'decline' });
  assert.deepEqual(denialWith({ decision: 'decline' }, '   ', true), { decision: 'decline' });
});

test('a pull request review says so', () => {
  assert.equal(reviewTargetLabel('pullRequest'), 'Pull request');
  assert.equal(reviewTargetLabel('uncommittedChanges'), 'Uncommitted changes');
  assert.equal(reviewTargetLabel(null), null);
});

test('every review target has its heading', () => {
  assert.equal(reviewTargetLabel('baseBranch'), 'Against a branch');
  assert.equal(reviewTargetLabel('commit'), 'Commit');
  assert.equal(reviewTargetLabel('custom'), 'Custom review');
  assert.equal(reviewTargetLabel(undefined), null);
});

test('Enter is the control’s own for any role that activates, and without a target it approves', () => {
  assert.equal(approvesOnEnter({ key: 'Enter' }), true);
  assert.equal(approvesOnEnter({ key: 'Enter', target: { tagName: 'DIV' } }), true); // no getAttribute
  assert.equal(approvesOnEnter({ key: 'Enter', target: {} }), true); // no tagName
  assert.equal(approvesOnEnter({ key: 'Enter', target: { tagName: 'DIV', getAttribute: () => 'switch' } }), false);
});

test('a permissions entry names its access and its path, typed or plain', () => {
  const line = (path: any, access?: string) => sandboxEntryLine({ access, path });
  assert.equal(line({ type: 'path', path: '/src' }, 'write'), 'Write /src');
  assert.equal(line({ type: 'glob_pattern', pattern: '**/*.env' }, 'deny'), 'Deny **/*.env');
  assert.equal(line('/plain', 'Read'), 'Read /plain');
  const special = (value: any) => line({ type: 'special', value }, 'read');
  assert.deepEqual(
    [
      special({ kind: 'root' }),
      special({ kind: 'minimal' }),
      special({ kind: 'project_roots', subpath: null }),
      special({ kind: 'project_roots', subpath: 'docs' }),
      special({ kind: 'tmpdir' }),
      special({ kind: 'slash_tmp' }),
      special({ kind: 'unknown', path: '/opt', subpath: null }),
      special({ kind: 'unknown', path: '/opt', subpath: 'x' }),
    ],
    [
      'Read the whole file system',
      'Read the minimal system paths',
      'Read the project roots',
      'Read docs in the project roots',
      'Read the temporary folder',
      'Read /tmp',
      'Read /opt',
      'Read /opt/x',
    ],
  );
  // no access mode, and a path this version can't read: the entry as sent
  assert.equal(sandboxEntryLine({ path: { type: 'other' } as any }), 'Access {"path":{"type":"other"}}');
  assert.equal(sandboxEntryLine({}), 'Access {}');
});

test("⌘↩ allows once and ⇧⌘↩ always allows (Claude Desktop's chords); anything else, a repeat or a script's key is not a chord", () => {
  assert.equal(scopeChord({ key: 'Enter', metaKey: true }), 'once');
  assert.equal(scopeChord({ key: 'Enter', metaKey: true, shiftKey: true }), 'always');
  assert.equal(scopeChord({ key: 'Enter' }), null);
  assert.equal(scopeChord({ key: '1', metaKey: true }), null);
  assert.equal(scopeChord({ key: 'Enter', metaKey: true, repeat: true }), null);
  assert.equal(scopeChord({ key: 'Enter', metaKey: true, isTrusted: false }), null);
});

test('a site or app card asks one question, and names where Always allow saves only where it is offered; unnamed sites and apps still read', () => {
  assert.deepEqual(scopeCopy('Codex', { kind: 'browserOrigin', origin: 'https://a.test', browser: 'iab' }, { always: true }), {
    ask: 'Allow Codex to use ',
    what: 'https://a.test',
    tail: ' in the built-in browser?',
    saved: 'Saved on this device. Remove in Settings → Browser.',
  });
  const site = scopeCopy('Codex', { kind: 'browserOrigin' }, { always: false });
  assert.equal(site.ask + site.what + site.tail, 'Allow Codex to use this site?');
  assert.equal(site.saved, undefined);
  assert.equal('saved' in site, false);
  // the user's own Chrome, where they are signed in: the question names it
  const chrome = scopeCopy('Codex', { kind: 'browserOrigin', origin: 'https://b.test', browser: 'chrome' }, { always: false });
  assert.equal(chrome.ask + chrome.what + chrome.tail, 'Allow Codex to use https://b.test in your Chrome?');
  assert.equal(chrome.saved, undefined);
  const app = scopeCopy(
    'Claude Code',
    { kind: 'computerAccess', app: { bundleId: 'n', name: 'Notes' }, browser: 'chrome' },
    { always: true },
  );
  assert.equal(app.ask + app.what + app.tail, 'Allow Claude Code to control Notes?');
  assert.equal(app.saved, 'Saved for every chat. Remove in Settings → Computer use.');
  assert.equal(scopeCopy('Codex', { kind: 'computerAccess', origin: 'https://b.test' }, { always: false }).what, 'https://b.test');
  assert.equal(scopeCopy('Codex', { kind: 'computerAccess' }, { always: false }).what, 'this app');
});
