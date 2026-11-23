// Shared control narration contracts, text formatting and result fields.
import { ownTable } from '../../../shared/ownTable.mjs';
import type { SkyProblem } from '../../../shared/skyComputerUse.mjs';
import { parseJsonRecord } from '../../../shared/jsonRecord.mjs';
import { prefixUnits } from '../../../shared/textPrefix.mjs';
import { pluralize } from '../format';
export type ControlSurface = 'browser' | 'desktop';

/** A tool call's arguments, as the harness passed them: any JSON object. */
export type ToolArgs = Record<string, unknown>;

export interface ControlStep {
  surface: ControlSurface;
  /** past tense, for a finished call: "Clicked “Submit”" */
  done: string;
  /** present tense, while it runs: "Clicking “Submit”" */
  doing: string;
  /** what Codex's computer use (Sky) reported when the step failed: its own message, and MoPilot's fix */
  problem?: SkyProblem;
  /** the desktop app the step works in, when the call names it ("Notes") */
  app?: string | null;
}

/**
 * The browser_* or desktop_* tool a call names, whatever the harness put around it: an MCP prefix
 * ("mcp__sage__browser_navigate"), a namespace ("sage.desktop_type") or the legacy sage_ prefix.
 */
export function controlTool(tool: unknown): { surface: ControlSurface; name: string } | null {
  if (typeof tool !== 'string' || !tool) return null;
  const last = tool.split(/__|[./:]/).pop() || '';
  // a basic harness joins MoPilot's server and tool ("sage_3f880302123f_browser_navigate")
  const m = /^(?:sage_(?:[0-9a-f]{12}_)?)?(browser|desktop)_([a-z_]+)$/.exec(last);
  return m ? { surface: m[1] as ControlSurface, name: m[2] } : null;
}

export const q = (s: unknown, n = 60) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${prefixUnits(t, n - 1)}…` : t;
};
export const quoted = (s: unknown) => `“${q(s)}”`;

/** The host a URL names, or the text itself when it is not a URL (a scheme-less address). */
export function hostOf(url: unknown): string {
  const s = String(url ?? '').trim();
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`).host || q(s);
  } catch {
    return q(s);
  }
}
/** The element name the browser host reports for a ref click: `on ref_12 "Submit"`. */
export function clickedName(text: string): string | null {
  const m = /\bon ref_\d+ ("(?:[^"\\]|\\.)*")/.exec(text);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) || null;
  } catch {
    return null;
  }
}

/** A string field of a desktop action record in a result ({"action":…,"app":"Notes","label":"Save"}). */
export function recordField(text: string, key: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    // a line that only starts like JSON: try the next one
    const parsed = parseJsonRecord(t);
    const value = parsed.ok ? parsed.record[key] : null;
    if (typeof value === 'string' && value) return value;
  }
  return null;
}
export const recordApp = (text: string) => recordField(text, 'app');

/** The apps desktop_request_access granted without a card because the user always allows them ({"alwaysAllowed":[…]}). */
export function alwaysAllowed(text: string): string[] {
  try {
    const r = JSON.parse(text.trim());
    return Array.isArray(r?.alwaysAllowed)
      ? r.alwaysAllowed.filter((x: unknown) => typeof x === 'string' && x).map((x: string) => q(x, 30))
      : [];
  } catch {
    return [];
  }
}

/** Both tenses of a verb phrase: [done, doing]. */
export type Tenses = [string, string];

/** Modifier names as a Mac shows them, in the Mac's order (⌃⌥⇧⌘). */
const MAC_MODS: [RegExp, string][] = [
  [/^(?:ctrl|control)$/, '⌃'],
  [/^(?:alt|option|opt)$/, '⌥'],
  [/^shift$/, '⇧'],
  [/^(?:super|cmd|command|meta|win)$/, '⌘'],
];
/** Named keys: [the symbol after a modifier, the word on its own]. */
const MAC_KEYS: Record<string, [string, string]> = ownTable({
  return: ['↩', 'Return'],
  enter: ['↩', 'Return'],
  escape: ['⎋', 'Esc'],
  esc: ['⎋', 'Esc'],
  tab: ['⇥', 'Tab'],
  backspace: ['⌫', 'Delete'],
  delete: ['⌫', 'Delete'],
  space: ['Space', 'Space'],
  left: ['←', '←'],
  right: ['→', '→'],
  up: ['↑', '↑'],
  down: ['↓', '↓'],
});

/**
 * A key or chord in a computer-use call as a Mac shows it: "super+n" → "⌘N", "shift+cmd+return" → "⇧⌘↩",
 * "escape" → "Esc". Chords separated by spaces are translated one by one; anything else stays as written.
 */
export function macKeys(combo: string): string {
  return combo
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => {
      const parts = chord.split('+').filter(Boolean);
      const mods = new Set<string>();
      const keys: string[] = [];
      for (const part of parts) {
        const low = part.toLowerCase();
        const mod = MAC_MODS.find(([re]) => re.test(low));
        if (mod) mods.add(mod[1]);
        else keys.push(part);
      }
      if (keys.length > 1 || (!keys.length && !mods.size)) return chord;
      const ordered = MAC_MODS.map(([, sym]) => sym)
        .filter((sym) => mods.has(sym))
        .join('');
      const k = keys[0];
      if (k === undefined) return ordered;
      const named = MAC_KEYS[k.toLowerCase().replace(/^arrow/, '')];
      const key = named ? named[ordered ? 0 : 1] : k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
      return ordered + key;
    })
    .join(' ');
}
export const CLICK: Record<string, Tenses> = ownTable({
  left_click: ['Clicked', 'Clicking'],
  right_click: ['Right-clicked', 'Right-clicking'],
  middle_click: ['Middle-clicked', 'Middle-clicking'],
  double_click: ['Double-clicked', 'Double-clicking'],
  triple_click: ['Triple-clicked', 'Triple-clicking'],
});
export const seconds = (d: unknown) => {
  const n = Math.max(0, Number(d ?? 1) || 0);
  return pluralize(Math.round(n * 10) / 10, 'second');
};
/** A tool call as an adapter sees it: its namespace (the MCP server), tool name, arguments and result text. */
export interface ControlCall {
  namespace: string;
  tool: string;
  args: ToolArgs;
  result: string;
  /** the call failed (its status, an error, or an MCP error result) */
  failed: boolean;
  /** why MoPilot declined the call's approval itself, not the user (the problem it reads as), or null */
  hostDeclined?: 'cleanupBlocked' | 'requestStopped' | null;
}

/** What a vendor's control tools read as in the thread. */
export interface ControlAdapter {
  /** the narration for one of this namespace's calls, or null when the call is not control */
  narrate(call: ControlCall, ctx: NarrationContext): ControlStep | null;
  /** the program or script the call ran, shown as code when the step is expanded */
  source?(call: ControlCall): { code: string; lang: string } | null;
  /**
   * the call handed the browser to the user (a sign-in, a CAPTCHA, a marked hand-off), or null; `earlier` is the same
   * thread's calls before it (this turn's and, where the caller has them, earlier turns'), oldest first (a persistent REPL reuses tabs a previous program opened)
   */
  handoff?(call: ControlCall, earlier: ControlCall[]): Handoff | null;
  /** the tabs in the user's browser the call's result lists */
  tabs?(call: ControlCall): SeenTab[];
}

/** Where a hand-off or a reported tab is: the chat's in-app browser, or the user's Chrome. */
export type BrowserWhere = 'app' | 'chrome';
/** Why the agent handed the browser over. */
export type HandoffReason = 'signIn' | 'captcha' | 'payment' | 'tookOver' | 'continue';
/**
 * The browser waits for the user: where, why, and the tab when the call names it. `signin`: the agent
 * handed the tab over (browser_request_signin) and its turn ended; the user's "Done, continue" or reply continues; `note` is why.
 */
export interface Handoff {
  where: BrowserWhere;
  reason: HandoffReason;
  url: string | null;
  tabId: string | null;
  signin?: boolean;
  note?: string;
}
/** A browser tab a call's result listed. `browserId` is the extension instance a Codex Browser plugin tab is in. */
export interface SeenTab {
  where: BrowserWhere;
  tabId: string | null;
  title: string;
  url: string;
  browserId: string | null;
}

/** Variables a native control program bound earlier (`let app = await cua.getApp("Notes")`), by name. */
export type NarrationContext = Map<string, { surface: ControlSurface; app: string | null }>;

export const step = (surface: ControlSurface, [done, doing]: Tenses): ControlStep => ({ surface, done, doing });
