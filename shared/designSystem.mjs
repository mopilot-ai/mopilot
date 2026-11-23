// A design system kept as files in a project, in Claude's Design System layout (README.md, tokens.json, api/tokens.md,
// previews whose first line is an @dsCard marker, a compiled _ds_manifest.json), and a design or deck made from one
// (design.json): parsing, checking and summarizing them, shared by main's design tools and the window.

/** Where a project keeps them unless .mopilot/design.json says otherwise. */
export const DEFAULT_SYSTEMS_DIR = 'design-systems';
export const DEFAULT_DESIGNS_DIR = 'designs';
export const MANIFEST = '_ds_manifest.json';
export const DESIGN_INDEX = 'design.json';

/** How much is read: the README as Claude's guide clips it, one file, tokens.json whole, and a bounded walk of a system. */
export const LIMITS = Object.freeze({ readme: 12000, file: 64 * 1024, tokens: 1024 * 1024, files: 2000, depth: 6 });

/** Files a design tool reads as text. */
export const TEXT_EXTS = Object.freeze(['.md', '.json', '.html', '.htm', '.css', '.js', '.mjs', '.svg', '.txt']);

/** The first line of a preview card: <!-- @dsCard group="…" name="…" viewport="WxH" -->. */
const MARKER = /^<!--\s*@dsCard\b([^]*?)-->/;
const ATTR = /([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * The card a preview's first line declares, or null when the file has no marker. A marker without a group still
 * parses (with group ''), so the checker can report it instead of the card silently vanishing.
 * @param {string} text the preview file
 * @returns {{ group: string, name: string | null, viewport: { width: number, height: number | null } | null } | null}
 */
export function parseDsCard(text) {
  const first = String(text ?? '')
    .replace(/^﻿/, '')
    .trimStart();
  const m = MARKER.exec(first);
  if (!m) return null;
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const a of m[1].matchAll(ATTR)) attrs[a[1].toLowerCase()] = a[2] ?? a[3];
  const vp = /^(\d{1,5})(?:\s*[x×]\s*(\d{1,5}))?$/.exec((attrs.viewport ?? '').trim());
  return {
    group: (attrs.group ?? '').trim(),
    name: attrs.name?.trim() || null,
    viewport: vp ? { width: Number(vp[1]), height: vp[2] ? Number(vp[2]) : null } : null,
  };
}

/** Compares names so "slide-2" sorts before "slide-10". */
export const naturalCompare = (/** @type {string} */ a, /** @type {string} */ b) =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);

/**
 * The manifest a system's cards compile to: grouped order, stable for the same cards whatever order they were found in.
 * @param {{ path: string, group: string, name?: string | null, viewport?: { width: number, height: number | null } | null }[]} cards
 */
export function compileManifest(cards) {
  const sorted = [...cards].filter((c) => c.group).sort((a, b) => naturalCompare(a.group, b.group) || naturalCompare(a.path, b.path));
  return {
    v: 1,
    cards: sorted.map((c) => ({
      path: c.path,
      group: c.group,
      name: c.name || nameFromPath(c.path),
      ...(c.viewport ? { viewport: c.viewport } : {}),
    })),
  };
}

/** A card's label from its file name: preview/buttons/primary-button.html -> "Primary button". */
export function nameFromPath(/** @type {string} */ p) {
  const base = String(p)
    .slice(String(p).lastIndexOf('/') + 1)
    .replace(/\.[^.]+$/, '');
  const words = base.replace(/[-_]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : String(p);
}

/** The README's title: its first `# ` heading, or null. */
export function readmeTitle(/** @type {string} */ text) {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(String(text ?? '').replace(/^﻿/, ''));
  return m ? m[1].trim() : null;
}

/** A folder name for a system or design called `name`. */
export function slugOf(/** @type {string} */ name) {
  const s = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return s || 'design-system';
}

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\))$/i;
const DIMENSION = /^-?\d*\.?\d+(px|rem|em|pt|%)$/;

/**
 * Every token in tokens.json as name -> value: DTCG groups ({ $value, $type }) and flat name -> value maps both work;
 * a group's $type is inherited by the tokens in it. Non-objects give no tokens.
 * @param {unknown} json
 * @returns {{ name: string, value: string, type: string | null }[]}
 */
export function flattenTokens(json) {
  /** @type {{ name: string, value: string, type: string | null }[]} */
  const out = [];
  const walk = (/** @type {any} */ node, /** @type {string[]} */ at, /** @type {string | null} */ type, depth) => {
    if (out.length >= 5000 || depth > 12) return;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      if (at.length && (typeof node === 'string' || typeof node === 'number')) out.push({ name: at.join('.'), value: String(node), type });
      return;
    }
    const own = typeof node.$type === 'string' ? node.$type : type;
    if ('$value' in node) {
      const v = node.$value;
      out.push({ name: at.join('.'), value: typeof v === 'object' ? JSON.stringify(v) : String(v), type: own });
      return;
    }
    for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) walk(v, [...at, k], own, depth + 1);
  };
  walk(json, [], null, 0);
  return out;
}

/**
 * The tokens a reader needs at a glance: colors, font families, sizes, and how many others there are.
 * @param {unknown} json tokens.json, parsed
 */
export function summarizeTokens(json) {
  const tokens = flattenTokens(json);
  /** @type {{ colors: { name: string, value: string }[], fonts: { name: string, value: string }[], sizes: { name: string, value: string }[], other: number, total: number }} */
  const s = { colors: [], fonts: [], sizes: [], other: 0, total: tokens.length };
  for (const t of tokens) {
    const type = (t.type ?? '').toLowerCase();
    const name = t.name.toLowerCase();
    if (type === 'color' || COLOR.test(t.value.trim())) s.colors.push({ name: t.name, value: t.value });
    else if (type === 'fontfamily' || /font[-_.]?famil|(^|\.)fonts?\./.test(name)) s.fonts.push({ name: t.name, value: t.value });
    else if (type === 'dimension' || type === 'fontsize' || DIMENSION.test(t.value.trim())) s.sizes.push({ name: t.name, value: t.value });
    else s.other += 1;
  }
  return s;
}

/**
 * What is wrong with a design.json, in words; [] when it is usable. Lenient: fields it does not know are left alone.
 * @param {unknown} json
 * @returns {string[]}
 */
export function checkDesignIndex(json) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return ['design.json is not a JSON object.'];
  const d = /** @type {Record<string, unknown>} */ (json);
  const problems = [];
  if (d.type !== 'design' && d.type !== 'slides') problems.push('design.json "type" must be "design" or "slides".');
  if (typeof d.title !== 'string' || !d.title.trim()) problems.push('design.json has no "title".');
  if (!Array.isArray(d.pages) || d.pages.length === 0) problems.push('design.json "pages" must list at least one page (an .html path).');
  else
    for (const p of d.pages)
      if (!isRelativeHtml(p))
        problems.push(`design.json page ${JSON.stringify(p)} is not a relative .html path inside the design's folder.`);
  if (d.designSystems !== undefined) {
    if (!Array.isArray(d.designSystems)) problems.push('design.json "designSystems" must be a list of {"path": …}.');
    else
      for (const s of d.designSystems)
        if (!s || typeof s !== 'object' || typeof (/** @type {any} */ (s).path) !== 'string')
          problems.push('Each design.json "designSystems" entry needs a "path" (the system\'s folder, relative to the project).');
  }
  if (d.size !== undefined) {
    const sz = /** @type {any} */ (d.size);
    if (!sz || !Number.isFinite(sz.width) || !Number.isFinite(sz.height) || sz.width <= 0 || sz.height <= 0)
      problems.push('design.json "size" must be {"width": n, "height": n} in pixels.');
  }
  return problems;
}

/** A path inside a folder, written relative to it: no absolute paths, drive letters, backslashes or `..` steps. */
export function isRelativeInside(/** @type {unknown} */ p) {
  if (typeof p !== 'string' || !p || p.length > 512 || p.includes('\0') || p.includes('\\')) return false;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '..' && seg !== '');
}

const isRelativeHtml = (/** @type {unknown} */ p) => isRelativeInside(p) && /\.html?$/i.test(String(p));
