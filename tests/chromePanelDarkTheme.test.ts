// The Chrome side panel's dark theme (electron/chrome-extension/sidepanel.css and panel.css, #3046 batch B8): the values taken from the app's own dark
// palette (src/styles/tokens.css), the elements that read them, WCAG contrast for the text and marks on each surface, and the light values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DARK,
  type Rgba,
  contrast,
  declared,
  extensionStylesheets,
  over,
  parseColor,
  parseRules,
  resolveToken,
  tokensFor,
} from './helpers/chromePanelCss.ts';

const sheets = extensionStylesheets();
const side = sheets.find((s) => s.file === 'sidepanel.css')!.css;
const popup = sheets.filter((s) => s.file === 'panel.css');
const dark = tokensFor(sheets, 'dark');
const light = tokensFor(sheets, 'light');
const darkPopup = tokensFor(popup, 'dark');
const colour = (tokens: Map<string, string>, name: string): Rgba => parseColor(resolveToken(tokens, name));
const D = (name: string) => colour(dark, name);

test("dark tokens are the app's own dark palette (src/styles/tokens.css)", () => {
  const ours: Record<string, string> = {
    '--bg': '#171a21', // the app's main surface: the page
    '--card': '#22252c', // the app's raised surface: the composer card
    '--soft': '#22252c',
    '--fg': '#eef1f6', // the app's text
    '--muted': '#a8adb7', // panel.css's own dark muted grey
    '--bubble': '#22252c', // the app's user bubble
    '--hover': '#35383f', // the app's third surface: a step above the menus and the card, so a hover shows on them
    '--info-bg': '#22252c',
    '--code-bg': '#22252c', // the app's code block
    '--menu-bg': '#22252c', // the app's menu
    '--danger-bg': '#361f1e', // the app's red at 16% over the page
    '--danger-fg': '#f06a62', // the app's red text
    '--error': '#f06a62',
    '--link': 'currentcolor', // links and inline code keep the text colour, as in light
    '--code-ic-fg': 'currentcolor',
    '--line': 'rgb(255 255 255 / 0.1)', // the app's hairline
    '--line-strong': 'rgb(255 255 255 / 0.2)', // the app's strong hairline
    '--accent': '#3b6ff5', // the app's blue accent, also in dark
  };
  for (const [name, value] of Object.entries(ours)) assert.equal(resolveToken(dark, name), value, name);
  assert.deepEqual(parseColor(dark.get('--code-ic-bg')!), [255, 255, 255, 0.06]);
  // the app's menu shadow in dark, for all three menus
  for (const name of ['--shadow-header-menu', '--shadow-row-menu', '--shadow-menu'])
    assert.equal(dark.get(name), '0 8px 24px rgb(0 0 0 / 0.32), 0 2px 6px rgb(0 0 0 / 0.2)', name);
});

test("light values are the app's own light palette, with the panel's own greys", () => {
  const kept: Record<string, string> = {
    '--bg': '#fbfcfe',
    '--fg': '#181e2a',
    '--soft': '#f0f1f3',
    '--accent': '#3b6ff5',
    '--card': '#fff',
    '--bubble': 'var(--soft)',
    '--hover': 'var(--soft)',
    '--info-bg': 'var(--soft)',
    '--code-bg': 'var(--soft)',
    '--code-ic-bg': 'var(--soft)',
    '--code-ic-fg': 'currentcolor',
    '--link': 'currentcolor',
    '--menu-bg': 'var(--bg)',
    '--line-strong': 'var(--line)',
    '--danger-bg': '#f9edeb',
    '--danger-fg': '#c9332a',
    '--rec': '#d33',
    '--on-rec': '#fff',
    '--shadow-card': '0 2px 10px rgb(0 0 0 / 0.08), 0 0 0 0.5px rgb(0 0 0 / 0.08)',
    '--shadow-header-menu': '0 8px 28px rgb(0 0 0 / 0.12)',
    '--shadow-row-menu': '0 8px 24px rgba(0, 0, 0, 0.14)',
    '--shadow-menu': '0 6px 24px rgb(0 0 0 / 0.14)',
    '--shadow-jump': '0 2px 8px rgb(0 0 0 / 0.08)',
    '--muted': '#6b6b6b',
    '--line': '#e4e4e4',
    '--error': '#c5221f',
  };
  for (const [name, value] of Object.entries(kept)) assert.equal(light.get(name), value, name);
});

test('the elements read the tokens: bubble, code, links, menus, card, banners', () => {
  const uses: [string, string, string][] = [
    ['.you', 'background', 'var(--bubble)'],
    ['.reply code', 'background', 'var(--code-ic-bg)'],
    ['.reply code', 'color', 'var(--code-ic-fg)'],
    ['.reply pre', 'background', 'var(--code-bg)'],
    ['.reply pre code', 'color', 'inherit'],
    ['.reply a', 'color', 'var(--link)'],
    ['.plan a', 'color', 'var(--link)'],
    ['.plan code', 'color', 'var(--code-ic-fg)'],
    ['.plan pre', 'background', 'var(--code-bg)'],
    ['.plan pre code', 'color', 'inherit'],
    ['.menu', 'background', 'var(--menu-bg)'],
    ['.menu', 'border', '1px solid var(--line-strong)'],
    ['.menu', 'box-shadow', 'var(--shadow-menu)'],
    ['.row-menu', 'background', 'var(--menu-bg)'],
    ['.row-menu', 'box-shadow', 'var(--shadow-row-menu)'],
    ['.header-menu', 'border', '1px solid var(--line-strong)'],
    ['.header-menu', 'box-shadow', 'var(--shadow-header-menu)'],
    ['.composer-card', 'box-shadow', 'var(--shadow-card)'],
    ['.jump', 'box-shadow', 'var(--shadow-jump)'],
    ['.mic.recording', 'background', 'var(--rec)'],
    ['.mic.recording', 'color', 'var(--on-rec)'],
    ['.usage-banner', 'background', 'var(--info-bg)'],
    ['.title:hover, .icon:hover', 'background', 'var(--hover)'],
    ['.side-item:hover, .row-chat:hover, .row-chat.on', 'background', 'var(--hover)'],
    ['.row-menu button:hover', 'background', 'var(--hover)'],
    ['.pick:hover:not(:disabled)', 'background', 'var(--hover)'],
    ['.menu-item:hover:not(:disabled)', 'background', 'var(--hover)'],
    ['#error', 'background', 'var(--danger-bg)'],
    ['#error', 'color', 'var(--danger-fg)'],
    // the refusal card (B9) shares the error banner's danger fill and text; the approaching banner is the usage banner above
    ['#refusal', 'background', 'var(--danger-bg)'],
    ['#refusal', 'color', 'var(--danger-fg)'],
    ['.card .choices button:not(.primary)', 'border-color', 'var(--line-strong)'],
    ['.step[data-state="failed"]::before', 'background', 'var(--error)'],
    ['.bar', 'border-bottom', '1px solid var(--line)'],
    ['.send:disabled', 'opacity', '0.5'],
  ];
  for (const [selector, prop, value] of uses) assert.equal(declared(side, selector, prop), value, `${selector} { ${prop} }`);
});

test('dark text reaches WCAG AA (4.5:1) on every surface it is drawn on', () => {
  const page = D('--bg');
  const surfaces: Record<string, Rgba> = {
    page,
    card: D('--card'),
    soft: D('--soft'),
    bubble: D('--bubble'),
    'code block': D('--code-bg'),
    menu: D('--menu-bg'),
    'usage banner': D('--info-bg'),
    hover: D('--hover'),
  };
  const failures: string[] = [];
  const check = (what: string, fg: Rgba, bg: Rgba, min: number) => {
    const ratio = contrast(over(fg, bg), bg);
    if (ratio < min) failures.push(`${what}: ${ratio.toFixed(2)} < ${min}`);
  };
  for (const [name, bg] of Object.entries(surfaces)) {
    check(`text on ${name}`, D('--fg'), bg, 4.5);
    check(`muted text on ${name}`, D('--muted'), bg, 4.5);
  }
  // links and inline code are the text colour; inline code sits on a 6% veil over the page, a card or the plan
  for (const name of ['page', 'card']) check(`inline code on ${name}`, D('--fg'), over(D('--code-ic-bg'), surfaces[name]), 4.5);
  check('error banner text', D('--danger-fg'), D('--danger-bg'), 4.5);
  check('error text on the page', D('--error'), page, 4.5);
  check('error text on the card', D('--error'), D('--card'), 4.5);
  check('primary button text', colour(darkPopup, '--btn-fg'), colour(darkPopup, '--btn'), 4.5);
  check('recording mic', D('--on-rec'), D('--rec'), 4.5);
  assert.deepEqual(failures, []);
});

test('placeholders take the muted text colour in dark, on every page that loads panel.css', () => {
  const rule = parseRules(popup[0].css).find((r) => r.selector === '::placeholder' && r.context.join() === DARK);
  assert.deepEqual(rule?.decls, [
    { prop: 'color', value: 'var(--muted)' },
    { prop: 'opacity', value: '1' },
  ]);
  assert.ok(contrast(colour(darkPopup, '--muted'), colour(darkPopup, '--bg')) >= 4.5);
});

test('a hover fill is told apart from the menus, the card and the page it lands on (1.2:1 or more)', () => {
  const hover = D('--hover');
  for (const name of ['--menu-bg', '--card', '--bg'])
    assert.ok(contrast(hover, D(name)) >= 1.2, `${name}: ${contrast(hover, D(name)).toFixed(2)}`);
  // light: the hover fill is the soft fill, which is not the page, the card or the menu either
  const soft = colour(light, '--hover');
  for (const name of ['--menu-bg', '--bg']) assert.ok(contrast(soft, colour(light, name)) >= 1.05, name);
});

test('dark icons and marks reach 3:1 on the page', () => {
  const page = D('--bg');
  const marks = ['--fg', '--muted', '--accent', '--error', '--ok', '--wait', '--off'];
  const failures = marks.filter((name) => contrast(D(name), page) < 3).map((name) => `${name}: ${contrast(D(name), page).toFixed(2)}`);
  assert.deepEqual(failures, []);
  // the send button's fill against the page behind it, and its arrow against the fill
  assert.ok(contrast(colour(dark, '--btn'), page) >= 3);
  assert.ok(contrast(colour(dark, '--btn-fg'), colour(dark, '--btn')) >= 4.5);
});

test('the popup and options pages (panel.css alone) keep their text and marks readable in dark too', () => {
  const page = colour(darkPopup, '--bg');
  for (const name of ['--fg', '--muted', '--error']) assert.ok(contrast(colour(darkPopup, name), page) >= 4.5, name);
  for (const name of ['--ok', '--wait', '--off']) assert.ok(contrast(colour(darkPopup, name), page) >= 3, name);
});

test('the cascade resolves as the browser does: the side panel redefines what panel.css set for dark', () => {
  // panel.css's dark #202124 page is not the side panel's: sidepanel.css (loaded after it) sets the page again in its dark block
  assert.equal(resolveToken(darkPopup, '--bg'), '#202124');
  assert.equal(resolveToken(dark, '--bg'), '#171a21');
  assert.throws(() => resolveToken(dark, '--nope'), /does not resolve/);
});

test('colour parsing and arithmetic', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('#0003'), [0, 0, 0, 0.2]);
  assert.deepEqual(
    parseColor('#00000052').map((v) => Math.round(v * 1000) / 1000),
    [0, 0, 0, 0.322],
  );
  assert.deepEqual(parseColor('rgb(255 255 255 / 0.1)'), [255, 255, 255, 0.1]);
  assert.deepEqual(parseColor('rgba(1, 2, 3, 0.5)'), [1, 2, 3, 0.5]);
  assert.deepEqual(parseColor('rgb(1 2 3)'), [1, 2, 3, 1]);
  assert.deepEqual(parseColor('rgb(0 0 0 / 50%)'), [0, 0, 0, 0.5]);
  assert.throws(() => parseColor('#12345'), /not a colour/);
  assert.throws(() => parseColor('rgb(0 0 0 / x)'), /not a colour/);
  assert.throws(() => parseColor('rgb(0 0)'), /not a colour/);
  assert.throws(() => parseColor('currentcolor'), /not a colour/);
  assert.deepEqual(over([255, 0, 0, 0.5], [0, 0, 0, 1]), [128, 0, 0, 1]);
  assert.equal(contrast([0, 0, 0, 1], [255, 255, 255, 1]), 21);
  assert.equal(contrast([255, 255, 255, 1], [255, 255, 255, 1]), 1);
});
