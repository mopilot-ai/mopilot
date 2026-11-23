// Why computer use refused an app or stopped a turn, kept as one short line in the chat's transcript on every harness (#1724), and what the model is told so its next turn can recover.
//
// One path for every no-go stop: a native Codex Computer Use program MoPilot stopped (an app on the built-in list,
// one the user blocked, MoPilot itself, or a desktop another chat holds), and MoPilot's own desktop_* and
// computer_* tools refusing such an app on Claude Code, Codex or an ACP harness. The line is a chat note in the chat's
// v2 file (meta.notes), so it is still there after a reload, and windows read it through chats:changed. It names the app
// it refused (`refused`), so the computer-use card shows that app as refused and no follow-up suggests it again.
const { SELF_PANE_HINT, HOST_BUNDLES, anyMatch, isHostName } = require('./desktopPolicy.cjs');
const { noteNoGo } = require('./actionGuard.cjs');
const { ToolError } = require('./registry.cjs');

/** MoPilot's own name, as a refused app is shown. */
const SELF_NAME = 'MoPilot';

/**
 * @typedef {{ reason: 'self' | 'builtIn' | 'blocked', app: string, name: string } | { reason: 'busy', holder: string | null, chat?: boolean }} Refusal
 *   `app`: the app as the agent named it (a bundle id or a name); `name`: what a person reads; `holder`: the title of
 *   the chat holding the desktop (null when it has none); `chat`: a chat holds it (else another app or MoPilot profile)
 */

/** Who holds the desktop, as a sentence names it. */
const holderOf = (r) => (r.holder ? `"${r.holder}"` : r.chat ? 'another chat' : 'another app');

/** The line the user reads in the transcript: short, as Claude's and Codex's are. */
function refusalText(r) {
  if (r.reason === 'self') return "Computer use can't control MoPilot itself.";
  if (r.reason === 'blocked') return `${r.name} is blocked in Settings → Computer use.`;
  if (r.reason === 'builtIn') return `Computer use can't control ${r.name}.`;
  return `Computer use stopped: ${holderOf(r)} is using this Mac.`;
}

/** What the model is told after MoPilot stopped its computer use, so its next turn answers another way. */
function modelNote(r) {
  const why =
    r.reason === 'busy'
      ? `${holderOf(r)} was controlling this Mac`
      : r.reason === 'self'
        ? 'computer use never controls MoPilot itself'
        : r.reason === 'blocked'
          ? `the user blocked ${r.name} in Settings → Computer use`
          : `computer use never controls ${r.name}`;
  const next =
    r.reason === 'busy'
      ? 'Do not retry computer use until the user asks.'
      : r.reason === 'self'
        ? `Do not try it again. ${SELF_PANE_HINT}`
        : `Do not try ${r.name} again; tell the user if the task needs it.`;
  return `MoPilot stopped your last turn because ${why}. ${next}`;
}

/**
 * How the computer-use helper's refusal of an app reads: its `refused` is why (its deny list's reason, "MoPilot"
 * for MoPilot itself), its `name` and `bundleId` the app.
 * @param {{ refused: string, name?: string | null, bundleId?: string | null }} app
 * @returns {Refusal}
 */
function helperRefusal(app) {
  const named = app.name || app.bundleId || app.refused;
  if (app.refused === SELF_NAME) return { reason: 'self', app: named, name: SELF_NAME };
  return { reason: 'builtIn', app: named, name: app.name || app.refused };
}

/** The error a tool call that refused a no-go app throws, once the chat has noted the refusal (./actionGuard.cjs noteNoGo). */
function noGoError(message, code, refusal) {
  noteNoGo(refusal);
  return new ToolError(message, code);
}

/**
 * A desktop tool that names MoPilot itself (by name, a helper's name, a development build's Electron, or their
 * bundle ids) is refused as the no-go app it is, never answered "not granted, request access" (#1724).
 * @param {unknown} query the app the call names
 */
function refuseSelf(query) {
  const q = String(query ?? '').trim();
  if (!q || !(isHostName(q) || anyMatch(HOST_BUNDLES, q))) return;
  throw noGoError(`Computer use never controls ${q} (MoPilot itself). ${SELF_PANE_HINT}`, 'refused', {
    reason: 'self',
    app: q,
    name: SELF_NAME,
  });
}

class ControlRefusals {
  /**
   * @param {object} o
   * @param {{ get: (id: string) => any, record: (id: string) => any, patchMeta: (id: string, patch: object) => boolean }} o.chats
   *   the chat store (electron/platform/chats.cjs)
   * @param {(chatId: string) => string | null} o.turnOf the chat's running turn, when the caller does not know it
   * @param {(id: string, chat: any) => void} o.changed every window reads the chat's new note (chats:changed)
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.seq = 0;
  }

  /**
   * Notes a refusal in the chat once per turn and app (a program or a model retrying it does not repeat the line).
   * @param {string} chatId
   * @param {Refusal} r
   * @param {string | null} [turnId] the turn it stopped; the chat's running turn when not given
   * @returns {boolean} whether a new line was written
   */
  note(chatId, r, turnId) {
    if (!chatId) return false;
    const turn = turnId ?? this.o.turnOf(chatId) ?? null;
    const text = refusalText(r);
    const notes = this.o.chats.record(chatId)?.meta?.notes ?? [];
    if (notes.some((n) => n.kind === 'control' && n.turnId === turn && n.text === text)) return false;
    const at = this.now();
    const note = {
      id: `control-${at}-${++this.seq}`,
      kind: 'control',
      text,
      ...(r.reason === 'busy' ? {} : { refused: { app: r.app, name: r.name } }),
      turnId: turn,
      // no turn id: the chat's latest turn shows it (src/lib/chatMeta.ts withChatNotes)
      turn: Number.MAX_SAFE_INTEGER,
      at,
    };
    // patchMeta-changes: the new note has its own id, so the notes always change
    if (!this.o.chats.patchMeta(chatId, { notes: [...notes, note] })) return false;
    this.o.changed(chatId, this.o.chats.get(chatId));
    return true;
  }
}

module.exports = { ControlRefusals, refusalText, modelNote, helperRefusal, noGoError, refuseSelf, SELF_NAME };
