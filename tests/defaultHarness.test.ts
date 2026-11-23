// The default harness for new chats: the one pref, how it resolves against what can run, what a page says when it
// falls back, and the one-time move from the two old prefs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicIdOf, defaultHarnessNote, harnessKindLabel, resolveDefaultHarness } from '../src/harness/defaultHarness.ts';
import { defaultHarnessPatch, isHarnessKind } from '../shared/defaultHarness.mjs';
import { runWithOf } from '../shared/scheduleTask.mjs';

const both = { codex: true, claude: true };
const none = { codex: false, claude: false };
const idle = { codex: false, claude: false };
const b = (id: string, state: string) => ({ id, state }) as any;
const resolve = (saved: any, o: { usable?: any; pending?: any; basics?: any[] } = {}) =>
  resolveDefaultHarness({ saved, usable: o.usable ?? both, pending: o.pending ?? idle, basics: o.basics ?? [] });

test('a saved harness that can run is what new chats start on, with no fallback', () => {
  assert.deepEqual(resolve('codex'), { saved: 'codex', kind: 'codex', firstTier: 'codex', fallback: null });
  assert.deepEqual(resolve('claude'), { saved: 'claude', kind: 'claude', firstTier: 'claude', fallback: null });
  // a basic default keeps Codex as the first-tier side of things (reviews, plugins)
  assert.deepEqual(resolve('acp:opencode', { basics: [b('opencode', 'admitted')] }), {
    saved: 'acp:opencode',
    kind: 'acp:opencode',
    firstTier: 'codex',
    fallback: null,
  });
});

test('a first-tier default that cannot run falls back to the other one, and says so', () => {
  assert.deepEqual(resolve('claude', { usable: { codex: true, claude: false } }), {
    saved: 'claude',
    kind: 'codex',
    firstTier: 'codex',
    fallback: 'unusable',
  });
  // the default still being looked for (Claude Code detecting at startup) is being checked, not unable to run
  assert.deepEqual(resolve('claude', { usable: { codex: true, claude: false }, pending: { codex: false, claude: true } }), {
    saved: 'claude',
    kind: 'codex',
    firstTier: 'codex',
    fallback: 'checking',
  });
  // the other one being checked again is the better bet than a default that isn't coming up
  assert.equal(resolve('codex', { usable: none, pending: { codex: false, claude: true } }).kind, 'claude');
  // both still being looked for: the saved one stays, with nothing to report
  assert.deepEqual(resolve('claude', { usable: none, pending: { codex: true, claude: true } }), {
    saved: 'claude',
    kind: 'claude',
    firstTier: 'claude',
    fallback: null,
  });
  // nothing first-tier can run: the first admitted basic harness does
  assert.deepEqual(resolve('codex', { usable: none, basics: [b('kimi', 'signin'), b('dsh', 'admitted')] }), {
    saved: 'codex',
    kind: 'acp:dsh',
    firstTier: 'codex',
    fallback: 'unusable',
  });
});

test('a basic default that is not admitted falls back with its own state as the reason', () => {
  for (const state of ['signin', 'checking', 'unsupported', 'off', 'missing'])
    assert.deepEqual(resolve('acp:opencode', { basics: [b('opencode', state)] }), {
      saved: 'acp:opencode',
      kind: 'codex',
      firstTier: 'codex',
      fallback: state,
    });
  // not listed at all: not installed
  assert.equal(resolve('acp:gone').fallback, 'missing');
  // Codex can't run: Claude Code
  assert.equal(resolve('acp:gone', { usable: { codex: false, claude: true } }).kind, 'claude');
  // neither can: another admitted basic harness, else Codex as the last word
  assert.equal(resolve('acp:gone', { usable: none, basics: [b('dsh', 'admitted')] }).kind, 'acp:dsh');
  assert.equal(resolve('acp:gone', { usable: none }).kind, 'codex');
});

test('the fallback is said in words, naming both harnesses; none is said when there is none', () => {
  assert.equal(defaultHarnessNote(resolve('codex')), null);
  assert.equal(
    defaultHarnessNote(resolve('acp:opencode', { basics: [b('opencode', 'signin')] })),
    'opencode isn’t signed in; new chats start in Codex',
  );
  const says = (fallback: any) => defaultHarnessNote({ saved: 'acp:opencode', kind: 'claude', fallback });
  assert.equal(says('missing'), 'opencode isn’t installed; new chats start in Claude Code');
  assert.equal(says('checking'), 'opencode is being checked; new chats start in Claude Code');
  assert.equal(says('unsupported'), 'opencode can’t run in MoPilot; new chats start in Claude Code');
  assert.equal(says('off'), 'opencode is turned off; new chats start in Claude Code');
  assert.equal(
    defaultHarnessNote(resolve('claude', { usable: { codex: true, claude: false } })),
    'Claude Code can’t run right now; new chats start in Codex',
  );
  // a harness this build doesn't know goes by its id
  assert.equal(harnessKindLabel('acp:someday'), 'someday');
  assert.equal(basicIdOf('acp:opencode'), 'opencode');
  assert.equal(basicIdOf('claude'), null);
});

test('only codex, claude and acp:<id> name a harness, for the default and for a scheduled task alike', () => {
  for (const v of ['codex', 'claude', 'acp:opencode', 'acp:kimi-2', 'acp:a_b']) assert.equal(isHarnessKind(v), true, v);
  for (const v of ['', 'acp', 'acp:', 'acp:Upper', 'acp:-x', 'gemini', 'acp:a:b', null, 3, {}])
    assert.equal(isHarnessKind(v), false, String(v));
  assert.equal(runWithOf({ harness: 'acp:opencode' }), 'acp:opencode');
  assert.equal(runWithOf({ harness: 'gemini' }), 'codex');
});

test('the old two prefs move once to one: a basic pick wins, then Claude Code, then Codex', () => {
  const cases: [unknown, unknown][] = [
    // nothing old: nothing to do (a new profile, or one already moved)
    [undefined, null],
    [null, null],
    [[], null],
    [{}, null],
    [{ defaultHarness: 'claude' }, null],
    // every old combination
    [{ harness: 'codex' }, { set: { defaultHarness: 'codex' }, unset: ['harness'] }],
    [{ harness: 'claude' }, { set: { defaultHarness: 'claude' }, unset: ['harness'] }],
    [
      { harness: 'codex', basicHarness: null },
      { set: { defaultHarness: 'codex' }, unset: ['harness', 'basicHarness'] },
    ],
    [
      { harness: 'claude', basicHarness: null },
      { set: { defaultHarness: 'claude' }, unset: ['harness', 'basicHarness'] },
    ],
    [
      { harness: 'codex', basicHarness: 'opencode' },
      { set: { defaultHarness: 'acp:opencode' }, unset: ['harness', 'basicHarness'] },
    ],
    [
      { harness: 'claude', basicHarness: 'kimi' },
      { set: { defaultHarness: 'acp:kimi' }, unset: ['harness', 'basicHarness'] },
    ],
    [{ basicHarness: 'dsh' }, { set: { defaultHarness: 'acp:dsh' }, unset: ['basicHarness'] }],
    // values no build wrote: Codex, the old default
    [{ harness: 'gemini' }, { set: { defaultHarness: 'codex' }, unset: ['harness'] }],
    [
      { harness: 'claude', basicHarness: 'Not An Id' },
      { set: { defaultHarness: 'claude' }, unset: ['harness', 'basicHarness'] },
    ],
    [
      { harness: 'claude', basicHarness: '' },
      { set: { defaultHarness: 'claude' }, unset: ['harness', 'basicHarness'] },
    ],
    // already moved (a newer build wrote it): it wins, and the old fields only go
    [
      { defaultHarness: 'acp:opencode', harness: 'claude', basicHarness: null },
      { set: {}, unset: ['harness', 'basicHarness'] },
    ],
    // a damaged new value is replaced from the old ones
    [
      { defaultHarness: 'nope', harness: 'claude' },
      { set: { defaultHarness: 'claude' }, unset: ['harness'] },
    ],
  ];
  for (const [prefs, want] of cases) assert.deepEqual(defaultHarnessPatch(prefs), want, JSON.stringify(prefs));
});
