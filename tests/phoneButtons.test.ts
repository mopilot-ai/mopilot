// The look of a button that cannot be used now, and of the selected segment: legible in both themes, not a faded copy of the active one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const uiPath = '../mobile/src/components/ui';
const segPath = '../mobile/src/components/Segmented';
const composerPath = '../mobile/src/components/Composer';
const themePath = '../mobile/src/theme';
const { Button } = await import(uiPath);
const { Segmented } = await import(segPath);
const { Composer } = await import(composerPath);
const { themes } = await import(themePath);

async function render(node: any, dark: boolean) {
  (globalThis as any).__phoneDark = dark;
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
const colourOf = (host: HTMLElement, text: string) => {
  const el = [...host.querySelectorAll('span[data-style]')].find((n) => n.textContent === text) as HTMLElement;
  return JSON.parse(el.dataset.style!).color;
};

for (const scheme of ['light', 'dark'] as const) {
  test(`a main button that cannot be used reads in the quiet ink, a secondary one just fades (${scheme})`, async () => {
    const t = themes[scheme];
    const main = await render(createElement(Button, { title: 'Continue', onPress: () => {}, disabled: true }), scheme === 'dark');
    assert.equal(colourOf(main.host, 'Continue'), t.ink3);
    await main.done();
    const live = await render(createElement(Button, { title: 'Continue', onPress: () => {} }), scheme === 'dark');
    assert.equal(colourOf(live.host, 'Continue'), t.btnInk);
    await live.done();
    const secondary = await render(
      createElement(Button, { title: 'Later', onPress: () => {}, disabled: true, secondary: true }),
      scheme === 'dark',
    );
    assert.equal(colourOf(secondary.host, 'Later'), t.ink);
    await secondary.done();
    const segments = await render(
      createElement(Segmented, {
        items: [
          { key: 'a', label: 'One' },
          { key: 'b', label: 'Two' },
        ],
        selected: 'a',
      }),
      scheme === 'dark',
    );
    // Claude's control: both labels in ink, the selected one a raised pill (white on light) with a soft shadow on the sunken track
    assert.equal(colourOf(segments.host, 'One'), t.ink);
    assert.equal(colourOf(segments.host, 'Two'), t.ink);
    // the raised pill is one view that slides under the options (drawn once the track is measured)
    await act(async () => (globalThis as any).__phoneOnLayout({ nativeEvent: { layout: { width: 200 } } }));
    const pill = JSON.parse(
      [...segments.host.querySelectorAll('[data-style]')]
        .find((n) => JSON.parse(n.getAttribute('data-style')!).backgroundColor === t.segment)!
        .getAttribute('data-style')!,
    );
    assert.ok(pill.shadowOpacity > 0, 'raised');
    assert.equal(
      JSON.parse(segments.host.querySelector('button[aria-label="Two"]')!.getAttribute('data-style')!).backgroundColor,
      undefined,
    );
    await segments.done();
  });
}

test('the round button sends in ink, dims when it cannot send, stops a running turn, and has the microphone beside it', async () => {
  const base = {
    draft: '',
    setDraft: () => {},
    placeholder: 'x',
    focusKey: 'k',
    autoFocus: false,
    running: false,
    stopDisabled: false,
    send: () => {},
    stop: () => {},
  };
  const button = (host: HTMLElement, label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLElement;
  const style = (el: HTMLElement) => JSON.parse(el.getAttribute('data-style')!);
  const off = await render(createElement(Composer, { ...base, disabled: true }), false);
  assert.equal(button(off.host, 'Send message').getAttribute('aria-disabled'), 'true');
  assert.equal(style(button(off.host, 'Send message')).opacity, 0.45, 'a send that cannot go is dimmed');
  await off.done();
  const on = await render(createElement(Composer, { ...base, disabled: false, draft: 'hi' }), false);
  assert.equal(colourOf(on.host, '↑'), themes.light.btnInk);
  assert.equal(style(button(on.host, 'Send message')).backgroundColor, themes.light.btn);
  await on.done();
  const stop = await render(createElement(Composer, { ...base, disabled: false, running: true, stopDisabled: true }), false);
  assert.equal(button(stop.host, 'Stop this chat’s turn').getAttribute('aria-disabled'), 'true');
  const square = [...stop.host.querySelectorAll('div[data-style]')].find(
    (n) => JSON.parse((n as HTMLElement).dataset.style!).width === 13,
  ) as HTMLElement;
  assert.equal(JSON.parse(square.dataset.style!).backgroundColor, themes.light.btnInk);
  await stop.done();
  const mic = await render(createElement(Composer, { ...base, disabled: true, menu: createElement('span') }), false);
  assert.ok(button(mic.host, 'Dictate'), 'the microphone is always beside send');
  assert.ok(button(mic.host, 'Send message'));
  // the microphone opens the menu that holds the voice note
  await act(async () => button(mic.host, 'Dictate').click());
  assert.ok(button(mic.host, 'Close dictation'));
  await mic.done();
});

test('a quiet danger button is red text on the secondary fill, and a section label is a quiet small-caps heading', async () => {
  const uiModule = await import(uiPath);
  for (const scheme of ['light', 'dark'] as const) {
    const t = themes[scheme];
    const v = await render(
      createElement('div', null, [
        createElement(Button, { key: 'b', title: 'Sign out', onPress: () => {}, secondary: true, quietDanger: true }),
        createElement(uiModule.SectionLabel, { key: 's' }, 'Account'),
      ]),
      scheme === 'dark',
    );
    assert.equal(colourOf(v.host, 'Sign out'), t.bad);
    assert.equal(colourOf(v.host, 'Account'), t.ink3);
    assert.ok(v.host.querySelector('[role="header"]'), 'a heading for a screen reader');
    await v.done();
  }
});
