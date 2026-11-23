// Which coding-side MCP servers MoMo may use (#2999 C0), one by one, default none: a sealed, owner-only file under MoMo's folder (<momo dir>/connectors/mcp.json, sealedFile.cjs SealedJson) that Reset MoMo erases (store 'connectors'). Allowing a server records the tools it had then, each by name and schema (names.cjs toolKey) with whether the server said it was read-only. Only those get a default: on when the server said read-only, off otherwise. A tool that is new since, or whose read-only claim changed, is off until the user turns it on; the user's own choice for a tool always wins. The read-only claim is the server's word, used for the default and shown as its claim, never as a guarantee.
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { SealedJson } = require('../../gateway/sealedFile.cjs');

/**
 * @typedef {{ readOnly: boolean }} Baseline what the server said about a tool when it was allowed
 * @typedef {{ allowedAt: number, baseline: Record<string, Baseline>, choices: Record<string, boolean> }} ServerEntry
 * @typedef {Record<string, ServerEntry>} Servers by catalog key
 * @typedef {{ key: string, readOnly: boolean }} SeenTool a tool as listed now: its toolKey and the server's read-only claim
 */

const record = (/** @type {unknown} */ v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {};

/** The file's value as Servers: damaged parts dropped, not guessed at. @returns {Servers} */
function shape(/** @type {unknown} */ value) {
  /** @type {Servers} */
  const out = {};
  for (const [key, v] of Object.entries(record(value))) {
    const e = record(v);
    if (!Number.isFinite(e.allowedAt)) continue;
    const baseline = Object.fromEntries(
      Object.entries(record(e.baseline))
        .filter(([, b]) => typeof record(b).readOnly === 'boolean')
        .map(([k, b]) => [k, { readOnly: b.readOnly }]),
    );
    const choices = Object.fromEntries(Object.entries(record(e.choices)).filter(([, c]) => typeof c === 'boolean'));
    out[key] = { allowedAt: e.allowedAt, baseline, choices };
  }
  return out;
}

/**
 * Whether a tool of an allowed server is on: the user's choice, else on only when it was there when the server was
 * allowed, the server said then that it was read-only, and still says so.
 * @param {ServerEntry} entry @param {SeenTool} tool
 */
function toolOn(entry, tool) {
  const choice = entry.choices[tool.key];
  if (choice !== undefined) return choice;
  const base = entry.baseline[tool.key];
  return base !== undefined && base.readOnly && tool.readOnly;
}

class McpAllowlist {
  /** @param {{ dir: string, safeStorage: import('../../gateway/sealedFile.cjs').SafeStorage | null | undefined, now?: () => number }} o */
  constructor({ dir, safeStorage, now = Date.now }) {
    this.now = now;
    this.store = new SealedJson({ file: path.join(dir, 'connectors', 'mcp.json'), safeStorage, shape, now });
  }

  /** Whether anything was ever allowed (the file is there): read without making MoMo's folder. */
  exists() {
    return fs.existsSync(this.store.file);
  }

  /** Every allowed server. Throws SealedUnavailableError without the OS key. @returns {Servers} */
  list() {
    return this.store.read();
  }

  /** @returns {ServerEntry | null} */
  get(/** @type {string} */ key) {
    return this.list()[key] ?? null;
  }

  /**
   * Allows a server with the tools it lists now as its baseline. Allowing it again keeps the user's choices, except for a
   * tool whose read-only claim differs from the last baseline: its choice was made about another tool, so it goes.
   */
  allow(/** @type {string} */ key, /** @type {SeenTool[]} */ tools) {
    const baseline = Object.fromEntries(tools.map((t) => [t.key, { readOnly: t.readOnly }]));
    return this.store.change((all) => {
      const before = all[key];
      const choices = Object.fromEntries(
        Object.entries(before?.choices ?? {}).filter(
          ([k]) => !before || !baseline[k] || before.baseline[k]?.readOnly === baseline[k].readOnly,
        ),
      );
      all[key] = { allowedAt: this.now(), baseline, choices };
    });
  }

  /** Takes a server out of MoMo; nothing allowed is not an error. */
  remove(/** @type {string} */ key) {
    return this.store.change((all) => {
      delete all[key];
    });
  }

  /** The user's choice for one tool of an allowed server (a server removed meanwhile changes nothing). */
  setTool(/** @type {string} */ key, /** @type {string} */ tool, /** @type {boolean} */ on) {
    if (typeof on !== 'boolean') throw new Error('A tool is turned on or off');
    return this.store.change((all) => {
      if (all[key]) all[key].choices[tool] = on;
    });
  }

  /** Deletes every allowance (Reset MoMo). */
  erase() {
    return this.store.erase();
  }
}

module.exports = { McpAllowlist, toolOn };
