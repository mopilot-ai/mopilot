// Who may call MoPilot's tools. Each harness session gets a random MCP server name, sage_<nonce>, @host-portable: loads in the Host process without Electron (host/boundary.json).
// and a token that lives only in this process's memory. The token changes on every resume and stops
// working when the session ends. Allow rules match only the random name, so an MCP server a repo
// brings along under the name "sage" is never taken for MoPilot's own.
// The in-process servers of Claude Code and Codex share one name per scope (`shared`) for the whole app run: the tool
// definitions open the cached prompt prefix, so a name that changed per process made every new or resumed CLI re-write
// the whole prefix (#2579). The name is new at every app start and never saved: the model and the transcripts see it, so a
// name that outlived the run could be declared by a repository's .mcp.json, which the CLI lets shadow our server of that
// name, and its tools would match the allow rules. Their handlers close over their own chat, so the name is no key.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const SERVER_NAME = /^sage_[0-9a-f]{12}$/;

const newServerName = () => `sage_${crypto.randomBytes(6).toString('hex')}`;
const newToken = () => crypto.randomBytes(32).toString('base64url');
/** Tokens are looked up by digest, so a lookup's timing says nothing about the token itself. */
const digest = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** True for a tool of this session's own server (harnesses name MCP tools mcp__<server>__<tool>). */
function isSageTool(toolName, serverName) {
  if (typeof toolName !== 'string' || !SERVER_NAME.test(serverName || '')) return false;
  const prefix = `mcp__${serverName}__`;
  return toolName.length > prefix.length && toolName.startsWith(prefix);
}

/**
 * The chat a session's calls belong to. A session may hold a resolver instead of a chat id: a harness's
 * native key maps to its chat only once the chat records it (a harness switch commits its new segment
 * after the native session has started), so the owner is looked up at each call, never captured early.
 * @param {string | (() => string)} chatId
 */
const chatOfOwner = (chatId) => (typeof chatId === 'function' ? chatId() : chatId);

/** What rotate() and assign() may change on a session. */
const PATCH_KEYS = ['harnessPid', 'chatId', 'segmentId', 'hide', 'tiered'];

/**
 * Live sessions by key (a Claude session, a Codex thread, an ACP session). Emits 'revoked'
 * ({key, serverName, digest}) whenever a token stops working, so open connections using it close, and
 * 'tools-changed' ({key, digest}) when a tiered session's list changed at a turn's end (mcp/toolTiers.cjs).
 */
class ToolSessions extends EventEmitter {
  /**
   * @param {{ preloaded?: () => string[] }} [o] preloaded: the groups ("surface/group") a tiered session opened now lists
   *   from the start (mcp/toolTiers.cjs preloadedGroups: the Chrome core while it is the chosen browser), kept for the
   *   session's life so what it lists and what it may call never part; a change applies to the next session, as on Claude
   */
  constructor({ preloaded = () => [] } = {}) {
    super();
    this.preloaded = preloaded;
    this.byKey = new Map();
    this.byDigest = new Map();
    /** @type {Map<string, string>} */
    this.shared = new Map();
  }

  /** The one server name every session of a scope presents during this run. */
  #sharedName(scope) {
    let name = this.shared.get(scope);
    if (!name) this.shared.set(scope, (name = newServerName()));
    return name;
  }

  /**
   * Starts a session with a fresh server name and token, replacing any session under the same key.
   * `hide(name)`: registry tools this session must not see or call (asked at list and at call time);
   * null: all of them. `shared`: the name scope whose sessions present one server name (the token stays the session's own).
   * `tiered`: its harness has no tool search, so its list is the core tools and the groups it loaded (mcp/toolTiers.cjs);
   * a new session (a switch's new segment) starts with none loaded.
   * @param {string} key
   * @param {{ harnessPid?: number | null, chatId?: string | (() => string), segmentId?: string,
   *           hide?: ((name: string) => boolean) | null, shared?: string | null, tiered?: boolean }} [o]
   * @returns {{ key: string, serverName: string, token: string }}
   */
  open(key, { harnessPid = null, chatId = key, segmentId = key, hide = null, shared = null, tiered = false } = {}) {
    this.end(key);
    const s = {
      key,
      serverName: shared ? this.#sharedName(shared) : newServerName(),
      harnessPid,
      chatId,
      segmentId,
      hide,
      tiered,
      /** groups ("surface/group") listed this turn, and those loaded during it, listed from the next */
      loaded: new Set(this.preloaded()),
      pending: new Set(),
      digest: null,
    };
    this.byKey.set(key, s);
    return this.#issue(s);
  }

  /** On resume: the same server name with a new token; the old token stops working. */
  rotate(key, patch = {}) {
    const s = this.byKey.get(key);
    if (!s) return null;
    this.#revoke(s);
    for (const k of PATCH_KEYS) if (patch[k] !== undefined) s[k] = patch[k];
    return this.#issue(s);
  }

  /** The harness let go of the session (it may resume it later): the token stops working, the name stays. */
  suspend(key) {
    const s = this.byKey.get(key);
    if (s) this.#revoke(s);
  }

  /** Updates who a session's calls belong to, keeping its token. */
  assign(key, patch) {
    const s = this.byKey.get(key);
    if (!s) return;
    for (const k of PATCH_KEYS) if (patch[k] !== undefined) s[k] = patch[k];
  }

  /** The session is over: its token stops working. */
  end(key) {
    const s = this.byKey.get(key);
    if (!s) return;
    this.#revoke(s);
    this.byKey.delete(key);
  }

  get(key) {
    const s = this.byKey.get(key);
    return s
      ? {
          key: s.key,
          serverName: s.serverName,
          harnessPid: s.harnessPid,
          chatId: chatOfOwner(s.chatId),
          segmentId: s.segmentId,
          hide: s.hide ?? null,
          tiered: s.tiered === true,
          loaded: new Set(s.loaded),
          callable: new Set([...s.loaded, ...s.pending]),
        }
      : null;
  }

  /**
   * A tiered session loaded `groups` ("surface/group") during its turn: callable now, listed from its next turn.
   * Returns false when there is no such session.
   * @param {string} key @param {string[]} groups
   */
  loadGroups(key, groups) {
    const s = this.byKey.get(key);
    if (!s) return false;
    for (const g of groups) if (!s.loaded.has(g)) s.pending.add(g);
    return true;
  }

  /**
   * A turn of `chat` ended (thread null: the chat's whole turn, a Stop or a crash; else one Codex thread's): the groups
   * its sessions loaded during it are listed from now on, and each session whose list changed is told ('tools-changed').
   * @param {string} chat @param {string | null} [thread]
   */
  commitTurn(chat, thread = null) {
    for (const s of this.byKey.values()) {
      if (!s.pending.size || (thread != null && s.segmentId !== thread)) continue;
      let owner;
      try {
        owner = chatOfOwner(s.chatId);
      } catch {
        // a session whose chat can't be read yet belongs to no turn that ended
        continue;
      }
      if (owner !== chat) continue;
      for (const g of s.pending) s.loaded.add(g);
      s.pending.clear();
      if (s.digest) this.emit('tools-changed', { key: s.key, digest: s.digest });
    }
  }

  /** The live session a token belongs to, or null. */
  resolve(token) {
    if (typeof token !== 'string' || !token) return null;
    const s = this.byDigest.get(digest(token));
    return s ? { ...this.get(s.key), digest: s.digest } : null;
  }

  /** Whether a token (by digest) still works. */
  live(d) {
    return this.byDigest.has(d);
  }

  #issue(s) {
    const token = newToken();
    s.digest = digest(token);
    this.byDigest.set(s.digest, s);
    return { key: s.key, serverName: s.serverName, token };
  }

  #revoke(s) {
    if (!s.digest) return;
    this.byDigest.delete(s.digest);
    this.emit('revoked', { key: s.key, serverName: s.serverName, digest: s.digest });
    s.digest = null;
  }
}

module.exports = { ToolSessions, isSageTool, chatOfOwner, SERVER_NAME, digest };
