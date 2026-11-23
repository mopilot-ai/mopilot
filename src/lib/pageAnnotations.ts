// Browser pane Annotate mode (IAB-06): the user marks elements and regions on a page, and "Add to
// chat" turns the marks into one composer attachment per page: a cropped screenshot with the
// numbered marks drawn on, plus structured text per mark. Everything here is pure: the in-page
// overlay (src/lib/annotateOverlay.ts) reports raw facts about the marked elements, and this module
// decides what leaves the page (selectors, names, excerpts, never secret input values).
import { ownTable } from '../../shared/ownTable.mjs';
import type { Attachment } from '../../shared/model/store';
import { prefixUnits } from '../../shared/textPrefix.mjs';
import { pluralize } from './format';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One step of an element's ancestry, the element itself first. */
export interface RawNode {
  tag: string;
  id?: string;
  /** only this element on the page has this id */
  idUnique?: boolean;
  testId?: string;
  testIdUnique?: boolean;
  /** 1-based index among siblings with the same tag */
  nth: number;
  /** siblings (itself included) with the same tag */
  ofType: number;
}

/** What the overlay reads from a marked element. Values of password and hidden inputs are never read. */
export interface RawElement {
  tag: string;
  type?: string;
  role?: string;
  ariaLabel?: string;
  labelledBy?: string;
  label?: string;
  alt?: string;
  title?: string;
  placeholder?: string;
  autocomplete?: string;
  href?: string;
  text?: string;
  value?: string;
  chain: RawNode[];
}

export interface RawMark {
  /** the overlay's stable id for the mark (numbers change when a mark is removed) */
  id?: number;
  n: number;
  kind: 'element' | 'region';
  /** typed in the pane, never in the page */
  note?: string;
  /** page (document) CSS px */
  rect: Rect;
  element?: RawElement | null;
}

export interface RawPage {
  url: string;
  title?: string;
  scrollX: number;
  scrollY: number;
  /** the layout viewport, CSS px */
  width: number;
  height: number;
  marks: RawMark[];
}

export interface MarkElement {
  tag: string;
  role: string;
  name?: string;
  text?: string;
  value?: string;
  href?: string;
  selector: string;
}

export interface Mark {
  n: number;
  kind: 'element' | 'region';
  note: string;
  rect: Rect;
  /** at least partly inside the screenshot */
  visible: boolean;
  element?: MarkElement;
}

export const TEXT_LIMIT = 160;
export const NAME_LIMIT = 80;
export const VALUE_LIMIT = 80;
export const NOTE_LIMIT = 500;
/** Space kept around the marks in the cropped screenshot, CSS px. */
export const CROP_PAD = 24;

/** Whitespace collapsed, cut to `max` characters with an ellipsis. */
export function excerpt(text: string | undefined | null, max = TEXT_LIMIT): string {
  const t = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${prefixUnits(t, max - 1).trimEnd()}…` : t;
}

const SECRET_TYPES = new Set(['password', 'hidden']);

/** True when an element's value must never leave the page: password and hidden inputs, password or card autofill fields. */
export function isSecretField(el: Pick<RawElement, 'tag' | 'type' | 'autocomplete'>): boolean {
  if (el.tag === 'input' && SECRET_TYPES.has(String(el.type ?? 'text').toLowerCase())) return true;
  const auto = String(el.autocomplete ?? '').toLowerCase();
  return /password|one-time-code|(^|\s)cc-/.test(auto);
}

const IDENT = /^-?[A-Za-z_][\w-]*$/;
const quoted = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * A CSS selector for the element whose ancestry is `chain` (element first): anchored at the
 * nearest unique id or data-testid, otherwise a tag path from <body> with :nth-of-type where a
 * tag repeats. Class names are left out: build tools hash them, so they don't survive a redeploy.
 */
export function cssSelector(chain: RawNode[]): string {
  const parts: string[] = [];
  for (const node of chain) {
    const tag = node.tag.toLowerCase();
    if (node.id && node.idUnique) {
      parts.unshift(IDENT.test(node.id) ? `#${node.id}` : `${tag}[id=${quoted(node.id)}]`);
      break;
    }
    if (node.testId && node.testIdUnique) {
      parts.unshift(`${tag}[data-testid=${quoted(node.testId)}]`);
      break;
    }
    parts.unshift(node.ofType > 1 ? `${tag}:nth-of-type(${node.nth})` : tag);
    if (tag === 'body' || tag === 'html') break;
  }
  return parts.join(' > ');
}

const INPUT_ROLES: Record<string, string> = ownTable({
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  text: 'textbox',
  number: 'spinbutton',
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
});
const TAG_ROLES: Record<string, string> = ownTable({
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  img: 'img',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  form: 'form',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  table: 'table',
  tr: 'row',
  td: 'cell',
  th: 'columnheader',
  dialog: 'dialog',
  aside: 'complementary',
  article: 'article',
  section: 'region',
  option: 'option',
  summary: 'button',
  label: 'label',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  p: 'paragraph',
});

/** The element's explicit role, or the implicit one for its tag; "generic" otherwise. */
export function roleOf(el: Pick<RawElement, 'tag' | 'type' | 'role' | 'href'>): string {
  const explicit = String(el.role ?? '')
    .trim()
    .split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.tag.toLowerCase();
  if (tag === 'a') return el.href ? 'link' : 'generic';
  if (tag === 'input') return INPUT_ROLES[String(el.type ?? 'text').toLowerCase()] ?? 'textbox';
  return TAG_ROLES[tag] ?? 'generic';
}

const NAMED_FROM_TEXT = new Set([
  'button',
  'link',
  'heading',
  'tab',
  'menuitem',
  'option',
  'cell',
  'columnheader',
  'listitem',
  'label',
  'checkbox',
  'radio',
]);

/** An approximation of the accessible name: aria-label, aria-labelledby, label, alt, title, placeholder, then text for roles named by their content. */
export function accessibleName(el: RawElement, role = roleOf(el)): string | undefined {
  const name =
    [el.ariaLabel, el.labelledBy, el.label, el.alt, el.title, el.placeholder].map((v) => excerpt(v, NAME_LIMIT)).find(Boolean) ||
    (NAMED_FROM_TEXT.has(role) ? excerpt(el.text, NAME_LIMIT) : '');
  return name || undefined;
}

/** What may be reported about a marked element. A secret field reports no value and no text. */
export function describeElement(el: RawElement): MarkElement {
  const role = roleOf(el);
  const secret = isSecretField(el);
  const out: MarkElement = { tag: el.tag.toLowerCase(), role, selector: cssSelector(el.chain) };
  const name = accessibleName(el, role);
  if (name) out.name = name;
  const text = secret ? '' : excerpt(el.text);
  if (text && text !== name) out.text = text;
  const value = secret ? '' : excerpt(el.value, VALUE_LIMIT);
  if (value) out.value = value;
  if (el.href) out.href = el.href;
  return out;
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

/** A mark's box in viewport coordinates. */
export function viewportRect(page: Pick<RawPage, 'scrollX' | 'scrollY'>, r: Rect): Rect {
  return { x: r.x - page.scrollX, y: r.y - page.scrollY, width: r.width, height: r.height };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

/**
 * The screenshot region, in the page's device-independent pixels (CSS px times `zoom`): the
 * marks' union padded by `pad` and clipped to the viewport; the whole viewport when no mark is in
 * view. Rounded outward to whole pixels.
 */
export function cropRect(page: Omit<RawPage, 'url' | 'title'>, zoom = 1, pad = CROP_PAD): Rect {
  const view: Rect = { x: 0, y: 0, width: page.width, height: page.height };
  const seen = page.marks.map((m) => intersect(viewportRect(page, m.rect), view)).filter((r): r is Rect => !!r);
  let crop = view;
  if (seen.length) {
    const x = Math.min(...seen.map((r) => r.x)) - pad;
    const y = Math.min(...seen.map((r) => r.y)) - pad;
    const right = Math.max(...seen.map((r) => r.x + r.width)) + pad;
    const bottom = Math.max(...seen.map((r) => r.y + r.height)) + pad;
    crop = intersect({ x, y, width: right - x, height: bottom - y }, view)!;
  }
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  const left = Math.floor(crop.x * z);
  const top = Math.floor(crop.y * z);
  return { x: left, y: top, width: Math.ceil((crop.x + crop.width) * z) - left, height: Math.ceil((crop.y + crop.height) * z) - top };
}

/** The raw marks as reportable marks, numbered in the order they were made. */
export function describeMarks(page: RawPage): Mark[] {
  const view: Rect = { x: 0, y: 0, width: page.width, height: page.height };
  return page.marks.map((m) => {
    const mark: Mark = {
      n: m.n,
      kind: m.kind,
      note: excerpt(m.note, NOTE_LIMIT),
      rect: round(m.rect),
      visible: !!intersect(viewportRect(page, m.rect), view),
    };
    if (m.kind === 'element' && m.element) mark.element = describeElement(m.element);
    return mark;
  });
}

/** The page URL without credentials or fragment. */
export function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    u.hash = '';
    return u.href;
  } catch {
    return excerpt(raw, 300);
  }
}

/** The text that goes with the screenshot: one block per mark, numbered as the badges in the image. */
export function annotationText(page: Pick<RawPage, 'url' | 'title' | 'width' | 'height' | 'scrollX' | 'scrollY'>, marks: Mark[]): string {
  const title = excerpt(page.title, NAME_LIMIT);
  const lines = [
    `Browser page annotations: ${pluralize(marks.length, 'mark')} on ${safeUrl(page.url)}${title ? ` ("${title}")` : ''}.`,
    'The attached screenshot shows the numbered marks; boxes are in page CSS pixels.',
    `Viewport: ${Math.round(page.width)}x${Math.round(page.height)}, scrolled to (${Math.round(page.scrollX)}, ${Math.round(page.scrollY)}).`,
  ];
  for (const m of marks) {
    lines.push('', `[${m.n}] ${m.kind === 'element' ? 'Element' : 'Region'}${m.note ? `: ${m.note}` : ''}`);
    const e = m.element;
    if (e) {
      lines.push(`  role: ${e.role}${e.name ? `, name: "${e.name}"` : ''} <${e.tag}>`);
      if (e.text) lines.push(`  text: "${e.text}"`);
      if (e.value) lines.push(`  value: "${e.value}"`);
      if (e.href) lines.push(`  href: ${safeUrl(e.href)}`);
      lines.push(`  selector: ${e.selector}`);
    }
    lines.push(`  box: x=${m.rect.x} y=${m.rect.y} w=${m.rect.width} h=${m.rect.height}${m.visible ? '' : ' (outside the screenshot)'}`);
  }
  return lines.join('\n');
}

function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The composer chip for one page: the marked screenshot, carrying its text until it is sent. */
export function pageAnnotationAttachment(page: RawPage, image: { path: string; previewUrl?: string }): Attachment {
  const marks = describeMarks(page);
  return {
    kind: 'image',
    path: image.path,
    name: `Annotations · ${hostOf(page.url)}`,
    previewUrl: image.previewUrl,
    text: annotationText(page, marks),
    pageUrl: safeUrl(page.url),
  };
}

/**
 * At send, each page-annotation chip becomes what every harness already takes: the image, then its
 * text as selected context (shared/selections.mjs). Other attachments pass through unchanged.
 */
export function expandPageAnnotations(attachments: Attachment[]): Attachment[] {
  return attachments.flatMap((a) =>
    a.pageUrl && a.kind === 'image'
      ? [
          { kind: 'image' as const, path: a.path, name: a.name, previewUrl: a.previewUrl },
          { kind: 'selection' as const, path: '', name: a.name, text: a.text ?? '' },
        ]
      : [a],
  );
}
