// The welcome page, shown while no harness can run a chat (WP3-11): one list of every supported coding agent, each
// connected right in its row (its subscription, an API key or MoPilot credits; the official install commands first
// when it is missing), as many as the user likes, then Continue. New chats start with the first one connected here.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { useEffect, useRef, useState, type ComponentType } from 'react';
import { useStore, get as getState, setPrefs } from '../../store/core';
import { chooseDefaultHarness } from '../../store/connection';
import { cancelChatgptLogin, login, loginWithApiKey, setCodexMode } from '../../store/accounts';
import { codexUsable, claudeUsable, savedDefaultHarness } from '../../store/chats';
import { navigate } from '../../store/panes';
import { applyClaudeKey } from '../../session/harness/billing';
import { recheckClaude } from '../../session/harness/claude';
import { RowContext, useRecheck, useRowSays, useRun } from './welcomeRow';
import { harnessInfo } from '../../harness/registry';
import { recheckHarness, refreshInstallTools } from '../../session/harness/harnessRuns';
import type { HarnessKind } from '../../harness/adapter';
import type { Presence } from '../../session/harness/installable';
import { InstallLines } from '../harness/InstallLines';
import { RECHECK_AFTER_MS, useAfter } from '../harness/installWatch';
import { UpdateFlow, UpdatePill, useHarnessUpdate } from '../harness/HarnessUpdate';
import { useHarnessStatus } from '../../session/harness/select';
import { HARNESS_LABEL } from '../../harness/types';
import { native } from '../../lib/native';
import { useEffectOn } from '../../lib/effects';
import { openLink, openMoPilotPage } from '../../session/open';
import { WebLink } from '../ui/WebLink';
import { useMoPilot } from '../../lib/mopilot';
import { hasMoPilotService } from '../../lib/mopilotService';
import {
  FIRST_CLASS,
  basicPresence,
  connectMethods,
  connectedKinds,
  firstPresence,
  joinedSince,
  rankAgents,
  setupNeed,
  startWith,
  type FirstClass,
  type Pay,
  type Presence as WelcomePresence,
} from '../../lib/welcome';
import { HarnessIcon } from '../harnessPicker/HarnessPicker';
import { TermView } from '../panels/TerminalPanel';
import { Spinner } from '../ui/icons';
import { BasicRow, Connected, MoreToggle, RowAction, agentLabel, basicRows } from './WelcomeAgents';
import type { BasicHarness } from '../../harness/types';
import { closeWelcome, dismissWelcome } from './welcomeState';
import { WelcomeChrome } from './WelcomeChrome';
import { WelcomeConductor } from './WelcomeConductor';

export { useWelcome, openWelcome, closeWelcome, dismissWelcome } from './welcomeState';

/** The CLI location is on the harness's own Settings page. */
const setLocation = (h: FirstClass) => {
  dismissWelcome();
  navigate({ name: 'settings', section: h });
};

// what differs per harness, looked up by id
const USABLE: Record<FirstClass, (s: ReturnType<typeof getState>) => boolean> = { claude: claudeUsable, codex: codexUsable };
const USE_CREDITS: Record<FirstClass, () => Promise<unknown>> = {
  claude: () => applyClaudeKey(() => native.claude.setAuthMode('mopilot')),
  codex: () => setCodexMode('mopilot'),
};
const USE_KEY: Record<FirstClass, (key: string) => Promise<unknown>> = {
  claude: (k) => applyClaudeKey(() => native.claude.setApiKey(k, '')),
  codex: loginWithApiKey,
};
const KEY_HINT: Record<FirstClass, string> = { claude: 'sk-ant-…', codex: 'sk-…' };
/** How long a browser sign-in waits before it offers to open the page again. */
export const SIGNIN_SLOW_MS = 120_000;
/** How long a connected row shows Connected before the page moves on by itself. */
export const ADVANCE_MS = 1200;

export function Welcome() {
  const status = { claude: useHarnessStatus('claude'), codex: useHarnessStatus('codex') };
  const usable = { claude: useStore((s) => USABLE.claude(s)), codex: useStore((s) => USABLE.codex(s)) };
  const basics = useStore((s) => s.basicHarnesses);
  const connected = connectedKinds(usable, basics);
  // what was connected when the page opened, and what has been connected on it since, in order (appending is idempotent)
  const [atOpen] = useState(connected);
  const joined = useRef<HarnessKind[]>([]);
  joined.current = joinedSince(joined.current, connected, atOpen);
  // the default the user already has (Settings may change it while the page is open) stands unless one is connected here
  const current = useStore((s) => savedDefaultHarness(s));
  const start = startWith(connected, joined.current, current);
  const [nudge, setNudge] = useState(false);
  const [more, setMore] = useState(false);
  const finish = () => {
    if (!start) return setNudge(true);
    chooseDefaultHarness(start);
    // a new install is welcomed until this (App.tsx)
    setPrefs({ welcomeDone: true });
    closeWelcome();
  };
  // opened with nothing connected: the first agent connected here moves the page on, once it has said Connected
  const advance = useAfter(ADVANCE_MS, atOpen.length === 0 && joined.current.length > 0);
  // one that dropped again before then moves nothing (no nudge the user didn't ask for)
  useEffectOn([advance], () => {
    if (advance && start) finish();
  });
  // every agent, ranked by what is on this Mac; rows are keyed by kind in one list, so a row that moves keeps its state
  const ranked = rankAgents<Agent>([
    ...FIRST_CLASS.map(
      (h): Agent => ({ kind: h, id: h, label: HARNESS_LABEL[h], tier: 'first', presence: firstPresence(status[h].state, usable[h]) }),
    ),
    ...basicRows(basics).map((r): Agent => ({ ...r, id: r.b.id, label: r.b.label, tier: 'basic', presence: basicPresence(r.b.state) })),
  ]);
  const row = (a: Agent) =>
    a.tier === 'basic' ? <BasicRow key={a.kind} b={a.b} vendor={a.vendor} /> : <FirstClassRow key={a.kind} h={a.kind} />;
  return (
    <div className="login welcome">
      <h1 className="login-title">Connect your coding agents</h1>
      <p className="login-hint welcome-tagline">Use one or several. Any chat can switch between them.</p>
      <div className="welcome-list" role="list" aria-label="Coding agents">
        {ranked.shown.map(row)}
        {more && ranked.more.map(row)}
        {ranked.more.length > 0 && (
          <MoreToggle
            ids={ranked.more.map((a) => a.id)}
            names={ranked.more.map((a) => a.label)}
            open={more}
            onToggle={() => setMore(!more)}
          />
        )}
      </div>
      <WelcomeChrome />
      <WelcomeConductor />
      {start && <p className="login-hint welcome-start">New chats start with {agentLabel(start, basics)}. You can change it anytime.</p>}
      {!start && nudge && <p className="login-hint welcome-nudge">Connect an agent to continue.</p>}
      <div className="login-actions welcome-nav">
        <button className="btn primary" onClick={finish}>
          Continue
        </button>
      </div>
    </div>
  );
}

/** One agent on the page: a first-class harness, or a basic one with main's status for it. */
type Agent = { id: string; label: string; presence: WelcomePresence } & (
  | { tier: 'first'; kind: FirstClass }
  | { tier: 'basic'; kind: HarnessKind; b: BasicHarness; vendor: string }
);

/** A first-class harness: Connected, Install (its official commands), or Connect (its ways to pay, then that one's form). */
function FirstClassRow({ h }: { h: FirstClass }) {
  const st = useHarnessStatus(h);
  const usable = useStore((s) => USABLE[h](s));
  const need = setupNeed(st.state, usable, st.rejected);
  const [open, setOpen] = useState(false);
  // the subscription is what most people already have: it is offered alone until the user asks for another way
  const [pay, setPay] = useState<Pay>('subscription');
  const [otherPay, setOtherPay] = useState(false);
  const [said, row] = useRowSays(need);
  const info = harnessInfo(h)!;
  const methods = connectMethods(
    { subscription: info.subscription!, subscriptionPlans: info.subscriptionPlans!, vendor: info.vendor },
    hasMoPilotService(),
  );
  const update = useHarnessUpdate(h, info.label);
  // an installed version that can't be used is updated right here; Settings is for anything else
  const updatable = need === 'broken' && !!update && (update.v.updatable || update.v.state !== 'idle');
  return (
    <RowContext.Provider value={row}>
      <div className="welcome-row" role="listitem">
        <div className="welcome-row-head">
          <HarnessIcon h={h} size={18} />
          <span className="welcome-row-label">{info.label}</span>
          {need === 'ready' && <Connected />}
          {need === 'checking' && (
            <span className="welcome-row-state">
              <Spinner size={14} /> Checking…
            </span>
          )}
          {need === 'install' && <RowAction label="Install" open={open} onToggle={() => setOpen(!open)} />}
          {need === 'credential' && <RowAction label="Connect" open={open} onToggle={() => setOpen(!open)} />}
          {updatable && <UpdatePill u={update!} />}
          {need === 'broken' && !updatable && (
            <button
              type="button"
              className="welcome-row-action"
              onClick={() => navigate({ name: 'settings', section: h, tab: 'advanced' })}
            >
              Settings
            </button>
          )}
        </div>
        {need === 'broken' && st.error && <p className="welcome-row-error">{st.error}</p>}
        {updatable && <UpdateFlow u={update!} />}
        {open && need === 'install' && (
          <div className="welcome-row-body">
            <Install h={h} />
          </div>
        )}
        {open && need === 'credential' && (
          <div className="welcome-row-body">
            {otherPay && (
              <div className="welcome-methods" role="group" aria-label={`Connect ${info.label} with`}>
                {methods.map((m) => (
                  <button
                    key={m.pay}
                    type="button"
                    className={`welcome-method ${pay === m.pay ? 'on' : ''}`}
                    aria-pressed={pay === m.pay}
                    onClick={() => {
                      setPay(m.pay);
                      row.say(null);
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            )}
            <p className="login-hint welcome-row-note">{methods.find((m) => m.pay === pay)!.hint}</p>
            <Credential key={pay} h={h} pay={pay} />
            {!otherPay && (
              <button type="button" className="text-link welcome-other-pay" onClick={() => setOtherPay(true)}>
                Use an API key or credits
              </button>
            )}
          </div>
        )}
        {said?.error && (
          <p className="welcome-row-error" role="alert">
            {said.text}
          </p>
        )}
        {said && !said.error && <p className="login-hint welcome-row-said">{said.text}</p>}
      </div>
    </RowContext.Provider>
  );
}

/** The recommended official command first, to run in the terminal below (a run main owns: leaving this page doesn't
 * stop it) or to copy; the harness is looked for again once one ends, and in the background while the row is open,
 * and its row moves on to Connect when it is found. */
function Install({ h }: { h: FirstClass }) {
  const info = harnessInfo(h)!;
  const item: Presence = { kind: h, label: info.label, vendor: info.vendor, tier: 'first', state: 'missing', version: null };
  const recheck = useRecheck((say) => recheckHarness(h, say), 'Not found yet.');
  // it is looked for in the background meanwhile (InstallLines): Re-check is for one that still isn't seen
  const late = useAfter(RECHECK_AFTER_MS, true);
  useEffect(() => {
    refreshInstallTools();
  }, []);
  return (
    <>
      <InstallLines item={item} onSetLocation={() => setLocation(h)} />
      <div className="welcome-methods">
        <button type="button" className="welcome-method" onClick={() => openLink(info.install.docs)}>
          I'll do it myself
        </button>
        {late && (
          <button type="button" className="welcome-method" onClick={recheck}>
            Re-check
          </button>
        )}
      </div>
    </>
  );
}

function Credential({ h, pay }: { h: FirstClass; pay: Pay }) {
  const mp = useMoPilot();
  const run = useRun();
  const [key, setKey] = useState('');
  // the key is checked before the row turns Connected: say so meanwhile
  const [saving, setSaving] = useState(false);

  // MoPilot credits: sign in to MoPilot, then point the harness at them
  useEffectOn([pay, mp.signedIn, h], () => {
    if (pay === 'mopilot' && mp.signedIn) run(USE_CREDITS[h]);
  });

  if (pay === 'mopilot')
    return (
      <div className="login-actions">
        {mp.signingIn ? (
          <>
            <span className="login-hint">Finish signing in in your browser…</span>
            <button className="btn ghost" onClick={() => run(() => native.mopilot.cancelSignIn())}>
              Cancel
            </button>
          </>
        ) : mp.signedIn ? (
          <span className="login-hint">
            <Spinner size={12} /> Connecting {HARNESS_LABEL[h]} to your credits…
          </span>
        ) : (
          <button
            className="btn primary"
            onClick={() =>
              run(async () => {
                const r = await native.mopilot.signIn();
                // said under the row, as every other step's failure; a sign-in the user closed says nothing
                if (!r.ok && r.error) throw new Error(r.error);
              })
            }
          >
            Sign in to MoPilot
          </button>
        )}
        {mp.signedIn && (
          <button className="btn ghost" onClick={() => openMoPilotPage('/credits')}>
            Buy credits
          </button>
        )}
      </div>
    );

  if (pay === 'apikey')
    return (
      <div className="login-actions">
        <input
          className="text-input"
          type="password"
          aria-label="API key"
          placeholder={KEY_HINT[h]}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
        />
        <button
          className="btn primary"
          disabled={!key.trim() || saving}
          onClick={() => {
            setSaving(true);
            run(() => USE_KEY[h](key.trim()).finally(() => setSaving(false)));
          }}
        >
          {saving ? <Spinner size={14} /> : null} {saving ? 'Checking…' : 'Save key'}
        </button>
      </div>
    );

  const Login = SUBSCRIPTION_LOGIN[h];
  return <Login />;
}

/** ChatGPT sign-in in the browser: Cancel frees the button (a closed tab never answers), and a long wait offers the page again. */
function CodexLogin() {
  const pending = useStore((s) => s.loginPending);
  const run = useRun();
  const slow = useAfter(SIGNIN_SLOW_MS, !!pending);
  return (
    <div className="login-actions">
      <button className="btn primary" disabled={!!pending} onClick={() => run(login)}>
        {pending ? <Spinner size={14} /> : null} Sign in with ChatGPT
      </button>
      {pending && (
        <p className="login-hint">
          {slow ? 'Still waiting?' : 'Finish signing in in your browser.'}
          {pending.authUrl && (
            <>
              {' '}
              <WebLink href={pending.authUrl}>Open again</WebLink>
              {' · '}
            </>
          )}
          {!pending.authUrl && ' '}
          <button type="button" className="text-link" onClick={() => run(cancelChatgptLogin)}>
            Cancel
          </button>
        </p>
      )}
    </div>
  );
}

/** Claude subscription: the CLI's own login, in a terminal right here. */
function ClaudeLogin() {
  const claude = useHarnessStatus('claude');
  const [term, setTerm] = useState<string | null>(null);
  const run = useRun();
  const recheck = useRecheck((say) => recheckClaude(undefined, say), 'Not signed in yet.');
  // a sign-in in the terminal below is checked when it ends: Re-check is for one done elsewhere
  const late = useAfter(RECHECK_AFTER_MS, !term);
  return (
    <>
      {!term && (
        <div className="login-actions">
          <button className="btn primary" disabled={!claude.bin} onClick={() => setTerm(`login-claude-${crypto.randomUUID()}`)}>
            Sign in
          </button>
          {late && (
            <button className="btn ghost" onClick={recheck}>
              Re-check
            </button>
          )}
        </div>
      )}
      {!term && !claude.bin && (
        <p className="login-hint welcome-row-note">
          {HARNESS_LABEL.claude} isn't found on this Mac.{' '}
          <button type="button" className="welcome-method" onClick={() => setLocation('claude')}>
            Set its location
          </button>
        </p>
      )}
      {term && claude.bin && <p className="login-hint welcome-row-note">Press Enter, then approve in your browser.</p>}
      {term && claude.bin && (
        <div className="basic-login-term">
          <TermView
            tab={{ id: term, cwd: getState().home, title: 'claude auth login', command: [claude.bin, 'auth', 'login'], signIn: true }}
            visible
            onExit={() => {
              setTerm(null);
              run(() => recheckClaude());
            }}
          />
        </div>
      )}
    </>
  );
}

const SUBSCRIPTION_LOGIN: Record<FirstClass, ComponentType> = { claude: ClaudeLogin, codex: CodexLogin };
