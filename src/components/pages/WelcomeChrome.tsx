// The welcome page's optional Chrome row (#1986): MoPilot's extension for every agent, with the same state, reason and next step as Settings → Browser (#2034).

import { Globe } from 'lucide-react';
import { capabilityReasonText } from '../../../shared/capabilityReasons.mjs';
import { useNativeAvailability } from '../../session/nativeAvailability';
import { isChromeExtensionAction, runChromeExtensionAction } from '../../session/chromeExtensionActions';
import { Connected } from './WelcomeAgents';

/** What the row gives, once it works: the extension is named as Settings → Browser names it (#2034). */
const CONNECTED_HINT = 'Agents can work in your signed-in Chrome through the MoPilot extension.';

/** Nothing where this build doesn't use its extension; else Connected, or its next step (or state) and why. */
export function WelcomeChrome() {
  const ext = useNativeAvailability()?.extension;
  if (!ext) return null;
  const connected = ext.state === 'mopilot';
  const steps = ext.actions.filter(isChromeExtensionAction);
  return (
    <>
      <p className="welcome-optional" id="welcome-optional">
        Optional
      </p>
      <div className="welcome-list" role="list" aria-labelledby="welcome-optional">
        <div className="welcome-row" role="listitem" data-testid="welcome-chrome">
          <div className="welcome-row-head">
            <Globe size={18} />
            <span className="welcome-row-label">Use your Chrome</span>
            {connected ? (
              <Connected />
            ) : steps.length ? (
              steps.map((a) => (
                <button key={a.kind} type="button" className="btn-pill" onClick={() => runChromeExtensionAction(a)}>
                  {a.label}
                </button>
              ))
            ) : (
              <span className="welcome-row-state">{ext.label}</span>
            )}
          </div>
          <p className="login-hint welcome-row-hint">{connected ? CONNECTED_HINT : capabilityReasonText(ext.reasonCode)}</p>
        </div>
      </div>
    </>
  );
}
