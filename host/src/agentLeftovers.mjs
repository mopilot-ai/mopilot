// What an agent's own store still holds of a deleted chat's session after the agent's delete: Codex's rollout file and Claude Code's per-session files, each keyed by the session's UUID. Plain files the Host can reach, so the Host removes them itself, and only files whose whole name is the session's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A session or thread id is a UUID (Claude Code's session id, a Codex thread id): anything else names no file here, so nothing is searched for or removed by it. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How deep a Codex rollout can be under `sessions/` (year/month/day) or `archived_sessions/`. */
const DEPTH = 4;

/** The files of a folder tree whose name `wanted` says, as paths. */
async function walk(/** @type {string} */ dir, /** @type {(name: string) => boolean} */ wanted, depth = DEPTH) {
  /** @type {string[]} */
  const found = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (error) {
    // no such folder: the agent never kept anything there
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && wanted(entry.name)) found.push(path.join(dir, entry.name));
    else if (entry.isDirectory() && depth > 0) found.push(...(await walk(path.join(dir, entry.name), wanted, depth - 1)));
  }
  return found;
}

/** Whether `file` exists as it is named, without following a link. */
const exists = (/** @type {string} */ file) =>
  fs.promises.lstat(file).then(
    () => true,
    () => false,
  );

/**
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [o] the agents' environment: where CODEX_HOME and CLAUDE_CONFIG_DIR point, else the user's home
 */
export function createAgentLeftovers({ env = process.env, home = os.homedir() } = {}) {
  return {
    /** Removes the rollout files of a Codex thread that its own delete left (`rollout-<time>-<thread>.jsonl`, plain or compressed, in `sessions/` or `archived_sessions/`); the names removed. @param {string} threadId @returns {Promise<string[]>} */
    async codex(threadId) {
      if (!UUID.test(threadId)) return [];
      const root = env.CODEX_HOME || path.join(home, '.codex');
      const wanted = (/** @type {string} */ name) =>
        name.startsWith('rollout-') && (name.endsWith(`-${threadId}.jsonl`) || name.endsWith(`-${threadId}.jsonl.zst`));
      const files = [...(await walk(path.join(root, 'sessions'), wanted)), ...(await walk(path.join(root, 'archived_sessions'), wanted))];
      for (const file of files) await fs.promises.rm(file, { force: true });
      return files.map((file) => path.basename(file));
    },
    /**
     * Removes what Claude Code keeps under exactly a session's id: its transcript and subagent folder in every project folder, and the per-session folders and files beside `projects/` (edit history, environment, debug log, todo lists). Nothing else, and nothing for an id that is no UUID; the names removed.
     * @param {string} sessionId @returns {Promise<string[]>}
     */
    async claude(sessionId) {
      if (!UUID.test(sessionId)) return [];
      const config = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
      const projects = path.join(config, 'projects');
      /** @type {string[]} */
      let names = [];
      try {
        names = await fs.promises.readdir(projects);
      } catch (error) {
        // no projects folder: Claude Code never ran here
        if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
      }
      const todos = (await fs.promises.readdir(path.join(config, 'todos')).catch(() => [])).filter(
        (name) => name.startsWith(`${sessionId}-`) && name.endsWith('.json'),
      );
      const files = [
        ...names.flatMap((project) => [path.join(projects, project, `${sessionId}.jsonl`), path.join(projects, project, sessionId)]),
        path.join(config, 'file-history', sessionId),
        path.join(config, 'session-env', sessionId),
        path.join(config, 'debug', `${sessionId}.txt`),
        ...todos.map((name) => path.join(config, 'todos', name)),
      ];
      /** @type {string[]} */
      const removed = [];
      for (const file of files) {
        if (!(await exists(file))) continue;
        await fs.promises.rm(file, { recursive: true, force: true });
        // the folder it was in and its name, never the project folder (it spells the chat's directory)
        removed.push(`${path.relative(config, file).split(path.sep)[0]}/${path.basename(file)}`);
      }
      return removed;
    },
  };
}
