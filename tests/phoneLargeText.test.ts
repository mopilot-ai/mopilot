// Large text: controls grow with it instead of clipping or running off the screen. The simulator pass (largest accessibility size) is not available here, so the layout rules are checked in the components.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';

const appPath = '../mobile/src/MobileApp';
const composerPath = '../mobile/src/components/Composer';
const welcomePath = '../mobile/src/screens/Welcome';
const { MobileApp } = await import(appPath);
const { Composer } = await import(composerPath);
const { Welcome } = await import(welcomePath);
const segPath = '../mobile/src/components/Segmented';
const termPath = '../mobile/src/components/TerminalInput';
const { Segmented } = await import(segPath);
const { TerminalInput } = await import(termPath);

async function mount(node: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  await flush();
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const styleOf = (el: Element | null | undefined) => JSON.parse((el as HTMLElement).dataset.style ?? '{}');

test('at large text the computer’s name on its card and a chat title cut to one line instead of growing the rows off the screen', async () => {
  const online = {
    phase: 'online',
    generation: 1,
    user: { id: 'u' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Mac' }],
    selectedPair: 'p',
    error: null,
  };
  const s = scripted(
    (m) =>
      m === 'chats.recent'
        ? { chats: [{ id: 'c', title: 'A chat with a long title that should show on two lines before it is cut' }] }
        : undefined,
    online,
  );
  s.runtime.start = async () => {};
  const v = await mount(
    createElement(MobileApp, { runtime: s.runtime, media: { library: async () => ({ picked: [], refused: [] }) } as any }),
  );
  const lines = (text: string) => {
    const n = [...v.host.querySelectorAll('span')].find((span) => span.textContent === text)!;
    return n.getAttribute('numberoflines') ?? n.getAttribute('numberOfLines');
  };
  assert.equal(lines('Mac'), '1', 'the computer’s name on its card');
  assert.equal(
    lines('A chat with a long title that should show on two lines before it is cut'),
    '1',
    'a row is two lines: title, then its line',
  );
  await v.done();
});

test('icon glyphs in fixed circles and marks keep their size, and the tab badge can grow', async () => {
  const props = {
    draft: '',
    setDraft: () => {},
    placeholder: 'x',
    focusKey: 'k',
    autoFocus: false,
    running: false,
    disabled: false,
    stopDisabled: false,
    send: () => {},
    stop: () => {},
    menu: createElement('span'),
    onAttach: () => {},
  };
  const composer = await mount(createElement(Composer, props));
  // with media to add, the bar has + and the microphone
  for (const glyph of ['+', '🎤']) {
    // the symbol's own text fallback, inside the symbol
    const el = [...composer.host.querySelectorAll('span')].filter((n) => n.textContent === glyph).at(-1)!;
    assert.equal(el.getAttribute('data-allow-font-scaling'), 'false', `${glyph} stays inside its circle`);
  }
  await composer.done();
  const welcome = await mount(createElement(Welcome, { busy: false, signIn: () => {} }));
  const mark = [...welcome.host.querySelectorAll('span')].find((n) => n.textContent === 'M')!;
  assert.equal(mark.getAttribute('data-allow-font-scaling'), 'false');
  await welcome.done();
});

// no text-carrying control is given a fixed height: a control sets minHeight, so it grows with its text. The fixed boxes are named here with what each holds.
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

const FIXED_HEIGHTS = new Set([
  'components/PlanSheet.tsx:5', // the sheet's drag handle
  'components/BottomSheet.tsx:5', // the grabber
  'components/AddToSessionSheet.tsx:28', // the round check on a ticked photo: a glyph that does not scale
  'components/AttachmentStrip.tsx:28', // the round × and ! on a file tile: glyphs that do not scale
  'screens/Welcome.tsx:72', // the mark
  'components/JumpToLatest.tsx:36', // the round down-arrow above the composer: a glyph that does not scale
  'components/JumpToLatest.tsx:12', // the dot on it that says an answer waits
  'components/Motion.tsx:4', // one of the three thinking dots
  'components/StepGlyph.tsx:24', // the round glyph of a steps row: a symbol that does not scale
  'screens/MomoPage.tsx:56', // the round mark on MoMo's page, holding the spark (a drawing, not text)
  'screens/MomoCapsule.tsx:7', // the status capsule's dot
  'screens/Momo.tsx:48', // the glass capsule that holds the ⋯ glyph
  'screens/MomoChat.tsx:44', // MoMo's round send and stop buttons: glyphs that do not scale
  'screens/MomoVoice.tsx:44', // MoMo's round microphone, Cancel and Stop buttons: glyphs that do not scale
  'screens/NewChat.tsx:8', // the computer chip's state dot
  'components/MachineSheets.tsx:8', // a machine's state dot
  'components/Segmented.tsx:1', // the selected pill's shadow offset, not a box
  'remote/useEndMeasure.ts:0', // the list's end marker: a view with no content that only says where the rows end, so no text to grow
]);

test('fixed heights are only dots, handles, the camera view and round buttons that hold a glyph that does not scale', () => {
  const found = new Set<string>();
  for (const file of sources(new URL('../mobile/src', import.meta.url).pathname)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/[^a-zA-Z]height:\s*(\d+)/g)) found.add(`${file.split('mobile/src/')[1]}:${m[1]}`);
  }
  assert.deepEqual(
    [...found].filter((f) => !FIXED_HEIGHTS.has(f)),
    [],
    'a control with text is sized with minHeight so that large text makes it grow',
  );
  assert.deepEqual(
    [...FIXED_HEIGHTS].filter((f) => !found.has(f)),
    [],
    'every fixed box named above still exists',
  );
});

test('labels that share a row shrink to fit rather than breaking mid-word, and the terminal keys wrap', async () => {
  const fits = (host: HTMLElement, text: string) =>
    [...host.querySelectorAll('span')].find((n) => n.textContent === text)?.getAttribute('data-fit');
  const segments = await mount(
    createElement(Segmented, {
      items: [
        { key: 'a', label: 'Terminal' },
        { key: 'b', label: 'Changes' },
      ],
      selected: 'a',
    }),
  );
  assert.equal(fits(segments.host, 'Terminal'), '0.7');
  await segments.done();
  const keys = await mount(createElement(TerminalInput, { write: () => {} }));
  const row = keys.host.querySelector('button[aria-label="Esc"]')!.parentElement!;
  assert.equal(styleOf(row).flexWrap, 'wrap');
  await keys.done();
});
