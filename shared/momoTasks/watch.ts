// MoMo's model-free change watch: fingerprint what is watched, compare with the last reading, say what changed. Ported from rakazo's routine-watch (see THIRD_PARTY.md).
import { createHash } from 'node:crypto';
import { prefixUnits } from '../textPrefix.mjs';

// Portions of this file are adapted from rakazo (https://github.com/elie222/rakazo), packages/contracts/src/routines/routine-watch.ts and
// packages/adapters/src/routines/routine-watch.ts, licensed under the Apache License, Version 2.0 (docs/licenses/rakazo-LICENSE.txt).
// Changes: zod is replaced by a hand-written parser; the `command` kind and the MCP-envelope, vault, sandbox and secret-redaction parts are left out
// (MoMo watches read-only tools, public HTTPS pages and files through injected readers); outcomes are returned, never written to a database.

export const WATCH_KINDS = ['files', 'tool', 'http'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const WATCH_DEFAULT_MINUTES = 15;
/** Keeps unattended checks from hammering a machine or a connected service. */
export const WATCH_MIN_MINUTES = 5;
export const WATCH_MAX_MINUTES = 1440;
/** A transient failure (a busy machine) is read again after this long without changing state. */
export const WATCH_RETRY_MS = 60_000;
const MAX_LISTED = 8;
const MAX_TRACKED_ENTRIES = 500;
const MAX_DETAIL = 600;

export type RoutineWatch = {
  kind: WatchKind;
  paths?: string[];
  tool?: string;
  url?: string;
  args?: Record<string, unknown>;
  /** JSON items are identified by the first field and compared by the others only, so a fetch time is not a change. */
  track?: string[];
  everyMinutes: number;
};

export type WatchOutcomeKind = 'baseline' | 'unchanged' | 'changed';
export type WatchState = {
  checkedAt: string;
  outcome: WatchOutcomeKind;
  fingerprint: string | null;
  /** path or item identity -> signature; kept so a change can be described, not only detected. */
  entries?: Record<string, string>;
  detail: string | null;
};

export type Reading = { fingerprint: string; entries?: Record<string, string>; detail?: string | null };

/** The check could not read now but may later (a busy machine): try again soon, keep the last state. */
export class WatchRetryError extends Error {}
/** The check cannot run as set up: the watch is paused and the user is told why. */
export class WatchError extends Error {}

/**
 * Whether a watch's host may be a public one. A name or address on this machine, a private network, a link-local range or the cloud metadata
 * service is refused up front. This is only the first check: a public name can still resolve to a private address, or redirect to one, so
 * the reader must resolve the name itself, check every address it connects to, and refuse redirects (rakazo's reader does the same).
 */
export function isPublicHost(hostname: string): boolean {
  // a trailing dot names the same host (`localhost.`)
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) return isPublicIpv6(host.slice(1, -1));
  if (host === 'localhost' || host === 'metadata.google.internal' || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) return false;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return true;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  const blocked =
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224;
  return !blocked;
}

function isPublicIpv6(address: string): boolean {
  // unique-local, link-local, mapped and translated IPv4, the deprecated IPv4-compatible form (`::a.b.c.d`) and 6to4 (`2002::/16`), which embed an IPv4 address
  if (
    /^f[cd]/.test(address) ||
    /^fe[89ab]/.test(address) ||
    address.startsWith('::') ||
    address.startsWith('2002:') ||
    address.startsWith('64:ff9b:')
  )
    return false;
  return true;
}

/** @returns the checked watch, or the sentence that says what to fix. */
export function parseWatch(value: unknown): { watch: RoutineWatch } | { error: string } {
  if (!value || typeof value !== 'object') return { error: 'Say what to watch.' };
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (kind !== 'files' && kind !== 'tool' && kind !== 'http') return { error: 'Watch files, a read-only tool or a public HTTPS page.' };
  const every = v.everyMinutes === undefined ? WATCH_DEFAULT_MINUTES : v.everyMinutes;
  if (typeof every !== 'number' || !Number.isInteger(every) || every < WATCH_MIN_MINUTES || every > WATCH_MAX_MINUTES)
    return { error: `everyMinutes must be a whole number from ${WATCH_MIN_MINUTES} to ${WATCH_MAX_MINUTES}.` };
  const watch: RoutineWatch = { kind, everyMinutes: every };
  const track = v.track;
  if (track !== undefined) {
    if (kind === 'files') return { error: 'Tracked fields apply to a tool or an HTTPS page.' };
    const fields = Array.isArray(track) ? track.map((t) => (typeof t === 'string' ? t.trim() : '')) : [];
    if (!fields.length || fields.length > 5 || fields.some((t) => !t || t.length > 100)) return { error: 'Track one to five field names.' };
    watch.track = fields;
  }
  if (kind === 'files') {
    const paths = Array.isArray(v.paths) ? v.paths.map((p) => (typeof p === 'string' ? p.trim() : '')) : [];
    if (!paths.length || paths.length > 20 || paths.some((p) => !p || p.length > 500))
      return { error: 'Add one to twenty files or folders to watch.' };
    watch.paths = paths;
  } else if (kind === 'tool') {
    const tool = typeof v.tool === 'string' ? v.tool.trim() : '';
    if (!tool || tool.length > 200) return { error: 'Pick a tool to check.' };
    watch.tool = tool;
    if (v.args && typeof v.args === 'object' && !Array.isArray(v.args)) watch.args = v.args as Record<string, unknown>;
  } else {
    const text = typeof v.url === 'string' ? v.url.trim() : '';
    // an unparseable address is reported like any other unsupported one
    const url = URL.canParse(text) ? new URL(text) : null;
    const valid = url !== null && url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port;
    if (!valid) return { error: 'Enter an HTTPS URL.' };
    if (!isPublicHost((url as URL).hostname))
      return { error: 'Enter a public HTTPS URL, not an address on this machine or a private network.' };
    watch.url = text;
  }
  return { watch };
}

export const nextWatchAt = (watch: Pick<RoutineWatch, 'everyMinutes'>, from: number): number => from + watch.everyMinutes * 60_000;

/** What a watch looks at, for rows and messages. A status URL can hold a token, so it is never copied in. */
export function describeWatch(watch: RoutineWatch): string {
  if (watch.kind === 'files') return (watch.paths ?? []).join(', ');
  if (watch.kind === 'http') return 'HTTPS page';
  return watch.tool ?? '';
}

/** A change check runs on its own and cannot ask for a card, so a tool that is not read-only is refused before it ever runs. */
export function assertWatchToolReadOnly(tool: string, readOnly: boolean): void {
  if (!readOnly) throw new WatchError(`${tool} can change things, and a watch cannot ask for approval. Pick a read-only tool.`);
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** JSON with sorted keys, so the same data always fingerprints the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const ITEM_SIGNATURE = 'item:';
const TITLE_FIELDS = ['name', 'title', 'subject', 'summary', 'filename', 'snippet'];

const itemTitle = (signature: string): string | null => {
  if (!signature.startsWith(ITEM_SIGNATURE)) return null;
  const { title } = JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { title?: unknown };
  return typeof title === 'string' && title ? title : null;
};

/** Titles are display details, never implicit tracked fields. */
const itemFields = (signature: string): string => {
  if (!signature.startsWith(ITEM_SIGNATURE)) return signature;
  return stableStringify((JSON.parse(signature.slice(ITEM_SIGNATURE.length)) as { fields: unknown }).fields);
};

/** The whole result as one fingerprint, for a watch that tracks nothing in particular. */
export const readWhole = (data: unknown): Reading => ({ fingerprint: sha256(stableStringify(data)) });

/** Files by name: `path -> size:mtime`. More than 2000 entries keep the fingerprint only. */
export function readFiles(files: { path: string; size: number; mtimeMs: number }[]): Reading {
  const entries = Object.fromEntries(files.map((f) => [f.path, `${f.size}:${f.mtimeMs}`]));
  const fingerprint = sha256(stableStringify(entries));
  return files.length > 2000
    ? { fingerprint, detail: `${files.length} watched files; something among them changed.` }
    : { fingerprint, entries, detail: null };
}

/**
 * The items in a JSON result, compared by the tracked fields only. Every object anywhere in the result that carries the first field is an
 * item; that field is its identity, the rest decide whether it was updated.
 */
export function readItems(data: unknown, track: readonly string[]): Reading {
  const identity = track[0] as string;
  const fields = track.slice(1);
  const items = new Map<string, { fields: string[]; titles: string[] }>();
  let count = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const id = record[identity];
    if (typeof id === 'string' || typeof id === 'number') {
      const key = String(id);
      const item = items.get(key) ?? { fields: [], titles: [] };
      item.fields.push(stableStringify(fields.map((field) => record[field] ?? null)));
      const titleField = TITLE_FIELDS.find((field) => typeof record[field] === 'string');
      if (titleField) item.titles.push(String(record[titleField]).slice(0, 120));
      items.set(key, item);
      count++;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(data);
  // ids can repeat in nested results: keep every object's values, independent of order
  const entries = Object.fromEntries(
    [...items].map(([id, item]) => [
      id,
      `${ITEM_SIGNATURE}${stableStringify({ fields: item.fields.sort(), title: item.titles.sort()[0] ?? null })}`,
    ]),
  );
  const fingerprint = sha256(
    stableStringify(Object.fromEntries(Object.entries(entries).map(([id, signature]) => [id, itemFields(signature)]))),
  );
  return count > MAX_TRACKED_ENTRIES
    ? { fingerprint, detail: `${count} watched items; something among them changed.` }
    : { fingerprint, entries, detail: null };
}

export function describeEntryChanges(before: Record<string, string>, after: Record<string, string>): string {
  const items = [...Object.values(before), ...Object.values(after)].some((signature) => signature.startsWith(ITEM_SIGNATURE));
  // files are named by path; tracked items by the title saved in their signature
  const name = (key: string, signature: string): string => (items ? (itemTitle(signature) ?? key) : key);
  const added: string[] = [];
  const edited: string[] = [];
  const removed: string[] = [];
  for (const [key, signature] of Object.entries(after)) {
    if (!(key in before)) added.push(name(key, signature));
    else if (itemFields(before[key] as string) !== itemFields(signature)) edited.push(name(key, signature));
  }
  for (const key of Object.keys(before)) if (!(key in after)) removed.push(name(key, before[key] as string));
  const lines: string[] = [];
  const list = (label: string, names: string[]): void => {
    if (!names.length) return;
    const shown = names.sort().slice(0, MAX_LISTED);
    const more = names.length - shown.length;
    lines.push(`${label}: ${shown.join(', ')}${more > 0 ? ` (and ${more} more)` : ''}`);
  };
  list('New', added);
  list(items ? 'Updated' : 'Edited', edited);
  list(items ? 'Gone' : 'Removed', removed);
  return lines.join('\n') || (items ? 'The watched items changed.' : 'The watched files changed.');
}

const clip = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL ? `${prefixUnits(trimmed, MAX_DETAIL)}…` : trimmed;
};

/** Pure: decides baseline, unchanged or changed, and describes the change. The first reading, or the first after a failure, only records where things stand. */
export function compareReading(previous: WatchState | null, reading: Reading, now: number): { state: WatchState; changed: boolean } {
  const base = {
    checkedAt: new Date(now).toISOString(),
    fingerprint: reading.fingerprint,
    ...(reading.entries ? { entries: reading.entries } : {}),
  };
  if (!previous?.fingerprint) return { changed: false, state: { ...base, outcome: 'baseline', detail: null } };
  if (previous.fingerprint === reading.fingerprint) return { changed: false, state: { ...base, outcome: 'unchanged', detail: null } };
  const detail = reading.entries && previous.entries ? describeEntryChanges(previous.entries, reading.entries) : (reading.detail ?? null);
  return { changed: true, state: { ...base, outcome: 'changed', detail: detail === null ? null : clip(detail) } };
}
