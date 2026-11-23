// Start a chat from a Linear issue: the user's own Linear API key (encrypted with safeStorage, never shown again), the issue a key like ENG-12 or its link names, and its text quoted for the agent as a description of the work, not instructions.
const path = require('node:path');
const { readSecret, writeSecret } = require('./secretFile.cjs');
const { mkdirPrivate } = require('./privateFiles.cjs');
const { quotedTask, shown } = require('../../shared/quotedTask.mjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');
const { linearRef } = require('../../shared/startRef.mjs');
const { noteIgnored } = require('../ignored.cjs');

const ENDPOINT = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 20_000;
const MAX_TITLE = 256;
const FIELDS = 'identifier title url branchName state { name type } team { key name }';
const NOT_CONNECTED = 'Connect Linear in Settings → Connections first.';

/**
 * @typedef {(url: string, init: { method: string, headers: Record<string, string>, body: string, signal: AbortSignal }) =>
 *   Promise<{ ok: boolean, status: number, json(): Promise<any> }>} Fetch
 * @typedef {{ ok: false, error: string, missing?: true }} Refusal
 */

/**
 * The Linear connection: its key in `<dir>/linear-key` (encrypted), and the issues it reads.
 * @param {{ dir: string, safe: any, fetch?: Fetch }} o
 */
function createLinear({ dir, safe, fetch: send = /** @type {Fetch} */ (/** @type {unknown} */ (globalThis.fetch)) }) {
  const file = path.join(dir, 'linear-key');
  /** The saved key, or null; one that can't be read (another machine's keychain) counts as none. */
  const key = () => {
    try {
      return readSecret(file, safe)?.value ?? null;
    } catch (error) {
      noteIgnored('read the saved Linear key', error);
      return null;
    }
  };

  /**
   * One GraphQL query with `apiKey`: its `data`, or why not in words for the window (Linear's own go to the log).
   * @param {string} apiKey @param {string} query @param {Record<string, unknown>} [variables]
   * @returns {Promise<{ ok: true, data: any } | (Refusal & { notFound?: true })>}
   */
  async function ask(apiKey, query, variables = {}) {
    let r;
    try {
      r = await send(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      noteIgnored('reach Linear', error);
      return { ok: false, error: 'Linear didn’t answer. Check the connection, then try again.' };
    }
    /** @type {any} */
    let body = null;
    try {
      body = await r.json();
    } catch (error) {
      noteIgnored("read Linear's answer", error);
    }
    const codes = (body?.errors ?? []).map((/** @type {any} */ e) => e?.extensions?.code);
    if (r.status === 401 || codes.includes('AUTHENTICATION_ERROR'))
      return {
        ok: false,
        error: 'Linear refused the API key: it was revoked or is wrong. Connect Linear again in Settings → Connections.',
      };
    if (r.status === 429 || codes.includes('RATELIMITED'))
      return { ok: false, error: 'Linear is limiting requests right now. Try again in a minute.' };
    // Linear answers an issue no one can see with an error naming the entity: no such issue, not a failure
    const messages = (body?.errors ?? []).map((/** @type {any} */ e) => String(e?.message ?? ''));
    if (r.ok && messages.some((m) => /entity not found/i.test(m)))
      return { ok: false, error: 'Linear has no such issue you can see.', notFound: true };
    if (!r.ok || body?.errors?.length || !body?.data) {
      console.warn(`[linear] query failed (${r.status}): ${JSON.stringify(body?.errors ?? body)?.slice(0, 500)}`);
      return { ok: false, error: 'Linear couldn’t answer that. Try again.' };
    }
    return { ok: true, data: body.data };
  }

  /** An issue as Linear answers it, checked: `{ ok, kind: 'linear', … }` or why not. */
  const issueOf = (/** @type {any} */ i) =>
    i &&
    typeof i.identifier === 'string' &&
    typeof i.title === 'string' &&
    typeof i.url === 'string' &&
    /^https:\/\/linear\.app\//.test(i.url) &&
    (i.branchName == null || typeof i.branchName === 'string')
      ? {
          ok: /** @type {const} */ (true),
          kind: /** @type {const} */ ('linear'),
          key: i.identifier,
          // as Linear shows it, on one line, cut whole: the picker and the chip show it
          title: prefixUnits(shown(i.title).replace(/\s+/g, ' ').trim(), MAX_TITLE),
          url: i.url,
          state: typeof i.state?.name === 'string' ? i.state.name : '',
          done: ['completed', 'canceled'].includes(i.state?.type),
          branch: typeof i.branchName === 'string' && /^[\w./-]{1,200}$/.test(i.branchName) ? i.branchName : null,
        }
      : null;

  return {
    /** Whether a key is saved, and its last four characters, which is all of it the window ever sees. */
    status() {
      const k = key();
      return { connected: !!k, last4: k ? k.slice(-4) : null };
    },
    /** Check `apiKey` with Linear, then keep it (encrypted); `{ ok, name }` (the account's), or why not. */
    async connect(/** @type {unknown} */ apiKey) {
      if (typeof apiKey !== 'string' || !/^lin_api_[A-Za-z0-9]{20,100}$/.test(apiKey.trim()))
        return {
          ok: false,
          error: 'That isn’t a Linear personal API key. Make one in Linear’s own settings, under Security & access, Personal API keys.',
        };
      const r = await ask(apiKey.trim(), 'query { viewer { name } }');
      if (!r.ok) return r;
      try {
        // its own folder, the user's only (first use makes it)
        mkdirPrivate(dir);
        writeSecret(file, apiKey.trim(), safe, 'the Linear key');
      } catch (error) {
        console.warn(`[linear] the key couldn't be saved: ${String(error)}`);
        return { ok: false, error: 'MoPilot couldn’t keep the Linear key on this Mac (the system keychain is unavailable). Try again.' };
      }
      return { ok: true, name: typeof r.data.viewer?.name === 'string' ? r.data.viewer.name : '' };
    },
    /** Forget the saved key. */
    disconnect() {
      try {
        require('node:fs').rmSync(file, { force: true });
      } catch (error) {
        noteIgnored('remove the saved Linear key', error);
      }
      return { ok: true };
    },
    /**
     * The issue `text` (ENG-12, or its linear.app link) names: `{ ok, kind: 'linear', key, title, url, state, done,
     * branch }` (branch: Linear's suggested branch name), with `context` (its text quoted for the agent) when `withText`.
     * @param {unknown} text @param {{ withText?: boolean }} [o]
     * @returns {Promise<any>}
     */
    async find(text, { withText = false } = {}) {
      const ref = linearRef(text);
      if (!ref) return { ok: false, error: 'Type a Linear issue’s key, like ENG-12, or paste its link.' };
      const k = key();
      if (!k) return { ok: false, error: NOT_CONNECTED };
      const r = await ask(k, `query($id: String!) { issue(id: $id) { ${FIELDS}${withText ? ' description' : ''} } }`, { id: ref.key });
      if (!r.ok) return 'notFound' in r ? { ok: false, error: `Linear has no issue ${ref.key} you can see.`, missing: true } : r;
      const found = issueOf(r.data.issue);
      if (!found) return { ok: false, error: `Linear has no issue ${ref.key} you can see.`, missing: true };
      if (!withText) return found;
      const body = typeof r.data.issue.description === 'string' ? r.data.issue.description : '';
      const intro = `This chat starts from Linear issue ${found.key} (${found.url})${found.state ? `, ${found.state.toLowerCase()}` : ''}.`;
      return { ...found, context: quotedTask({ intro, where: 'Linear', title: found.title, body }) };
    },
  };
}

module.exports = { createLinear, ENDPOINT };
