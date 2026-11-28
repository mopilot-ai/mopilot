// Codex in the pickers and Settings pages (see ../parts.tsx).
// @plain-copy: user text here names no ACP, CLI, endpoint, Basic or billing type (tests/userCopyJargon.invariant.test.ts)
import { missingHint } from '../../../../shared/host/agentReadiness.mjs';
import { useEffect, useState } from 'react';
import {
  addCodexApiKey,
  login,
  refreshAccountsUsage,
  removeAccount,
  setAccountPool,
  setAutoSwitch,
  setCodexMode,
} from '../../../store/accounts';
import { get as getState, useStore } from '../../../store/core';
import { native } from '../../../lib/native';
import { noteIgnored } from '../../../lib/ignored';
import { assetUrl } from '../../../lib/paths';
import { useMoPilot } from '../../../lib/mopilot';
import { hasMoPilotService } from '../../../lib/mopilotService';
import { useCreditsView } from '../../../harness/useCreditsView';
import { endpointLabel, type BillingProps, type Mode } from '../../pages/settings/BillingRow';
import { CodexMark } from '../../ui/icons';
import type { HarnessParts } from '../parts';
import type { HarnessStatus } from '../../../harness/types';
import type { HarnessBinary } from '../../../lib/cliSource';
import { useCodexBinaries } from '../../../harness/codexBinaries';
import { CodexExpiredBanner } from './ExpiredBanner';

// The ChatGPT mark, read at runtime from the user's own ChatGPT.app (nothing copied into this repo).
// It's a macOS template image, so it is drawn as a mask in the current text color.
const CHATGPT_MARK = '/Applications/ChatGPT.app/Contents/Resources/chatgptTemplate@2x.png';
let chatgptMark: boolean | null = null;
const markListeners = new Set<(v: boolean) => void>();
function useChatGPTMark() {
  const [has, setHas] = useState(chatgptMark ?? false);
  useEffect(() => {
    if (chatgptMark !== null) return setHas(chatgptMark);
    markListeners.add(setHas);
    if (markListeners.size === 1)
      native.fs.exists(CHATGPT_MARK).then(
        (v) => {
          chatgptMark = v;
          for (const l of markListeners) l(v);
          markListeners.clear();
        },
        (e) => {
          // an optional probe: the Codex mark stays, and the next icon that mounts asks again
          noteIgnored('look for the ChatGPT mark', e);
          markListeners.clear();
        },
      );
    return () => void markListeners.delete(setHas);
  }, []);
  return has;
}

function Icon({ size }: { size: number }) {
  const hasMark = useChatGPTMark();
  if (hasMark)
    return (
      <span
        className="harness-icon codex chatgpt-mark"
        role="img"
        aria-label="Codex"
        style={{
          width: size,
          height: size,
          WebkitMaskImage: `url("${assetUrl(CHATGPT_MARK)}")`,
          maskImage: `url("${assetUrl(CHATGPT_MARK)}")`,
        }}
      />
    );
  return <CodexMark size={size} className="harness-icon codex" aria-label="Codex" />;
}

/** What Codex pays with, for its Pay with row and the Use an API key action. */
function useBilling(): BillingProps {
  const accounts = useStore((s) => s.accounts);
  const mp = useMoPilot();
  const active = accounts.accounts.find((a) => a.id === accounts.active);
  // Replace and Remove act on the key in use, else the one saved key
  const key =
    (active?.kind === 'apiKey' && !active.mopilot ? active : null) ?? accounts.accounts.find((a) => a.kind === 'apiKey' && !a.mopilot);
  const mode: Mode = active?.mopilot ? 'mopilot' : active?.kind === 'apiKey' ? 'apiKey' : 'subscription';
  const chatgpt = accounts.accounts.filter((a) => a.kind === 'chatgpt');
  const credits = useCreditsView().line;
  return {
    keys: { placeholder: 'API key · sk-…', urlPlaceholder: 'https://openrouter.ai/api/v1', official: 'OpenAI' },
    mode,
    hasKey: !!key,
    hasSubscription: chatgpt.length > 0,
    // a build without the MoPilot service offers no credits
    credits: hasMoPilotService() ? { signedIn: mp.signedIn } : undefined,
    desc:
      mode === 'mopilot'
        ? credits
        : mode === 'apiKey'
          ? `${endpointLabel(active?.baseUrl, 'OpenAI')} API key · billed per token`
          : chatgpt.length
            ? `ChatGPT · ${active?.email ?? 'signed in'}`
            : 'Not signed in with ChatGPT',
    // Your own provider is Claude Code's only: Codex never offers it
    onSwitch: (m) => (m === 'routed' ? Promise.resolve() : setCodexMode(m)),
    onAddKey: (k, u) => addCodexApiKey(k, u, key?.id),
    onRemoveKey: async () => key && removeAccount(key.id),
    onSignIn: () => login(),
  };
}

/** One switch for moving on when an account runs out: behind the relay, new chats also go to the account with the most left. */
async function setAutomatic(on: boolean) {
  await setAutoSwitch(on);
  if (getState().accounts.relay) await setAccountPool(on ? 'spread' : 'single');
}

export const codexParts: HarnessParts = {
  refreshUsage: () => refreshAccountsUsage('surface'),
  Icon,
  signIn: () => login(),
  signInLabel: 'Sign in',
  missingHint: missingHint('Codex', { settings: 'Settings → Codex' }),
  fastDesc: '1.5x speed, increased usage',
  fastTip: null,
  usageHint: 'Usage shows once Codex reports it',
  useBilling,
  useAutoSwitch: () => [useStore((s) => s.accounts.autoSwitch), setAutomatic],
  useBinary: useCodexBinary,
  Banner: CodexExpiredBanner,
};

/** What CodexBinaryRow gives its Version row; the binary the status names while the installs can't be read. */
function useCodexBinary(st: HarnessStatus): HarnessBinary {
  const { bins, error } = useCodexBinaries();
  const manual = useStore((s) => s.codexBin);
  return { bin: bins?.current ?? (error ? st.bin : null), installs: bins?.candidates, manual };
}
