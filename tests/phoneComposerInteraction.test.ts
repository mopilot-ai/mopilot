// Composer menu scrolling and keyboard dismissal on both composer surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, click } from './support/phone/component-kit';
const menuPath = '../mobile/src/components/ComposerMenu';
const { ComposerMenu } = await import(menuPath);
const composerPath = '../mobile/src/components/Composer';
const { Composer } = await import(composerPath);
const boxPath = '../mobile/src/components/ComposerBox';
const { ComposerBox } = await import(boxPath);

test('the menu bounds a keyboard-preserving list, highlights its first row, and picks the last row', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const rows = Array.from({ length: 20 }, (_, i) => ({
    name: `c${i}`,
    description: '',
    hint: '',
    kind: 'command' as const,
    as: 'text' as const,
    skill: false,
  }));
  const picked: unknown[] = [];
  await act(async () =>
    root.render(
      createElement(ComposerMenu, {
        menu: { kind: 'slash', status: 'ready', error: null, rows },
        skills: [],
        pick: (r: unknown) => picked.push(r),
        removeSkill() {},
      }),
    ),
  );
  const list = host.querySelector('[data-flat-list]');
  assert.ok(list, 'native virtualized list');
  assert.equal(list.getAttribute('data-keyboard-taps'), 'handled');
  assert.deepEqual(JSON.parse(list.getAttribute('data-style')!), { maxHeight: 260, flexGrow: 0, flexShrink: 1, minHeight: 0 });
  assert.equal(host.querySelector('[role="menuitem"]')?.getAttribute('aria-selected'), 'true');
  await click('Command /c19');
  assert.deepEqual(picked, [rows[19]]);
  await act(async () => root.unmount());
  host.remove();
});

test('both composer surfaces offer a keyboard-minimize control without changing the draft', async () => {
  for (const Component of [Composer, ComposerBox]) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const before = (globalThis as any).__keyboardDismissed ?? 0;
    await act(async () =>
      root.render(
        createElement(Component as any, {
          draft: 'keep',
          value: 'keep',
          setDraft() {},
          onChangeText() {},
          placeholder: 'Message',
          focusKey: 'c',
          autoFocus: false,
          running: false,
          disabled: true,
          stopDisabled: true,
          send() {},
        }),
      ),
    );
    const control = host.querySelector('button[aria-label="Minimize keyboard"]')!;
    const shape = JSON.parse(control.getAttribute('data-style')!);
    assert.equal(shape.minHeight, 36);
    assert.equal(shape.aspectRatio, 1);
    assert.equal(control.querySelector('[data-allow-font-scaling]')?.getAttribute('data-allow-font-scaling'), 'false');
    await click('Minimize keyboard');
    assert.equal((globalThis as any).__keyboardDismissed, before + 1);
    assert.ok(host.querySelector('input')?.value === 'keep');
    await act(async () => root.unmount());
    host.remove();
  }
});
