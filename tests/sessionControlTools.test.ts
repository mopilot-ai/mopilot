// electron/capabilities/tools/sessionControl.cjs: unarchive_session, set_session_title, clear_session, delete_session,
// detach_session and the model, effort, fast mode, output style and permission setters act only on the calling session or
// one this chat started, never raise cost or permission past the caller's own, and report what a harness cannot do as
// unavailable, the same way on Codex, Claude Code and ACP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlSetup as setup, settingsFor, textOf, KINDS } from './support/sessionManagementFakes.ts';

test('the control tools are registered with the policies that gate them, and only for the owner of the call', async () => {
  const s = setup();
  assert.deepEqual(
    s.r.list().map((t: any) => [t.name, t.policy]),
    [
      ['unarchive_session', 'act'],
      ['set_session_title', 'act'],
      ['clear_session', 'act'],
      ['delete_session', 'irreversible'],
      ['detach_session', 'act'],
      ['set_session_model', 'act'],
      ['set_session_harness', 'act'],
      ['set_session_effort', 'act'],
      ['set_session_fast_mode', 'act'],
      ['set_session_output_style', 'act'],
      ['set_session_permission_mode', 'act'],
    ],
  );
  assert.match(textOf(await s.r.invoke('top', 'other', 'set_session_title', { session_id: 'alpha', title: 'x' })), /no_owner/);
  s.orchestrator.unavailable = 'journal_unavailable';
  assert.match(textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: 'x' })), /journal_unavailable/);
});

test('an error without a code is not dressed up as a tool answer', async () => {
  const s = setup();
  s.host.setTitle = async () => {
    throw new Error('disk on fire');
  };
  assert.match(textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: 'New' })), /disk on fire/);
});

test('unarchive_session restores an archived session this chat started, and nothing else', async () => {
  const s = setup('claude', 'claude', { archived: ['alpha', 'gamma'] });
  assert.equal(
    textOf(await s.call('top', 'unarchive_session', { session_id: 'alpha' })),
    'Unarchived session alpha ("Alpha task"). It is back in the session list; its next message resumes the conversation where it left off.',
  );
  assert.deepEqual(s.log, [['unarchive', 'alpha']]);
  assert.match(textOf(await s.call('top', 'unarchive_session', { session_id: 'gamma' })), /Unarchived session gamma/, 'a grandchild too');
  assert.match(textOf(await s.call('top', 'unarchive_session', { session_id: 'self' })), /self_refused: This session is not archived\./);
  assert.match(
    textOf(await s.call('gamma', 'unarchive_session', { session_id: 'alpha' })),
    /not_linked: Only a session this chat started can be unarchived/,
  );
  assert.match(textOf(await s.call('top', 'unarchive_session', { session_id: 'solo' })), /not_linked/);
  const live = setup();
  assert.match(
    textOf(await live.call('top', 'unarchive_session', { session_id: 'alpha' })),
    /not_archived: Session alpha \("Alpha task"\) is not archived\./,
  );
  assert.deepEqual(live.log, []);
});

test('set_session_title renames this session or one it started on every harness, and refuses what is not plain text', async () => {
  for (const kind of KINDS) {
    const s = setup(kind, kind);
    assert.equal(
      textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: '  Fix  the   build ' })),
      'Renamed session alpha ("Alpha task") to "Fix the build" (was "Alpha task").',
    );
    assert.deepEqual(s.log.pop(), ['title', 'alpha', 'Fix the build']);
    assert.equal(
      textOf(await s.call('top', 'set_session_title', { session_id: 'self', title: 'Lead' })),
      'Renamed this session to "Lead" (was "Top").',
    );
    assert.deepEqual(s.log.pop(), ['title', 'top', 'Lead']);
  }
  const s = setup();
  assert.equal(
    textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: 'alpha TASK' })),
    'Session alpha ("Alpha task") is already named "alpha TASK".',
  );
  assert.equal(
    textOf(await s.call('top', 'set_session_title', { session_id: 'top', title: 'top' })),
    'This session is already named "top".',
  );
  assert.deepEqual(s.log, []);
  assert.match(textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: '   ' })), /invalid_title: title is required/);
  assert.match(
    textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: 'x'.repeat(201) })),
    /invalid_title: title must be 1 to 200 characters/,
  );
  assert.match(textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: 'bad\u202etitle' })), /plain visible text/);
  assert.match(textOf(await s.call('top', 'set_session_title', { session_id: 'alpha', title: 'zero\u200bwidth' })), /plain visible text/);
  assert.match(
    textOf(await s.call('alpha', 'set_session_title', { session_id: 'top', title: 'x' })),
    /not_linked: Only this session or a session this chat started can be renamed/,
  );
  const gone = setup('claude', 'claude', { facts: { alpha: { describe: null, settings: null } } });
  assert.match(
    textOf(await gone.call('top', 'set_session_title', { session_id: 'alpha', title: 'x' })),
    /not_found: Could not rename session alpha \("Alpha task"\) - it is no longer available/,
  );
  const goneSelf = setup('claude', 'claude', { facts: { top: { describe: null } } });
  assert.match(
    textOf(await goneSelf.call('top', 'set_session_title', { session_id: 'self', title: 'x' })),
    /Could not rename this session/,
  );
  // a session with no title of its own is renamed without a "was"
  const untitled = setup();
  untitled.children.alpha.title = null;
  untitled.facts.alpha.describe = { title: null };
  assert.equal(
    textOf(await untitled.call('top', 'set_session_title', { session_id: 'alpha', title: 'New' })),
    'Renamed session alpha to "New".',
  );
  untitled.facts.alpha.describe = { title: 'From the harness' };
  assert.match(
    textOf(await untitled.call('top', 'set_session_title', { session_id: 'alpha', title: 'Newer' })),
    /\(was "From the harness"\)/,
  );
});

test('clear_session says MoPilot has no in-place clear, on each harness, after checking who is asking', async () => {
  for (const kind of KINDS) {
    const s = setup(kind, kind);
    const text = textOf(await s.call('top', 'clear_session', { session_id: 'alpha' }));
    assert.match(
      text,
      new RegExp(`unavailable: Session alpha \\("Alpha task"\\) was not cleared: /clear in MoPilot starts a new chat.*\\(${kind}\\)`),
    );
    assert.match(text, /Start a fresh session with start_session/);
  }
  const s = setup();
  assert.match(textOf(await s.call('top', 'clear_session', { session_id: 'self' })), /Session top was not cleared/);
  assert.match(textOf(await s.call('top', 'clear_session', { session_id: 'solo' })), /not_linked/);
  const unknown = setup('claude', 'claude', { facts: { alpha: { settings: null } } });
  assert.doesNotMatch(textOf(await unknown.call('top', 'clear_session', { session_id: 'alpha' })), /\(claude\)/);
});

test('delete_session asks the user, then deletes idle sessions this chat started and names every skipped one', async () => {
  const denied = setup('claude', 'claude', { approve: false });
  assert.match(textOf(await denied.call('top', 'delete_session', { session_ids: ['alpha'] })), /denied|not approved|approval/i);
  assert.deepEqual(denied.log, []);
  const s = setup('claude', 'claude', {
    states: { gamma: 'running' },
    facts: { alpha: { describe: { title: 'Alpha task' }, settings: settingsFor('claude'), removeFails: false } },
  });
  const text = textOf(await s.call('top', 'delete_session', { session_ids: ['alpha', 'gamma', 'self', 'solo', 'alpha', '  ', 7 as any] }));
  assert.equal(
    text,
    'Deleted 1 session: alpha ("Alpha task"). Skipped: gamma ("Gamma task") - it is working; self - this session cannot delete itself; solo - not a session this chat started.',
  );
  assert.deepEqual(s.log, [['remove', 'alpha']]);
  assert.equal(s.asked.length, 1, 'one card for the whole call');
  const waiting = setup('claude', 'claude', { states: { alpha: 'awaitingUser' } });
  assert.match(
    textOf(await waiting.call('top', 'delete_session', { session_ids: ['alpha'] })),
    /^Nothing was deleted\. Skipped: alpha \("Alpha task"\) - it is waiting for the user\.$/,
  );
  const failing = setup('claude', 'claude', { facts: { alpha: { describe: {}, settings: settingsFor('claude'), removeFails: true } } });
  assert.match(
    textOf(await failing.call('top', 'delete_session', { session_ids: ['alpha'] })),
    /Nothing was deleted\. Skipped: alpha \("Alpha task"\) - the harness refused\./,
  );
  const archived = setup('claude', 'claude', { archived: ['alpha'] });
  assert.match(
    textOf(await archived.call('top', 'delete_session', { session_ids: ['alpha', 'gamma'] })),
    /^Deleted 2 sessions: alpha \("Alpha task"\), gamma \("Gamma task"\)\.$/,
  );
  const noReason = setup();
  noReason.children.alpha.title = null;
  assert.match(textOf(await noReason.call('top', 'delete_session', { session_ids: ['alpha'] })), /^Deleted 1 session: alpha\.$/);
  assert.match(
    textOf(await setup().call('top', 'delete_session', { session_ids: [] })),
    /invalid_session: session_ids must name at least one/,
  );
  assert.match(textOf(await setup().call('top', 'delete_session', { session_ids: ['', 3 as any] })), /invalid_session/);
  assert.match(
    textOf(await setup().call('top', 'delete_session', { session_ids: Array.from({ length: 26 }, (_, i) => `s${i}`) })),
    /too_many: session_ids may name at most 25/,
  );
  assert.match(textOf(await setup().call('top', 'delete_session', { session_ids: 'alpha' as any })), /bad_args/);
});

test('detach_session moves a direct child (or this session) to top level, and says when it already is', async () => {
  const s = setup();
  assert.match(
    textOf(await s.call('top', 'detach_session', { session_id: 'alpha' })),
    /^Session alpha \("Alpha task"\) is now a top-level session\. It no longer nests under this session/,
  );
  assert.deepEqual(s.calls.pop(), ['detach', 'alpha']);
  assert.match(
    textOf(await s.call('alpha', 'detach_session', { session_id: 'self' })),
    /^This session is now a top-level session\. It no longer nests under session top, is not archived along with it/,
  );
  assert.deepEqual(s.calls.pop(), ['detach', 'alpha']);
  // a grandchild is not a direct child; a session with no parent, or already detached, is top level
  assert.match(
    textOf(await s.call('top', 'detach_session', { session_id: 'gamma' })),
    /not_linked: Only this session or a session this chat started directly can be detached/,
  );
  assert.equal(textOf(await s.call('top', 'detach_session', { session_id: 'self' })), 'This session is already a top-level session.');
  const detached = setup('claude', 'claude', { detached: ['alpha'] });
  assert.equal(
    textOf(await detached.call('top', 'detach_session', { session_id: 'alpha' })),
    'Session alpha ("Alpha task") is already a top-level session.',
  );
  assert.deepEqual(detached.calls, []);
});
