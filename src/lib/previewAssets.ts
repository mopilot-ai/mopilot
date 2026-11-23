// Inline an HTML preview's same-folder stylesheets, scripts and images, which its opaque srcdoc sandbox cannot fetch.

import { useState } from 'react';
import { dirname, joinPath } from './paths';
import { useEffectOn } from './effects';
import { native } from './native';
import { ignoring, noteIgnored } from './ignored';

export type AssetReader = {
  readText: (path: string) => Promise<string | null>;
  readDataUrl: (path: string) => Promise<string | null>;
};

/** The local files, read through main. */
export const nativeAssets: AssetReader = {
  readText: (path) => native.fs.readText(path),
  readDataUrl: (path) => native.fs.readImageDataUrl(path),
};

/** Files a preview may pull in: at most this many, and this many characters in all. */
export const MAX_ASSETS = 64;
export const MAX_ASSET_CHARS = 8_000_000;

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const STYLESHEET = /\.css$/i;
const SCRIPT = /\.m?js$/i;

// A tag's attributes, with quoted values kept whole so "src=" inside another attribute's value is never one.
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const ATTRS = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
// One pass over the page: comments and script bodies are passed over, so markup inside them is never rewritten.
const TOKENS = new RegExp(
  `<!--[\\s\\S]*?-->|<(script|style)\\b(${TAG_BODY})>([\\s\\S]*?)</\\1\\s*>|<(link|img|image)\\b(${TAG_BODY})>`,
  'gi',
);

type Attr = { name: string; value: string; index: number; length: number };

function attrs(body: string): Attr[] {
  return [...body.matchAll(ATTRS)].map((m) => ({
    name: m[1].toLowerCase(),
    value: m[2] ?? m[3] ?? m[4] ?? '',
    index: m.index!,
    length: m[0].length,
  }));
}

/** `body` with attribute `a` replaced by `text` (empty removes it). */
const splice = (body: string, a: Attr, text: string) =>
  (text ? body.slice(0, a.index) : body.slice(0, a.index).trimEnd()) + text + body.slice(a.index + a.length);

/**
 * The file a relative reference names, inside `dir` or a folder below it; null for a URL, an absolute or
 * root-relative path, or one that climbs out with "..", so a page can only read the files beside it.
 */
export function localAsset(ref: string, dir: string): string | null {
  const bare = ref.trim().replace(/[?#].*$/s, '');
  if (!bare || /^[a-z][\w+.-]*:/i.test(bare) || bare.startsWith('/') || bare.startsWith('\\')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null;
  }
  const parts = decoded.split(/[\\/]/).filter((p) => p && p !== '.');
  if (!parts.length || parts.includes('..')) return null;
  return joinPath(dir, parts.join('/'));
}

/** Text placed in a <style> or <script> element, so it cannot close that element early. */
const raw = (text: string, tag: string) => text.replace(new RegExp(`</(${tag})`, 'gi'), (_, name) => `<\\/${name}`);

type Budget = { count: number; chars: number };

function spend(budget: Budget, chars: number) {
  if (budget.chars + chars > MAX_ASSET_CHARS) return false;
  budget.count++;
  budget.chars += chars;
  return true;
}

async function read(kind: 'text' | 'image', file: string, io: AssetReader, budget: Budget, type: RegExp = IMAGE) {
  if (budget.count >= MAX_ASSETS || !type.test(file)) return null;
  // an unreadable file stays a reference, as a browser shows a page whose stylesheet failed to load
  const value = await (kind === 'text' ? io.readText(file) : io.readDataUrl(file)).catch(ignoring("read an HTML preview's local file"));
  return value != null && spend(budget, value.length) ? value : null;
}

/** Each match of `pattern` replaced by what `swap` resolves it to, the matches read in order. */
async function replaceAsync(text: string, pattern: RegExp, swap: (match: RegExpExecArray) => Promise<string>) {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out += text.slice(last, m.index) + (await swap(m as RegExpExecArray));
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

/** url(...) references in CSS, resolved against the stylesheet's own folder. */
function inlineCssUrls(css: string, dir: string, io: AssetReader, budget: Budget) {
  return replaceAsync(css, /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"'()\s]+))\s*\)/gi, async (m) => {
    const file = localAsset(m[1] ?? m[2] ?? m[3], dir);
    const url = file && (await read('image', file, io, budget));
    return url ? `url("${url}")` : m[0];
  });
}

/** `html` with the files its relative <link rel=stylesheet>, <script src>, <img src>, SVG <image href> and CSS url() name inlined. */
export async function inlineLocalAssets(html: string, htmlPath: string, io: AssetReader): Promise<string> {
  const dir = dirname(htmlPath);
  const budget: Budget = { count: 0, chars: 0 };
  return replaceAsync(html, TOKENS, async (m) => {
    const [token, block, blockBody, content, tag, tagBody] = m;
    if (block?.toLowerCase() === 'style') return `<${block}${blockBody}>${await inlineCssUrls(content, dir, io, budget)}</${block}>`;
    if (block) {
      const src = content.trim() ? undefined : attrs(blockBody).find((a) => a.name === 'src');
      const file = src && localAsset(src.value, dir);
      const code = file && (await read('text', file, io, budget, SCRIPT));
      return code == null ? token : `<${block}${splice(blockBody, src!, '')}>${raw(code, 'script')}</${block}>`;
    }
    if (!tag) return token;
    const list = attrs(tagBody);
    if (tag.toLowerCase() === 'link') {
      const href = list.find((a) => a.name === 'href');
      if (!href || !list.some((a) => a.name === 'rel' && /\bstylesheet\b/i.test(a.value))) return token;
      const file = localAsset(href.value, dir);
      const css = file && (await read('text', file, io, budget, STYLESHEET));
      if (css == null) return token;
      return `<style data-href="${file!.replace(/"/g, '&quot;')}">${raw(await inlineCssUrls(css, dirname(file!), io, budget), 'style')}</style>`;
    }
    const names = tag.toLowerCase() === 'img' ? ['src'] : ['href', 'xlink:href'];
    const ref = list.find((a) => names.includes(a.name));
    const file = ref && localAsset(ref.value, dir);
    const url = file && (await read('image', file, io, budget));
    return url ? `<${tag}${splice(tagBody, ref!, `${tagBody.slice(ref!.index, ref!.index + ref!.name.length)}="${url}"`)}>` : token;
  });
}

/**
 * The preview HTML of `html` (the file at `path`) with its local assets inlined, null until the first result.
 * A new `html`, `path` or `refresh` replaces an inlining still in flight; until it lands, the last one stays.
 * `tag` comes back with the result it was read for (the file pane's preview revision), so a frame changes once.
 */
export function useLocalAssets<T = undefined>(
  html: string | null | undefined,
  path: string,
  { refresh, tag, io = nativeAssets }: { refresh?: unknown; tag?: T; io?: AssetReader } = {},
) {
  const [state, setState] = useState<{ key: string; html: string; tag: T | undefined } | null>(null);
  useEffectOn([html, path, refresh], () => {
    if (html == null) return;
    let current = true;
    void inlineLocalAssets(html, path, io).then(
      (inlined) => current && setState({ key: path, html: inlined, tag }),
      (error) => {
        noteIgnored("inline an HTML preview's local files", error);
        if (current) setState({ key: path, html, tag });
      },
    );
    return () => {
      current = false;
    };
  });
  return html == null || state?.key !== path ? null : state;
}
