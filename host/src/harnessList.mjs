// Every harness this Host can name with whether it is installed and signed in (./harnessState.mjs), as the Host's status and a chat's credential bookkeeping both ask for it.
import { acpHarnesses, which } from './acp.mjs';
import { listHarnesses, reportedHarness } from './harnessState.mjs';

/** The last definite sign-in answer of each Claude Code and Codex a Host's probe gave, kept per data folder: a probe that cannot tell (it timed out under load) reports it. @type {Map<string, boolean>} */
const lastKnown = new Map();
/** When each agent's probe first could not tell, with no answer since. @type {Map<string, number>} */
const unknownSince = new Map();

/**
 * Every harness this Host can name with whether it is installed and signed in (./harnessState.mjs).
 * @param {{ paths: { dataDir: string }, env: NodeJS.ProcessEnv, signedIn: { get: (id: string) => boolean }, noSignIn: Parameters<typeof listHarnesses>[0]['noSignIn'], exec?: Parameters<typeof listHarnesses>[0]['exec'], which?: typeof which }} o
 */

export function harnessList({ paths, env, signedIn, noSignIn, exec, which: find = which }) {
  const acp = acpHarnesses({ dataDir: paths.dataDir, env }).map((h) => ({ ...h, signedIn: signedIn.get(h.id) }));
  const last = {
    get: (/** @type {string} */ id) => lastKnown.get(`${paths.dataDir}\n${id}`),
    set: (/** @type {string} */ id, /** @type {boolean} */ v) => lastKnown.set(`${paths.dataDir}\n${id}`, v),
    since: (/** @type {string} */ id) => {
      const k = `${paths.dataDir}\n${id}`;
      if (!unknownSince.has(k)) unknownSince.set(k, Date.now());
      return /** @type {number} */ (unknownSince.get(k));
    },
    clear: (/** @type {string} */ id) => unknownSince.delete(`${paths.dataDir}\n${id}`),
  };
  return listHarnesses({ env, which: find, acp, noSignIn, exec, last });
}

/**
 * The harnesses as the Host's status reports them: each with its models and sign-in as its family knows them, and `installable` for a missing agent this Host can install.
 * @param {Parameters<typeof harnessList>[0] & { installer: { installable: (list: any[]) => Iterable<string> }, codex: any, sessions: any, leases: any, ownRuns: { chatCredentials: any } }} o what names them, the installer that says what can be installed, and what each family reports from
 */
export async function reportedHarnesses({ installer, codex, sessions, leases, ownRuns, ...list }) {
  const all = await harnessList(list);
  const installable = new Set(installer.installable(all));
  return Promise.all(
    all.map(async (h) => {
      const one = await reportedHarness(h, { codex, sessions, leases, credentials: ownRuns.chatCredentials, env: list.env });
      return installable.has(h.id) ? { ...one, installable: true } : one;
    }),
  );
}
