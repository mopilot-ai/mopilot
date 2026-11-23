// Claude Code's logins on this machine as the Host reports them: the CLI's own login and each login added here, read from the account list the Claude harness keeps (electron/harness/claude/accounts.cjs), so a chat can be pinned to one.

/**
 * @param {{ active?: string, accounts?: { id: string, email?: string | null, loggedIn?: boolean, authMethod?: string | null, isDefault?: boolean }[] } | null | undefined} view the harness's account list
 * @returns {{ id: string, label: string, state: 'ok' | 'signedOut', limited: boolean, billing: 'subscription' | 'apiKey', active: boolean }[]}
 */
export function claudeLoginsOf(view) {
  return (view?.accounts ?? []).map((a) => ({
    id: a.id,
    label: a.email || (a.isDefault ? 'This machine' : a.id),
    state: a.loggedIn ? 'ok' : 'signedOut',
    // a limit is read from a turn's own failure, which the Host does not keep per login yet
    limited: false,
    billing: /api/i.test(a.authMethod ?? '') ? 'apiKey' : 'subscription',
    active: a.id === view?.active,
  }));
}
