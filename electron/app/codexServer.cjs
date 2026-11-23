// The Codex binary main runs (the user's choice, else the newest release installed, past copies that kept quitting)
// and the one app-server process for it.
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const os = require('node:os');
const { windowsCandidates } = require('../platform/winbin.cjs');
const { toolCandidates, toolVersion, offPathFields, fileKey, runnableTool, versionedToolCopies } = require('../platform/userTools.cjs');
const { AppServer } = require('../harness/codex.cjs');
const { loopbackDirect } = require('../platform/loopbackHttp.cjs');
const { installSource, hostIo } = require('../harness/installMethod.cjs');
const { preferredInstalls, highestInstalls } = require('../harness/versions.cjs');
const { IsolatedServer } = require('../harness/codexIsolatedServer.cjs');
const { prepareMomoHome, adoptRollout, setThreadHomes } = require('../harness/codexMomoHome.cjs');
const { momoDir } = require('../momo/stores.cjs');
const { isolatedLogin } = require('../identity/accounts/isolatedLogin.cjs');

/**
 * @param {import('../main.cjs').CodexServerDeps} deps what main.cjs passes in; `live` reads main's late-bound telemetry
 */
function createCodexServer({ app, APP_NAME, isWin, shellEnv, readState, preferHighestCli, live }) {
  /** The Codex binary's version (electron/platform/userTools.cjs: its package.json, else one `--version` per binary). */
  const versionOf = (c) => toolVersion(c, { env: shellEnv.childEnv() });

  /** @returns {Promise<import('../platform/userTools.cjs').CliCandidate[]>} */
  async function probeCandidates() {
    const highest = preferHighestCli();
    const list = (
      isWin
        ? [process.env.CODEX_BIN, ...windowsCandidates('codex', process.env)]
        : [
            process.env.CODEX_BIN,
            // the login shell's PATH and the user-tool folders every detector shares, then the installs only Codex has
            ...toolCandidates(
              ['codex'],
              [
                path.join(os.homedir(), '.codex/bin/codex'),
                '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
                '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
                '/Applications/Codex.app/Contents/Resources/codex',
              ],
              highest,
            ),
          ]
    ).filter(Boolean);
    const seen = new Set();
    /** @type {string[]} */
    const found = [];
    for (const c of list) {
      if (highest ? !runnableTool(c) : !fs.existsSync(c)) continue;
      const real = fileKey(c, isWin ? 'win32' : process.platform);
      if (seen.has(real)) continue;
      seen.add(real);
      found.push(c);
    }
    // each asked at once, in its own process (a binary already asked is not run again); with how it was installed,
    // which Settings names it by
    const io = hostIo(shellEnv);
    const describe = (copy) => ({ ...copy, ...installSource('codex', copy.path, io), ...offPathFields(copy.path, ['codex']) });
    if (highest) return (await versionedToolCopies(found, versionOf)).map(describe);
    return Promise.all(found.map(async (bin) => describe({ path: bin, version: await versionOf(bin) })));
  }

  /** @type {import('../platform/userTools.cjs').CliCandidate[] | null} */
  let cachedCandidates = null;
  /** @type {Promise<import('../platform/userTools.cjs').CliCandidate[]> | null} the probe in flight */
  let probing = null;
  let probeSeq = 0;
  /**
   * The installed copies and their versions, asked again (callers read `cachedCandidates` first). Callers meanwhile
   * share the probe in flight; a forced probe replaces it, and only the latest one started is remembered.
   */
  function codexCandidates(force = false) {
    if (probing && (!force || preferHighestCli())) return probing;
    const seq = ++probeSeq;
    const job = probeCandidates().then((out) => {
      if (seq === probeSeq) cachedCandidates = out;
      return out;
    });
    probing = job;
    const settled = () => {
      if (probing === job) probing = null;
    };
    job.then(settled, settled);
    return job;
  }

  /** The user's choice, while it is still there. */
  const preferred = () => {
    const pref = readState().codexBin;
    return pref && fs.existsSync(pref) ? pref : null;
  };
  /**
   * Copies that kept quitting before they answered (fallBack), set aside for this run: the default passes over them
   * while another copy is installed. Keyed by path; the user's own choice is never set aside.
   * @type {Set<string>}
   */
  const setAside = new Set();
  /** @type {Map<string, string | null>} the version of each binary the user picked, once asked (codexBinary) */
  const pickedVersions = new Map();
  /** @param {import('../platform/userTools.cjs').CliCandidate[]} list */
  const orderOf = (list) => (preferHighestCli() ? highestInstalls(list, 'codex') : preferredInstalls(list, 'codex'));
  /** @param {import('../platform/userTools.cjs').CliCandidate[]} list copies to pick from; a startup failure sets a copy aside */
  const pick = (list) => {
    const order = orderOf(list);
    return (order.find((c) => !setAside.has(c.path)) ?? order[0])?.path ?? 'codex';
  };
  /**
   * The binary to run (the user's choice, else the default pick): the path when it is known now, so a start
   * spawns at once as before; else a promise of it while the installed copies are asked.
   * @returns {string | Promise<string>}
   */
  function codexBinary() {
    const pref = preferred();
    if (pref) {
      // a pick is not among the copies probed: its version is asked beside the start, so a pick that keeps quitting
      // is named with it
      if (!pickedVersions.has(pref)) {
        pickedVersions.set(pref, null);
        void versionOf(pref).then((v) => pickedVersions.set(pref, v));
      }
      return pref;
    }
    if (cachedCandidates && !preferHighestCli()) return pick(cachedCandidates);
    // a choice made while the copies were asked wins
    return codexCandidates().then((list) => preferred() ?? pick(list));
  }
  /**
   * A copy as the windows name it: its version and how it was installed, when it is one of the copies found.
   * @param {string} bin
   * @returns {import('../../shared/model/native').CodexCopy}
   */
  const describe = (bin) => {
    const c = cachedCandidates?.find((x) => x.path === bin);
    return { path: bin, version: c?.version ?? pickedVersions.get(bin) ?? null, via: c?.via ?? null, from: c?.from ?? null };
  };
  /**
   * The copy `bin` as the windows name it, and whether it is the user's own choice.
   * @param {string | null} bin the binary the last start ran
   */
  const copyOf = (bin) => ({ copy: describe(bin ?? 'codex'), pinned: !!bin && preferred() === bin });
  /**
   * The default copy `bin` keeps quitting before it answers: it is set aside for this run, and the next installed copy
   * is the one the next start runs. Null when there is none to move to, or when the user picked a binary (theirs
   * stays: they are told it keeps quitting instead).
   * @param {string | null} bin the binary the last start ran
   * @returns {import('../../shared/model/native').CodexCopy | null}
   */
  function fallBack(bin) {
    if (!bin || !cachedCandidates || preferred()) return null;
    setAside.add(bin);
    // only a copy not yet set aside: going back to one that quit already would never end
    const next = orderOf(cachedCandidates).find((c) => !setAside.has(c.path));
    return next ? describe(next.path) : null;
  }
  // A newly found install is for the next start. Report the live server's path while it still owns the process.
  const runningBin = () => (preferHighestCli() && server.status === 'running' ? server.bin : null);
  /** @returns {Promise<string>} */
  const findCodexBinary = async () => codexBinary();
  /** Settings → About: every installed copy asked again, and the one in use among them. */
  async function codexBinaries() {
    const candidates = await codexCandidates(true);
    const current = runningBin() ?? preferred() ?? pick(candidates);
    // whether the user's terminal runs that same codex (Settings → About says when it doesn't)
    return { candidates, current, ...offPathFields(current, ['codex']) };
  }

  const server = new AppServer({
    findBin: codexBinary,
    // a default copy that keeps quitting before it answers gives way to the next installed one (codexConnection.cjs)
    copies: { copyOf, fallBack },
    // GUI apps launched from Finder get a minimal env; codex gets the login shell's.
    // loopback stays off the user's proxy, so the account relay sees the app-server itself (relayPeers.cjs)
    env: () => loopbackDirect(shellEnv.childEnv()),
    onCrashReport: (code, signal, stderr) =>
      live.telemetry?.error({ message: `codex app-server exited (${code ?? signal})`, stack: stderr.slice(-2000), process: 'codex' }),
  });

  // MoMo's chats run on a second app-server whose CODEX_HOME is MoMo's own (#2308): none of the user's AGENTS.md,
  // skills, hooks or memories reach them. Same binary and environment; started by the first request it takes.
  // read when used, never at load: main creates this before app.setPath('userData') runs (app/lifecycle.cjs prepareApp)
  const momoHome = () => path.join(momoDir(app.getPath('userData')), 'codex-home');
  // a MoMo chat's thread is read from MoMo's home, any other from the user's (harness/codexRollout.cjs, #2326)
  setThreadHomes((threadId) => (live.codex?.isolation?.applies({ threadId }) === true ? momoHome() : null));
  const isolated = new IsolatedServer({
    main: server,
    server: new AppServer({
      findBin: codexBinary,
      env: () => ({ ...loopbackDirect(shellEnv.childEnv()), CODEX_HOME: momoHome() }),
      onCrashReport: (code, signal, stderr) =>
        live.telemetry?.error({
          message: `MoMo's codex app-server exited (${code ?? signal})`,
          stack: stderr.slice(-2000),
          process: 'codex',
        }),
    }),
    // an isolated chat's thread (harness/codexIsolation.cjs), as the adapter knows it
    owns: (threadId) => live.codex?.isolation?.applies({ threadId }) === true,
    prepare: () => prepareMomoHome({ home: momoHome(), userHome: shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex') }),
    // a thread made before MoMo had a home (harness/codexMomoHome.cjs adoptRollout)
    adopt: (threadId) =>
      adoptRollout({ threadId, home: momoHome(), userHome: shellEnv.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex') }),
    // the account in use, once the accounts are open (app/identity.cjs)
    login: async () => (live.accounts ? isolatedLogin(live.accounts) : null),
  });

  // The name stays the app-server's client id; the title and version follow the app.
  const clientInfo = (name = 'sage_codex_desktop') => ({ name, title: APP_NAME, version: app.getVersion() });

  return { server, isolated, codexBinary, findCodexBinary, codexBinaries, clientInfo };
}

module.exports = { createCodexServer };
