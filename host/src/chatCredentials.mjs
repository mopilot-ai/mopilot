// Which credential a machine chat runs on, when its start asked: the sources this Host has for an agent (its own login, a key the app lent, an organization lease), the one a chat started now would use, and the choice a chat carries from its start. A choice is kept on disk and checked on every message, and a turn whose choice is gone is refused, never run on another credential (#4667).
import fs from 'node:fs';
import path from 'node:path';
import { acpKeyed } from '../../shared/host/credentials.mjs';
import { isHostFamily } from '../../shared/host/chatIds.mjs';
import { HostRefusal } from './hostFs.mjs';
import { DEFAULT_ORDER, LENT_FIRST_ORDER, REFUSALS, usingOf } from '../../shared/host/logins.mjs';

/** The agent an id names: `acp:gemini` is Gemini, `claude` and `codex` are themselves. @param {string} harness */
const agentOf = (harness) => (harness.startsWith('acp:') ? harness.slice(4) : harness);

/** The agents that run a chat on the credential it chose, whatever the others are on: Claude Code's CLI is spawned per chat, and Codex has an app-server per credential (host/src/codexFamily.mjs). Every other agent shares one process. */
const PER_CHAT = new Set(['claude', 'codex']);

/** How long after a signed-out reading with something lent it is read again, and how long two such readings in a row are trusted: a CLI probe that comes back early (right after the Host starts, under load) reads like a true one. */
const DOUBT_MS = 1500;
const CONFIRMED_MS = 60_000;

/** The harness a chat id names: `claude:<uuid>` is Claude Code, `acp:<agent>:<uuid>` is that agent, a bare id is a Codex thread. @param {string} chatId */
export const harnessOfChat = (chatId) =>
  chatId.startsWith('claude:') ? 'claude' : chatId.startsWith('acp:') ? `acp:${chatId.split(':')[1]}` : 'codex';

/** Whether the shared process of an agent (Codex's app-server, an ACP agent) runs on a key or lease the app lent: a basic agent by its own id. @param {{ has: (h: string) => boolean }} leases @param {string} harness */
export const lentTo = (leases, harness) =>
  isHostFamily(harness) ? leases.has(harness) : leases.has('acp') || (acpKeyed(harness) && leases.has(harness));

/**
 * @param {object} o
 * @param {{ has: (h: string) => boolean, hasKey: (h: string) => boolean, hasOrg: (h: string) => boolean, orgIdentity?: (h: string) => string | undefined }} o.leases the keys and leases the app lent
 * @param {{ add: (chatId: string) => void, delete: (chatId: string) => void, has: (chatId: string) => boolean } | null} [o.ownRuns] Claude Code chats that run on the Host's own sign-in (their CLI is given nothing lent)
 * @param {string} [o.dataDir] where the choices are kept; without one they are kept in memory only
 * @param {Map<string, { list: () => { id: string, state: string }[], pin: (chatId: string, login: string | null) => void, refresh?: () => Promise<unknown> }>} [o.logins] each agent's logins on this machine, by harness (a family registers its own; none: one unnamed login)
 * @param {number} [o.doubtMs] how long after a signed-out reading with something lent it is read again (tests bring 0)
 * @param {readonly string[]} [o.order] the default order (shared/host/logins.mjs DEFAULT_ORDER); tests bring another
 */
export function createChatCredentials({ leases, ownRuns = null, dataDir, order = DEFAULT_ORDER, logins = new Map(), doubtMs = DOUBT_MS }) {
  /** Whether each agent's own login could be used at the last status the Host reported (signed in, and not expired); an agent not in it has not been asked yet, which is not the same as signed out. @type {Map<string, boolean>} */
  const signedAt = new Map();
  /** Asks the Host for a status, so the sign-in state is known before a chat is kept on anything (set by the Host's wiring). @type {(() => Promise<unknown>) | null} */
  let probe = null;
  /** @type {Promise<unknown> | null} */
  let probing = null;
  /** When each agent was last read as signed out twice in a row with something lent, so a machine that really is signed out is not asked about for every chat. @type {Map<string, number>} */
  const confirmedOut = new Map();
  const file = dataDir ? path.join(dataDir, 'chat-credentials.json') : null;
  /** The choice and the agent it was made for: the chat's id names only where it began. A file an older Host wrote has no agent beside a choice, and reads as the id says. What a chat began on when it chose nothing is `implicit`: kept so a later change of default or of what is lent never moves it while it can still run. @type {Map<string, { source: 'own' | 'key' | 'org', login?: string, harness?: string, implicit?: true }>} */
  const chosen = new Map();
  if (file) {
    try {
      for (const [id, c] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) chosen.set(id, /** @type {any} */ (c));
    } catch {
      // none kept yet, or a damaged file: no chat has a choice
    }
  }
  const save = () => {
    if (!file) return;
    fs.mkdirSync(/** @type {string} */ (dataDir), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(chosen)), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  /** The lease family and the key holder of an agent: an organization lease is per family (`acp` for every basic agent), a key per agent. @param {string} harness */
  const holders = (harness) => {
    const family = isHostFamily(harness) ? harness : 'acp';
    const agent = agentOf(harness);
    return { org: leases.hasOrg(family), key: isHostFamily(harness) ? leases.hasKey(harness) : acpKeyed(agent) && leases.hasKey(agent) };
  };
  /**
   * What exists for an agent now, and what a chat started without a choice uses. Claude Code follows the default order (the machine's own login first): its CLI is spawned per chat,
   * so a chat can run on it whatever is lent. Every other agent runs all chats in one process that uses what is lent (a lease, then a key) until H3, so that is what it reports.
   * A login that is signed out or expired is not one a chat can use (a limited one is, and is shown as it is).
   * @param {string} harness @param {boolean} signedIn
   */
  function stateOf(harness, signedIn) {
    const own = signedIn && ownUsable(harness);
    signedAt.set(harness, own);
    const { org, key } = holders(harness);
    const sources = { own, key, org };
    return { sources, using: usingOf(sources, PER_CHAT.has(harness) ? order : LENT_FIRST_ORDER) };
  }
  /**
   * Whether the machine's own login can be used: one the agent lists as expired cannot. A signed-out state is the status's to say (the list's own-login row is read once by the harness and can lag it),
   * so only `expired` is taken from the list.
   * @param {string} harness
   */
  function ownUsable(harness) {
    return (
      logins
        .get(harness)
        ?.list()
        .find((l) => l.id === 'default')?.state !== 'expired'
    );
  }
  /** Throws the refusal for a choice that cannot be honored now. @param {string} harness @param {{ source: string, login?: string }} choice */
  function verify(harness, choice) {
    const { org, key } = holders(harness);
    const using = org ? 'org' : key ? 'key' : 'own';
    // a named login must be one this machine has for the agent, signed in; an agent that lists none has one sign-in
    if (choice.login !== undefined) {
      const list = logins.get(harness)?.list();
      if (!list && choice.login !== 'default') throw new HostRefusal('not_supported', REFUSALS.not_supported);
      const have = (list ?? [{ id: 'default', state: 'ok' }]).find((l) => l.id === choice.login);
      if (!have) throw new HostRefusal('login_unavailable', REFUSALS.login_unavailable);
      if (have.state !== 'ok') throw new HostRefusal('login_signed_out', REFUSALS.login_signed_out);
    }
    if (choice.source === 'own') {
      // a Claude Code CLI is spawned per chat, and Codex has a process per credential; an agent whose one process is shared cannot
      if (!PER_CHAT.has(harness) && using !== 'own')
        throw new HostRefusal(
          'credential_unavailable',
          "This agent runs all its chats in one process on this machine, and that process is using what your Mac lent it, so one chat can't use this machine's own login yet.",
          { cause: 'shared' },
        );
      return;
    }
    if (choice.source === 'key' && !key)
      throw new HostRefusal('credential_unavailable', 'The key from your Mac is not available.', { cause: 'key' });
    if (choice.source === 'org' && !org)
      throw new HostRefusal('credential_unavailable', "Your organization's access is not available.", { cause: 'org' });
    // a lease outranks a key wherever one process serves both (Claude Code's CLI gets what is lent, a shared agent's process uses it): choosing the key under a lease would be served by the lease. Codex's key has an app-server of its own.
    if (choice.source === 'key' && org && harness !== 'codex')
      throw new HostRefusal('credential_unavailable', "Your organization's access is in use, so the key can't be chosen for one chat.", {
        cause: 'lease_in_use',
      });
  }
  /** Puts a chat on or off the Host's own sign-in as its choice says: only a chat that runs Claude Code on its own login is on it. @param {string} chatId @param {string} harness @param {{ source: string }} choice */
  const apply = (chatId, harness, choice) => {
    if (!ownRuns) return;
    if (harness === 'claude' && choice.source === 'own') ownRuns.add(chatId);
    else ownRuns.delete(chatId);
  };
  /** The agent a kept choice is for. @param {string} chatId @param {{ harness?: string }} choice */
  const agentOfChoice = (chatId, choice) => choice.harness ?? harnessOfChat(chatId);
  /** The chats this Host started that could not be kept on anything yet (nothing usable, or the state unknown): new ones, so the default order applies to them, not the one a chat that began before the default changed keeps. @type {Set<string>} */
  const started = new Set();
  /** What exists for an agent now, as the last status said; null before it has said anything. @param {string} harness */
  const currentSources = (harness) => (signedAt.has(harness) ? { ...holders(harness), own: signedAt.get(harness) === true } : null);
  /**
   * Keeps a chat on what it began on, without making that a choice of its person's. Nothing is kept while the sign-in state is unknown or while no source can be used:
   * the chat is then settled by a later message, when something can run, and never put on a credential by a guess.
   * @param {string} chatId @param {string} harness @param {readonly string[]} order @returns {boolean} whether the chat was kept on a source
   */
  const settle = (chatId, harness, order) => {
    const s = PER_CHAT.has(harness) ? currentSources(harness) : null;
    if (!s || !(s.own || s.key || s.org)) return false;
    const source = usingOf(s, order);
    chosen.set(chatId, { source, harness, implicit: true });
    save();
    apply(chatId, harness, { source });
    started.delete(chatId);
    return true;
  };
  /** Whether a source can run now for an agent; true while the state is not known yet, since a record is never dropped on a guess. @param {string} harness @param {string} source */
  const usable = (harness, source) => {
    const s = currentSources(harness);
    return !s || s[/** @type {'own'} */ (source)];
  };
  return {
    stateOf,
    /**
     * A chat start's choice, checked and kept: refused (nothing kept) when it cannot be honored now.
     * @param {{ chatId: string, harness: string, credential?: { source: 'own' | 'key' | 'org', login?: string } }} p
     */
    admit({ chatId, harness, credential }) {
      if (!credential) {
        // a chat that chose nothing is kept on what the default gives it now, so a later change of what is lent or signed in never moves it
        if (!settle(chatId, harness, order)) started.add(chatId);
        return;
      }
      verify(harness, credential);
      chosen.set(chatId, { ...credential, harness });
      save();
      apply(chatId, harness, credential);
      if (credential.login !== undefined) logins.get(harness)?.pin(chatId, credential.login);
    },
    /**
     * A choice checked against the agent a chat is about to move to: refused with the coded reason when it cannot be honored there (nothing kept).
     * @param {{ harness: string, credential?: { source: 'own' | 'key' | 'org', login?: string } }} p
     */
    checkChoice({ harness, credential }) {
      if (credential) verify(harness, credential);
    },
    /** Every message of a chat with a choice: refused when what it chose is gone (a key taken back, a lease ended), never run on another credential. @param {string} chatId @param {string} harness */
    check(chatId, harness) {
      const choice = chosen.get(chatId);
      // Codex runs a chat's thread in the app-server of the credential it began on: it cannot move to another credential under the thread, so a credential that is gone is refused
      if (choice && (!choice.implicit || harness === 'codex')) return verify(harness, choice);
      if (choice && agentOfChoice(chatId, choice) === harness && usable(harness, choice.source)) return;
      // what a chat began on has stopped being usable (a key taken back, a login signed out), or it began on another agent: it moves by the same order, and what it runs on is what is kept
      if (choice) {
        chosen.delete(chatId);
        apply(chatId, harness, { source: 'key' });
        save();
        return settle(chatId, harness, order);
      }
      // a chat that began before chats were kept on what they began on keeps what it has been using: its own login if it was on it, else what a lent key or lease put it on
      if (ownRuns?.has(chatId)) {
        chosen.set(chatId, { source: 'own', harness, implicit: true });
        save();
      } else settle(chatId, harness, started.has(chatId) ? order : LENT_FIRST_ORDER);
    },
    /**
     * Before a chat is kept on a credential: the agent's sign-in state is known, and a signed-out reading with something lent is not trusted when it was taken before: a status that came back early
     * or timed out reads the same as one that is true, and it would put the chat on the lent credential for good. A chat that is already kept is not asked about.
     * @param {string} harness @param {string} [chatId]
     */
    async ready(harness, chatId) {
      if (!probe) return;
      const { key, org } = holders(harness);
      const doubted =
        signedAt.get(harness) === false &&
        (key || org) &&
        !(chatId !== undefined && chosen.has(chatId)) &&
        Date.now() - (confirmedOut.get(harness) ?? 0) > CONFIRMED_MS;
      if (signedAt.has(harness) && !doubted) return;
      // the agent's own-login row is read first, where it is read once and lazily (Claude Code's: nothing in a Host asks the app to)
      probing ??= (async () => {
        await logins
          .get(harness)
          ?.refresh?.()
          .catch(() => undefined);
        await probe?.();
        // signed out with something lent is the reading that moves a chat onto it for good: read again after a moment before it counts
        if (signedAt.get(harness) === false && (key || org)) {
          await new Promise((r) => setTimeout(r, doubtMs));
          await probe?.();
          if (signedAt.get(harness) === false) confirmedOut.set(harness, Date.now());
        }
      })().finally(() => (probing = null));
      await probing.catch(() => undefined);
    },
    /** @param {() => Promise<unknown>} ask the Host's status, which tells each agent's sign-in state to `stateOf` */
    setProbe(ask) {
      probe = ask;
    },
    /** The chats that run Claude Code with a kept choice of their own sign-in are put back on it after a restart: by the agent the choice was made for, so a chat that moved to Claude Code is and one that moved away is not. */
    restore() {
      for (const [chatId, c] of chosen) apply(chatId, agentOfChoice(chatId, c), c);
    },
    /** A switch settled: the chat's choice is for the agent it runs on now, and its own sign-in follows. @param {string} chatId @param {string} harness */
    moved(chatId, harness) {
      const choice = chosen.get(chatId);
      if (!choice || agentOfChoice(chatId, choice) === harness) return;
      chosen.set(chatId, { ...choice, harness });
      save();
      apply(chatId, harness, choice);
    },
    /** @param {string} chatId */
    forget(chatId) {
      started.delete(chatId);
      if (!chosen.delete(chatId)) return;
      ownRuns?.delete(chatId);
      save();
    },
    /**
     * Whether a Claude Code chat that chose nothing runs on the machine's own login because the default order puts it first (only matters while something is lent).
     * @param {string} chatId
     */
    ownByDefault: (chatId) =>
      chatId.startsWith('claude:') &&
      !chosen.has(chatId) &&
      usingOf({ ...holders('claude'), own: signedAt.get('claude') === true }, LENT_FIRST_ORDER) === 'own',
    /**
     * A family tells where its logins are (Claude Code: its accounts), so a pin can be checked and the report can list them.
     * @param {string} harness @param {{ list: () => { id: string, state: string }[], pin: (chatId: string, login: string | null) => void, refresh?: () => Promise<unknown> }} family
     */
    bindLogins: (harness, family) => void logins.set(harness, family),
    /** The agent's logins as reported, or null when it lists none. @param {string} harness */
    loginsOf: (harness) => logins.get(harness)?.list() ?? null,
    /**
     * Pins a chat to one login, or lets it go (null): kept with the chat's choice, checked like a start's, and effective from its next turn.
     * @param {{ chatId: string, login: string | null }} p
     */
    setLogin({ chatId, login }) {
      const harness = harnessOfChat(chatId);
      const now = chosen.get(chatId);
      if (login === null) {
        if (now?.login === undefined) return { login: null };
        const { login: _gone, ...rest } = now;
        chosen.set(chatId, rest);
        save();
        logins.get(harness)?.pin(chatId, null);
        return { login: null };
      }
      const next = { source: /** @type {'own'} */ ('own'), login };
      verify(harness, next);
      chosen.set(chatId, next);
      save();
      apply(chatId, harness, next);
      logins.get(harness)?.pin(chatId, login);
      return { login };
    },
    /** @param {string} chatId */
    choiceOf(chatId) {
      const { harness: _agent, implicit, ...choice } = chosen.get(chatId) ?? {};
      return chosen.has(chatId) && !implicit ? /** @type {{ source: 'own' | 'key' | 'org', login?: string }} */ (choice) : null;
    },
    /** The effective choice a side chat inherits, including a credential the parent settled on automatically. */
    sideChatChoice(chatId, harness) {
      const choice = chosen.get(chatId);
      if (!choice || agentOfChoice(chatId, choice) !== harness) return undefined;
      const { source, login } = choice;
      return login === undefined ? { source } : { source, login };
    },
    /** The opaque principal of the organization's current lease. A token renewal keeps the same principal. @param {string} harness */
    sideChatOrgIdentity: (harness) => leases.orgIdentity?.(harness),
    /** The credential a chat is kept on, chosen or begun on; null before it is kept on one. @param {string} chatId */
    sourceOf: (chatId) => chosen.get(chatId)?.source ?? null,
  };
}
