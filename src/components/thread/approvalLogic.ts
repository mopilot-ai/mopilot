// Pure rules for the approval card: which key does what, how long ⌘↩ is held, and who is asking.
import type { Segment } from '../../harness/types';
import type { SageApprovalParams } from '../../lib/native';
import type { FileSystemPath } from '../../protocol/v2/FileSystemPath';
import type { FileSystemSpecialPath } from '../../protocol/v2/FileSystemSpecialPath';

/** How long ⌘↩ is held to confirm an action that can't be undone (keyboard users, design ux F13). */
export const HOLD_MS = 1000;

/** A legacy Codex approval's refusal: ReviewDecision's `denied` carries the reason, unlike v2's plain `decline`. */
export const LEGACY_DENY = { decision: { denied: { rejection: 'The user declined this request.' } } };
/** The 1, 2, 3 keys pick one of at most this many choices. */
export const MAX_KEY_CHOICES = 3;

export type ApprovalKey = { type: 'deny' } | { type: 'choose'; index: number } | { type: 'holdStart' };

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  repeat?: boolean;
  isTrusted?: boolean;
}

/** What a key press means on a card with `choices` allow-buttons; null for anything else. Only a person's keys count. */
export function approvalKey(e: KeyLike, ctx: { choices: number; destructive: boolean }): ApprovalKey | null {
  if (e.isTrusted === false) return null;
  if (e.key === 'Escape') return { type: 'deny' };
  if (ctx.destructive) return e.key === 'Enter' && e.metaKey && !e.repeat ? { type: 'holdStart' } : null;
  const n = Number(e.key);
  if (['1', '2', '3'].includes(e.key) && n <= Math.min(ctx.choices, MAX_KEY_CHOICES)) return { type: 'choose', index: n - 1 };
  return null;
}

/**
 * Claude Desktop's chords on a site or app card, beside the 1, 2, 3 keys: ⌘↩ allows once and ⇧⌘↩ always allows.
 * Only a person's fresh key counts.
 */
export function scopeChord(e: KeyLike & { shiftKey?: boolean }): 'once' | 'always' | null {
  if (e.isTrusted === false || e.repeat || e.key !== 'Enter' || !e.metaKey) return null;
  return e.shiftKey ? 'always' : 'once';
}

/**
 * What a site or app card says (Claude Desktop's site card): one question. Where Always allow saves the
 * grant is the primary button's tooltip, only where Always allow is offered.
 */
export function scopeCopy(
  agent: string,
  params: Pick<SageApprovalParams, 'kind' | 'origin' | 'app' | 'browser'>,
  { always }: { always: boolean },
): { ask: string; what: string; tail: string; saved?: string } {
  const site = params.kind === 'browserOrigin';
  const what = site ? (params.origin ?? 'this site') : (params.app?.name ?? params.origin ?? 'this app');
  const place = !site ? '' : params.browser === 'chrome' ? ' in your Chrome' : params.browser === 'iab' ? ' in the built-in browser' : '';
  const saved = site ? 'Saved on this device. Remove in Settings → Browser.' : 'Saved for every chat. Remove in Settings → Computer use.';
  return { ask: `Allow ${agent} to ${site ? 'use' : 'control'} `, what, tail: `${place}?`, ...(always ? { saved } : {}) };
}

/** Releasing ⌘ or ↩ cancels a hold in progress. */
export const endsHold = (key: string) => key === 'Enter' || key === 'Meta';

/** A field that is taking text keeps its keys. */
export function isTypingTarget(t: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  return t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || !!t?.isContentEditable;
}

/** A focused control that Enter activates by itself (Deny, the options chevron, a menu item): Enter is its own. */
export function activatesOnEnter(t: { tagName?: string; getAttribute?: (n: string) => string | null } | null): boolean {
  if (!t) return false;
  if (['BUTTON', 'A', 'SELECT', 'SUMMARY'].includes(t.tagName ?? '')) return true;
  return ['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'option', 'checkbox', 'radio', 'switch', 'tab'].includes(
    t.getAttribute?.('role') ?? '',
  );
}

/** Plain Enter approves with the card's first choice: a fresh key from a person, not on a control that takes Enter itself. */
export const approvesOnEnter = (e: KeyLike & { target?: unknown }) =>
  e.key === 'Enter' &&
  e.isTrusted !== false &&
  !e.repeat &&
  !e.metaKey &&
  !activatesOnEnter(e.target as Parameters<typeof activatesOnEnter>[0]);

/**
 * Whether a card should act on a window key press. With more than one card on screen (a side chat, split panes), the
 * card holding focus answers, or else the first card that sees the key outside a pane that isn't focused; it marks
 * the key as taken.
 */
export function cardOwnsKey(
  e: { defaultPrevented: boolean; target: unknown },
  card: { contains(n: unknown): boolean; closest?(s: string): unknown } | null,
): boolean {
  if (e.defaultPrevented) return false;
  const inCard = (e.target as { closest?: (s: string) => unknown } | null)?.closest?.('.approval-card');
  if (inCard) return !card || card.contains(inCard);
  return !card?.closest?.(UNFOCUSED_PANE);
}

/** A split pane, or the primary one, that doesn't have focus: window keys aimed at no element skip its cards. */
export const UNFOCUSED_PANE = '[data-pane-focused="false"]';

/**
 * Whether a window key belongs to a chat's view: the view holding focus takes it; with focus in no view, a pane's view
 * does, unless it is a side pane's or a split pane that isn't focused.
 */
export function viewOwnsKey(target: Element | null, view: Element | null, inPane: boolean): boolean {
  const focusedView = target?.closest('.thread-view');
  return focusedView ? focusedView === view : !inPane && !view?.closest(UNFOCUSED_PANE);
}

/** The segment of the chat that sent a request, by the native session id in its params. */
export function sourceSegment(params: unknown, segments: Segment[] | undefined): Segment | null {
  const p = params as { threadId?: string | null; sessionId?: string | null } | null | undefined;
  const id = p?.threadId ?? p?.sessionId;
  if (!id || !segments?.length) return null;
  return segments.find((s) => s.nativeId === id || s.nativeId === `claude:${id}`) ?? null;
}

/** Who is asking: the harness of the segment that sent the request, else the chat's current one. */
export function sourceLabel(params: unknown, segments: Segment[] | undefined, labelOf: (s: Segment) => string, fallback: string): string {
  const seg = sourceSegment(params, segments);
  return seg ? labelOf(seg) : fallback;
}

/** A denial that carries the user's note, when there is one and the harness can take it. */
export function denialWith(deny: unknown, note: string, carries: boolean): unknown {
  const reason = note.trim();
  return carries && reason ? { ...(deny as object), reason } : deny;
}

/** A sandbox path Codex names by kind, in words. */
function specialPath(v: FileSystemSpecialPath): string {
  switch (v.kind) {
    case 'root':
      return 'the whole file system';
    case 'minimal':
      return 'the minimal system paths';
    case 'project_roots':
      return v.subpath ? `${v.subpath} in the project roots` : 'the project roots';
    case 'tmpdir':
      return 'the temporary folder';
    case 'slash_tmp':
      return '/tmp';
    default:
      return v.subpath ? `${v.path}/${v.subpath}` : v.path;
  }
}

/**
 * One file-system entry of a Codex permissions request as a line ("Write /src"): the protocol's typed
 * path (a path, a glob or a special path) with its access mode, or a plain path as older entries had.
 */
export function sandboxEntryLine(e: { access?: string; path?: FileSystemPath | string }): string {
  const access = e.access ? e.access[0].toUpperCase() + e.access.slice(1) : 'Access';
  const p = e.path;
  const where =
    typeof p === 'string'
      ? p
      : p?.type === 'path'
        ? p.path
        : p?.type === 'glob_pattern'
          ? p.pattern
          : p?.type === 'special'
            ? specialPath(p.value)
            : JSON.stringify(e);
  return `${access} ${where}`;
}

/** Names in a sentence: "A", "A and B", "A, B and C", "A, B and 3 more". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > 3) return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** The one question an access or takeover card asks. */
export function accessSentence(agent: string, params: SageApprovalParams): string {
  // a teach tour (desktop_request_teach_access): the agent walks the person through a task, and Next runs its actions
  if (params.teach) return `Allow ${agent} to guide you through ${params.reason?.trim().slice(0, 80) || 'a task'}?`;
  // one question, as Claude Desktop and Codex ask it: "Allow Claude to use Notes?" (Claude Design option 4A)
  const apps = params.apps ?? [];
  const extras = [
    params.clipboardRead && 'read the clipboard',
    params.clipboardWrite && 'write the clipboard',
    params.systemKeyCombos && 'press whole-Mac shortcuts',
  ].filter(Boolean) as string[];
  const and = extras.length ? ` and ${nameList(extras)}` : '';
  // the mouse and keyboard, asked on its own or (screenControl) with the apps on the access card: one question either way
  const where = `${apps.length ? ` in ${nameList(apps.map((a) => a.name))}` : ''}${and}`;
  // a chat that lives on a machine uses that machine's desktop: the card says so, since an answer given there is not one for this Mac
  const on = params.machine ? ` on ${params.machine}` : '';
  if (params.kind === 'computerTakeover' || params.screenControl)
    return `Allow ${agent} to use ${params.machine ? `the mouse and keyboard${where}${on}` : `your mouse and keyboard${where}`}?`;
  if (!apps.length) return `Allow ${agent} to ${nameList(extras)}${on}?`;
  return `Allow ${agent} to use ${nameList(apps.map((a) => a.name))}${and}${on}?`;
}

/** The broad-reach warnings (desktopPolicy.cjs) as one line: the first, and how many more. */
export function warningLine(apps: { name: string; warning?: string | null }[]): string {
  const warned = apps.filter((a) => a.warning);
  if (!warned.length) return '';
  const first = `${warned[0].name}: ${warned[0].warning}`;
  return warned.length > 1 ? `${first} (+${warned.length - 1} more in Details)` : first;
}

/** Queued cards peeking behind the one shown, as Claude Desktop stacks them: one ghost per waiting card, at most two. */
export function ghostCount(total: number): number {
  return Math.min(2, Math.max(0, total - 1));
}
