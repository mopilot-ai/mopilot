// The Claude-baseline building blocks: glass circles and capsules, chips, session rows and their fold, sheet groups, the composer shell, headers, and the new tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const glassPath = '../mobile/src/components/Glass';
const rowPath = '../mobile/src/components/SessionRow';
const groupPath = '../mobile/src/components/Grouped';
const composerPath = '../mobile/src/components/ComposerBox';
const sheetPath = '../mobile/src/components/SheetFrame';
const headerPath = '../mobile/src/components/PageHeader';
const themePath = '../mobile/src/theme';
const motionPath = '../mobile/src/motion';
const fontsPath = '../mobile/src/fonts';
const { GlassCircle, GlassCapsule, Capsule, Chip } = await import(glassPath);
const { StatusGlyph, SectionHeader, SessionRow, FoldCapsule, NestedGuide } = await import(rowPath);
const { Group, GroupItem, GroupLabel } = await import(groupPath);
const { ComposerBox, ComposerButton, ModelPill } = await import(composerPath);
const { SheetFrame, SheetHeader } = await import(sheetPath);
const { PageHeader } = await import(headerPath);
const { light, dark } = await import(themePath);
const { spring } = await import(motionPath);
const { serifFamily, monoFamily } = await import(fontsPath);

async function render(node: any, isDark = false) {
  (globalThis as any).__phoneDark = isDark;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    done: async () => {
      delete (globalThis as any).__phoneDark;
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const style = (el: Element | null) => JSON.parse((el as HTMLElement).dataset.style!);
const button = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
const press = async (el: HTMLElement) => act(async () => el.click());
const text = (host: HTMLElement, t: string) =>
  [...host.querySelectorAll('span[data-style]')].find((n) => n.textContent === t) as HTMLElement;

test('a glass circle is a 48 pt round button with its state dot only when asked', async () => {
  let hits = 0;
  const icon = createElement('span', null, 'i');
  for (const [badge, colour] of [
    ['on', light.ok],
    ['off', light.ink3],
  ] as const) {
    const r = await render(createElement(GlassCircle, { label: 'Where it runs', onPress: () => hits++, badge }, icon));
    const b = button(r.host, 'Where it runs');
    assert.equal(style(b).width, 48);
    assert.equal(style(b).borderRadius, 24);
    assert.equal(style(b).backgroundColor, light.surface);
    assert.ok(Number(b.dataset.activeOpacity) < 1, 'it dims while held');
    const dot = [...b.querySelectorAll('[data-style]')].map(style).find((s) => s.position === 'absolute');
    assert.equal(dot.backgroundColor, colour);
    await press(b);
    await r.done();
  }
  const plain = await render(createElement(GlassCircle, { label: 'Back', onPress: () => {} }, icon));
  assert.ok(![...button(plain.host, 'Back').querySelectorAll('[data-style]')].map(style).some((s) => s.position === 'absolute'));
  await plain.done();
  assert.equal(hits, 2);
});

test('a glass capsule holds one 40 pt button per item, each pressable by its label', async () => {
  const seen: string[] = [];
  const r = await render(
    createElement(GlassCapsule, {
      items: [
        { label: 'History', onPress: () => seen.push('h'), icon: createElement('span', null, 'h') },
        { label: 'More', onPress: () => seen.push('m'), icon: createElement('span', null, 'm') },
      ],
    }),
  );
  await press(button(r.host, 'History'));
  await press(button(r.host, 'More'));
  assert.deepEqual(seen, ['h', 'm']);
  assert.equal(style(button(r.host, 'More')).width, 40);
  assert.ok(Number(button(r.host, 'More').dataset.activeOpacity) < 1);
  await r.done();
});

test('the New chat capsule and a chip name what they do and dim while held', async () => {
  let n = 0;
  const r = await render(
    createElement(
      'div',
      null,
      createElement(Capsule, { title: 'New chat', icon: createElement('span', null, '+'), onPress: () => n++ }),
      createElement(Capsule, { title: 'New task', onPress: () => n++ }),
      createElement(Chip, { label: 'Agent', value: 'Codex', onPress: () => n++ }),
    ),
  );
  for (const label of ['New chat', 'New task', 'Agent, Codex']) {
    const b = button(r.host, label);
    assert.ok(Number(b.dataset.activeOpacity) < 1, label);
    await press(b);
  }
  assert.equal(n, 3);
  assert.equal(style(button(r.host, 'New chat')).minHeight, 48);
  assert.equal(style(button(r.host, 'Agent, Codex')).minHeight, 40);
  assert.equal(style(text(r.host, 'Codex')).color, light.ink);
  await r.done();
});

test('status glyphs: amber hand for waiting, a spinning ring for working, a blue dot for new, a small ring otherwise', async () => {
  const r = await render(
    createElement(
      'div',
      null,
      ...(['waiting', 'working', 'new', 'idle', 'stopped'] as const).flatMap((state) => [
        createElement(StatusGlyph, { key: state, state }),
        createElement(StatusGlyph, { key: `${state}-s`, state, small: true }),
      ]),
    ),
  );
  const names = [...r.host.querySelectorAll('[data-symbol]')].map((n) => n.getAttribute('data-symbol'));
  assert.deepEqual(names.slice(0, 6), ['hand.raised', 'hand.raised', 'circle.dotted', 'circle.dotted', 'circle.fill', 'circle.fill']);
  assert.ok(names.slice(6).every((n) => n === 'circle'));
  const spinning = [...r.host.querySelectorAll('[data-style]')].map(style).filter((s) => s.animationIterationCount === 'infinite');
  assert.equal(spinning.length, 2, 'only the working glyphs turn');
  await r.done();
});

test('a session row: title, grey line (text or a node), nested inset, and its own screen-reader label', async () => {
  let opened = 0;
  const r = await render(
    createElement(
      'div',
      null,
      createElement(SectionHeader, { title: 'mopilot', icon: createElement('span', null, 'b') }),
      createElement(SectionHeader, { title: 'Computers' }),
      createElement(SessionRow, { title: 'Fix login', detail: 'Waiting for you · 2m', state: 'waiting', onPress: () => opened++ }),
      createElement(SessionRow, {
        title: 'Build APKs',
        detail: createElement('span', { 'data-style': '{}' }, 'node'),
        state: 'working',
        nested: true,
        label: 'Build APKs, Working',
        onPress: () => opened++,
      }),
    ),
  );
  assert.equal(r.host.querySelectorAll('[role="header"]').length, 2);
  const top = button(r.host, 'Fix login, Waiting for you · 2m');
  assert.equal(style(top).paddingLeft, 24);
  assert.equal(style(text(r.host, 'Fix login')).fontSize, 17);
  assert.equal(style(text(r.host, 'Waiting for you · 2m')).color, light.ink2);
  const child = button(r.host, 'Build APKs, Working');
  assert.equal(style(child).paddingLeft, 60);
  assert.equal(style(text(r.host, 'Build APKs')).fontSize, 16);
  assert.equal(child.dataset.activeUnderlay, light.sunken, 'a held row lays its colour under the content');
  await press(top);
  await press(child);
  assert.equal(opened, 2);
  await r.done();
  const bare = await render(createElement(SessionRow, { title: 'Quiet', detail: '', state: 'idle', onPress: () => {} }));
  assert.ok(button(bare.host, 'Quiet'), 'an empty grey line leaves the title alone');
  await bare.done();
});

test('the fold capsule counts sub-sessions, says whether they are shown and turns its chevron', async () => {
  let taps = 0;
  for (const [count, open, label, turn] of [
    [1, false, '1 sub-session', '0deg'],
    [3, true, '3 sub-sessions', '180deg'],
  ] as const) {
    const r = await render(createElement(NestedGuide, null, createElement(FoldCapsule, { count, open, onPress: () => taps++ })));
    const b = button(r.host, label);
    assert.equal(b.getAttribute('aria-expanded'), String(open));
    const rot = [...b.querySelectorAll('[data-style]')].map(style).find((s) => s.transform);
    assert.equal(rot.transform[0].rotate, turn);
    await press(b);
    const guide = [...r.host.querySelectorAll('[data-style]')].map(style).find((s) => s.position === 'absolute');
    assert.equal(guide.left, 35);
    await r.done();
  }
  assert.equal(taps, 2);
});

test('sheet groups: label, rows with chevron or check, blue link and red sign-out tones, a trailing control, a plain row', async () => {
  const seen: string[] = [];
  const r = await render(
    createElement(
      'div',
      null,
      createElement(GroupLabel, null, 'Computers'),
      createElement(
        Group,
        null,
        createElement(GroupItem, {
          key: 'a',
          title: 'Appearance',
          value: 'System',
          end: 'chevron',
          onPress: () => seen.push('a'),
          icon: createElement('span', null, 'i'),
        }),
        createElement(GroupItem, { key: 'b', title: 'Opus 5.5', detail: 'For complex work', end: 'check', onPress: () => seen.push('b') }),
        createElement(GroupItem, {
          key: 'c',
          title: 'Add a computer',
          tone: 'link',
          onPress: () => seen.push('c'),
          icon: createElement('span', null, '+'),
        }),
        createElement(GroupItem, { key: 'd', title: 'Sign out', tone: 'danger', onPress: () => seen.push('d') }),
        createElement(GroupItem, { key: 'e', title: 'Haptic feedback', trailing: createElement('span', null, 'switch'), end: 'chevron' }),
        null,
      ),
    ),
  );
  assert.equal(r.host.querySelectorAll('[role="header"]').length, 1);
  await press(button(r.host, 'Appearance, System'));
  await press(button(r.host, 'Opus 5.5'));
  await press(button(r.host, 'Add a computer'));
  await press(button(r.host, 'Sign out'));
  assert.deepEqual(seen, ['a', 'b', 'c', 'd']);
  assert.equal(button(r.host, 'Opus 5.5').getAttribute('aria-selected'), 'true');
  assert.equal(style(text(r.host, 'Add a computer')).color, light.accent);
  assert.equal(style(text(r.host, 'Sign out')).color, light.bad);
  assert.equal(style(text(r.host, 'Sign out')).textAlign, 'center');
  assert.equal(style(text(r.host, 'Appearance')).textAlign, 'left');
  const symbols = [...r.host.querySelectorAll('[data-symbol]')].map((n) => n.getAttribute('data-symbol'));
  assert.deepEqual(symbols, ['chevron.right', 'checkmark'], 'a trailing control replaces the end mark');
  assert.ok(text(r.host, 'switch') || r.host.textContent!.includes('switch'));
  await r.done();
});

test('group hairlines are inset as in Claude’s Settings: from where the row above starts its title, to a row padding short of the edge', async () => {
  const r = await render(
    createElement(
      Group,
      null,
      createElement(GroupItem, { key: 'a', title: 'With a glyph', icon: createElement('span', null, 'i') }),
      createElement(GroupItem, { key: 'b', title: 'Plain' }),
      createElement(GroupItem, { key: 'c', title: 'Another glyph', icon: createElement('span', null, '+') }),
      createElement(GroupItem, { key: 'd', title: 'Last' }),
    ),
  );
  const lines = [...r.host.querySelectorAll('[data-style]')].map(style).filter((st) => st.borderTopWidth === 1);
  assert.deepEqual(
    lines.map((st) => [st.marginLeft, st.marginRight, st.borderTopColor]),
    [
      [54, 16, light.line],
      [16, 16, light.line],
      [54, 16, light.line],
    ],
    'after a row with a glyph the line starts at its title (16 + 24 + 14); after a plain row at the row padding',
  );
  await r.done();
  const one = await render(createElement(Group, null, createElement(GroupItem, { key: 'only', title: 'Alone' })));
  assert.equal(
    [...one.host.querySelectorAll('[data-style]')].map(style).filter((st) => st.borderTopWidth === 1).length,
    0,
    'one row, no line',
  );
  await one.done();
});

test('the composer shell: chips, +, the model pill, the strong send end; without + or chips when not given', async () => {
  const seen: string[] = [];
  let typed = '';
  const r = await render(
    createElement(ComposerBox, {
      value: '',
      onChangeText: (t: string) => (typed = t),
      placeholder: 'Reply…',
      onAttach: () => seen.push('attach'),
      chips: createElement('span', null, 'chips'),
      bar: createElement(ModelPill, { model: 'Opus 5.5', detail: 'High', onPress: () => seen.push('model') }),
      end: createElement(ComposerButton, {
        label: 'Send',
        strong: true,
        onPress: () => seen.push('send'),
        icon: createElement('span', null, '↑'),
      }),
    }),
  );
  await press(button(r.host, 'Add to session'));
  await press(button(r.host, 'Model, Opus 5.5 High'));
  await press(button(r.host, 'Send'));
  assert.deepEqual(seen, ['attach', 'model', 'send']);
  assert.equal(style(button(r.host, 'Send')).backgroundColor, light.btn);
  assert.equal(style(button(r.host, 'Add to session')).backgroundColor, light.sunken);
  assert.ok(r.host.querySelector('input[placeholder="Reply…"]'));
  assert.ok(r.host.textContent!.includes('chips'));
  await r.done();
  const bare = await render(
    createElement(ComposerBox, {
      value: 'x',
      onChangeText: () => {},
      placeholder: 'Ask MoMo anything',
      editable: false,
      bar: createElement(ModelPill, { model: 'GPT-5.5', onPress: () => {} }),
      end: createElement(ComposerButton, {
        label: 'Stop',
        strong: true,
        disabled: true,
        onPress: () => {},
        icon: createElement('span', null, '■'),
      }),
    }),
  );
  assert.equal(button(bare.host, 'Add to session'), null);
  assert.ok(button(bare.host, 'Model, GPT-5.5'));
  const stop = button(bare.host, 'Stop');
  assert.equal(stop.disabled, true);
  assert.equal(style(stop).opacity, 0.45);
  assert.equal(stop.dataset.activeOpacity, '0.45', 'a disabled button does not dim further');
  assert.equal(bare.host.textContent!.includes('chips'), false);
  await bare.done();
  const empty = await render(createElement(ComposerBox, { value: '', onChangeText: () => {}, placeholder: 'Reply…', chips: '' }));
  assert.ok(empty.host.querySelector('input'), 'an empty chips value draws no row (and no raw text)');
  await empty.done();
  assert.equal(typed, '');
});

test('a sheet: ✕ or ‹, the centred title, an optional right control, then its content', async () => {
  let closed = 0;
  const r = await render(
    createElement(
      SheetFrame,
      { title: 'Settings', onClose: () => closed++, right: createElement('span', null, 'R') },
      createElement('span', null, 'body'),
    ),
  );
  await press(button(r.host, 'Close'));
  assert.equal(r.host.querySelector('[role="header"]')!.textContent, 'Settings');
  assert.ok(r.host.textContent!.includes('body') && r.host.textContent!.includes('R'));
  await r.done();
  const back = await render(createElement(SheetHeader, { title: 'Effort', onClose: () => closed++, back: true }));
  await press(button(back.host, 'Back'));
  assert.ok(back.host.querySelector('[data-symbol="chevron.left"]'));
  await back.done();
  assert.equal(closed, 2);
});

test('the page header centres its title and grey line between the side controls; an empty title draws no header', async () => {
  const r = await render(
    createElement(PageHeader, {
      title: 'Chats',
      subtitle: 'Sub-session of Android startup check',
      left: createElement('span', null, 'L'),
      right: createElement('span', null, 'R'),
    }),
  );
  assert.equal(r.host.querySelector('[role="header"]')!.textContent, 'Chats');
  assert.equal(style(text(r.host, 'Sub-session of Android startup check')).fontSize, 12);
  await r.done();
  const bare = await render(createElement(PageHeader, { subtitle: createElement('span', null, 'Online') }));
  assert.equal(bare.host.querySelector('[role="header"]'), null);
  assert.ok(bare.host.textContent!.includes('Online'));
  await bare.done();
});

test('in dark the blocks draw the dark tokens', async () => {
  const r = await render(
    createElement(GlassCircle, { label: 'Back', onPress: () => {}, badge: 'on' }, createElement('span', null, 'i')),
    true,
  );
  assert.equal(style(button(r.host, 'Back')).backgroundColor, dark.surface);
  assert.equal(style(button(r.host, 'Back')).borderColor, dark.glassLine);
  await r.done();
});

test('baseline tokens: graphic orange and amber, the drawer step, and Claude’s sheet spring', () => {
  for (const palette of [light, dark]) {
    assert.match(palette.orange, /^#[0-9a-f]{6}$/);
    assert.notEqual(palette.drawer, palette.bg);
  }
  assert.equal(light.bg, '#fafaf8');
  assert.equal(dark.bg, '#151515');
  // response 0.36 s as the reference has it, but critically damped (damping 2 · √stiffness): the reference's 0.88 overshoots
  const w = (2 * Math.PI) / 0.36;
  assert.ok(Math.abs(spring.baseline.stiffness - w * w) < 0.5);
  assert.ok(Math.abs(spring.baseline.damping - 2 * w) < 0.05);
});

test('the serif is the system one on iOS and the generic serif elsewhere; the mono face is unchanged', () => {
  assert.equal(serifFamily(), 'ui-serif');
  assert.equal(monoFamily(), 'Menlo');
  (globalThis as any).__phonePlatform = 'android';
  try {
    assert.equal(serifFamily(), 'serif');
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});
