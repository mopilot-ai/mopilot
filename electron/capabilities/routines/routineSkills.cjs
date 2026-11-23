// Action memory's routines as skills (#3571, G4): each saved routine is one skill of MoPilot's bundled "routines"
// plugin, written under the app's data folder and seeded into the plugin store like the built-in plugin, so every
// harness lists it through the plugin delivery it already has (Claude Code's plugins, Codex's skills, an ACP harness's
// plugin_skills). A skill names the routine and its parameters, never the values it recorded.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { userError } = require('../../../shared/userError.mjs');
const { noteIgnored } = require('../../ignored.cjs');

const PLUGIN = 'routines';

/** What a seed the store declined means for the user (store.cjs seedBundled); 'installed' and 'current' are fine. */
const SEED_PROBLEMS = Object.freeze({
  removed: 'The Routines plugin was removed.',
  foreign: 'Another plugin is named routines.',
  unreadable: "The plugin list can't be read.",
});

/** A routine's skill folder name: `routine-` and its name in lowercase words, with its id's start for uniqueness. */
function skillSlug(r) {
  const words = r.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `routine-${words ? `${words}-` : ''}${r.id
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 6)
    .toLowerCase()}`;
}

/** One routine's SKILL.md. Front matter values are JSON strings, which YAML reads as double-quoted scalars. */
function skillDoc(r) {
  const params = r.params.map((p) => p.name);
  const what = (r.description || r.name).replace(/[.\s]+$/, '');
  // no double quotes inside: not every reader of the front matter undoes a JSON string's escapes
  const plain = (/** @type {string} */ t) => t.replace(/\s+/g, ' ').replaceAll('"', "'").replaceAll('\\', '/');
  const label = `'${plain(r.name)}'`;
  const call = JSON.stringify({ routine: r.id, params: Object.fromEntries(params.map((n) => [n, `<${n}>`])) });
  return [
    '---',
    `name: ${skillSlug(r)}`,
    // what the model sees in its skill list: enough to run it without loading the skill
    `description: ${JSON.stringify(`Saved routine ${label}: ${plain(what)}. The routine_run tool (routine: ${label}) reads its pages again, changes nothing, and returns what they say and the recorded steps left for you to do.`)}`,
    '---',
    '',
    `# ${r.name}`,
    '',
    `Call the \`routine_run\` tool with \`${call}\`.`,
    params.length ? `Parameters: ${params.join(', ')}. Leave one out to use the value recorded with the routine.` : 'It has no parameters.',
    'A routine saved from several messages has parts: a run does one, and its result says when to run the next.',
    'A run never acts: its result lists the steps recorded after the reads, from an earlier run. Check them against the request and do them yourself.',
    '',
  ].join('\n');
}

/**
 * Writes the plugin folder for `routines` (replacing what was there) and returns its path.
 * @param {string} dir the folder that holds the plugin folder
 * @param {any[]} routines
 */
function writePlugin(dir, routines) {
  const root = path.join(dir, PLUGIN);
  const skills = path.join(root, 'skills');
  fs.rmSync(skills, { recursive: true, force: true });
  fs.mkdirSync(skills, { recursive: true, mode: 0o700 });
  // the store reads a plugin's name from its manifest: it installs a staged copy, whose folder name says nothing
  const manifest = path.join(root, '.claude-plugin');
  fs.mkdirSync(manifest, { recursive: true, mode: 0o700 });
  writePrivate(
    path.join(manifest, 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'Your saved routines.' }, null, 2),
    fs,
  );
  for (const r of routines) {
    const folder = path.join(skills, skillSlug(r));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder, 'SKILL.md'), skillDoc(r), { mode: 0o600 });
  }
  return root;
}

/**
 * Keeps the plugin in step with the store: written and seeded at start and after each change, one at a time, the
 * latest list winning (a change during a seed is written once that seed ends).
 * What the last seed left is kept as problem(): why new chats can't see the routines, or null.
 * @param {{ dir: string, store: InstanceType<typeof import('./routineStore.cjs').RoutineStore>,
 *           seed: (folder: string) => Promise<unknown>, onProblem?: (() => void) | null }} o onProblem: problem() changed
 */
function syncRoutineSkills({ dir, store, seed, onProblem = null }) {
  /** @type {string | null} */
  let problem = null;
  const set = (/** @type {string | null} */ next) => {
    if (next === problem) return;
    problem = next;
    onProblem?.();
  };
  /** @type {Promise<void> | null} */
  let running = null;
  let again = false;
  const run = async () => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        try {
          const result = await seed(writePlugin(dir, store.list()));
          set(SEED_PROBLEMS[String(result)] ?? null);
        } catch (error) {
          // the routines still run with routine_run; their skills catch up on the next change
          noteIgnored('list routines as skills', error);
          set(userError(error));
        }
      } while (again);
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };
  const off = store.onChange(() => void run());
  return { sync: run, stop: off, problem: () => problem };
}

module.exports = { skillSlug, skillDoc, writePlugin, syncRoutineSkills, PLUGIN };
