// UI copy stays as short as Claude Desktop's and the Codex app's: every prose string on the cards, notices and settings
// rows agents touch most fits one line (docs/ui-copy.md). A longer one is listed here with why, so it is reviewed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { proseStrings, SLOT } from '../scripts/copy-length.mjs';

export const GUARDS = ['src/components/'];

/**
 * The caps, from the vendors' own strings (Claude 2.42585.0, ChatGPT 26.1013.40934): a card's question or line is at
 * most as long as "Allow Claude to use {domain} in Chrome on your computer?"; a notice, strip or settings row at most
 * as long as their longest one-line notices.
 */
const CARD = 60;
const NOTICE = 72;

/** Approval and site cards. */
const CARDS = [...treeFiles('src/components/thread/approvals', /\.tsx?$/), 'src/components/thread/approvalLogic.ts'];
/** Every notice, strip, card, banner and hint component, found by name so a new one is covered when it's created. */
const BY_NAME = treeFiles('src/components', /(?:Notice|Strip|Card|Banner|Hint)[^/]*\.tsx$/).filter((f) => !CARDS.includes(f));
/** In-chat and pane notices, strips, refusals, Browser and Computer settings. */
const NOTICES = [
  ...BY_NAME,
  'shared/browserNotice.mjs',
  'src/components/thread/PeerMessages.tsx',
  'src/components/thread/NativeCleanup.tsx',
  'src/components/thread/ComputerActivity.tsx',
  'src/components/panels/browserPanel/auxiliary.tsx',
  'src/components/panels/browserPanel/Downloads.tsx',
  'src/lib/browserDownloads.ts',
  'src/components/thread/view/friendlyError.ts',
  'src/components/panels/BrowserPanel.tsx',
  'src/components/panels/browserPanel/SignInNotices.tsx',
  'src/components/pages/settings/Browser.tsx',
  'src/components/pages/settings/BrowserUse.tsx',
  'src/components/pages/settings/ComputerUse.tsx',
  'src/components/browser/ClaudeInChromeNote.tsx',
  'src/lib/turnStall.ts',
  'src/lib/useChromeContinuation.ts',
  'src/store/chats.ts',
  'src/store/answerRetired.ts',
  'src/store/liveAction.ts',
  'shared/chromeHandoff.mjs',
  'electron/capabilities/browser/siteRisk.cjs',
  'shared/netErrors.mjs',
  'shared/peerReasons.mjs',
  'shared/userError.mjs',
  'src/components/thread/PeerMessages.tsx',
];

/** Longer strings that stay, as `file|start of the string`, with why. Keep this list short. */
const LONGER: Record<string, string> = {
  'src/components/momo/home/HomeBanner.tsx|is offline and still holds a copy':
    "the design's own words for a move that finished while the old machine was offline (W1.2)",
  'src/components/momo/home/HomeBanner.tsx|Chat and the morning brief wait': "the design's own words for a move in progress (W1.1)",
  'src/components/momo/home/HomeBanner.tsx|MoMo can’t think until an agent is installed':
    "the design's own words for an agent that is missing on the home (section 1, When it fails)",
  'src/components/momo/home/HomeBanner.tsx|MoMo can’t think until it is signed in':
    "the design's own words for an agent that is signed out on the home (W1.4)",
  'shared/chromeHandoff.mjs|with Claude in Chrome: call': 'tells the model how to reach the handed-off tab',
  'shared/chromeHandoff.mjs|with the Codex Browser plugin in the user': 'tells the model how to reach the handed-off tab',
  "shared/chromeHandoff.mjs|with the Codex Browser plugin on MoPilot's": 'tells the model how to reach the handed-off tab',
  'shared/chromeHandoff.mjs|with your Chrome tools: call': 'tells the model how to reach the handed-off tab',
  'shared/chromeHandoff.mjs|with your Chrome browser tools at': 'tells the model how to reach the handed-off tab',
  'shared/chromeHandoff.mjs|The user moved this sign-in to their Chrome': 'the tool result the model reads after a hand-off',
  'shared/chromeHandoff.mjs|in their Chrome at':
    "the hidden routing note of a continuation; only the model reads it (the user's bubble shows one short line)",
  'shared/chromeHandoff.mjs|Continue the current browser task in Your Chrome':
    "the hidden routing note of a continuation; only the model reads it (the user's bubble shows one short line)",
  'electron/capabilities/browser/siteRisk.cjs|: high risk. Reading it needs': 'the tool result the model reads about a risky site',
  "shared/netErrors.mjs|Couldn't show this page (": 'the tool result the model reads about a form result it must not resubmit',
  'shared/browserNotice.mjs|blocked_address ': 'the tool result the model reads when a page tried to open a non-web address',
  'shared/browserNotice.mjs|app_link ': 'the tool result the model reads when a page tried to open an app link',
  "shared/browserNotice.mjs|Couldn't load this page: its security": 'the tool result the model reads about an untrusted certificate',
  "shared/browserNotice.mjs|Didn't reload ": 'the tool result the model reads about a form result it must not reload',
  "shared/browserNotice.mjs|isn't responding: a script on the page": 'the error the model reads for a page that stopped responding',
  "src/components/thread/HandoffStrip.tsx|I'm done in ": 'the message the chat sends for the user to continue; the model reads it',
};

/** Every over-long prose string on the surfaces, with the LONGER entries that list it. */
const LONG = [...CARDS.map((file) => [file, CARD] as const), ...NOTICES.map((file) => [file, NOTICE] as const)].flatMap(([file, max]) =>
  proseStrings(fs.readFileSync(file, 'utf8'), file)
    .filter((s) => s.length > max)
    .map((s) => ({
      at: `${file}:${s.line} (${s.length} > ${max}) ${s.text}`,
      keys: Object.keys(LONGER).filter((k) => k.startsWith(`${file}|`) && s.text.startsWith(k.slice(file.length + 1))),
    })),
);

test('every prose string on the covered surfaces fits one line, or is listed with why', () => {
  assert.deepEqual(
    LONG.filter((s) => !s.keys.length).map((s) => s.at),
    [],
  );
});

test('every LONGER entry still matches a long string, so the list only shrinks', () => {
  const found = new Set(LONG.flatMap((s) => s.keys));
  assert.deepEqual(
    Object.keys(LONGER).filter((k) => !found.has(k)),
    [],
  );
});

test('proseStrings reads literals, templates and JSX runs, and skips code, imports and diagnostics', () => {
  const src = `import x from 'a b c d';
export { y } from 'e f g h';
export * from 'i j k l';
const a = 'one two three';
const b = \`hello there \${name} and \${other}\`;
ignoring('this is a log line');
console.warn('so is this one');
toast.error('a toast the user sees');
const c = <p className="a b c d" title="a tip with words">Allow {agent} to use {site}? <b>bold words here</b> after the {/* note */} tag ok</p>;
const d = <> <i>a</i>{cond} trailing words here</>;
const e = 'two words';
`;
  const got = proseStrings(src, 'x.tsx').map((s) => [s.line, s.text, s.length]);
  assert.deepEqual(got, [
    [4, 'one two three', 13],
    [5, 'hello there and', 15 + 2 * SLOT],
    [8, 'a toast the user sees', 21],
    [9, 'a tip with words', 16],
    [9, 'Allow to use ?', 14 + 2 * SLOT],
    [9, 'bold words here', 15],
    [9, 'after the tag ok', 16],
    [10, 'trailing words here', 19 + SLOT],
  ]);
});
