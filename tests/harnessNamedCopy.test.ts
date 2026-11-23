// Shared UI names no harness unless the harness is its subject (#1645: the Code Review page said "Review with Claude Code"
// on every harness). Each shared file (components, harness services, store, lib, App and main's app, IPC, sessions,
// capabilities, plugins and platform) whose strings name Codex, Claude Code, OpenCode or ChatGPT is listed here with its
// count and why, so a new one is reviewed before it ships. One harness's own files are exempt: the
// components/harness/<kind>/ pages, and files or folders named for a harness (claude*, codex*, acp*) in src/harness,
// src/session/harness and main's folders. So are diagnostics, which only reach the log. Bare "Claude" is not matched:
// it is also the vendor's account and Claude in Chrome, which shared copy names on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = [
  'electron/app/',
  'electron/capabilities/',
  'electron/app/ipc/',
  'electron/platform/',
  'electron/plugins/',
  'electron/session/',
  'src/components/',
  'src/harness/',
  'src/lib/',
  'src/session/',
  'src/store/',
];

const NAME = /\b(?:Codex|Claude Code|OpenCode|ChatGPT)\b/;
/** A file or folder that belongs to one harness, by its name. */
const ONE_HARNESS = (p: string) => /^(?:claude|codex|acp)/.test(path.basename(p));
const CODE = /\.(tsx?|cjs|mjs)$/;
// toasts and errors the store, harness services and main build reach every harness too (the app menu's Help named only
// Codex's docs; plugin IPC said "a plugin Claude Code or Codex installed" on an ACP chat)
const SCANNED = [
  ...treeFiles('src/components', /\.tsx?$/, { skip: (p) => /src\/components\/harness\/(?:claude|codex)$/.test(p) }),
  ...['src/store', 'src/lib', 'electron/app'].flatMap((r) => treeFiles(r, CODE)),
  // session's harness runtime is checked like src/harness, below
  ...treeFiles('src/session', CODE, { skip: (p) => /src\/session\/harness$/.test(p) }),
  ...[
    'src/harness',
    'src/session/harness',
    'electron/app/ipc',
    'electron/session',
    'electron/capabilities',
    'electron/plugins',
    'electron/platform',
  ].flatMap((r) => treeFiles(r, CODE, { skip: ONE_HARNESS })),
  'src/App.tsx',
  'shared/chromeApproval.mjs',
  'shared/elicitation.mjs',
].filter((f) => !f.endsWith('.d.ts'));
const DIAGNOSTIC = /\b(?:noteIgnored|ignoring|console\.\w+)\(/;

/** Lines a file names a harness on, in code, strings or JSX text (not comments, imports or diagnostics). */
function namingLines(text: string): number[] {
  return stripComments(text)
    .split('\n')
    .flatMap((line, i) => (!/^\s*import\b/.test(line) && !DIAGNOSTIC.test(line) && NAME.test(line) ? [i + 1] : []));
}

/** Where a shared file names a harness, and why the harness is the subject there. */
const NAMED: Record<string, { lines: number; why: string }> = {
  'src/components/momo/home/homeFixtures.ts': {
    lines: 16,
    why: 'fixture data standing in for the home’s own words about its agents (dev switch and unit tests only; a real view brings its own names)',
  },
  'src/components/composer/ComposerSlash.tsx': { lines: 2, why: 'ultracode is a Claude Code feature' },
  'src/components/composer/RunOnChip.tsx': {
    lines: 1,
    why: 'the Run on menu’s cloud environments are Codex Cloud’s, offered only when the new chat’s agent has them (cap `cloud`)',
  },
  'src/components/pages/Home.tsx': {
    lines: 1,
    why: 'offers the one-click Claude Code install when only a basic harness is set up (docs/acceptance.md A2.2)',
  },
  'src/components/accounts/access.tsx': {
    lines: 5,
    why: "Codex's app server quitting and restarting (and a restart that fails), and adding a ChatGPT account",
  },
  'src/components/accounts/settings.tsx': { lines: 7, why: "each harness's own accounts and sign-in" },
  'src/components/harness/ResetCards.tsx': { lines: 5, why: "each harness's own usage resets: Claude's and Codex's reset pages" },
  'src/components/harness/Usage.tsx': { lines: 1, why: "Codex credits, Codex's own usage row" },
  'src/components/pages/CloudTask.tsx': { lines: 2, why: 'Codex Cloud tasks, opened in ChatGPT' },
  'src/components/pages/Login.tsx': { lines: 11, why: 'connecting to Codex, updating it, and the "Needs Codex" gate for Codex-only pages' },
  'src/components/pages/MoPilotSettings.tsx': { lines: 1, why: 'lists the harnesses credits pay for' },
  'src/components/pages/Scheduled.tsx': { lines: 2, why: 'lists every harness, and the Codex app and Claude Desktop schedulers' },
  'src/components/pages/scheduled/TaskDetail.tsx': { lines: 1, why: 'the Codex app and Claude Desktop schedulers' },
  'src/components/pages/Welcome.tsx': { lines: 1, why: 'Sign in with ChatGPT connects Codex' },
  'src/components/pages/settings/About.tsx': { lines: 5, why: "Codex's CLI path and app server" },
  'src/components/pages/settings/Appearance.tsx': { lines: 1, why: 'the Codex theme presets' },
  'src/components/pages/settings/Browser.tsx': {
    lines: 1,
    why: 'Claude in Chrome is a setting of Claude Code chats: its group is titled for them',
  },
  'src/components/pages/settings/BrowserUse.tsx': { lines: 12, why: "Codex Browser Use's own settings" },
  'src/components/pages/settings/ComputerUse.tsx': { lines: 2, why: 'the Codex Computer Use switch is a setting of Codex chats (#1381)' },
  'src/components/pages/settings/RemoteControl.tsx': {
    lines: 3,
    why: "the ChatGPT account whose devices can control this computer, and the ChatGPT app a device pairs from, and the group that sets this link apart from MoPilot's own phone pairing",
  },
  'src/components/pages/settings/EstimatedCost.tsx': {
    lines: 4,
    why: "importing Claude Code's transcripts and Codex's rollouts: the sessions it reads are those harnesses', run outside MoPilot",
  },
  'src/components/pages/settings/General.tsx': { lines: 1, why: 'the Codex app and Claude Desktop schedulers' },
  'src/components/pages/settings/ProvidersModels.tsx': {
    lines: 3,
    why: 'Your own provider runs Claude Code (plan Part B3; Codex and basic harnesses come in B4 and B5), and the tier models are Claude Code’s own model families',
  },
  'src/components/pages/settings/Git.tsx': { lines: 1, why: "the Codex app's worktree folder, which its cleanup deletes worktrees from" },
  'src/components/panels/FindingAnnotation.tsx': { lines: 1, why: 'the name of the harness that wrote the review' },
  'src/components/plugins/StorePage.tsx': { lines: 1, why: 'Codex installing for its own app' },
  'src/components/plugins/TrustDialog.tsx': { lines: 1, why: 'LSP configuration only reaches Claude Code' },
  'src/components/plugins/usePluginStore.ts': { lines: 1, why: "Codex's own installs" },
  'src/components/thread/NativeCleanup.tsx': { lines: 4, why: "Codex's own computer use, and restarting Codex lets go of it" },
  'src/components/thread/approvals/toolCards.tsx': { lines: 1, why: "Claude Code's own tool approval (claude/toolApproval)" },
  'src/components/thread/items/output.tsx': { lines: 2, why: "restarting Codex, the way past an earlier turn Codex didn't release" },
  'src/harness/accountView.ts': { lines: 1, why: "each harness's own CLI login" },
  'shared/chromeApproval.mjs': { lines: 2, why: "Claude Code's own Claude in Chrome permission and how long it keeps it" },
  'src/harness/commands.ts': { lines: 6, why: "each harness's own slash commands and their labels" },
  'src/harness/copy.ts': {
    lines: 12,
    why: 'copy keyed by harness: Codex init, the Codex config.toml note, voice, Remote Control and Cloud, Claude Code feedback and sandbox, the login a native dictation needs',
  },
  'shared/elicitation.mjs': { lines: 3, why: "Codex Computer Use's own approval requests" },
  'src/harness/family.ts': {
    lines: 1,
    why: "each harness's own traits: MoMo's Codex app-server signs in only with a ChatGPT sign-in (#2308)",
  },
  'src/harness/entries.ts': { lines: 1, why: "Codex plugins and skills, and Codex's ChatGPT account for feedback" },
  'src/harness/mcpConnection.ts': { lines: 1, why: "an MCP server Claude Code's own config manages" },
  'src/harness/polyfills/init.ts': { lines: 1, why: "the harnesses' names for the /init file they read" },
  'src/harness/registry.ts': {
    lines: 4,
    why: "each harness's registry entry: where it stores chats, ChatGPT sign-in, the plans its subscription covers",
  },
  'src/session/harness/select.ts': { lines: 2, why: "a Codex account's ChatGPT plan name" },
  'src/App.tsx': { lines: 1, why: 'Codex Cloud pages need Codex' },
  'src/store/archivedCodex.ts': { lines: 3, why: "Codex's archive pages" },
  'src/store/connection.ts': { lines: 2, why: "Codex's app server exiting, and Codex as the source of its archived chats" },
  'src/store/send.ts': { lines: 1, why: 'a chat another Codex app holds' },
  'src/store/threads.ts': { lines: 5, why: 'a chat another Codex app holds, and the names of the other apps that hold chats' },
  'src/store/types.ts': { lines: 1, why: 'the legacy ~/Documents/Codex folder, a path' },
  'src/lib/blockedChoices.ts': { lines: 2, why: 'Codex Browser Use refusals' },
  'src/lib/browserSites.ts': { lines: 3, why: "lists every harness, and Codex Browser Use's rules" },
  'src/lib/codexImportSource.ts': { lines: 1, why: 'the app a setup item Codex detected came from (Claude Code among them)' },
  'src/lib/dictation.ts': { lines: 1, why: 'dictation by a ChatGPT account, an option the user picks' },
  'src/lib/scheduleTask.ts': { lines: 10, why: 'the harness a task runs on, and the Codex app and Claude Desktop schedulers' },
  'src/lib/settingsNav.ts': { lines: 7, why: "each harness's settings page and the Codex config.toml note" },
  'src/lib/settingsSearch.ts': { lines: 3, why: "the titles of rows on a harness's own settings page, which search must find" },
  'electron/app/codexServer.cjs': { lines: 3, why: "paths of Codex's own binary, and the ChatGPT app that ships one" },
  'electron/app/identity.cjs': { lines: 1, why: "a Codex chat's usage-limit notification" },
  'electron/app/sessions.cjs': { lines: 2, why: "a Claude Code chat's usage-limit and goal notifications" },
  'electron/capabilities/browser/iabBackend/protocol.cjs': {
    lines: 1,
    why: "the model-facing upload hint for Codex's Browser plugin, which names the ChatGPT extension",
  },
  'electron/capabilities/browser/refusals.cjs': { lines: 4, why: 'Codex Browser Use site blocks, matched and explained to the model' },
  'electron/capabilities/computerPresentation.cjs': { lines: 1, why: "the harnesses' names for whose computer use is running" },
  'electron/capabilities/nativeAvailability/probe.cjs': { lines: 2, why: "Codex Computer Use's app and the ChatGPT app that ships it" },
  'electron/capabilities/nativeAvailability/status.cjs': {
    lines: 23,
    why: "Codex's native browser and computer control: its plugins, Codex Computer Use and ChatGPT for Chrome",
  },
  'electron/capabilities/nativeDesktopHold.cjs': { lines: 1, why: 'Codex Computer Use taking the desktop' },
  'electron/capabilities/contract/serverRequests.cjs': { lines: 1, why: "declining Codex's own computer use request" },
  'electron/capabilities/tools/remoteControl.cjs': { lines: 4, why: "Claude Code's own link; other chats are told so" },
  'electron/capabilities/tools/scheduledTasks.cjs': {
    lines: 2,
    why: 'model-facing tool descriptions: tasks span every harness, and the Codex app and Claude Desktop schedulers',
  },
  'electron/app/ipc/accounts.cjs': { lines: 1, why: 'Codex Cloud needs a ChatGPT sign-in' },
  'electron/platform/automationRun.cjs': { lines: 1, why: "the harnesses' names" },
  'electron/platform/automationStore.cjs': { lines: 1, why: "a task moved out of the Codex app's folder (a log line)" },
  'electron/platform/chatStart.cjs': { lines: 1, why: "forking a chat is Codex's own" },
  'electron/platform/git.cjs': { lines: 2, why: "the Codex app's worktree folder, whose cleanup deletes worktrees" },
  'electron/platform/nativeSchedulers.cjs': { lines: 2, why: 'the Codex app scheduler and its binaries' },
  'electron/platform/voice.cjs': { lines: 1, why: 'dictation by a ChatGPT account' },
  'electron/platform/chatgptDictation.cjs': { lines: 10, why: "the ChatGPT login's streaming dictation, named in its own failures" },
  'electron/plugins/sourcePlans.cjs': { lines: 5, why: "how Codex reads a plugin's manifest" },
  'electron/session/controllerEvents.cjs': { lines: 1, why: "the harnesses' names" },
  'src/lib/deleteChatQuestion.ts': {
    lines: 1,
    why: 'what Codex keeps of a chat deleted on a machine (its own database), said only for a chat that runs on Codex',
  },
};

test('shared UI names a harness only where the harness is the subject, and each place is listed with why', () => {
  const found = Object.fromEntries(
    SCANNED.map((f) => [f, namingLines(fs.readFileSync(f, 'utf8')).length] as const).filter(([, n]) => n > 0),
  );
  assert.deepEqual(
    found,
    Object.fromEntries(Object.entries(NAMED).map(([f, v]) => [f, v.lines])),
    "A shared component names a harness. Name the chat's own harness (chatHarnessLabel, useSourceLabel) or say it without a name; if the harness is the subject, list the file here with why (docs/bug-prevention/cross-harness-gaps.md).",
  );
});

test('the scanner reads strings and JSX text, not comments, imports or lowercase ids', () => {
  assert.deepEqual(namingLines("const a = 'Review with Codex';"), [1]);
  assert.deepEqual(namingLines('<p>\n  Ask Claude Code\n</p>'), [2]);
  assert.deepEqual(namingLines('const a = `${x} via OpenCode`;'), [1]);
  assert.deepEqual(namingLines("// Codex's own\nconst h = 'codex';"), []);
  assert.deepEqual(namingLines("import { CodexMark } from './mark';\nconst m = CodexMark;"), []);
  assert.deepEqual(namingLines("x().catch(ignoring('read the Codex account'));\nnoteIgnored('list Codex chats', e);"), []);
});
