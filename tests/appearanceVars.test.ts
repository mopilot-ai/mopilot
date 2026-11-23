// Appearance settings as CSS variables (src/lib/appearance.ts) and theme presets (src/lib/themes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearanceVars } from '../src/lib/appearance.ts';
import { ACCENT_CHOICES, THEMES, themeById } from '../src/lib/themes.ts';
import { DEFAULT_PALETTE, defaultPalette } from '../shared/defaultPalette.mjs';

const base = { codeFontSize: 12 };

test('each mode without a theme derives every surface from the default palette', () => {
  for (const dark of [true, false]) {
    const pal = defaultPalette(dark);
    const v = appearanceVars(base as any, 14, dark);
    assert.equal(v['--fs-chat'], '14px');
    assert.equal(v['--fs-code'], '12px');
    assert.deepEqual([v['--main'], v['--text'], v['--accent']], [pal.bg, pal.fg, pal.accent]);
    for (const name of ['--sidebar', '--frame', '--composer-bg', '--surface', '--bubble', '--menu-bg', '--accent-soft', '--diff-hunk'])
      assert.ok(v[name], `${dark ? 'dark' : 'light'} sets ${name}`);
  }
  // MoPilot's sidebar rises above the dark chat surface and remains white in light mode.
  assert.equal(appearanceVars(base as any, 14, true)['--sidebar'], 'rgb(40, 43, 50)');
  assert.equal(appearanceVars(base as any, 14, false)['--sidebar'], 'rgb(255, 255, 255)');
});

test('the page zoom main applies is a variable too, for the title bar to keep clear of the window buttons', () => {
  assert.equal(appearanceVars(base as any, 14, true)['--zoom'], '1', 'Actual Size without a saved level');
  assert.equal(appearanceVars({ ...base, zoomLevel: 1 } as any, 14, true)['--zoom'], '1.2');
  // an unusable saved level is Actual Size, as main applies it
  assert.equal(appearanceVars({ ...base, zoomLevel: 'x' } as any, 14, true)['--zoom'], '1');
  assert.equal(appearanceVars({ ...base, zoomLevel: 1 } as any, 14, true)['--fs-chat'], '14px', 'zoom leaves the chat font size');
});

test('a preset uses its palette for the mode, and a mode it lacks falls back to the default palette', () => {
  const dark = appearanceVars({ ...base, themePreset: 'dracula' } as any, 14, true);
  assert.deepEqual([dark['--main'], dark['--text'], dark['--accent']], ['#282A36', '#F8F8F2', '#FF79C6']);
  // Dracula has no light palette: light mode keeps the default one
  const light = appearanceVars({ ...base, themePreset: 'dracula' } as any, 14, false);
  assert.deepEqual([light['--main'], light['--accent']], [DEFAULT_PALETTE.light.bg, DEFAULT_PALETTE.light.accent]);
  assert.equal(appearanceVars({ ...base, themePreset: 'proof' } as any, 14, false)['--main'], '#F5F3ED');
  assert.equal(appearanceVars({ ...base, themePreset: 'unknown' } as any, 14, true)['--main'], DEFAULT_PALETTE.dark.bg);
});

test('overrides win over the palette, one side at a time', () => {
  const v = appearanceVars({ ...base, themePreset: 'nord', bgOverride: '#000', fgOverride: '#fff' } as any, 14, true);
  assert.deepEqual([v['--main'], v['--text'], v['--ink']], ['#000', '#fff', '255, 255, 255']);
  const fgOnly = appearanceVars({ ...base, fgOverride: '#112233' } as any, 14, false);
  assert.deepEqual([fgOnly['--main'], fgOnly['--text']], [DEFAULT_PALETTE.light.bg, '#112233']);
  const bgOnly = appearanceVars({ ...base, bgOverride: '#fafafa' } as any, 14, false);
  assert.deepEqual([bgOnly['--main'], bgOnly['--text']], ['#fafafa', DEFAULT_PALETTE.light.fg]);
});

test('accents by name, by colour, or from the palette, and every tint follows the one picked', () => {
  const green = accentColor('green');
  assert.equal(appearanceVars({ ...base, accent: 'green' } as any, 14, false)['--accent'], green);
  const custom = appearanceVars({ ...base, accent: '#123456', themePreset: 'nord' } as any, 14, true);
  assert.deepEqual(
    [custom['--accent'], custom['--send-bg'], custom['--toggle-on'], custom['--badge-text']],
    ['#123456', '#123456', '#123456', '#123456'],
  );
  assert.equal(custom['--focus-ring'], 'rgba(18, 52, 86, 0.6)');
  assert.equal(custom['--accent-soft'], 'rgba(18, 52, 86, 0.16)');
  // a name this build lacks, or a value that is not a color, keeps the palette's accent
  for (const accent of ['weird', 'red'])
    assert.equal(appearanceVars({ ...base, accent } as any, 14, false)['--accent'], DEFAULT_PALETTE.light.accent, accent);
  // the default palette keeps toggles and focus rings in its own interactive color; a picked accent takes them over
  assert.equal(appearanceVars(base as any, 14, false)['--toggle-on'], DEFAULT_PALETTE.light.interactive);
  assert.equal(appearanceVars({ ...base, accent: 'green' } as any, 14, false)['--toggle-on'], green);
});

test('fonts by name or family', () => {
  assert.equal(
    appearanceVars({ ...base, fontFamily: 'mono' } as any, 14, false)['--font-sans'],
    'ui-monospace, "SF Mono", Menlo, monospace',
  );
  assert.equal(
    appearanceVars({ ...base, fontFamily: 'Inter' } as any, 14, false)['--font-sans'],
    '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
  );
  assert.equal(appearanceVars(base as any, 14, false)['--font-sans'], undefined);
});

test('themes are found by id, and the named accents are unique', () => {
  assert.equal(themeById('nord')?.label, 'Nord');
  assert.equal(themeById(null), null);
  assert.equal(new Set(THEMES.map((t) => t.id)).size, THEMES.length);
  assert.equal(new Set(ACCENT_CHOICES.map((a) => a.value)).size, ACCENT_CHOICES.length);
  assert.ok(!ACCENT_CHOICES.some((a) => a.value === 'default'), 'the default accent is the palette’s, not a named one');
});

function accentColor(name: string) {
  return ACCENT_CHOICES.find((a) => a.value === name)!.color;
}
