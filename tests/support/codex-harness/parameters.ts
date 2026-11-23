// Codex harness parameters unit cases with shared server and session fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInput, permissionParams, sandboxPolicyFor, turnParams, chatPrefs, goalErrorMessage } from './fixture';

export function registerParametersCases() {
  test('permission and sandbox parameters for each mode', () => {
    assert.deepEqual(permissionParams('auto-review'), {
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      approvalsReviewer: 'auto_review',
    });
    assert.deepEqual(sandboxPolicyFor('read-only'), { type: 'readOnly', networkAccess: false });
    assert.deepEqual(sandboxPolicyFor('full-access'), { type: 'dangerFullAccess' });
    assert.deepEqual(sandboxPolicyFor('default', null).writableRoots, []);
    assert.deepEqual(sandboxPolicyFor('default', '/w').writableRoots, ['/w']);
  });

  test('buildInput sends images, skills and mentions as their own items; a selection may have no text', () => {
    const input = buildInput('do it', [
      { kind: 'selection' },
      { kind: 'image', path: '/a.png' },
      { kind: 'skill', name: 'review', path: '/s/SKILL.md' },
      { kind: 'file', name: 'b.ts', path: '/b.ts' },
    ]);
    assert.equal(input[0].type, 'text');
    assert.match(input[0].text, /<selected-text>\n\[""\]\n<\/selected-text>/);
    assert.deepEqual(input.slice(1), [
      { type: 'localImage', path: '/a.png' },
      { type: 'skill', name: 'review', path: '/s/SKILL.md' },
      { type: 'mention', name: 'b.ts', path: '/b.ts' },
    ]);
    assert.deepEqual(buildInput('   '), []);
  });

  test('turnParams: a prefix, plan mode, and the config defaults a collaboration mode needs', () => {
    const p = turnParams('t', 'c', { text: 'hi', opts: { prefix: '/review', plan: true } }, { permission: 'read-only' }, '/w', {
      model: 'cfg',
      effort: 'high',
    });
    assert.equal(p.input[0].text, '/review\n\nhi');
    assert.deepEqual(p.collaborationMode, {
      mode: 'plan',
      settings: { model: 'cfg', reasoning_effort: 'high', developer_instructions: null },
    });
    assert.deepEqual(p.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    const q = turnParams('t', 'c', { text: 'hi' }, {}, null);
    assert.deepEqual(q.collaborationMode.settings, { model: '', reasoning_effort: null, developer_instructions: null });
    assert.equal(turnParams('t', 'c', { text: 'hi' }, {}, null, { defaultModel: 'dm' }).collaborationMode.settings.model, 'dm');
    assert.equal(q.collaborationMode.mode, 'default');
  });

  test('chatPrefs ignores a missing or non-object config; goalErrorMessage reads goal failures', () => {
    assert.deepEqual(chatPrefs({ model: 'a' }, null), { model: 'a' });
    assert.deepEqual(chatPrefs({ model: 'a' }, 'x'), { model: 'a' });
    assert.deepEqual(chatPrefs({ model: 'a', effort: 'low' }, { model: undefined }), { model: null, effort: 'low' });
    assert.equal(goalErrorMessage(new Error('goals feature is disabled')), 'Goals are turned off in Codex settings');
    assert.equal(goalErrorMessage({ message: 'cannot set on ephemeral thread' }), "Temporary chats can't have goals");
    assert.equal(goalErrorMessage('boom'), 'boom');
    assert.equal(goalErrorMessage(null), 'null');
  });
}
