// main's command about an agent's browser tab (open, close, select) read into what the store's agent-tab actions take.

/**
 * main's request about an agent's browser tab (electron/main.cjs browserTabs): its chat and browser_* tab id, null for the chat's original tab;
 * `after`, a duplicate's source tab id the same way; `auto`, only when true, a request at the agent's own pace (a reveal, its
 * turn's result, browser_tabs_select) that never reopens a pane the user closed on a tab they saw.
 */
export function agentTabRequest(
  arg: unknown,
): { chatId: string; tabKey: string | null; focus?: boolean; after?: string | null; auto?: boolean } | null {
  if (!arg || typeof arg !== 'object') return null;
  const { chatId, tabKey, focus, after, auto } = arg as {
    chatId?: unknown;
    tabKey?: unknown;
    focus?: unknown;
    after?: unknown;
    auto?: unknown;
  };
  if (typeof chatId !== 'string' || !chatId) return null;
  return {
    chatId,
    tabKey: typeof tabKey === 'string' && tabKey ? tabKey : null,
    ...(typeof focus === 'boolean' ? { focus } : {}),
    ...(after === null || (typeof after === 'string' && after) ? { after } : {}),
    ...(auto === true ? { auto } : {}),
  };
}
