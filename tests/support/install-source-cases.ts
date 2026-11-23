// One matrix of install states for both places a harness's install is named: its page header (HarnessVersionLine)
// and its Version row (HarnessVersionRow). Each case gives the words both must say, so the two can't drift (#1402).
const native = { path: '/u/.local/bin/claude', version: '2.1.302', via: 'self', from: 'standalone install' };
const brew = { path: '/opt/homebrew/bin/claude', version: '2.1.302', via: 'brew', from: 'Homebrew' };

export interface InstallSourceCase {
  name: string;
  /** the binary chats run */
  bin: string;
  installs?: (typeof native)[];
  /** the path the user set */
  manual: string | null;
  /** main's update check of `bin` */
  check: { via: string | undefined; from: string | null; blockedReason: string | null };
  /** how both name the install */
  words: string;
  /** the header's whole line under the version */
  line: string;
}

export const INSTALL_SOURCE_CASES: InstallSourceCase[] = [
  {
    name: 'found automatically',
    bin: native.path,
    installs: [native, brew],
    manual: null,
    check: { via: 'self', from: 'standalone install', blockedReason: null },
    words: 'Native installer',
    line: 'Up to date · Native installer',
  },
  {
    name: 'a found install picked from the menu',
    bin: brew.path,
    installs: [native, brew],
    manual: brew.path,
    check: { via: 'brew', from: 'Homebrew (cask)', blockedReason: null },
    words: 'Homebrew',
    line: 'Up to date · Homebrew',
  },
  {
    name: 'a custom location none of the installs is',
    bin: '/s/dev-claude-wrapper.sh',
    installs: [native, brew],
    manual: '/s/dev-claude-wrapper.sh',
    check: { via: 'unknown', from: '/s/dev-claude-wrapper.sh', blockedReason: 'unknown-install' },
    words: 'Custom location',
    line: 'Custom location: update it the way you installed it',
  },
  {
    name: 'bundled with an app',
    bin: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    installs: [],
    manual: null,
    check: { via: 'app-bundle', from: 'ChatGPT.app', blockedReason: 'app-bundle' },
    words: 'Bundled with ChatGPT.app',
    line: 'Bundled with ChatGPT.app: updates with the app',
  },
  {
    name: 'installs not read yet: main names the binary',
    bin: '/n/bin/claude',
    manual: null,
    check: { via: 'npm', from: 'npm global', blockedReason: null },
    words: 'npm',
    line: 'Up to date · npm',
  },
  {
    name: 'a way of installing main may add later',
    bin: '/x/claude',
    installs: [],
    manual: null,
    check: { via: 'nix', from: null, blockedReason: 'unknown-install' },
    words: 'Installed manually',
    line: 'Installed manually: update it the way you installed it',
  },
];
