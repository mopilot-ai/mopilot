// Placement and live ownership of a skill chip when picked from the composer or Skills page.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, fire, mount, mouse } from './support/composer-kit.ts';
import { fx, last, mountComposer, reset, settle } from './support/composer-setup.ts';

beforeEach(() => reset());
const titles = () => $$('.slash-panel .add-panel-title').map((x) => x.textContent);
const row = (title: string) => $$('.slash-panel .add-panel-item').find((x) => x.querySelector('.add-panel-title')!.textContent === title)!;

test('a Codex skill replaces its inline query and the caret follows the chip', async () => {
  fx.skills = async () => ({ skills: [{ path: '/r/lint', name: 'team:lint_fix', scope: 'repo', interface: { displayName: 'Lint' } }] });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await settle();
    const before = '盘一下 ';
    await m.type(`${before}$team 的结果`, before.length + '$team'.length);
    assert.deepEqual(titles(), ['Lint']);
    await mouse(row('Lint'), 'mousedown');
    await settle(5);
    const chip = m.editor().querySelector('.composer-skill');
    assert.equal(m.editor().textContent, `${before}Lint 的结果`);
    assert.equal(m.text, `${before} 的结果`, 'only the typed reference is replaced by the skill');
    const caret = window.getSelection()!.getRangeAt(0).cloneRange();
    caret.setStartBefore(chip);
    assert.equal(caret.cloneContents().textContent, 'Lint', 'typing resumes immediately after the chip');
  } finally {
    await m.unmount();
  }
});

test('Try Now appends after the current draft even if the caret is at its start', async () => {
  const m = await mountComposer({ threadId: null });
  try {
    await m.type('Check the draft ', 0);
    await fire(window, new CustomEvent('insert-skill', { detail: { name: 'ship', path: '/s/SKILL.md', displayName: 'Ship' } }));
    assert.equal(m.editor().textContent, 'Check the draft Ship');
  } finally {
    await m.unmount();
  }
});

test('a skill action delivered after the editor detaches leaves its draft alone', async () => {
  const { useSlashPick } = await import('../src/components/composer/useSlashPick.ts');
  const skill = { name: 'Ship', path: '/ship/SKILL.md' };
  const draftKey = 'home';
  const input = { current: null };
  const options = { attachments: [] };
  function DetachedEditor() {
    const { insertSkill } = useSlashPick({
      input,
      draftKey,
      currentKey: { current: draftKey },
      attachments: options.attachments,
      currentOptions: { current: options },
      text: 'Draft',
      setText: () => assert.fail('must not replace a detached draft'),
      setIncoming: () => assert.fail('must not attach to a detached draft'),
      closePopup: () => assert.fail('the external action owns no popup'),
    });
    return createElement('button', { onClick: () => insertSkill(skill) }, 'Try now');
  }
  const m = await mount(createElement(DetachedEditor));
  try {
    await click($('button', m.host));
  } finally {
    await m.unmount();
  }
});

test('a skill pick refused by the live attachment target preserves the typed reference for retry', async () => {
  let blocked = false;
  fx.attachmentTarget = { why: null, read: () => ({ key: blocked ? 'machine' : 'local', blocked }) };
  fx.skills = async () => ({ skills: [{ path: '/s', name: 'ship-it', scope: 'user' }] });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await settle();
    await m.type('Please $ship');
    blocked = true;
    await mouse(row('Ship It'), 'mousedown');
    assert.equal(m.text, 'Please $ship');
    assert.equal(m.editor().querySelector('.composer-skill'), null);
    assert.match(last('toast')?.[1], /can be attached to a machine chat/);
    blocked = false;
    await m.type('Please $ship');
    // The DOM can change before the composition commits the next draft and popup.
    m.editor().firstChild.textContent = '请 Please $ship';
    await mouse(row('Ship It'), 'mousedown');
    assert.equal(m.text, '请 Please $ship');
    assert.equal(m.editor().querySelector('.composer-skill'), null);
    await m.type('Please $ship');
    await mouse(row('Ship It'), 'mousedown');
    assert.equal(m.editor().textContent, 'Please Ship It');
  } finally {
    await m.unmount();
  }
});
