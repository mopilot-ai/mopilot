// Which of a machine's agents a row names (src/lib/machineAgents.ts): ready and signed-out agents, a missing Claude Code or Codex, core agents first, never a test agent; and which agents Sign in and Install are for. The status line built from them is in tests/machineStatus.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingAgents, shownAgents, signinAgents } from '../src/lib/machineAgents.ts';

type S = 'ready' | 'signin' | 'missing' | null;
const agent = (id: string, label: string, state: S) => ({ id, label, state, reason: '' });
const claude = (s: S) => agent('claude', 'Claude Code', s);
const codex = (s: S) => agent('codex', 'Codex', s);
const gemini = (s: S) => agent('gemini', 'Gemini', s);
const grok = (s: S) => agent('grok', 'Grok', s);
const kimi = (s: S) => agent('kimi', 'Kimi Code', s);

test('the Mac mini: Claude Code ready, Codex not installed, Gemini and Grok signed out, other agents absent', () => {
  // the Host's order: Claude Code, Codex, then the ACP agents it knows
  const agents = [gemini('signin'), claude('ready'), codex('missing'), kimi('missing'), grok('signin')];
  assert.deepEqual(
    shownAgents(agents).map((a) => a.id),
    ['claude', 'codex', 'gemini', 'grok'],
  );
  assert.deepEqual(
    signinAgents(agents).map((a) => a.id),
    ['gemini', 'grok'],
  );
  assert.deepEqual(
    missingAgents(agents).map((a) => a.id),
    ['codex'],
    'an agent the user never runs is not offered',
  );
});

test('none ready: Claude Code first among those needing sign-in', () => {
  const agents = [gemini('signin'), claude('signin'), codex('missing')];
  assert.equal(signinAgents(agents)[0].id, 'claude');
});

test('an agent whose state the row did not say is never shown or offered, and a test agent never is', () => {
  const agents = [
    claude(null),
    { id: 'codex', label: 'Codex' },
    gemini('signin'),
    agent('fake', 'fake', 'ready'),
    agent('fake', 'fake', 'signin'),
  ];
  assert.deepEqual(
    shownAgents(agents).map((a) => a.id),
    ['gemini'],
  );
  assert.deepEqual(
    signinAgents(agents).map((a) => a.id),
    ['gemini'],
  );
});
