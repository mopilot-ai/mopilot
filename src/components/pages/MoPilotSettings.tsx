// Settings → MoPilot account and Settings → Privacy.
import { shareUsageDataEnabled } from '../../../shared/usageData.mjs';
import { native } from '../../lib/native';
import { openMoPilotPage } from '../../session/open';
import { useMoPilot } from '../../lib/mopilot';
import { useCreditsView } from '../../harness/useCreditsView';
import { setPrefs, toast, useStore } from '../../store/core';
import { Group, Row, Toggle } from './Settings';
import { chooseShareUsageData } from './shareUsageData';
import { hasMoPilotService } from '../../lib/mopilotService';

export function MoPilotAccountSettings() {
  const mp = useMoPilot();
  const credits = useCreditsView();
  const signIn = () =>
    native.mopilot.signIn().then((r) => {
      if (r.ok) toast('Signed in to MoPilot', 'success');
      else if (r.error) toast(r.error, 'error');
    });
  if (!mp.signedIn) {
    return (
      <Group desc="Sign in to use MoPilot credits.">
        <Row title={credits.empty} desc={mp.signingIn ? 'Finish signing in in your browser…' : 'Sign in with Google or GitHub'}>
          {mp.signingIn ? (
            <button className="btn-pill" onClick={() => native.mopilot.cancelSignIn()}>
              Cancel
            </button>
          ) : (
            <button className="btn primary sm" onClick={signIn}>
              Sign in
            </button>
          )}
        </Row>
      </Group>
    );
  }
  return (
    <>
      <Group>
        <Row title={mp.user?.name || mp.user?.email} desc={mp.user?.name ? mp.user.email : undefined}>
          <button className="btn-pill" onClick={() => openMoPilotPage('/account')}>
            Manage account
          </button>
          <button className="btn-pill" onClick={() => native.mopilot.signOut()}>
            Sign out
          </button>
        </Row>
      </Group>
      <Group title="Credits" desc="Pay for Codex and Claude Code by usage.">
        <Row title={credits.balance} desc="Available balance">
          <button className="btn-pill" onClick={() => native.mopilot.refresh()}>
            Refresh
          </button>
          <button className="btn primary sm" onClick={() => openMoPilotPage('/credits')}>
            Buy credits
          </button>
        </Row>
      </Group>
    </>
  );
}

export function PrivacySettings() {
  const share = useStore((s) => s.prefs.shareUsageData);
  const requestLog = useStore((s) => s.prefs.requestLog);
  return (
    <Group>
      {/* a build without the MoPilot service collects and shares nothing, so there is no choice to make or data to delete */}
      {hasMoPilotService() && (
        <Row
          title="Share usage data"
          desc="On by default, including when signed out. Includes analytics, crash reports, prompts, and responses. Secrets and personal identifiers are redacted. A bug report you send goes either way."
        >
          <Toggle on={shareUsageDataEnabled(share)} onChange={(v) => chooseShareUsageData(v)} />
        </Row>
      )}
      <Row
        title="Request log"
        desc="Keep a local log of each model request (harness, account, model, tokens, errors) for 30 days, and each day's usage by harness and model for a year after. Never prompts, replies or keys; nothing is uploaded."
      >
        <Toggle on={requestLog !== false} onChange={(v) => setPrefs({ requestLog: v })} />
      </Row>
      {hasMoPilotService() && (
        <>
          <Row title="Privacy policy" desc="What is collected and how to delete it" onClick={() => openMoPilotPage('/privacy')} />
          <Row
            title="Delete data you've shared"
            desc="Sign in on the web to delete everything uploaded from your account"
            onClick={() => openMoPilotPage('/account')}
          />
        </>
      )}
    </Group>
  );
}
