// Claude Code on the Host: the app's own ClaudeAdapter and Claude harness (electron/harness/claude), run by the real Agent SDK in this process with the Host's own sign-in (the `claude` CLI on this machine, signed in by `mopilot-host login claude`; nothing of the Mac's ~/.claude is read). It plugs into the composition root (./sessions.mjs) as `families.claude`: the controller routes `claude:<id>` chats to the adapter, the harness's events reach the controller as electron/app/sessions.cjs wires them, and ./turnBridge.mjs tells the stream what the chat's turns do.
import { claudeLoginsOf } from './claudeLogins.mjs';
import { createRequire } from 'node:module';
import { SchemaError } from '../../shared/host/schema.mjs';
import { HostRefusal } from './hostFs.mjs';
import { unsupportedGoalWords } from '../../shared/codexGoals.mjs';
import { which } from './acp.mjs';
import { createModelCache, pickModels } from './claudeModels.mjs';
import { createTurnBridge } from './turnBridge.mjs';
import { withOpener } from './opener.mjs';
import { withKeyHelper } from './orgKeyHelper.mjs';
import { clampToCeiling } from '../../shared/host/policy.mjs';

const require = createRequire(import.meta.url);
const { createClaudeHarness } = require('../../electron/harness/claude/index.cjs');
const { ClaudeAdapter } = require('../../electron/harness/claude/adapter.cjs');
const { adapterSettings } = require('../../electron/session/adapterSettings.cjs');
const { heldOf } = require('../../electron/session/goalHeld.cjs');
const { traitsOf } = require('../../electron/harness/family.cjs');
const { noteIgnored } = require('../../electron/ignored.cjs');
const { proc } = require('../../electron/platform/ports/proc.cjs');
const { spawnGroup } = require('../../electron/platform/winbin.cjs');

/** The IPC the harness registers handlers on: the Host has no windows to call them. */
const NO_IPC = {
  handle() {
    /* no window calls it */
  },
};
/** The permission modes a client may set for a chat; `plan` keeps the mode the chat was in as the one its tools run under once the plan is approved. */
const PERMISSIONS = new Set(['default', 'auto-review', 'full-access', 'read-only', 'plan']);
/** How long a CLI gets to run its exit hooks when the Host stops. */
const CLOSE_GRACE_MS = 500;

/**
 * Starts the Claude Code CLI for the SDK: through the proc port, so the Host records the child (host/src/children.mjs) and the next Host ends it if this one is killed hard, and in a process group of its own, so ending the group reaches the commands it started.
 * @param {import('@anthropic-ai/claude-agent-sdk').SpawnOptions} o
 * @param {(data: string) => void} stderr where the CLI's diagnostics go
 */
export function spawnClaudeCode(o, stderr) {
  const child = spawnGroup((...args) => proc.spawn(...args), o.command, o.args, {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: o.signal,
    windowsHide: true,
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', stderr);
  child.stderr?.on('error', (error) => noteIgnored("read the Claude Code CLI's diagnostics", error));
  return child;
}

/**
 * @param {object} [o]
 * @param {() => Promise<any>} [o.sdk] how the Agent SDK is loaded (default: the installed package); a test brings a fake
 * @param {ReturnType<typeof import('./tools.mjs').createHostTools> | null} [o.tools] the Host's tool channel: a session is given MoPilot's tools through it (in-process MCP servers over the Host's registry; the app's tools are relayed)
 * @param {{ envFor: (harness: string) => Record<string, string>, hasOrg?: (harness: string) => boolean, orgLease?: (harness: string) => { identity: string, expiresAt: number } | null, onChange?: (fn: (harness: string, change?: string) => void) => unknown } | null} [o.leases] the key the app lent for Claude Code (./credentialLease.mjs): each CLI started gets it in its environment, which Claude Code ranks above this Host's own sign-in
 * @param {ReturnType<typeof import('./orgKeyHelper.mjs').createOrgKeyHelper> | null} [o.orgKey] the key helper a CLI asks for its organization lease through; without it a lease is not used by Claude Code
 * @param {ReturnType<typeof import('./ownCredentials.mjs').createOwnRuns> | null} [o.ownRuns] the chats started to run on the Host's own sign-in (a scheduled run): their CLI never gets a lent key or lease
 * @returns {((ctx: import('./sessions.mjs').FamilyContext) => { claudeTurns: any, claude: any, loginRefused: () => boolean, loginWorks: () => void, goal: (p: { chatId: string, action: string, human?: boolean }) => Promise<unknown>, permit: (p: { requestId: string, optionId?: string, form?: { action: string, content?: object } }) => boolean, prepare: (key: string, cwd?: string, check?: () => void) => Promise<void>, close: () => Promise<unknown>, signedOut: () => void }) & { signedOut: (harness: string) => void, signedIn: (harness: string) => void, catalog: (cwd?: string) => Promise<any> }}
 */
export function createClaudeFamily({ sdk, tools = null, leases = null, orgKey = null, ownRuns = null } = {}) {
  /** The family built for the Host's sessions, once it is: a sign-out tells it. @type {{ signedOut: () => void, loginWorks: () => void, catalog: (cwd?: string) => Promise<any> } | null} */
  let current = null;
  /** @param {import('./sessions.mjs').FamilyContext} ctx */
  const make = (ctx) => {
    /** The CLI a chat runs: the one named by hand, else the `claude` on the Host's PATH, which is the one `status` reports and `login claude` signs in; none: the harness looks in the usual places. */
    const claudeBin = () => ctx.env.MOPILOT_CLAUDE_BIN || which('claude', ctx.env) || undefined;
    // the key is read when each CLI starts: a key lent or taken back reaches the next one, never the command line; a page it opens goes to the Host's opener (./opener.mjs)
    // an organization lease is asked for through the key helper each time (./orgKeyHelper.mjs): a renewed token reaches a running CLI, and the token itself is in no env or argv
    const spawn = (
      /** @type {import('@anthropic-ai/claude-agent-sdk').SpawnOptions} */ o,
      /** @type {(data: string) => void} */ stderr,
      /** @type {string} */ key,
    ) => {
      // a chat on the Host's own sign-in gets nothing the app lent (the lease itself stays for the chats it was lent to)
      // (by the chat the session belongs to: a chat that switched to Claude Code runs a session of its own)
      const own = ownRuns?.has(ctx.controller().chatOf(key)) === true;
      // the CLI is started for the identity whose message goes out now, and its helper can only ever read that identity's token
      const lease = orgKey && !own ? leases?.orgLease?.('claude') : null;
      const identity = lease?.identity;
      const args = identity && orgKey ? withKeyHelper(o.args, orgKey.command) : o.args;
      return spawnClaudeCode(
        {
          ...o,
          args,
          env: {
            ...withOpener(ctx.env, o.env),
            ...(own ? {} : leases?.envFor('claude')),
            ...(identity && orgKey ? orgKey.env(identity, /** @type {{ expiresAt: number }} */ (lease).expiresAt - Date.now()) : {}),
          },
        },
        stderr,
      );
    };
    const claude = createClaudeHarness({ sdk, spawn });
    // without a peer check on this machine there are no tools (`status` says so); the registry and sessions are the Host's own
    if (tools?.available) claude.setTools({ registry: tools.registry, sessions: tools.sessions });
    const bridge = createTurnBridge({
      state: ctx.state,
      emit: ctx.emit,
      controller: ctx.controller,
      answer: (requestId, result) => claude.resolvePermission(requestId, result),
    });
    // a turn starts and ends when the shared controller says so; the stream hears it from the store's own changes
    const published = ctx.state.publish;
    ctx.state.publish = (change) => {
      published.call(ctx.state, change);
      try {
        bridge.patched(change);
      } catch (error) {
        noteIgnored("report a Claude Code chat's turn to the stream", error);
      }
    };
    /** The chat's goal in the store; one Claude holds is also kept in the chat's file (electron/session/goalHeld.cjs). */
    const writeGoal = (/** @type {string} */ chatId, /** @type {any} */ goal) => {
      const changed = ctx.state.patch(chatId, { goal });
      try {
        if (traitsOf(ctx.controller().ref(chatId).kind).holdsGoal)
          ctx.chats.patchMeta(chatId, { goalHeld: heldOf(ctx.state.get(chatId).goal) });
      } catch (error) {
        // the chat may not be loaded, or its file not writable: the held goal is written again on its next change
        noteIgnored("keep a chat's held goal", error);
      }
      return changed;
    };
    const settings = adapterSettings({ chats: ctx.chats });
    const claudeTurns = new ClaudeAdapter({
      api: claude.turnApi,
      probeInfo: (/** @type {string} */ account) => claude.probeInfo(account),
      state: ctx.state,
      // there is no window to push settings: a chat runs on its own saved ones, then these
      prefs: () => ({ permission: 'default', claudeSelection: null, claudeBin: claudeBin() }),
      send: (
        /** @type {string} */ chatId,
        /** @type {string} */ key,
        /** @type {any} */ opts,
        /** @type {any} */ input,
        /** @type {any} */ priority,
        /** @type {any} */ meta,
      ) => ctx.controller().claudeSend(chatId, key, opts, input, priority, meta),
      enqueue: (/** @type {string} */ chatId, /** @type {any} */ item) => ctx.controller().send(chatId, item, null),
      interrupted: (/** @type {string} */ key) => ctx.controller().onClaudeControl(key, 'interrupt'),
      chatOf: (/** @type {string} */ key) => ctx.controller().chatOf(key),
      ref: (/** @type {string} */ chatId) => ctx.controller().ref(chatId),
      emit: bridge.adapterEvent,
      setGoal: writeGoal,
      // the Host has no notifier: a goal's or a limit's notice reaches the person through the chat itself
      notifyGoal: () => undefined,
      notifyLimit: () => undefined,
      ...settings,
      // the mode a turn runs under never exceeds the owner's ceiling, whenever the chat's mode was set and whatever the ceiling was then
      savedSettings: (/** @type {string} */ chatId) => clampToCeiling(settings.savedSettings(chatId), ctx.ceiling?.()),
    });
    const models = createModelCache({
      ask: async () => {
        const bin = await claude.findBinary(claudeBin());
        return bin ? pickModels((await claude.probe(bin))?.models) : [];
      },
      report: (error) => noteIgnored('ask Claude Code for its models', error),
    });
    claude.setChatOf((/** @type {string} */ key) => ctx.controller()?.chatOf(key));
    /** Every chat's CLI ends the way an idle one retires; the next message starts one with the login or key there is now. */
    const signedOut = () => {
      for (const key of [...claudeTurns.sessions.keys()]) void claude.retire(key, CLOSE_GRACE_MS);
    };
    /** This machine's Claude Code logins, from the harness's account list. */
    const logins = () => {
      const view = claude.turnApi.accounts?.();
      // the CLI's own login is read once, lazily, by the harness (a window asks it to; a Host has none): a list that is asked for before then asks for the read, and says it on its next answer
      if (view?.accounts.some((/** @type {{ id: string, checked?: boolean }} */ a) => a.id === 'default' && a.checked === false))
        void readLogin().catch(() => undefined);
      return claudeLoginsOf(view);
    };
    let reading = 0;
    /** Reads the CLI's own login (`claude auth status`) if nothing has. */
    const readLogin = async (refresh = false) => {
      reading++;
      try {
        await claude.turnApi.readCliLogin?.(claudeBin(), refresh);
      } finally {
        reading--;
      }
    };
    /** Whether what `status` reports of Claude Code is still being found: the CLI's own login is being read, or its models asked for. */
    const settling = () => reading > 0 || models.asking();
    // a pin is kept in the chat's own file, where the adapter reads the login a chat runs on (adapterSettings savedAccount), so it holds across restarts
    const pin = (/** @type {string} */ chatId, /** @type {string | null} */ login) =>
      void ctx.chats.patchMeta(chatId, { account: login ? { id: login, pinned: true } : null });
    ownRuns?.chatCredentials?.bindLogins('claude', { list: logins, pin, refresh: readLogin });
    claude.register(NO_IPC, () => undefined, {
      onEvent: (/** @type {any} */ event) => {
        // the stream hears a message before the controller ends the turn it closes, so the turn's last updates come before its end
        bridge.harnessEvent(event);
        ctx.controller().onClaudeEvent(event);
        claudeTurns.observe(event);
      },
    });
    // the CLI entered Plan on its own (EnterPlanMode) or left it (an approved ExitPlanMode returns to the mode before): the chat's saved mode and the lane say what it is now, so no client reads a mode the CLI has left
    /** @type {any} */ (claudeTurns).modeChanged = (
      /** @type {string} */ chatId,
      /** @type {string | undefined} */ was,
      /** @type {string} */ now,
    ) => {
      if (!chatId || !ctx.chats.records.has(chatId) || (was === 'plan') === (now === 'plan')) return;
      const config = /** @type {Record<string, any>} */ ({ ...ctx.chats.records.get(chatId)?.meta?.config });
      // Plan the client already set (or the first message asked for) keeps the base it saved: the CLI's first report of it names no mode before
      if (now === 'plan' && config.permission === 'plan') return;
      const base = was && was !== 'plan' ? was : (config.permission ?? 'default');
      ctx.chats.patchMeta(chatId, { config: { ...config, permission: now, ...(now === 'plan' ? { planBasePermission: base } : {}) } });
      ctx.emit({ kind: 'state', chatId, patch: { permission: now, plan: now === 'plan' } });
    };
    const api = {
      claudeTurns,
      claude,
      /** The CLI this Host runs, for a handoff note written by Claude Code (a switch away from it). */
      bin: claudeBin,
      permit: bridge.permit,
      /** The models the CLI offers, as kept so far (see ./claudeModels.mjs). */
      models: models.get,
      /** Whether the login or the models are still being found (see `settling` above). */
      settling,
      /** Claude Code's commands and skills for a folder (electron/harness/claude/catalog.cjs): what a session there reported, else read from the CLI. @param {string} [cwd] */
      catalog: (cwd) => claude.catalog(claudeBin(), cwd ?? ''),
      logins,
      /**
       * The permission mode the chat's turns run under from now on: kept in the chat's file, and applied to its live CLI at once.
       * @param {string} chatId
       * @param {string} value
       */
      async setPermission(chatId, value) {
        if (!PERMISSIONS.has(value)) throw new SchemaError('That permission mode is not one this host knows.');
        const config = /** @type {Record<string, any>} */ ({ ...ctx.chats.records.get(chatId)?.meta?.config });
        const base = config.permission && config.permission !== 'plan' ? config.permission : (config.planBasePermission ?? 'default');
        ctx.chats.patchMeta(chatId, {
          config: { ...config, permission: value, ...(value === 'plan' ? { planBasePermission: base } : {}) },
        });
        // (the adapter's own signature types a chat id as null)
        await claudeTurns.permissionChanged(/** @type {any} */ (chatId));
      },
      noteUser: bridge.noteUser,
      /**
       * What the goal bar does to the chat's goal (`chat.goal`), run by the app's own adapter as on this Mac: the goal now. A Codex goal's edit and budget have no form on Claude Code, whose goal is the CLI's own.
       * @param {{ chatId: string, action: string, human?: boolean }} p
       */
      async goal({ chatId, action, human = false }) {
        if (action === 'edit' || action === 'budget') throw new HostRefusal('unsupported', unsupportedGoalWords('Claude Code', action));
        try {
          await claudeTurns.goalAction(chatId, action, human);
        } catch (error) {
          throw new HostRefusal('unsupported', error instanceof Error ? error.message : String(error));
        }
        return ctx.state.get(chatId).goal ?? null;
      },
      /**
       * Readies a chat before its message is queued. A chat this Host has no session for (new, or the Host restarted) starts a session in `cwd` when no transcript exists and resumes it when one does.
       * A session still marked new whose transcript exists is a resume: its first CLI died before the adapter heard the send was accepted, and a second start under the same id would be refused.
       * @param {string} key
       * @param {string} [cwd]
       * @param {() => void} [check]
       */
      async prepare(key, cwd, check = () => undefined) {
        check();
        // the helper's socket is open before a CLI that asks it starts
        if (orgKey && leases?.hasOrg?.('claude')) await orgKey.listen();
        check();
        if (claudeTurns.sessions.get(key)?.fresh === false) return;
        const resume = await claude.turnApi.hasTranscript(key.replace(/^claude:/, ''));
        check();
        // the check and the change are one step: a send that got here first has registered, and its turn may have started
        const known = claudeTurns.sessions.get(key);
        if (!known) claudeTurns.registerSession(key, { cwd, resume });
        else if (known.fresh && resume) claudeTurns.sessions.set(key, { ...known, fresh: false, forkFrom: null });
      },
      /** Running turns are interrupted and every CLI is asked to quit. */
      close: () => claude.closeAll(CLOSE_GRACE_MS),
      signedOut,
      /** Whether a turn found this Host's Claude Code login unusable (the provider refused it for its organization, or it lapsed) and it has not worked since: the status says so before the next send. */
      loginRefused: () => [...claudeTurns.marks.snapshot().values()].some((/** @type {{ expired?: boolean }} */ m) => m.expired === true),
      /** The CLI installed a new login. Clear the failure marks and re-read the CLI profile before reporting it again. */
      loginWorks() {
        for (const account of [...claudeTurns.marks.snapshot().keys()]) claudeTurns.marks.works(account);
        void readLogin(true).catch((error) => noteIgnored('refresh the Claude Code login after sign-in', error));
      },
    };
    current = api;
    return api;
  };
  /** Claude Code was signed out on this Host, or its lent key changed: the CLIs started with the old login let it go (nothing to do before the sessions have built the family, or for another harness). @param {string} harness */
  make.signedOut = (harness) => {
    if (harness === 'claude') current?.signedOut();
  };
  /** Claude Code's commands and skills for a folder; rejects before the Host's sessions have built the family. @param {string} [cwd] */
  make.catalog = (cwd) => (current ? current.catalog(cwd) : Promise.reject(new Error('Claude Code has not started.')));
  /** Claude Code was signed in on this Host: a failed turn's mark on the old login is over. @param {string} harness */
  make.signedIn = (harness) => {
    if (harness === 'claude') current?.loginWorks();
  };
  // a renewed organization token reaches the running CLIs through the key helper, and a CLI keeps the identity it was started for: only a new credential retires them
  leases?.onChange?.((harness, change) => change === 'changed' && make.signedOut(harness));
  return make;
}
