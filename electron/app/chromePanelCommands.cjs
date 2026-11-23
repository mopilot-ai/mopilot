// The Chrome side panel's / menu (app/chromePanel.cjs): each harness's commands and skills for the chat's folder, as the app's / menu lists them, and a Codex skill picked there resolved to the skill the message carries.
const path = require('node:path');
const { lexicalInside } = require('../platform/pathInside.cjs');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { claudeSkipped } = require('../../shared/claudeSlash.mjs');

/**
 * One row of the / menu; `as` says how a message takes it: its /name in the text (Claude Code, a basic harness), or a
 * skill carried beside the text (Codex).
 * @typedef {{ name: string, description: string, hint: string, kind: 'command' | 'skill', as: 'text' | 'skill' }} PanelCommand
 */

/** A skill's scope, the narrowest first: one in the project wins over the user's, the system's or an admin's. */
const SCOPE_RANK = Object.freeze({ repo: 0, user: 1, system: 2, admin: 3 });

/**
 * Codex's skills for a folder as the app's / menu lists them (src/harness/codexCatalog.ts composerCodexSkills): one per
 * name, enabled, the project's over the user's and the system's, and among project copies the nearest root's.
 * @param {any} result skills/list's answer
 * @param {string} cwd
 */
function codexSkills(result, cwd) {
  const data = Array.isArray(result?.data) ? result.data : [];
  const matching = data.filter((e) => path.resolve(String(e.cwd)) === path.resolve(cwd));
  const projectRoot = (/** @type {any} */ s) => {
    const root = String(s.path).replace(/[\\/]\.(?:codex|agents|claude)[\\/]skills[\\/].*$/, '');
    return root !== s.path && lexicalInside(root, cwd) ? root.length : 0;
  };
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const entry of matching.length ? matching : data)
    for (const skill of entry.skills ?? []) {
      if (skill.enabled === false) continue;
      const prev = byName.get(skill.name);
      const rank = (/** @type {any} */ s) => SCOPE_RANK[/** @type {keyof typeof SCOPE_RANK} */ (s.scope)] ?? 9;
      if (!prev || rank(skill) < rank(prev) || (rank(skill) === rank(prev) && projectRoot(skill) > projectRoot(prev)))
        byName.set(skill.name, skill);
    }
  return [...byName.values()];
}

/**
 * @param {object} d
 * @param {any} d.live main's late-bound services: codex, controller (a basic harness's session state)
 * @param {{ findBinary: (bin?: string) => Promise<string | null>, catalog: (bin: string, cwd: string, account?: string) => Promise<any> }} d.claude
 * @param {() => any} d.prefs the app's prefs
 * @param {(chatId: string) => string | null} d.kindOf the harness kind a chat runs on now
 * @param {(chatId: string) => Promise<string | null>} d.cwdOf the chat's folder
 * @param {string} d.home the folder a new chat's menu reads (one with no project starts in a folder of its own)
 */
function createPanelCommands({ live, claude, prefs, kindOf, cwdOf, home }) {
  /** The kind a menu is for, and the folder its commands are read for. */
  async function where(/** @type {{ harness?: string, chatId?: string, cwd?: string | null }} */ p) {
    const kind = parseKind(p.chatId ? kindOf(p.chatId) : (p.harness ?? null));
    if (!kind) throw new Error(p.chatId ? "That chat isn't in MoPilot." : 'Pick a harness.');
    const cwd = (p.chatId ? await cwdOf(p.chatId) : p.cwd) ?? home;
    return { kind, cwd };
  }

  /**
   * Each family's commands for a folder.
   * @type {Record<string, (cwd: string, chatId: string | undefined) => Promise<PanelCommand[]>>}
   */
  const LIST = {
    // the CLI's commands a message can run, and its skills (each one a /command too)
    async claude(cwd, chatId) {
      const bin = await claude.findBinary(prefs().claudeBin ?? undefined);
      if (!bin) return [];
      // the login the chat runs on (its own skills and commands); a new chat's is the active one
      const c = await claude.catalog(bin, cwd, (chatId && live.claudeTurns?.accountOf(chatId)) || undefined);
      const skip = claudeSkipped(c?.terminalSlash ?? []);
      const skills = new Set(c?.skills ?? []);
      /** @type {PanelCommand[]} */
      const commands = (c?.commands ?? [])
        .filter((/** @type {any} */ x) => !skip.has(x.name))
        .map((/** @type {any} */ x) => ({
          name: x.name,
          description: x.description,
          hint: x.argumentHint ?? '',
          kind: skills.has(x.name) ? 'skill' : 'command',
          as: 'text',
        }));
      const listed = new Set(commands.map((x) => x.name));
      for (const name of skills) if (!listed.has(name)) commands.push({ name, description: '', hint: '', kind: 'skill', as: 'text' });
      return commands;
    },
    // its skills; Codex's own commands run in the app (they aren't a message's text)
    async codex(cwd) {
      return codexSkills(await live.codex.skillList(cwd), cwd).map((s) => ({
        name: String(s.name),
        description: String(s.shortDescription ?? s.description ?? ''),
        hint: '',
        kind: 'skill',
        as: 'skill',
      }));
    },
    // what the session's agent announced (available_commands_update); none before it has started
    async acp(_cwd, chatId) {
      const list = (chatId ? live.controller.state.get(chatId)?.acp?.commands : null) ?? [];
      return list.map((/** @type {any} */ x) => ({
        name: String(x.name),
        description: String(x.description ?? ''),
        hint: String(x.input?.hint ?? ''),
        kind: 'command',
        as: 'text',
      }));
    },
  };

  /**
   * Each family's skills a message carries besides its text.
   * @type {Record<string, (names: string[], cwd: string) => Promise<{ kind: 'skill', name: string, path: string }[]>>}
   */
  const SKILLS = {
    // a Codex skill goes by its path (harness/codexParams.cjs buildInput)
    async codex(names, cwd) {
      const found = codexSkills(await live.codex.skillList(cwd), cwd);
      return names.map((name) => {
        const s = found.find((x) => x.name === name);
        if (!s) throw new Error(`The skill ${name} isn't there any more.`);
        return { kind: 'skill', name: String(s.name), path: String(s.path) };
      });
    },
    // Claude Code and a basic harness take a skill or command as its /name in the text
    claude: async () => [],
    acp: async () => [],
  };

  return {
    /** The / menu for a chat, or a new chat on `harness` (in `cwd`, a saved project's folder). */
    async commands(/** @type {{ harness?: string, chatId?: string, cwd?: string | null }} */ p) {
      const { kind, cwd } = await where(p);
      return { commands: await LIST[kind.family](cwd, p.chatId) };
    },
    /**
     * The skills a message names, as it carries them: a Codex skill by its path (harness/codexParams.cjs buildInput);
     * a harness that takes a skill as /name text needs none. Refused when one isn't there any more.
     */
    async skills(/** @type {string[]} */ names, /** @type {{ harness?: string, chatId?: string, cwd?: string | null }} */ p) {
      if (!names.length) return [];
      const { kind, cwd } = await where(p);
      return SKILLS[kind.family](names, cwd);
    },
  };
}

module.exports = { createPanelCommands, codexSkills };
