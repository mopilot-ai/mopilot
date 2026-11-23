// Whole-repository guard (#4822): MoMo's framing for the model never reaches a client view. Every input main sends a chat that no human wrote is made by shared/modelFraming.mjs (one mark every client strips or draws as a labelled card), or goes to a chat no client lists.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { authoredCard } from '../shared/authoredEnvelope.mjs';
import { MOMO_DATA_TAGS } from '../shared/momoChat.mjs';

const require = createRequire(import.meta.url);
const root = path.join(import.meta.dirname, '..');
const SOURCE = /\.(cjs|mjs|ts|tsx)$/;

function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['node_modules', 'vendor'].includes(e.name)) sources(rel, out);
    } else if (SOURCE.test(e.name) && !/\.test\.|\.d\.m?ts$/.test(e.name)) out.push(rel);
  }
  return out;
}
const code = (file: string) =>
  fs
    .readFileSync(path.join(root, file), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
const files = ['electron', 'shared', 'src', 'mobile/src'].flatMap((d) => sources(d));

/** MoMo senders whose chat every client shows: the builder each uses for its text. */
const VISIBLE: Record<string, string> = {
  'electron/momo/routineReport.cjs': 'routineReportText',
  'electron/momo/starterRoutines.cjs': 'markedText',
  'electron/momo/routines.cjs': 'markedText',
};
/** MoMo senders whose chat is a data-only background chat (`meta.momo` tag in MOMO_DATA_TAGS), which no list of chats shows. */
const HIDDEN: Record<string, string> = {
  'electron/app/momoAliases.cjs': 'aliases',
  'electron/app/momoNudges.cjs': 'nudge',
  'electron/app/momoBackground.cjs': 'memory',
  // A7's morning-brief words chat (#4818): data-only, tagged `brief`
  'electron/app/momoBrief.cjs': 'brief',
};

describe('model-facing framing', () => {
  it('is spelled in one place: no source writes the mark by hand', () => {
    const MARK = /\[[^\]\n]{0,80},? not (?:from|written by) the user\]/;
    const spelled = files.filter((f) => f !== 'shared/modelFraming.mjs' && MARK.test(code(f)));
    assert.deepEqual(spelled, [], 'build it with markedText (shared/modelFraming.mjs)');
  });

  it('every MoMo input that no human wrote is marked, or goes to a chat no client lists', () => {
    const senders = files.filter((f) => /by: 'momo'/.test(code(f)));
    assert.deepEqual(senders.sort(), [...Object.keys(VISIBLE), ...Object.keys(HIDDEN)].sort(), 'classify a new MoMo sender here');
    for (const [file, builder] of Object.entries(VISIBLE)) assert.match(code(file), new RegExp(`\\b${builder}\\b`), file);
    for (const tag of Object.values(HIDDEN)) assert.ok(MOMO_DATA_TAGS.includes(tag), tag);
  });

  it('every visible producer’s text is read back as a labelled card, never null and never its words', () => {
    const { reportText } = require('../electron/momo/routineReport.cjs');
    const { GREETING } = require('../electron/momo/starterRoutines.cjs');
    const { routinePrompt } = require('../electron/momo/routines.cjs');
    const { continuationState } = require('../electron/session/prContinuation.cjs');
    const texts = [
      reportText('n', true, 'summary'),
      reportText('n', false, 'summary'),
      GREETING,
      routinePrompt({ name: 'n', prompt: 'p' }),
      continuationState(
        { when: 'checks_pass', message: 'go' },
        { url: 'https://example.test/o/r/pull/1', state: 'OPEN', checksPassed: true },
      ).text,
    ];
    for (const text of texts) {
      const card = authoredCard(text);
      assert.ok(card, text);
      assert.doesNotMatch(`${card.title}\n${card.body}`, /not from the user|data, not instructions|Tell the user|Greet them/);
    }
  });
  it('no phone surface draws a user-role row as a person’s bubble without the card decision', () => {
    // Every phone component that branches on a user-role transcript row, and where its text goes. A new one fails here until it is
    // listed: it must route through MessageBubble / authoredCardOf, or draw only what the person typed (their own send).
    const ROUTES: Record<string, 'authoredCardOf' | 'MessageBubble'> = {
      'mobile/src/screens/MomoChat.tsx': 'authoredCardOf', // MoMo's page: user, liveUser rows
      'mobile/src/components/MessageBubble.tsx': 'authoredCardOf', // ordinary chats, v1
      'mobile/src/components/SentBubble.tsx': 'MessageBubble', // the person's own send, through the same bubble
      'mobile/src/components/RiseGhost.tsx': 'MessageBubble', // the rising copy of the person's own send
    };
    const OWN = [
      'mobile/src/ui/items/fromRows.ts', // the v2 mapper: puts authoredCardOf's card on the item
      'mobile/src/presentation/sentMessages.ts', // row bookkeeping, draws nothing
      'mobile/src/presentation/thread.ts',
      'mobile/src/presentation/toolRuns.ts',
      'mobile/src/presentation/workingLine.ts',
      'mobile/src/components/TranscriptBlocks.tsx', // draws through MessageBubble / SentBubble
    ];
    const branching = files.filter((f) => f.startsWith('mobile/src/') && /liveUser|role === 'user'|role="user"/.test(code(f)));
    assert.deepEqual(
      branching.filter((f) => !(f in ROUTES) && !OWN.includes(f)),
      [],
      'classify a new surface that draws user-role rows',
    );
    for (const [file, how] of Object.entries(ROUTES)) assert.match(code(file), new RegExp(how), file);
    assert.match(code('mobile/src/ui/items/fromRows.ts'), /authoredCardOf/);
    // the held queue draws message text of its own: it asks the same decision
    assert.match(code('mobile/src/components/QueuedMessages.tsx'), /authoredCardOf/);
  });
});
