// Settings search: the words each page answers to beyond its name, which pages a query finds and why, and the
// pieces of a name to highlight. Pure; the sidebar draws the results (components/pages/Settings.tsx).

/** What each page holds, in the words someone would type to find it. */
export const KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  accounts: [
    'Sign in',
    'Sign out',
    'Login',
    'API key',
    'API usage',
    'Usage',
    'Estimated cost',
    'Cost',
    'Spend',
    'Price',
    'Limits',
    'Credits',
    'Codex credits',
    'Subscription',
    'Pay with',
    'Plan',
    'Switch automatically when one runs out',
    'When every account runs out',
    'Use an API key',
    'Reset cards on Claude',
    'Usage limit resets',
  ],
  general: [
    'Language',
    'Default permissions',
    'Full access',
    'Task folder',
    'Open files in',
    'Show in menu bar',
    'Confirm before quitting',
    'Expand panels',
    'Show panel button',
    'iOS Simulator',
    'Android Emulator',
    'Terminal position',
    'Run scheduled tasks',
    'Send with',
    'When you ask for an unrelated task',
    'Automatically archive inactive chats',
    'Apply code review fixes automatically',
    'Resume after quota resets',
    'Switch harness at a usage limit',
    'Follow-up behavior: Queue or Steer',
    'Notifications',
    'Notification quiet hours',
    'Show reasoning',
  ],
  appearance: [
    'Theme',
    'Dark mode',
    'Light mode',
    'Accent color',
    'Background',
    'Foreground',
    'Chat font size',
    'Code font size',
    'Wrap long lines in code blocks',
  ],
  mini: ['Floating window', 'Quick Chat shortcut'],
  shortcuts: ['Hotkeys', 'Key bindings'],
  privacy: ['Share usage data', 'Crash reports', 'Telemetry', 'Request log', 'Privacy policy', "Delete data you've shared"],
  harnesses: ['New chats use', 'Use for new chats', 'Default for new chats', 'Default harness', 'Use highest installed CLI version'],
  codex: [
    'Models',
    'Reasoning',
    'Web search',
    'Memory',
    'AGENTS.md',
    'Instructions',
    'Pay with API key',
    'Plugins',
    'MCP servers',
    'Hooks',
    'Cloud environments',
    'Output detail',
    'Reasoning summary',
    'Reasoning efforts',
    'Custom rules',
    'Use memory',
    'Include tool-assisted chats',
    'Delete memories',
    'Keep imports in sync',
    'Content to sync',
    'Settings folder',
    'Restart Codex',
  ],
  claude: [
    'Models',
    'CLAUDE.md',
    'Instructions',
    'Pay with API key',
    'Cloud provider',
    'Bedrock',
    'Vertex',
    'MCP servers',
    'Plugins',
    'Hooks',
    'Skills',
    'Use cloud provider',
    'Artifacts and designs',
    'Connect new sessions to Remote Control',
    'Remote Control',
    'Claude Design',
    'Install a plugin',
    'settings.json',
    'CLI location',
  ],
  // the vendors' own product names too ("Gemini CLI"), which people search by
  'other-harnesses': [
    'opencode',
    'Gemini',
    'Gemini CLI',
    'Kimi Code',
    'Qwen Code',
    'Copilot',
    'Copilot CLI',
    'Cursor',
    'Cursor CLI',
    'Goose',
    'ACP',
    'MCP servers from its own settings',
  ],
  computer: [
    'Computer control',
    'Screen Recording',
    'Accessibility',
    'Input Monitoring',
    'Apps',
    "Allow brief switching to the app when background control doesn't work",
    'Use Codex Computer Use in Codex chats',
    'Always allowed',
    'Blocked apps',
    'Block another app',
  ],
  'computer-access': [
    'Remote',
    'Let paired devices use this Mac',
    'Allow computers on this network',
    'Pair a device',
    'Other computers',
    'Access log',
    'Revoke',
  ],
  'computer-history': [
    'Memories',
    'Record activity',
    'Allowed apps',
    'Allowed sites',
    'Passwords and secure fields',
    'Keep memories for',
    'Retention',
  ],
  browser: [
    'Routines',
    'Saved browser steps',
    'Preferred browser',
    'Open local sites in',
    'Show full URL',
    'Record turn replays',
    'Browsing data',
    'Location',
    'Ask where to save downloads',
    'MoPilot extension',
    'Use Claude in Chrome',
    'Playwright Extension',
    'Connection token',
    'Chrome profile',
    'Cookies',
    'Storage',
    'Site permissions',
    'Site access',
    'Downloads and uploads',
    'Browsing history',
    'Full CDP access',
  ],
  voice: ['Dictation engine', 'Microphone', 'Speech', 'Language', 'Voice input hotkey', 'Recent recordings', 'Delete all recordings'],
  connections: ['SSH', 'Remote hosts', 'Control this Mac', 'Control other devices', 'Allow connections'],
  connectors: ['Built-in connectors', 'GitHub', 'Linear', 'Quick Actions', 'Services menu'],
  git: [
    'Commits',
    'Branch prefix',
    'Pull requests',
    'Diffs',
    'Show only last turn changes',
    'Worktree root',
    'Delete old worktrees',
    'Delete branch on archive',
    'Worktrees to keep',
    'Branches',
  ],
  archived: ['Archive', 'Restore chats'],
  about: [
    'Version',
    'Check for updates',
    'Update automatically',
    'Update channel',
    'Copy diagnostics',
    'Report a bug',
    'Join the community',
    'Discord',
    'Third-party notices',
    'Request log',
    'CLI path',
  ],
};

/** The tab of a page that has tabs which a matched word lives on, so a hit opens the tab that shows it (Connections: Control this Mac, Control other devices, SSH). */
const WORD_TAB: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  connections: {
    SSH: 'ssh',
    'Remote hosts': 'other',
    'Control other devices': 'other',
    'Control this Mac': 'this-mac',
    'Allow connections': 'this-mac',
  },
};

/** The tab a search hit on `word` of `section` opens, or undefined when the page has none for it. */
export const tabOfWord = (section: string, word: string | null): string | undefined => (word ? WORD_TAB[section]?.[word] : undefined);

export interface SearchHit<T> {
  item: T;
  /** the page's own words that matched, when its name did not: shown under the name */
  hint: string | null;
  /** the first of those words: the setting to land on; null when the page matched by name */
  target: string | null;
}

/** At most this many matched words under a page's name. */
const HINTS = 2;

/**
 * The pages a query finds, in sidebar order: by name, group or keyword, case-insensitively. A page found by name
 * shows no hint; one found only through its keywords shows the words that matched. An empty query finds everything.
 */
export function searchSettings<T extends { id: string; label: string; group: string }>(
  items: readonly T[],
  query: string,
  keywords: Readonly<Record<string, readonly string[]>> = KEYWORDS,
): SearchHit<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.map((item) => ({ item, hint: null, target: null }));
  return items.flatMap<SearchHit<T>>((item) => {
    if (item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q)) return [{ item, hint: null, target: null }];
    const words = (keywords[item.id] ?? []).filter((k) => k.toLowerCase().includes(q));
    return words.length ? [{ item, hint: words.slice(0, HINTS).join(' · '), target: words[0] }] : [];
  });
}

/** A text cut where the query appears, so the matches can be marked. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  const low = text.toLowerCase();
  let at = 0;
  for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, at)) {
    if (i > at) parts.push({ text: text.slice(at, i), hit: false });
    parts.push({ text: text.slice(i, i + q.length), hit: true });
    at = i + q.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), hit: false });
  return parts;
}
