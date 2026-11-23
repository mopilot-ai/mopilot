// The app stylesheet as the build sees it: src/styles/app.css with the area files it imports inlined in order.
import { readFileSync } from 'node:fs';

const MANIFEST = new URL('../../src/styles/app.css', import.meta.url);
const IMPORT = /^@import '\.\/([\w/-]+\.css)';$/gm;

/** The files app.css imports, in cascade order, relative to src/styles (e.g. `app/thread.css`). */
export function appCssParts(): string[] {
  return [...readFileSync(MANIFEST, 'utf8').matchAll(IMPORT)].map((m) => m[1]);
}

/** One part's text. */
export const readAppCssPart = (part: string) => readFileSync(new URL(part, MANIFEST), 'utf8');

/** Every part of app.css concatenated in import order: the rules a test reads instead of the manifest. */
export function appCss(): string {
  return appCssParts().map(readAppCssPart).join('');
}

const TOKENS = new URL('../../src/styles/tokens.css', import.meta.url);
/** A step of the type scale: a ratio that multiplies --fs-chat (src/styles/tokens.css). */
const STEP = /^calc\(var\(--fs-chat\)\s*\*\s*([\d.]+)\)$/;

/**
 * `css` with the type scale's tokens replaced by the sizes they resolve to at the shipped defaults. jsdom
 * substitutes no custom property, so a rule that reads a step computes as nothing there and the element falls
 * back to the UA's 16px; a test that asserts the size a surface renders at substitutes the scale first.
 */
export function resolveTypeScale(css: string): string {
  const tokens = readFileSync(TOKENS, 'utf8');
  const root = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('\n}', tokens.indexOf(':root {')));
  const declared = new Map([...root.matchAll(/^\s*(--(?:fs|lh)-[\w-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]));
  // --fs-chat first: every step is a ratio of it, whatever order the tokens are declared in
  const chat = Number.parseFloat(declared.get('--fs-chat') ?? '14');
  const sizes = new Map(
    [...declared].map(([name, value]) => {
      const step = STEP.exec(value);
      return [name, step ? `${Number(step[1]) * chat}px` : value];
    }),
  );
  return css.replace(/var\((--(?:fs|lh)-[\w-]+)\)/g, (whole, name) => sizes.get(name) ?? whole);
}
