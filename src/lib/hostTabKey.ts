// Which Host a pane tab's key names (the renderer's copy of electron/capabilities/browser/hostTabKey.cjs decodeTabKey; tests/remoteViewKey.test.ts holds the two to the same answers).

/** The Host of an agent tab's pane key when it is a tab on another Host, else null (a tab on this Mac keeps its plain key). */
export function hostOfTabKey(key: string | null | undefined): string | null {
  if (typeof key !== 'string' || !key.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== 'host') return null;
  const [, hostId, tabId] = parsed;
  return typeof hostId === 'string' && hostId && hostId !== 'local' && typeof tabId === 'string' && tabId ? hostId : null;
}

/** Whether an agent tab's pane key names a Host's desktop (hostDesktopTabs.cjs) rather than a page. */
export function isDesktopTabKey(key: string | null | undefined): boolean {
  if (!hostOfTabKey(key)) return false;
  return (JSON.parse(key as string) as unknown[])[2] === 'desktop';
}
