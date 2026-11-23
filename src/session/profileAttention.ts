// Whether an account or harness needs the user: a lapsed Codex or Claude account, or the picked basic harness signed out.
import { useStore } from '../store/core';
import { savedDefaultHarness } from '../store/chats';
import { useHarnessAccounts } from './harness/select';
import { needsAttention } from '../harness/accounts';
import { installedBasics } from '../harness/launch';
import { basicIdOf } from '../harness/defaultHarness';

/**
 * True while any Codex or Claude account needs a sign-in, or the basic harness new chats use asks for one. A basic
 * harness merely installed and never picked does not count. The sidebar's account button and the title bar's
 * sidebar toggle (while the sidebar is hidden) both show it.
 */
export function useProfileAttention(): boolean {
  const codex = useHarnessAccounts('codex');
  const claude = useHarnessAccounts('claude');
  const basics = installedBasics(useStore((s) => s.basicHarnesses));
  // the basic harness picked for new chats, whether or not it can run now
  const pickedBasic = useStore((s) => basicIdOf(savedDefaultHarness(s)));
  return [...codex.accounts, ...claude.accounts].some(needsAttention) || basics.some((b) => b.state === 'signin' && b.id === pickedBasic);
}
