// The MoPilot credit balance as the account view shows it (accountView.ts creditsView), apart from useAccountView.ts
// so the billing rows and the profile menu need no harness state for it.
import { useMemo } from 'react';
import { useMoPilot } from '../lib/mopilot';
import { creditsView } from './accountView';

/** The MoPilot credit balance. */
export function useCreditsView() {
  const mp = useMoPilot();
  return useMemo(() => creditsView(mp), [mp]);
}
