// The Shiki engine behind highlight.ts: it runs in the highlight worker, or in the window where there is none.
import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
  type ThemeRegistration,
  bundledLanguages,
} from 'shiki';
import { DEFAULT_PALETTE } from '../../shared/defaultPalette.mjs';
import { cacheable } from './highlightCache';

let hl: Promise<Highlighter> | null = null;
const loaded = new Set<string>(['text']);
const DARK: string = 'codex-dark';
const LIGHT: string = 'codex-light';

// Token colors sampled from the official Codex app's diff/code rendering.
const codexDark = {
  name: 'codex-dark',
  type: 'dark',
  colors: { 'editor.background': DEFAULT_PALETTE.dark.bg, 'editor.foreground': DEFAULT_PALETTE.dark.fg },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#8b8b8b' } },
    {
      scope: ['keyword.control', 'keyword.control.flow', 'keyword.control.import', 'keyword.control.export', 'keyword.control.from'],
      settings: { foreground: '#f67576' },
    },
    {
      scope: [
        'storage.type',
        'storage.modifier',
        'keyword.declaration',
        'keyword.other',
        'entity.name.function',
        'support.function',
        'meta.function-call entity.name.function',
      ],
      settings: { foreground: '#b06dff' },
    },
    { scope: ['variable.parameter', 'meta.parameters variable', 'entity.other.attribute-name'], settings: { foreground: '#fa994c' } },
    { scope: ['keyword.operator', 'punctuation.accessor', 'storage.type.function.arrow'], settings: { foreground: '#6dcbf4' } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: '#999999' } },
    { scope: ['string', 'string.quoted', 'punctuation.definition.string'], settings: { foreground: '#5ecb8b' } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character'], settings: { foreground: '#68cdf2' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#ffd479' } },
    { scope: ['entity.name.tag'], settings: { foreground: '#f67576' } },
    { scope: ['variable.other.property', 'meta.object-literal.key', 'support.type.property-name'], settings: { foreground: '#7cc7ff' } },
    { scope: ['markup.heading'], settings: { foreground: '#b06dff', fontStyle: 'bold' } },
  ],
};
const codexLight = {
  name: 'codex-light',
  type: 'light',
  colors: { 'editor.background': DEFAULT_PALETTE.light.bg, 'editor.foreground': DEFAULT_PALETTE.light.fg },
  tokenColors: [
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#8a8a8a' } },
    {
      scope: ['keyword.control', 'keyword.control.flow', 'keyword.control.import', 'keyword.control.export'],
      settings: { foreground: '#d1393c' },
    },
    {
      scope: ['storage.type', 'storage.modifier', 'keyword.declaration', 'keyword.other', 'entity.name.function', 'support.function'],
      settings: { foreground: '#8a3ffc' },
    },
    { scope: ['variable.parameter', 'entity.other.attribute-name'], settings: { foreground: '#c26a12' } },
    { scope: ['keyword.operator', 'punctuation.accessor'], settings: { foreground: '#0a84b8' } },
    { scope: ['punctuation', 'meta.brace'], settings: { foreground: '#7a7a7a' } },
    { scope: ['string', 'string.quoted'], settings: { foreground: '#1f8a43' } },
    { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#0a84b8' } },
    { scope: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'], settings: { foreground: '#9a6700' } },
  ],
};

const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  yml: 'yaml',
  md: 'markdown',
  golang: 'go',
  'c++': 'cpp',
  objc: 'objective-c',
  kt: 'kotlin',
  diff: 'diff',
  patch: 'diff',
};

function getHl() {
  if (!hl)
    hl = createHighlighter({ themes: [codexDark as ThemeRegistration, codexLight as ThemeRegistration], langs: [] }).catch((error) => {
      hl = null;
      throw error;
    });
  return hl;
}

/** Share equivalent reads until they settle; a rejection never becomes a cached result. */
function sharePending<T>(pending: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const held = pending.get(key);
  if (held !== undefined) return held;
  // Start after publishing the promise, including when a dependency throws synchronously.
  const task = Promise.resolve()
    .then(run)
    .finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

const loading = new Map<string, Promise<string>>();

async function ensureLang(h: Highlighter, lang: string) {
  const l = Object.hasOwn(ALIASES, lang) ? ALIASES[lang] : lang;
  if (loaded.has(l)) return l;
  if (!Object.hasOwn(bundledLanguages, l)) return 'text';
  return sharePending(loading, l, async () => {
    try {
      await h.loadLanguage(l as BundledLanguage);
      loaded.add(l);
      return l;
    } catch {
      return 'text';
    }
  });
}

const cache = new Map<string, string>();
const highlighting = new Map<string, Promise<Highlighted>>();

/** The html, and whether it is final: a plain-text fallback for a grammar that failed to load is not, and is asked again. */
export type Highlighted = { html: string; final: boolean };

export async function highlightEntry(code: string, lang: string, dark: boolean): Promise<Highlighted> {
  const key = JSON.stringify([dark, lang, code]);
  const hit = cache.get(key);
  if (hit) return { html: hit, final: true };
  return sharePending(highlighting, key, async () => {
    const h = await getHl();
    const name = (lang || 'text').toLowerCase();
    const requested = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
    const l = await ensureLang(h, requested);
    const html = h.codeToHtml(code, { lang: l, theme: dark ? DARK : LIGHT });
    // Retry transient grammar failures instead of caching their plain-text fallback.
    const final = l !== 'text' || requested === 'text' || !Object.hasOwn(bundledLanguages, requested);
    if (final && cacheable(code)) {
      if (cache.size > 400) cache.clear();
      cache.set(key, html);
    }
    return { html, final };
  });
}

/** Tokenize lines for diff rendering; returns per-line arrays of [text, color]. */
export async function tokenizeLines(code: string, lang: string, dark: boolean) {
  const h = await getHl();
  const l = await ensureLang(h, lang);
  // codex-dark and codex-light were loaded by name in getHl(); this overload's types only name the bundled themes
  const res = h.codeToTokensBase(code, { lang: l as BundledLanguage, theme: (dark ? DARK : LIGHT) as BundledTheme });
  return res.map((line) => line.map((t) => [t.content, t.color ?? ''] as [string, string]));
}
