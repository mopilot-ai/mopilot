// Settings → Appearance: theme, accent and color overrides, fonts and sizes.

import { Group, Row, Toggle, Select } from './Controls';
import { useResolvedDark } from '../../markdown/Markdown';
import { Download, Copy, ChevronDown, ChevronRight } from '../../ui/icons';
import { useEffect, useState } from 'react';
import { useStore, setPrefs, toast } from '../../../store/core';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { copyText } from '../../../session/clipboard';
import { Menu, MenuItem, SubMenu, useAnchor, Tooltip } from '../../ui/Popover';
import { ACCENT_CHOICES, THEMES, themeById, type Palette } from '../../../lib/themes';
import { DEFAULT_PALETTE, defaultPalette } from '../../../../shared/defaultPalette.mjs';

/* ------------------------------------------------------------------ */
/* Appearance                                                          */
/* ------------------------------------------------------------------ */
export const ACCENTS: { value: string; label: string; color: string }[] = [
  { value: 'default', label: 'Default', color: DEFAULT_PALETTE.dark.accent },
  ...ACCENT_CHOICES,
];

export function Appearance() {
  const prefs = useStore((s) => s.prefs);
  const [advanced, setAdvanced] = useState(false);
  const dark = useResolvedDark();
  const preset = themeById(prefs.themePreset);
  const pal = preset ? ((dark ? preset.dark : preset.light) ?? null) : null;
  const accent = ACCENTS.find((a) => a.value === (prefs.accent ?? 'default')) ?? ACCENTS[0];
  // a hex accent, else the theme palette's: either one switches the accent row to a color input
  const customAccent = prefs.accent?.startsWith('#') ? prefs.accent : pal?.accent;
  return (
    <>
      <Group title="Visual style">
        <Row title="Mode">
          <div className="mode-thumbs">
            {(['system', 'light', 'dark'] as const).map((m) => (
              <button
                key={m}
                className={`mode-thumb ${m} ${prefs.theme === m ? 'on' : ''}`}
                onClick={() => setPrefs({ theme: m })}
                title={m[0].toUpperCase() + m.slice(1)}
              >
                <span className="mt-side" />
                <span className="mt-lines">
                  <i />
                  <i />
                  <i />
                </span>
              </button>
            ))}
          </div>
        </Row>
      </Group>
      <Group>
        <Row title="Theme">
          <ThemeTools dark={dark} pal={pal} />
          <ThemePicker dark={dark} />
        </Row>
        <Row title="Accent">
          {customAccent ? (
            <>
              <Select
                value="custom"
                options={[{ value: 'custom', label: 'Custom' }, ...ACCENTS.map((a) => ({ value: a.value, label: a.label }))]}
                onChange={(v) => v !== 'custom' && setPrefs({ accent: v === 'default' ? null : v })}
              />
              <ColorInput value={customAccent} onChange={(v) => setPrefs({ accent: v })} />
            </>
          ) : (
            <Select
              value={accent.value}
              icon={
                <span
                  className="color-dot"
                  style={{ background: accent.value === 'default' ? defaultPalette(dark).accent : accent.color }}
                />
              }
              options={ACCENTS.map((a) => ({ value: a.value, label: a.label }))}
              onChange={(v) => setPrefs({ accent: v === 'default' ? null : v })}
            />
          )}
        </Row>
        <Row title="Background">
          <ColorInput value={prefs.bgOverride ?? (pal ?? defaultPalette(dark)).bg} onChange={(v) => setPrefs({ bgOverride: v })} />
        </Row>
        <Row title="Foreground">
          <ColorInput value={prefs.fgOverride ?? (pal ?? defaultPalette(dark)).fg} onChange={(v) => setPrefs({ fgOverride: v })} />
        </Row>
        <Row title="Font">
          <FontSelect />
        </Row>
      </Group>
      <div className="settings-links">
        <button className="link-muted" onClick={() => setAdvanced((a) => !a)}>
          Advanced {advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          className="link-muted"
          onClick={() =>
            setPrefs({
              accent: null,
              bgOverride: null,
              fgOverride: null,
              fontFamily: null,
              themePreset: null,
              fontSize: 14,
              codeFontSize: 12,
            })
          }
        >
          Reset to default
        </button>
      </div>
      {advanced && (
        <Group>
          <Row title="Chat font size">
            <Select
              value={String(prefs.fontSize)}
              options={['12', '13', '14', '15', '16', '18'].map((v) => ({ value: v, label: `${v}px` }))}
              onChange={(v) => setPrefs({ fontSize: Number(v) })}
            />
          </Row>
          <Row title="Code font size">
            <Select
              value={String(prefs.codeFontSize)}
              options={['11', '12', '13', '14'].map((v) => ({ value: v, label: `${v}px` }))}
              onChange={(v) => setPrefs({ codeFontSize: Number(v) })}
            />
          </Row>
          <Row title="Wrap long lines in code blocks">
            <Toggle on={prefs.wrapCode} onChange={(v) => setPrefs({ wrapCode: v })} />
          </Row>
        </Group>
      )}
    </>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="color-input">
      <span className="color-dot" style={{ background: value }} />
      <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <span>{value.toUpperCase()}</span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/* Theme picker (Appearance)                                           */
/* ------------------------------------------------------------------ */
function ThemeBadge({ pal }: { pal: Palette | null }) {
  return (
    <span className="theme-badge" style={pal ? { background: pal.bg, color: pal.accent, borderColor: 'transparent' } : undefined}>
      Aa
    </span>
  );
}

function ThemePicker({ dark }: { dark: boolean }) {
  const prefs = useStore((s) => s.prefs);
  const a = useAnchor();
  const preset = themeById(prefs.themePreset);
  const mode = dark ? 'dark' : 'light';
  const choose = (id: string | null) => {
    // A preset replaces any manual color overrides, as in the official picker.
    setPrefs({ themePreset: id, bgOverride: null, fgOverride: null, accent: null });
    a.close();
  };
  return (
    <>
      <button ref={a.ref} className="select-btn theme-select" onClick={a.toggle}>
        <ThemeBadge pal={preset ? (preset[mode] ?? null) : null} />
        <span className="select-label">{preset?.label ?? 'Default'}</span>
        <ChevronDown size={14} strokeWidth={2} />
      </button>
      <Menu anchor={a.anchor} open={a.open} onClose={a.close} placement="bottom-end" width={200}>
        {/* the app's own palette, Claude Desktop's (shared/defaultPalette.mjs); the Codex themes are presets on top of it */}
        <MenuItem icon={<ThemeBadge pal={null} />} checked={!preset} onSelect={() => choose(null)}>
          Default
        </MenuItem>
        <SubMenu icon={<ThemeBadge pal={null} />} label="Codex themes">
          {THEMES.filter((t) => t[mode]).map((t) => (
            <MenuItem key={t.id} icon={<ThemeBadge pal={t[mode]!} />} checked={preset?.id === t.id} onSelect={() => choose(t.id)}>
              {t.label}
            </MenuItem>
          ))}
        </SubMenu>
      </Menu>
    </>
  );
}

/** Import a VS Code color theme (JSON) or copy the current theme to the clipboard. */
function ThemeTools({ dark, pal }: { dark: boolean; pal: Palette | null }) {
  const prefs = useStore((s) => s.prefs);
  const mode = dark ? 'Dark' : 'Light';
  const current = () => ({
    background: prefs.bgOverride ?? (pal ?? defaultPalette(dark)).bg,
    foreground: prefs.fgOverride ?? (pal ?? defaultPalette(dark)).fg,
    accent: (prefs.accent?.startsWith('#') ? prefs.accent : pal?.accent) ?? defaultPalette(dark).accent,
  });
  return (
    <>
      <Tooltip label={`Import ${mode} theme`}>
        <button
          className="icon-btn"
          aria-label={`Import ${mode} theme`}
          onClick={async () => {
            const [file] = await native.dialog.openFiles();
            if (!file) return;
            try {
              const j = JSON.parse((await native.fs.readText(file)) ?? '');
              const c = j.colors ?? {};
              const bg = j.background ?? c['editor.background'];
              const fg = j.foreground ?? c['editor.foreground'] ?? c.foreground;
              const ac = j.accent ?? c['button.background'] ?? c.focusBorder;
              if (!bg || !fg) throw new Error('no colors');
              setPrefs({
                themePreset: null,
                bgOverride: bg.slice(0, 7).toUpperCase(),
                fgOverride: fg.slice(0, 7).toUpperCase(),
                accent: ac ? ac.slice(0, 7).toUpperCase() : null,
              });
              toast(`Imported ${j.name ?? 'theme'}`);
            } catch {
              toast('That file isn’t a color theme', 'error');
            }
          }}
        >
          <Download size={15} strokeWidth={1.7} />
        </button>
      </Tooltip>
      <Tooltip label={`Copy ${mode} theme`}>
        <button
          className="icon-btn"
          aria-label={`Copy ${mode} theme`}
          onClick={() =>
            copyText(
              JSON.stringify(
                { name: themeById(prefs.themePreset)?.label ?? 'Custom', type: dark ? 'dark' : 'light', ...current() },
                null,
                2,
              ),
              'Theme copied',
            )
          }
        >
          <Copy size={15} strokeWidth={1.7} />
        </button>
      </Tooltip>
    </>
  );
}

/** Font picker listing installed fonts, like the official app (local-fonts API). */
let fontCache: string[] | null = null;
function FontSelect() {
  const prefs = useStore((s) => s.prefs);
  const [fonts, setFonts] = useState<string[]>(fontCache ?? []);
  useEffect(() => {
    if (fontCache) return;
    (window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> })
      .queryLocalFonts?.()
      .then((list: { family: string }[]) => {
        fontCache = [...new Set(list.map((f) => f.family))].filter((f) => !f.startsWith('.')).sort((x, y) => x.localeCompare(y));
        setFonts(fontCache);
      })
      // font access denied or unsupported: only System is offered, and the next visit asks again
      .catch((e) => noteIgnored('list the installed fonts', e));
  }, []);
  const value = prefs.fontFamily ?? 'system';
  const opts = [{ value: 'system', label: 'System' }, ...fonts.map((f) => ({ value: f, label: f }))];
  if (value !== 'system' && !fonts.includes(value)) opts.push({ value, label: value });
  return <Select value={value} options={opts} onChange={(v) => setPrefs({ fontFamily: v === 'system' ? null : v })} />;
}
