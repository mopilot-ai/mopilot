// Claude Code's harness parts for the shared harness pages: its icon, billing, status rows, signed-out banner and Advanced section.
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)

import { lazy, useEffect, useRef, useState } from 'react';
import { missingHint } from '../../../../shared/host/agentReadiness.mjs';
import { get as getState, setPrefs, useStore } from '../../../store/core';
import { navigate } from '../../../store/panes';
import { openLink } from '../../../session/open';
import { native } from '../../../lib/native';
import type { ClaudeArtifactsInfo } from '../../../lib/native/claude';
import { ignoring } from '../../../lib/ignored';
import { useMoPilot } from '../../../lib/mopilot';
import { hasMoPilotService } from '../../../lib/mopilotService';
import { useCreditsView } from '../../../harness/useCreditsView';
import { useRouting } from '../../../lib/routing';
import {
  detectClaude,
  pinClaudeChat,
  recheckClaude,
  refreshClaudeAccounts,
  refreshClaudeUsage,
  reloginClaudeAccount,
  setClaudeAutoSwitch,
  switchClaudeAccount,
} from '../../../session/harness/claude';
import { applyClaudeKey, useClaudeKey, payWithMoPilotCredits } from '../../../session/harness/billing';
import { useComposerFamily, useHarnessStatus } from '../../../session/harness/select';
import { claudeSignedOut, signInAccountFor } from '../../../harness/accounts';
import { AlertTriangle } from '../../ui/icons';
import { endpointLabel, type BillingProps } from '../../pages/settings/BillingRow';
import { Group, Row, Toggle } from '../../pages/Settings';
import type { HarnessParts } from '../parts';
import { ClaudeCustomize } from './Customize';
import { ClaudeMark } from './mark';
// the login terminal brings xterm in: loaded only when a page shows it
const ClaudeLoginTerm = lazy(() => import('../../accounts/claudeLoginTerm').then((m) => ({ default: m.ClaudeLoginTerm })));
import { HarnessVersionRow } from '../HarnessVersionRow';
import { focusedChat } from '../../../store/split';

const signIn = (chatId?: string | null) => {
  const s = getState();
  return reloginClaudeAccount(chatId ? signInAccountFor(s.claudeChats, s.claudeAccounts, chatId) : s.claudeAccounts.active);
};

/** What Claude Code pays with, for its Pay with row and the Use an API key action. */
function useBilling(): BillingProps {
  const claude = useHarnessStatus('claude');
  const ck = useClaudeKey();
  const mp = useMoPilot();
  const credits = useCreditsView().line;
  const routing = useRouting(!!ck?.routed?.available);
  const routed = ck?.mode === 'routed' ? ck.routed : null;
  return {
    keys: { placeholder: 'API key · sk-ant-…', urlPlaceholder: 'https://openrouter.ai/api', official: 'Anthropic' },
    mode: ck?.mode ?? 'subscription',
    hasKey: !!ck?.set,
    hasSubscription: claude.state !== 'signin',
    // a build without the MoPilot service offers no credits
    credits: hasMoPilotService() ? { signedIn: mp.signedIn } : undefined,
    // only where this app runs the model router; chats on your other machines keep their own sign-in
    routed: ck?.routed?.available
      ? {
          loaded: routing.loaded,
          configs: routing.configs.map((c) => ({ id: c.id, name: c.name })),
          configId: ck.routed.configId,
          onChoose: (id) => applyClaudeKey(() => native.claude.setAuthMode('routed', id)),
        }
      : undefined,
    desc: routed
      ? routed.name
        ? `${routed.name} · your own provider, billed per token · chats on your other machines keep their own sign-in`
        : 'The model config chosen here was removed. Choose another.'
      : ck?.mode === 'mopilot'
        ? credits
        : ck?.mode === 'apiKey'
          ? `${endpointLabel(ck.baseUrl, 'Anthropic')} API key ending ${ck.hint} · billed per token`
          : claude.state === 'signin'
            ? 'Not signed in with Claude'
            : `Claude subscription${claude.plan ? ` · ${claude.plan}` : ''}`,
    onSwitch: (m) => applyClaudeKey(() => native.claude.setAuthMode(m)),
    onAddKey: (k, u) => applyClaudeKey(() => native.claude.setApiKey(k, u)),
    onRemoveKey: () => applyClaudeKey(() => native.claude.clearApiKey()),
    onSignIn: () => signIn(),
  };
}

/**
 * Whether Claude Code may publish to claude.ai (its Artifact tool): off by default, since the tool adds ~12k tokens to
 * every request. Main restarts idle sessions when it
 * changes; the newest answer wins over an older one still arriving.
 */
function ArtifactsRow() {
  const [info, setInfo] = useState<ClaudeArtifactsInfo | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = seq.current;
    native.claude.artifacts().then((v) => void (n === seq.current && setInfo(v)), ignoring('read the Claude Code artifacts switch'));
  }, []);
  const set = (on: boolean) => {
    const n = ++seq.current;
    // the toggle is enabled only once the switch is read and not killed
    setInfo({ on, killed: false });
    native.claude.setArtifacts(on).then((v) => void (n === seq.current && setInfo(v)), ignoring('save the Claude Code artifacts switch'));
  };
  return (
    <Row
      title="Artifacts and designs"
      desc={`Lets Claude Code publish pages, slides and designs to claude.ai. Adds about 12k tokens to every request. Needs a claude.ai Pro, Max, Team or Enterprise login.${info?.killed ? ' Turned off for now.' : ''}`}
    >
      <Toggle on={!!info?.on && !info.killed} disabled={!info || info.killed} onChange={set} />
    </Row>
  );
}

/**
 * Whether every new Claude Code session is linked to Remote Control (claude.ai/code and the Claude app) when it starts: off
 * by default. The newest answer wins over an older one still arriving.
 */
function RemoteControlRow() {
  const [on, setOn] = useState<boolean | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = seq.current;
    native.claude.remoteControlDefault().then((v) => void (n === seq.current && setOn(v)), ignoring('read the Remote Control setting'));
  }, []);
  const set = (v: boolean) => {
    const n = ++seq.current;
    setOn(v);
    native.claude.setRemoteControlDefault(v).then((r) => void (n === seq.current && setOn(r)), ignoring('save the Remote Control setting'));
  };
  return (
    <Row
      title="Connect new sessions to Remote Control"
      desc="Follow new Claude Code sessions from claude.ai or the Claude app. Needs a claude.ai subscription login."
    >
      <Toggle on={!!on} disabled={on === null} onChange={set} />
    </Row>
  );
}

/** The rows only Claude Code has: which CLI install runs (and where it is), whether a cloud provider bills it, and its Artifact tool. */
export function ClaudeRows({ status: st }: { status: import('../../../harness/types').HarnessStatus }) {
  const claudeBin = useStore((s) => s.prefs.claudeBin);
  const ck = useClaudeKey();
  return (
    <>
      <HarnessVersionRow
        kind="claude"
        label="Claude Code"
        name="claude"
        bin={st.bin ?? null}
        version={st.version ?? null}
        installs={st.candidates}
        manual={claudeBin}
        where={st}
        onPick={pickClaudeBin}
      />
      <Row title="Use cloud provider" desc="Use shell credentials for Bedrock, Vertex, or Foundry. Billed to your cloud account.">
        <Toggle on={!!ck?.cloudEnv} onChange={(v) => applyClaudeKey(() => native.claude.setCloudEnv(v))} />
      </Row>
      <ArtifactsRow />
      <RemoteControlRow />
      {st.state === 'missing' && (
        <Row title="Install Claude Code">
          <button className="btn-pill" onClick={() => openLink('https://code.claude.com/docs/en/setup')}>
            Install guide
          </button>
        </Row>
      )}
    </>
  );
}

/** Its login lapsed: a Claude chat's own login, else outside a chat the one new chats use, once signed in before (D-43). */
function SignedOutBanner() {
  const st = useStore((s) => s.claude.status);
  const pool = useStore((s) => s.claudeAccounts);
  const chats = useStore((s) => s.claudeChats);
  const chatId = useStore(focusedChat);
  // the chat's harness, or outside a chat the one new chats start on: a Codex or basic harness's chat runs on no
  // Claude login, so Claude Code's lapsed one is not its banner (as Codex's is not a Claude chat's)
  const family = useComposerFamily(chatId);
  const out = family === 'claude' ? claudeSignedOut(st, pool, chats, chatId) : null;
  if (!out) return null;
  const recheck = () => {
    void refreshClaudeAccounts();
    return recheckClaude();
  };
  const use = (id: string) => (chatId ? pinClaudeChat(chatId, id) : switchClaudeAccount(id));
  return (
    <div className="acct-banner" role="alert">
      <AlertTriangle size={14} />
      <span className="acct-banner-text">
        Your <b>Claude Code</b> sign-in
        {out.email ? (
          <>
            {' '}
            for <b>{out.email}</b>
          </>
        ) : null}{' '}
        has expired.
      </span>
      <span className="acct-banner-actions">
        {out.others.map((o) => (
          <button key={o.id} className="btn-pill" title={o.email ?? o.id} onClick={() => use(o.id)}>
            {out.others.length > 1 ? `Use ${o.email ?? o.id}` : 'Use another account'}
          </button>
        ))}
        <button className="btn-pill" onClick={recheck}>
          Re-check
        </button>
        <button className="btn primary sm" onClick={() => reloginClaudeAccount(out.login)}>
          Sign in
        </button>
      </span>
    </div>
  );
}

function pickClaudeBin(v: string | null) {
  setPrefs({ claudeBin: v });
  // detection reads the path from the store, which holds it already. Cannot reject: a failed detection is shown in
  // the status
  void detectClaude(true);
}

/**
 * Claude Code's Advanced section: which install runs (its version row also chooses another path) and a cloud
 * provider. Re-check is in the page's header.
 */
export function ClaudeAdvanced() {
  const st = useHarnessStatus('claude');
  return (
    <Group title="How Claude Code runs">
      <ClaudeRows status={st} />
    </Group>
  );
}

export const claudeParts: HarnessParts = {
  refreshUsage: refreshClaudeUsage,
  Customize: ClaudeCustomize,
  addsAccountDirectly: true,
  Banner: SignedOutBanner,
  Icon: ClaudeMark,
  signIn,
  signInLabel: 'Sign in',
  SignedOutActions: () => (
    <>
      <button className="hp-mini" onClick={() => navigate({ name: 'settings', section: 'accounts' })}>
        Use an API key
      </button>
      {hasMoPilotService() && (
        <button
          className="hp-mini"
          title="Bill Claude Code to your MoPilot credits; signs in to MoPilot first when needed"
          onClick={() => payWithMoPilotCredits('claude')}
        >
          Use MoPilot credits
        </button>
      )}
      <button className="hp-mini" onClick={() => recheckClaude()}>
        Re-check
      </button>
    </>
  ),
  fastDesc: 'Faster output, billed to extra usage',
  missingHint: missingHint('Claude Code', { settings: 'Settings → Claude Code' }),
  fastTip: 'Fast mode: billed to extra usage, not your plan limits',
  usageHint: 'Usage shows after your first chat',
  LoginTerm: ClaudeLoginTerm,
  CardAction: () => (
    <button className="btn-pill" onClick={() => recheckClaude()}>
      Re-check
    </button>
  ),
  useBilling,
  useAutoSwitch: () => [useStore((s) => s.claudeAccounts.autoSwitch), setClaudeAutoSwitch],
  // what ClaudeRows gives its Version row
  useBinary: (st) => ({ bin: st.bin ?? null, installs: st.candidates, manual: useStore((s) => s.prefs.claudeBin) }),
};
