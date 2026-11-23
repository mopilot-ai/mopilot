// MoMo's CODEX_HOME (#2308): the folder under <userData>/momo its Codex app-server runs with (codexIsolatedServer.cjs).
// It carries the user's model and provider settings from their own config.toml, and nothing that instructs or
// remembers: no AGENTS.md (or AGENTS.override.md), skills, hooks, rules, prompts, plugins, MCP servers or memories.
// Checked on codex-cli 0.162.1 (`codex debug prompt-input`): the global AGENTS.md and $CODEX_HOME/skills are read from
// CODEX_HOME only; ~/.agents/skills is read whatever CODEX_HOME is, so an isolated thread's config turns skills off
// (codexIsolation.cjs). Its config.toml also switches Codex's own shell, exec, image-reading, sub-agent and memory tools off
// for every thread on it, whatever the thread's start carries (#2139). Its threads' rollouts stay here. Made ready before each
// start of that app-server.
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const { parse, stringify } = require('smol-toml');
const { mkdirPrivate } = require('../platform/privateFiles.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { HOME_FEATURES_OFF } = require('./codexIsolation.cjs');
const { createCodexRollouts, setThreadHomes } = require('./codexRollout.cjs');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');

/** The settings of the user's config.toml MoMo's Codex keeps: which model, on which provider and endpoint, signed in how. */
const SETTINGS = new Set([
  'model',
  'model_provider',
  'model_providers',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_context_window',
  'model_auto_compact_token_limit',
  'service_tier',
  'openai_base_url',
  'chatgpt_base_url',
  'forced_login_method',
  'forced_chatgpt_workspace_id',
  'cli_auth_credentials_store',
  'profile',
]);
/** What Codex reads from its home that instructs, extends or remembers, and any sign-in it saved: never in MoMo's. */
const LEFT_OUT = /^(AGENTS(\.override)?\.md|skills|hooks\.json|rules|prompts|plugins|memories.*|auth\.json)$/;

const kept = (table) => Object.fromEntries(Object.entries(table).filter(([k]) => SETTINGS.has(k)));

/** The settings MoMo's Codex keeps of a config.toml's text; an unreadable one keeps none. */
function settingsOf(text) {
  let doc;
  try {
    doc = parse(text);
  } catch (error) {
    noteIgnored("read the Codex settings for MoMo's Codex", error);
    return {};
  }
  const out = kept(doc);
  // each profile with only the same settings (one names a model and its effort, never instructions)
  if (isJsonRecord(doc.profiles))
    out.profiles = Object.fromEntries(
      Object.entries(doc.profiles)
        .filter(([, v]) => isJsonRecord(v))
        .map(([k, v]) => [k, kept(v)]),
    );
  return out;
}

/**
 * Makes `home` ready: owner-only, nothing left in it that instructs or remembers, and its config.toml the user's
 * settings from `userHome` (their CODEX_HOME). Throws when the folder can't be made.
 * @param {{ home: string, userHome: string, fileFs?: typeof fs }} o
 */
function prepareMomoHome({ home, userHome, fileFs = fs }) {
  mkdirPrivate(home, fileFs);
  for (const name of fileFs.readdirSync(home))
    if (LEFT_OUT.test(name)) fileFs.rmSync(path.join(home, name), { recursive: true, force: true });
  let text = '';
  try {
    text = fileFs.readFileSync(path.join(userHome, 'config.toml'), 'utf8');
  } catch (error) {
    // no config of their own: Codex's defaults
    if (error?.code !== 'ENOENT') noteIgnored("read the Codex settings for MoMo's Codex", error);
  }
  // and Codex's own shell, exec, image-reading and memory off for every thread on this app-server, whatever its start carries
  writePrivate(path.join(home, 'config.toml'), stringify({ ...settingsOf(text), features: { ...HOME_FEATURES_OFF } }), fileFs);
}

/** A Codex thread id (UUID): nothing else is looked for in a home. */
const THREAD_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** How many forks back a thread's source is followed. */
const MAX_LINEAGE = 8;
/** How long a thread found in neither home is not looked for again (its rollout may be written late). */
const NOT_THERE_MS = 60_000;
/** The longest first line (a rollout's session_meta, with its instructions) read to find what a thread was forked from. */
const MAX_HEAD = 16 << 20;
/** Threads looked for in the user's home and not found: thread -> when. */
const notThere = new Map();

/**
 * A MoMo chat's thread made before MoMo had a home of its own (#2326) has its rollout in the user's. MoMo's app-server
 * can't resume it from there, and it is never resumed on the user's (isolation stays closed): its rollout is copied into
 * MoMo's home, at the same place under it, so the resume finds it (checked on codex-cli 0.164: nothing else is needed).
 * A fork also brings the rollout it was forked from, which Codex needs to resume it. The copy is MoMo's own chat's history
 * and stays here; it is written under another name and renamed, so a copy cut short is never taken for the thread.
 * Never throws; false when nothing was copied (it is there already, or is nowhere).
 * @param {{ threadId: string, home: string, userHome: string, fileFs?: typeof fs }} o
 */
function adoptRollout(o) {
  return adopt(o, 0);
}

async function adopt({ threadId, home, userHome, fileFs = fs }, depth) {
  const missed = notThere.get(threadId);
  if ((missed !== undefined && clock.now() - missed < NOT_THERE_MS) || !THREAD_ID.test(threadId)) return false;
  try {
    if (await createCodexRollouts({ codexHome: () => home }).locate(threadId)) return false;
    const from = await createCodexRollouts({ codexHome: () => userHome }).locate(threadId);
    if (!from) {
      notThere.set(threadId, clock.now());
      return false;
    }
    notThere.delete(threadId);
    const to = path.join(home, path.relative(userHome, from));
    mkdirPrivate(path.dirname(to), fileFs);
    const part = `${to}.adopting`;
    fileFs.copyFileSync(from, part);
    fileFs.renameSync(part, to);
    const source = forkedFrom(from, fileFs);
    if (source && depth < MAX_LINEAGE) await adopt({ threadId: source, home, userHome, fileFs }, depth + 1);
    return true;
  } catch (error) {
    noteIgnored("copy a MoMo chat's earlier Codex thread into MoMo's home", error);
    return false;
  }
}

/** The thread a rollout was forked from, named in its first line (read whole, however long); null for none. */
function forkedFrom(file, fileFs) {
  try {
    const fd = fileFs.openSync(file, 'r');
    try {
      const chunk = Buffer.alloc(1 << 16);
      const parts = [];
      let at = 0;
      for (;;) {
        const n = fileFs.readSync(fd, chunk, 0, chunk.length, at);
        const piece = chunk.subarray(0, n);
        const eol = piece.indexOf(10);
        parts.push(Buffer.from(eol < 0 ? piece : piece.subarray(0, eol)));
        at += n;
        if (eol >= 0 || n === 0 || at > MAX_HEAD) break;
      }
      const id = JSON.parse(Buffer.concat(parts).toString('utf8'))?.payload?.forked_from_id;
      return typeof id === 'string' ? id : null;
    } finally {
      fileFs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

module.exports = { adoptRollout, setThreadHomes, prepareMomoHome, settingsOf, SETTINGS };
