// The Claude Code harness's shared mutable state: what main wires in, the logins and the live CLI processes, one object per load of electron/harness/claude/index.cjs.
// electron/harness/claude/index.cjs creates it once and hands it to each section module (claudeAuth, claudeCli, claudeQueries,
// claudeCatalog, claudeSessions, claudeChromeSessions, claudeTranscripts). Sections read its fields when they run,
// never at load, so what main sets later (register(), setTools(), the providers) is what they see.
const { CLAUDE_DEFAULT_ID } = require('./accounts.cjs');
const { readStoreFile, writePrivate } = require('../../platform/fsutil.cjs');
const { electron } = require('../../platform/ports/electronApi.cjs');

/**
 * MoPilot's tools for each session: { registry, sessions, enabled?, nativeChrome?, hideTool? }, set by main.
 * `nativeChrome()` is the remote switch for Claude in Chrome (native.claude.chrome); `hideTool(name)` names the
 * MoPilot tools a session with Claude in Chrome must not see (Your Chrome's, so one Chrome has one controller).
 * @typedef {{ registry: InstanceType<typeof import('../../capabilities/contract/registry.cjs').Registry>,
 *             sessions: Pick<InstanceType<typeof import('../../capabilities/contract/session.cjs').ToolSessions>, 'open' | 'end'>,
 *             enabled?: () => boolean, nativeChrome?: () => boolean, hideTool?: ((name: string) => boolean) & { message?: (name: string) => string } }} SageTools
 */

/** @typedef {{ handedOff?: (chatId: string | undefined, url: string) => boolean, preferHighestCli?: () => boolean, sdk?: () => Promise<any>, spawn?: (o: import('@anthropic-ai/claude-agent-sdk').SpawnOptions, stderr: (data: string) => void, key: string) => import('@anthropic-ai/claude-agent-sdk').SpawnedProcess }} HarnessOptions */

/** @typedef {Record<string, { wires?: string[], efforts?: string[] } | null | undefined>} GatewayCaps */
/** A model config as routed mode reads it (electron/routing/configs.cjs). @typedef {{ id: string, name: string, provider: string, model: string, tierModels: Record<string, string | undefined> }} RoutedConfig */

/** @typedef {{ onWatch?: (key: string, file: string) => void, onUnwatch?: (key: string) => void }} WatchHooks */

/** @type {(chatId: string, state: object | null, key: string) => void} */
const noChromeLink = () => {
  /* no listener until register() sets one */
};

/** @param {Pick<HarnessOptions, 'sdk' | 'spawn'>} [o] `sdk`: how the Agent SDK is loaded when the default import is not wanted (a test's fake); `spawn`: how Claude Code is started instead of the SDK's own spawn (the Host's tracked one), given where the CLI's stderr goes and the chat key it serves */
function createState({ sdk, spawn } = {}) {
  /** @type {Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null} */
  let sdkPromise = null;
  const state = {
    /** The Agent SDK, imported on first use. */
    sdk: sdk ?? (() => (sdkPromise ??= import('@anthropic-ai/claude-agent-sdk'))),
    /** How Claude Code is started, or null for the SDK's own spawn. */
    spawn: spawn ?? null,
    /** Claude Code logins (electron/harness/claude/accounts.cjs); created in register(). */
    accts: /** @type {InstanceType<typeof import('./accounts.cjs').ClaudeAccounts> | null} */ (null),
    /** The login a chat runs on when it names none. */
    activeAccount: /** @type {() => string} */ (() => state.accts?.state.active ?? CLAUDE_DEFAULT_ID),
    /** The signed-in MoPilot device's gateway key (mpk_…), set by main. */
    gatewayKey: /** @type {() => string | null} */ (() => null),
    /** MoPilot's gateway capability table by model (main wires mopilot.modelCaps); null when unknown. */
    gatewayCaps: /** @type {() => Promise<GatewayCaps | null>} */ (async () => null),
    /**
     * MoPilot's model router (electron/routing, wired by main's app/ipc/routing.cjs) for "Your own provider": a saved model config by id,
     * the base a CLI reaches one at (null until the router listens) and the token it sends; null in a process without one (a Host).
     */
    routing:
      /** @type {() => { configOf: (id: string) => RoutedConfig | null, baseFor: (id: string) => string | null, token: string } | null} */ (
        () => null
      ),
    /** The chat a session key (claude:<session id>) belongs to; set by main (controller.chatOf), else the key itself. */
    chatOf: /** @type {(key: string) => string} */ ((key) => key),
    /** The chat is kept apart from the coding side (MoMo's): its sessions read no CLAUDE.md and keep no auto memory; set by main. */
    isolated: /** @type {(chatId: string) => boolean} */ ((_chatId) => false),
    /** The warm title CLI per login (titleHelper.cjs), made with the queries; a composer's prewarm starts it. */
    titleHelper: /** @type {ReturnType<typeof import('./titleHelper.cjs').createTitleHelper> | null} */ (null),
    /** The capability registry and tool sessions (electron/capabilities) every new session gets its tools from. */
    sageTools: /** @type {SageTools | null} */ (null),
    /** MoPilot's plugin store, delivered to each new session (electron/plugins/delivery.cjs); set by main. */
    plugins:
      /** @type {{ forClaude: (o: { configDir?: string, cwd?: string }) => Promise<{ plugins: any[], release: () => unknown, withheld: { id: string, why: string }[] }>, markNative: (family: string, ok: boolean, chatId?: string) => unknown } | null} */ (
        null
      ),
    /** Each session event, to main's hook and the windows; replaced by register(). */
    emit: /** @type {(evt: object) => void} */ (
      () => {
        /* replaced by register() */
      }
    ),
    /** A folder's command catalog changed, to the windows; replaced by register(). */
    broadcastCatalog: /** @type {(evt: object) => void} */ (
      () => {
        /* replaced by register() */
      }
    ),
    /** main's reconcile (electron/session/contract/reconcile.cjs) hears when a transcript is followed and let go */
    watchHooks: /** @type {WatchHooks} */ ({}),
    /** Called when a probe or a session's getSettings has new answers. */
    onProbe: /** @type {() => void} */ (
      () => {
        /* no listener yet */
      }
    ),
    /** A login works again (a verified check passed, or its status reads signed in again): main's adapter forgets its lapse. */
    onLoginWorks: /** @type {(account: string) => void} */ (
      () => {
        /* no listener until main sets one */
      }
    ),
    /** A /usage read says how much a login has left (percent) and when the CLI measured it: main's adapter ranks the logins by it, and holds one with nothing left back, before a chat starts. */
    onLoginLeft: /** @type {(account: string, left: number, measuredAt: number) => void} */ (
      () => {
        /* no listener until main sets one */
      }
    ),
    /** Main learns of each Claude in Chrome link change: (chatId, link | null) — null once the chat's session is gone. */
    onChromeLink: noChromeLink,
    /** Main learns that a CLI process started for (chatId, key): its Claude in Chrome is fixed from now (the controller plan). */
    onProcess: /** @type {(chatId: string, key: string) => void} */ (
      () => {
        /* no listener until main sets one */
      }
    ),
    /** Whether a session's Claude in Chrome is its chat's (chatId, key): main's segment scope; every session until main sets it. */
    chromeScope: /** @type {(chatId: string, key: string) => boolean} */ (() => true),
    /** Where Remote Control remembers its choices (electron/harness/claude/remoteControl.cjs): a file in userData, null where there is no app. */
    remoteFile: () => {
      const app = /** @type {any} */ (electron)?.app;
      return app ? `${app.getPath('userData')}/claude-remote-control.json` : null;
    },
    /** Whether the network is up (Electron's net.isOnline); true where there is no app to ask. */
    online: () => {
      const net = /** @type {any} */ (electron)?.net;
      return typeof net?.isOnline === 'function' ? net.isOnline() : true;
    },
    /** e2e: the harness offers a hook that sweeps the idle reaper as if hours had passed (MOPILOT_REAPER_TEST) */
    reaperTest: !!process.env.MOPILOT_REAPER_TEST,
    /** Calls `fn` each time the computer wakes from sleep (Electron's powerMonitor); returns how to stop. Nothing where there is no app. */
    onResume: (/** @type {() => void} */ fn) => {
      const pm = /** @type {any} */ (electron)?.powerMonitor;
      if (typeof pm?.on !== 'function') return undefined;
      pm.on('resume', fn);
      return () => pm.removeListener('resume', fn);
    },
    /** How those choices are read (a file that isn't a JSON object is reported and starts empty) and written (owner only). */
    remoteIo: {
      read: (/** @type {string} */ file) =>
        readStoreFile(file, 'Remote Control choices', (d) => !!d && typeof d === 'object' && !Array.isArray(d)).data,
      write: writePrivate,
    },
    /** key -> the live CLI process for a chat */
    sessions: new Map(),
    /** key -> a CLI that is ending gracefully (retire()): a new process for the key starts after it quit */
    retiring: /** @type {Map<string, Promise<boolean>>} */ (new Map()),
    /** key -> a send() replacing or starting the CLI for a chat: other sends for the key wait for it, then use that CLI */
    starting: /** @type {Map<string, Promise<void>>} */ (new Map()),
    /** keys of CLIs started before their chat's first message that no chat took yet (harness/claude/warm.cjs): their end is quiet */
    prewarmed: /** @type {Set<string>} */ (new Set()),
    /** before a CLI starts: the governor makes room under its cap (harness/claude/governor.cjs makeRoom) */
    beforeStart: /** @type {(() => unknown) | null} */ (null),
    /** sessionId → the transcript tip Sage's last process on it wrote, kept after that process ends (see watch()) */
    endedTips: /** @type {Map<string, string | null | undefined>} */ (new Map()),
    /** key -> the chain entry an edited message's session resumes at, for its next process */
    resumeAt: /** @type {Map<string, string>} */ (new Map()),
    timing: {
      /** how long a finished turn whose Claude in Chrome group holds only blank tabs waits before its idle CLI ends */
      blankGroupMs: 2000,
      /** how long an ending CLI gets to run its exit hooks and quit before the SDK closes it */
      retireMs: 4000,
    },
  };
  return state;
}

/** @typedef {ReturnType<typeof createState>} ClaudeState */

module.exports = { createState, noChromeLink };
