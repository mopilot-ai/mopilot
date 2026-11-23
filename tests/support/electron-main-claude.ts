// The fake Claude Code harness loadMain() (electron-main-harness.ts) gives main: electron/harness/claude/index.cjs (the
// harness in main, every call a mock a test reads or replaces) and adapter.cjs (the ChatController's adapter class,
// recorded in inst.ClaudeAdapter).

/**
 * @param makers the harness's mock-function, resolved-mock and recorded-class makers, and its transcript finder
 */
export function claudeFakes({
  fn,
  resolved,
  cls,
  findTranscript,
}: {
  fn: (impl?: any) => any;
  resolved: (v?: any) => any;
  cls: (name: string, init?: (...a: any[]) => any) => any;
  findTranscript: any;
}) {
  const claude: any = {
    turnApi: { detect: resolved({ state: 'ready', bin: '/bin/claude' }), findTranscript },
    governor: { watch: fn(() => () => {}) },
    identity: { claude: true },
  };
  for (const k of [
    'scrubProcessEnv',
    'probeInfo',
    'messages',
    'allTurns',
    'replies',
    'summarize',
    'setProbeListener',
    'register',
    'ownBusy',
    'ownWrites',
    'observe',
    'ledgerAccount',
    'version',
    'setTools',
    'setPlugins',
    'setChatOf',
    'setGatewayKeyProvider',
    'setGatewayCapsProvider',
    'mopilotChanged',
    'closeAll',
    'visionAuth',
    'retireChat',
    'nativeChromeFor',
    'setChromeLinkListener',
    'setChromeScope',
    'setProcessListener',
    ...['nativeChromeOf', 'toolsOf', 'setIsolated', 'setChatNames'],
    'chromeLinks',
    'chromeLinkOf',
    'chromeReconnect',
    'chromeBrowsers',
    'chromeSelect',
  ])
    claude[k] = fn();
  const mods = {
    'electron/harness/claude/index.cjs': { createClaudeHarness: fn(() => claude) },
    'electron/harness/claude/adapter.cjs': {
      ClaudeAdapter: cls('ClaudeAdapter', () => ({ permissionChanged: resolved(), sessions: new Map() })),
    },
  };
  return { claude, mods };
}
