// Codex settings that stay on this computer, rendered for real with their app modules stubbed: memory and
// AGENTS.md (Personalization).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, mount, createElement, Personalization } from './support/codex-settings-kit.ts';

test('Personalization turns Codex memory on and off, deletes memories after confirming, and edits instructions', async () => {
  const confirms: boolean[] = [];
  (globalThis as any).confirm = () => confirms.shift() ?? false;
  fixture.state.config = { features: { memories: true }, memories: { disable_on_external_context: true } };
  fixture.state.codexHome = '/home/.codex';
  const v = await mount(createElement(Personalization));
  try {
    assert.equal(v.row('Use memory').querySelector('input').checked, true);
    assert.equal(v.row('Include tool-assisted chats').querySelector('input').checked, false);
    await v.toggle('Use memory');
    await v.toggle('Include tool-assisted chats');
    await v.flush();
    assert.deepEqual(
      fixture.params.filter(([m]: [string]) => m === 'config/value/write').map(([, p]: [string, any]) => [p.keyPath, p.value]),
      [
        ['features.memories', false],
        ['memories.disable_on_external_context', false],
      ],
    );
    // Delete asks first; cancelling sends nothing
    confirms.push(false);
    await v.click('Delete');
    assert.ok(!fixture.calls.includes('memory/reset'));
    confirms.push(true);
    await v.click('Delete');
    await v.flush();
    assert.ok(fixture.calls.includes('memory/reset'));
    assert.deepEqual(fixture.toasts.at(-1), ['Memories deleted']);
    fixture.fail.add('memory/reset');
    confirms.push(true);
    await v.click('Delete');
    await v.flush();
    assert.deepEqual(fixture.toasts.at(-1), ['memory/reset failed', 'error']);
    fixture.answer = async () => {
      throw 'busy';
    };
    confirms.push(true);
    await v.click('Delete');
    await v.flush();
    assert.deepEqual(fixture.toasts.at(-1), ['busy', 'error']);

    await v.clickLink('Learn more');
    await v.clickRow('Custom rules');
    assert.deepEqual(fixture.opened, ['https://developers.openai.com/codex/memory', '/home/.codex/rules']);
    assert.equal(v.host.querySelector('.instructions-editor'), null);
    // AGENTS.md opens on Edit and closes on Done
    await v.click('Edit');
    assert.equal(v.host.querySelector('.instructions-editor')?.textContent, 'codex');
    await v.click('Done');
    assert.equal(v.host.querySelector('.instructions-editor'), null);
  } finally {
    await v.dispose();
    delete (globalThis as any).confirm;
  }
});

test('Personalization without Codex: only the file rows, the page says what needs Codex; tool-assisted chats follow memory being off', async () => {
  fixture.ok = false;
  const v = await mount(createElement(Personalization));
  try {
    assert.equal(v.host.querySelector('.needs-codex'), null);
    assert.equal(v.host.textContent!.includes('Use memory'), false);
    assert.equal(v.host.textContent!.includes('AGENTS.md'), true);
    await v.clickRow('Custom rules');
    assert.deepEqual(fixture.opened, [], 'no rules folder before Codex home is known');
  } finally {
    await v.dispose();
  }
  fixture.ok = true;
  fixture.state.config = {};
  const off = await mount(createElement(Personalization));
  try {
    const tools = off.row('Include tool-assisted chats').querySelector('input');
    assert.equal(off.row('Use memory').querySelector('input').checked, false);
    assert.equal(tools.checked, true);
    assert.equal(tools.disabled, true, 'only with memory on');
  } finally {
    await off.dispose();
  }
});
