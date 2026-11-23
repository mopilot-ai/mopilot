// A small reader for the Chrome extension's stylesheets (electron/chrome-extension/*.css) and the WCAG contrast arithmetic the dark-theme tests share (#3046 batch B8).
import fs from 'node:fs';
import path from 'node:path';

export interface Declaration {
  prop: string;
  value: string;
}
export interface Rule {
  selector: string;
  /** the enclosing at-rules, outermost first (`@media (prefers-color-scheme: dark)`) */
  context: string[];
  decls: Declaration[];
}

export const EXTENSION_DIR = path.join(import.meta.dirname, '..', '..', 'electron', 'chrome-extension');
export const DARK = '@media (prefers-color-scheme: dark)';

/** The extension's stylesheets, panel.css first (sidepanel.html loads it before sidepanel.css), found by folder, not listed. */
export function extensionStylesheets(): { file: string; css: string }[] {
  const files = fs.readdirSync(EXTENSION_DIR).filter((f) => f.endsWith('.css'));
  files.sort((a, b) => (a === 'panel.css' ? -1 : b === 'panel.css' ? 1 : a.localeCompare(b)));
  return files.map((file) => ({ file, css: fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8') }));
}

/** Cuts `text` at top-level `;`, ignoring those inside quotes and parentheses (a data: URL has them). */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function declarationsOf(body: string): Declaration[] {
  return splitTopLevel(body)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const colon = d.indexOf(':');
      if (colon < 0) throw new Error(`not a declaration: ${d}`);
      return { prop: d.slice(0, colon).trim(), value: d.slice(colon + 1).trim() };
    });
}

/** Every style rule, at any depth of @media, @supports, @starting-style and @keyframes, in source order. */
export function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const walk = (text: string, context: string[]) => {
    let from = 0;
    for (;;) {
      const open = text.indexOf('{', from);
      if (open < 0) return;
      let depth = 1;
      let quote = '';
      let close = open + 1;
      for (; close < text.length && depth > 0; close++) {
        const c = text[close];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth--;
      }
      // (a statement at-rule such as @import ends in a semicolon and has no block: what follows it is the next rule's head)
      const head = text.slice(from, open).split(';').pop()!.trim();
      const body = text.slice(open + 1, close - 1);
      from = close;
      // an at-rule whose block holds declarations (@property, @font-face) is read as a rule of its own, so its colours are scanned too
      if (head.startsWith('@') && !body.includes('{'))
        rules.push({ selector: head.replace(/\s+/g, ' '), context, decls: declarationsOf(body) });
      else if (head.startsWith('@')) walk(body, [...context, head.replace(/\s+/g, ' ')]);
      else rules.push({ selector: head, context, decls: declarationsOf(body) });
    }
  };
  walk(source, []);
  return rules;
}

/** The custom properties the stylesheets set on :root for a scheme (later blocks and later files win, as the cascade does). */
export function tokensFor(sheets: { css: string }[], scheme: 'light' | 'dark'): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const sheet of sheets) {
    for (const rule of parseRules(sheet.css)) {
      if (rule.selector !== ':root') continue;
      const dark = rule.context.includes(DARK);
      if (rule.context.length > (dark ? 1 : 0) || (dark && scheme === 'light')) continue;
      for (const d of rule.decls) if (d.prop.startsWith('--')) tokens.set(d.prop, d.value);
    }
  }
  return tokens;
}

/** A token's value with var(--x) chains followed. */
export function resolveToken(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let hops = 0; hops < 10; hops++) {
    if (value === undefined) break;
    const ref = /^var\((--[\w-]+)\)$/.exec(value);
    if (!ref) return value;
    value = tokens.get(ref[1]);
  }
  throw new Error(`token ${name} does not resolve`);
}

/** A rule's declaration for a property, from the last rule with that exact selector and no at-rule around it. */
export function declared(css: string, selector: string, prop: string): string | undefined {
  const found = parseRules(css).filter((r) => r.selector === selector && r.context.length === 0);
  return found.flatMap((r) => r.decls).findLast((d) => d.prop === prop)?.value;
}

export type Rgba = [number, number, number, number];

/** #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(r g b / a) and rgba(r, g, b, a). */
export function parseColor(text: string): Rgba {
  const value = text.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = [...digits].map((d) => d + d).join('');
    if (digits.length !== 6 && digits.length !== 8) throw new Error(`not a colour: ${text}`);
    const n = (i: number) => Number.parseInt(digits.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), digits.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(value);
  if (!fn) throw new Error(`not a colour: ${text}`);
  const [channels, alpha] = fn[1].split('/');
  const percent = alpha?.trim().endsWith('%') ? 100 : 1;
  const nums = channels
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const a = alpha === undefined ? (nums[3] ?? 1) : Number.parseFloat(alpha) / percent;
  if (nums.length < 3 || [...nums.slice(0, 3), a].some(Number.isNaN)) throw new Error(`not a colour: ${text}`);
  return [nums[0], nums[1], nums[2], a];
}

/** `top` drawn over an opaque `base`. */
export function over(top: Rgba, base: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => Math.round(top[i] * a + base[i] * (1 - a))).concat(1) as Rgba;
}

const luminance = ([r, g, b]: Rgba) => {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

/** The WCAG 2 contrast ratio of two opaque colours. */
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const NAMED =
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(
    ' ',
  );

/** CSS system colours: they follow the scheme, but a panel that draws them has not decided its own dark colour. */
const SYSTEM =
  'canvas canvastext linktext visitedtext activetext buttonface buttontext buttonborder field fieldtext highlight highlighttext selecteditem selecteditemtext mark marktext graytext accentcolor accentcolortext'.split(
    ' ',
  );

/** The colour literals in a declaration value: hex, a colour function or a named colour. Quoted text, url(...) and var(--name) are not colours. */
export function colourLiterals(value: string, prop = ''): string[] {
  const text = value
    .replace(/url\((?:"[^"]*"|'[^']*'|[^)])*\)/gi, '')
    .replace(/"[^"]*"|'[^']*'/g, '')
    .replace(/--[\w-]+/g, '');
  const found = [...text.matchAll(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/gi)].map((m) => m[0]);
  // a word in a font stack, an animation's name or a grid area is a name, not a colour
  if (!/^(font|animation|grid|will-change|transition|counter|view-transition)/.test(prop))
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) if (NAMED.includes(word) || SYSTEM.includes(word)) found.push(word);
  return found;
}
