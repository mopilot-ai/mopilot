// The ControllerPlan record (docs/control-plane/design.md): who controls each surface of a chat on its current segment, decided when the segment starts and again when its own session loads, kept in the chat's meta.
// The status strip (session state), the credential route, "Continue in Chrome" and the switch sheet read it, never whichever session last reported.
const { decidePlan, planChanges, changeLines } = require('../../shared/controllerPlan.mjs');
const { familyOf } = require('./contract/route.cjs');
const { toRendererSegment } = require('../platform/chats.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { claudeNames } = require('../capabilities/contract/surfaceNote.cjs');

const NO_VENDOR = Object.freeze({ chrome: null, computer: null, iab: null });
const INVENTORY_KEY = { claude: 'key', codex: 'id', acp: 'key' };
const CHROME_TOOL_NAME = {
  claude: claudeNames('sage').name('chrome_tabs_context_mcp'),
  codex: 'chrome_tabs_context_mcp',
  acp: 'chrome_tabs_context_mcp',
};

/**
 * What decidePlan needs for a segment, from main's live services. Each harness family answers for its own
 * sessions and names its own controllers: a session that is running answers for itself (a Claude CLI's Claude in
 * Chrome is fixed per process, a loaded Codex thread keeps its path until it unloads); a segment whose session
 * isn't running yet gets what a new one would get now.
 * @param {object} o
 * @param o.tools () => string[]: the registry tools sessions are shown now
 * @param o.yourChrome () => boolean: the browser channel is Your Chrome
 * @param o.claude - { channel(): boolean, nativeChromeOf(key): boolean | null, nativeChromeFor(chatId): boolean }
 * @param o.codex - { channel(): boolean, loadedPath(threadId): { chrome, computer, iab, tools } | null, nativeSurfaces(): { chrome, computer },
 *   iabAvailable(): boolean, chromeBackend?: () => { serves(threadId): boolean, available(): boolean } | null } (iab: the Codex Browser plugin
 *   drives the pane through its in-app browser backend; chromeBackend: MoPilot serves the user's Chrome to it)
 * @param o.acp - { channel(): boolean }
 */
function planInputs(o) {
  /** @typedef {{ id: string | null, key: string | null }} Ref */
  /** @type {Record<string, (ref: Ref, chatId: string) => { channel: boolean, vendor: { chrome: string | null, computer: string | null, iab: string | null } }>} */
  const families = {
    claude: (ref, chatId) => {
      const running = ref.key ? o.claude.nativeChromeOf(ref.key) : null;
      const chrome = running ?? o.claude.nativeChromeFor(chatId);
      return { channel: o.claude.channel(), vendor: { chrome: chrome ? 'claude-in-chrome' : null, computer: null, iab: null } };
    },
    codex: (ref) => {
      const path = ref.id ? o.codex.loadedPath(ref.id) : null;
      const native = path ?? o.codex.nativeSurfaces();
      // a native thread's plugin drives the pane through its "iab" backend: one it has, or one a thread loaded now gets
      const iab = path ? path.iab : (native.chrome || native.computer) && o.codex.iabAvailable();
      const own = o.codex.chromeBackend?.();
      return {
        channel: path ? path.tools : o.codex.channel(),
        ownChrome: !!(own && (path ? own.serves(/** @type {string} */ (ref.id)) : native.chrome && own.available())),
        vendor: {
          chrome: native.chrome ? 'codex-browser-plugin' : null,
          computer: native.computer ? 'codex-computer-use' : null,
          iab: iab ? 'codex-browser-plugin' : null,
        },
      };
    },
    acp: () => ({ channel: o.acp.channel(), vendor: NO_VENDOR }),
  };
  return (/** @type {{ kind: string, id: string | null, key: string | null }} */ ref, /** @type {string} */ chatId) => {
    const family = familyOf(ref.kind);
    const state = families[family](ref, chatId);
    const tools = o.tools();
    const loaded = o[family].toolsOf?.(ref[INVENTORY_KEY[family]], tools) ?? null;
    return { ...state, tools: loaded ?? tools, channel: loaded === null ? state.channel : loaded.length > 0, yourChrome: o.yourChrome() };
  };
}

class ControllerPlans {
  /**
   * @param {object} o
   * @param o.chats ChatsStore: the plan is the chat's meta.controllerPlan
   * @param o.sessions SessionStore: windows read the plan from the chat's session state (the status strip)
   * @param o.ref (chatId) => the chat's NativeRef
   * @param o.chatOf (key) => the chat a native session key belongs to
   * @param o.inputs (ref, chatId) => decidePlan's input (planInputs)
   */
  constructor(o) {
    this.chats = o.chats;
    this.sessions = o.sessions;
    this.ref = o.ref;
    this.chatOf = o.chatOf;
    this.inputs = o.inputs;
    /** chat id -> the plan of a chat without a file of its own (a temporary chat): never written as a new file */
    this.unsaved = new Map();
  }

  /** The plan for `ref`: the segment it is for (its key) and the controller of each surface. */
  make(chatId, ref) {
    return { key: ref.key, ...decidePlan(this.inputs(ref, chatId)) };
  }

  /** Fresh, non-persisting capabilities for an action now, including the current session's tool presentation. */
  snapshot(chatId) {
    try {
      const ref = this.ref(chatId);
      const input = this.inputs(ref, chatId);
      return {
        ...input,
        key: ref.key,
        plan: { key: ref.key, ...decidePlan(input) },
        chromeToolName: CHROME_TOOL_NAME[familyOf(ref.kind)],
      };
    } catch (error) {
      noteIgnored("read a chat's current tool capabilities", error);
      return null;
    }
  }

  /**
   * Decide the plan for the chat's current segment, and keep it in its meta (in memory for a chat without a file,
   * such as a temporary chat, which must not get one) and its session state.
   */
  decide(chatId) {
    const plan = this.make(chatId, this.ref(chatId));
    if (this.chats.saved(chatId)) {
      this.unsaved.delete(chatId);
      this.chats.patchMeta(chatId, { controllerPlan: plan });
    } else this.unsaved.set(chatId, plan);
    this.sessions.patch(chatId, { controllerPlan: plan });
    return plan;
  }

  /** Segment end: a switch settled on a new segment, whose plan is decided now. */
  segmentEnded({ chatId }) {
    this.decide(chatId);
  }

  /**
   * A native session on `key` started or loaded (a Claude CLI, a Codex thread, an ACP session): the plan is
   * decided again from what it really got, only when it is the chat's current segment. A session of an earlier
   * segment, still up after a switch, never changes it.
   */
  loaded(key, chatId = this.chatOf(key)) {
    try {
      if (this.ref(chatId).key === key) this.decide(chatId);
    } catch (error) {
      noteIgnored("decide a chat's controller plan for a session that loaded", error);
    }
  }

  /** The plan of the chat's current segment: the one kept for it, else what it gets now; null for a chat whose segment can't be read. */
  current(chatId) {
    let ref;
    try {
      ref = this.ref(chatId);
    } catch (error) {
      noteIgnored("read a chat's segment for its controller plan", error);
      return null;
    }
    const kept = [this.chats.record(chatId).meta.controllerPlan, this.unsaved.get(chatId)].find((p) => p?.key === ref.key);
    return kept ?? this.make(chatId, ref);
  }

  /**
   * What a switch to `harness` would change: the plan of the chat's latest segment on it (a switch back resumes
   * that session) or of a new session, against what the current segment gets now, so a setting changed since its
   * plan was decided is not listed as the switch's doing; and the switch sheet's lines for it.
   */
  preview(chatId, harness) {
    let current;
    let next;
    try {
      current = this.make(chatId, this.ref(chatId));
      const prev = this.chats
        .record(chatId)
        .segments.filter((s) => s.kind === harness)
        .at(-1);
      next = this.make(
        chatId,
        prev ? { kind: harness, id: prev.nativeId, key: toRendererSegment(prev).nativeId } : { kind: harness, id: null, key: null },
      );
    } catch (error) {
      // a chat whose segment, or a harness, this build doesn't know: nothing to list
      noteIgnored('preview the controller plan of a harness switch', error);
      return { current: null, next: null, changes: [], lines: [] };
    }
    const changes = planChanges(current, next);
    return { current, next, changes, lines: changeLines(changes) };
  }
}

module.exports = { ControllerPlans, planInputs };
