import { test } from 'node:test';
import assert from 'node:assert/strict';

const { pickChip, pickStrip } = await import('../src/lib/statusStrip.ts');
const { fullAccessBannerText, permissionMenu, permissionLearnMore } = await import('../src/harness/permissionsMenu.ts');
const { modelHeader } = await import('../src/harness/modelHeader.ts');

test('the status strip shows one thing: computer control > approval > the Stop all question; the goal is no strip', () => {
  assert.equal(pickStrip({}), null);
  assert.equal(pickStrip({ tasks: true }), 'tasks');
  assert.equal(pickStrip({ tasks: true, approval: true }), 'approval');
  assert.equal(pickStrip({ tasks: true, approval: true, computer: true }), 'computer');
  // a goal passed as a strip (from an older caller) is never picked: its place is the pill above the composer
  assert.equal(pickStrip({ goal: true } as Record<string, boolean>), null);
  assert.equal(pickStrip({ goal: true, tasks: true } as Record<string, boolean>), 'tasks');
});

test('the next-message chip slot holds one chip: a pending switch before a Cloud new chat', () => {
  assert.equal(pickChip({}), null);
  assert.equal(pickChip({ cloud: true }), 'cloud');
  assert.equal(pickChip({ cloud: true, switch: true }), 'switch');
});

test('the permissions menu lists all four anchors, with the harness own name and difference (D-27)', () => {
  for (const h of ['codex', 'claude'] as const) {
    const m = permissionMenu(h);
    assert.deepEqual(
      m.rows.map((r) => r.id),
      ['read-only', 'default', 'auto-review', 'full-access'],
    );
    assert.deepEqual(
      m.rows.map((r) => r.label),
      ['Read-only', 'Ask for approval', 'Approve for me', 'Full access'],
    );
    for (const r of m.rows) assert.match(r.detail, / · /);
  }
  assert.equal(permissionMenu('codex').title, 'What Codex can do');
  assert.equal(permissionMenu('claude').title, 'What Claude Code can do');
  // the same anchor does not mean the same thing
  assert.match(permissionMenu('claude').rows[0].detail, /writes and Bash are refused/);
  assert.match(permissionMenu('codex').rows[0].detail, /read-only sandbox/);
  assert.match(fullAccessBannerText('claude'), /^Claude Code can edit any file/);
  assert.match(fullAccessBannerText('codex'), /^Codex can edit any file/);
  assert.match(fullAccessBannerText('codex'), /read and interact with websites without your approval/);
  assert.equal(permissionLearnMore('codex'), permissionMenu('codex').learnMore);
  assert.equal(permissionLearnMore('claude'), permissionMenu('claude').learnMore);
});

test('the model header is harness, provider, model; a first-party provider is left out', () => {
  assert.equal(
    modelHeader({ harness: 'Claude Code', provider: { label: 'MoPilot', firstParty: false }, model: 'claude-sonnet-5' }),
    'Claude Code · MoPilot · claude-sonnet-5',
  );
  assert.equal(
    modelHeader({ harness: 'Claude Code', provider: { label: 'Anthropic', firstParty: true }, model: 'Sonnet' }),
    'Claude Code · Sonnet',
  );
  assert.equal(modelHeader({ harness: 'Codex', provider: null, model: 'gpt' }), 'Codex · gpt');
});
