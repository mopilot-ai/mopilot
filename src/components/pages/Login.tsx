// What to show when Codex isn't working: the fix to run, an inline note and a page-sized notice.

import { restartCodex } from '../../store/connection';
import { toast, toastFailure } from '../../store/core';
import { userError } from '../../../shared/userError.mjs';
import { useHarnessStatus } from '../../session/harness/select';
import { harnessInfo } from '../../harness/registry';
import { openLink } from '../../session/open';
import { signInHarness } from '../harnessPicker/HarnessPicker';
import { native } from '../../lib/native';
import { useVersionOf } from '../../harness/harnessUpdates';
import { versionWarning } from '../../harness/compat';
import { copyText } from '../../session/clipboard';
import { manualUpdateCommand } from '../../../shared/harnessInstall.mjs';

// The first-launch flow is Welcome.tsx; this is only the stand-in for what needs Codex.

/** The action of a fix with nothing to click (`label` empty). */
const nothing = () => undefined;

/** Update Codex now, saying why when main didn't start it. */
async function updateCodex() {
  const r = await native.harnessUpdates.update('codex', 'now');
  if (r.ok) return;
  if (r.error === 'busy') return toast("Another update is running. Try again once it's done.", 'error');
  // the reason as words, never main's code for it
  toast(`Couldn't update Codex. ${userError(r.message, { fallback: 'It can’t be updated from here.', who: 'Codex' })}`, 'error');
}

/** What gets Codex working again, or null when it already is. `label` is empty while it's still being looked for. */
export function useCodexFix(): { text: string; label: string; run: () => void } | null {
  const st = useHarnessStatus('codex');
  const v = useVersionOf('codex');
  if (st.state === 'ready' || st.state === 'apikey') return null;
  // an update under way is the fix: a restart now would start the binary it is replacing (#3518)
  if (v?.state === 'updating') return { text: 'Codex is updating.', label: '', run: nothing };
  // a version this app can't run: a restart starts it again, so the fix is its update (or, without one, the version
  // line above saying why there is none)
  const tooOld = versionWarning(harnessInfo('codex')?.versions, st.version);
  if (tooOld && v?.blockedReason === 'manual-terminal' && manualUpdateCommand(v))
    return {
      text: `${tooOld} Run the update command in your terminal, then restart MoPilot.`,
      label: 'Copy update command',
      run: () => void copyText(v.command!, 'Copied command'),
    };
  if (tooOld)
    return v?.updatable
      ? { text: tooOld, label: 'Update Codex', run: () => void updateCodex().catch(toastFailure("Couldn't update Codex")) }
      : { text: tooOld, label: '', run: nothing };
  if (st.state === 'detecting') return { text: 'Connecting to Codex…', label: '', run: nothing };
  if (st.state === 'signin') return { text: 'Codex isn’t signed in.', label: 'Sign in', run: () => signInHarness('codex') };
  if (st.state === 'missing')
    return {
      text: 'Codex isn’t installed.',
      label: 'Install Codex',
      run: () => openLink(harnessInfo('codex')!.install.docs),
    };
  return {
    text: 'Couldn’t connect to Codex.',
    label: 'Retry',
    run: () => void restartCodex().catch(toastFailure("Couldn't restart Codex")),
  };
}

/** An inline note: this part needs Codex, and the one action that fixes that. */
export function NeedsCodex({ what }: { what: string }) {
  const fix = useCodexFix();
  return (
    <div className="conn-error" role="status">
      <div className="conn-error-title">Needs Codex</div>
      <p className="login-hint">
        {what} {fix?.text ?? ''}
      </p>
      {fix?.label && (
        <button className="btn primary" onClick={fix.run}>
          {fix.label}
        </button>
      )}
    </div>
  );
}

/** In place of a page that needs Codex, while Codex isn't connected and signed in. */
export function CodexNotice({ what = 'This page needs Codex.' }: { what?: string }) {
  return (
    <div className="center-fill">
      <NeedsCodex what={what} />
    </div>
  );
}
