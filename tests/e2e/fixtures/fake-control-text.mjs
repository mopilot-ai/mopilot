// Separates scripted fake-CLI controls from canonical app wake reports and roster metadata; original input remains display data.
import { rosterLine, wakeText, withoutRosterBlock } from '../../../shared/sideSessions.mjs';
import { MOMO_TAG, isMomoBlock } from '../../../shared/momoContext.mjs';

const event = (waiting = []) => wakeText({ notes: [], roster: '', waiting });
const plainEvent = event();
const eventOpen = plainEvent.slice(0, plainEvent.indexOf('>') + 1);
const rosterExample = rosterLine([{ name: 'fixture-worker', chatId: 'fixture-id', state: 'idle' }]);
const [rosterHead, rosterTail] = rosterExample.split('fixture-worker = fixture-id (idle)');
const name = /^[a-z0-9-]{1,24}$/;
const waitingForms = [['fixture-worker'], ['fixture-one', 'fixture-two']].map((names) => {
  const [before, after] = event(names).split(names.join(', '));
  return { before, after, count: names.length };
});

/** The text input each fake receives; images and other wire blocks are not scripted commands. */
export const fakeTextOf = (input) =>
  typeof input === 'string'
    ? input
    : (input || [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');

/**
 * The user's text without the MoMo context main put ahead of it (shared/momoContext.mjs withMomoContext): a model reads
 * that block, it does not repeat it, so a fake's echo is of what the user wrote. Anything else is left as it came.
 */
export function withoutMomoContext(text) {
  const close = `</${MOMO_TAG}>`;
  const at = text.startsWith(`<${MOMO_TAG}>\n`) ? text.indexOf(close) : -1;
  if (at < 0 || !isMomoBlock(text.slice(0, at + close.length)) || text[at + close.length] !== '\n') return text;
  return text.slice(at + close.length + 1);
}

/** A complete producer roster paragraph, including its optional main-owned notes directory. */
function roster(text) {
  if (!text.startsWith(rosterHead)) return false;
  const at = text.indexOf(rosterTail);
  if (at < rosterHead.length) return false;
  const members = text.slice(rosterHead.length, at).split('; ');
  if (!members.every((member) => /^(?:[a-z0-9-]{1,24}|parent \([a-z0-9-]{1,24}\)) = [^\s;]+ \([^()\n]+\)$/.test(member))) return false;
  const suffix = text.slice(at + rosterTail.length);
  return suffix === '' || /^ Shared session notes: [^\n]+\.$/.test(suffix);
}

// The prefixes and fixed endings come from noteText, heldNote, proposals, forget, childWork and scheduler.
// Variable titles, branches and errors may contain paragraphs, so a note is not split on arbitrary blank lines.
const noteForms = [
  /^The session "[\s\S]+?" you started \([\s\S]+? mention the outcome to the user in one line when it matters\.(?: Edited outside its declared paths [\s\S]+? Check those files before you rely on them\.)?(?=\n\n|$)/,
  /^The session [\s\S]+? so the sessions waiting for it are held: [\s\S]+? Mention it to the user in one line\.(?=\n\n|$)/,
  /^These sessions wait for each other in a loop, so they are held and never start: [\s\S]+? Mention it to the user in one line\.(?=\n\n|$)/,
  /^The user started your proposed task [\s\S]+? It runs on its own; you get a note when it ends a turn\.(?=\n\n|$)/,
  /^The session [^\n]+ was deleted\.(?: \d+ waiting messages? for it (?:was|were) not sent\.)?(?=\n\n|$)/,
  /^The chat that started this one \([\s\S]+?\) was deleted; this chat is top-level now\.(?=\n\n|$)/,
  /^The user merged [\s\S]+? in your folder\.(?=\n\n|$)/,
  /^A message waiting for the session [\s\S]+? was not sent: that chat is archived or gone\.(?=\n\n|$)/,
  /^A message for [\s\S]+? did not start: [\s\S]+$/,
];

function canonicalPrefix(text) {
  while (text) {
    if (roster(text)) return true;
    const note = noteForms.map((form) => form.exec(text)?.[0]).find(Boolean);
    if (!note) return false;
    text = text.slice(note.length).replace(/^\n\n/, '');
  }
  return true;
}

function canonicalEvent(text) {
  if (text === plainEvent) return true;
  return waitingForms.some(({ before, after, count }) => {
    if (!text.startsWith(before) || !text.endsWith(after)) return false;
    const names = text.slice(before.length, -after.length).split(', ');
    return (
      (count === 1 ? names.length === 1 : names.length > 1) &&
      names.every((value) => name.test(value)) &&
      new Set(names).size === names.length &&
      text === event(names)
    );
  });
}

/**
 * Claude supplies human provenance; Codex has no such wire field and passes unknown. On that wire an identical
 * human-pasted canonical app envelope is indistinguishable. Ordinary typed, child, peer and handoff controls stay intact.
 * @param {string} input
 * @param {'human'|'nonhuman'|'unknown'} provenance
 */
export function fakeControlText(input, provenance = 'unknown') {
  const text = withoutRosterBlock(input);
  if (provenance !== 'human') {
    const at = text.lastIndexOf(`\n\n${eventOpen}`);
    const body = text.startsWith(eventOpen) ? text : at < 0 ? '' : text.slice(at + 2);
    const prefix = body === text ? '' : at < 0 ? text : text.slice(0, at);
    if (canonicalEvent(body) && canonicalPrefix(prefix)) return '';
  }
  // A visible trailing roster can also contain a path named SLOW; it is metadata, not a scripted task.
  const split = text.lastIndexOf('\n\n');
  return split >= 0 && roster(text.slice(split + 2)) ? text.slice(0, split) : text;
}

/** The words a fake writes as another turn's search aliases (electron/momo/aliases.cjs): each one's other language. */
const FAKE_ALIASES = { dentist: '\u7259\u533b', landlord: '\u623f\u4e1c', lease: '\u79df\u7ea6', wednesday: '\u5468\u4e09' };

/**
 * A fake model's reply to MoMo's search-aliases prompt (electron/momo/aliases.cjs aliasPrompt): for each numbered turn,
 * the other language of the FAKE_ALIASES words it uses, as JSON; null for any other prompt.
 */
export function fakeAliasReply(text) {
  if (!/^For each numbered chat turn below, write up to \d+ search terms/.test(text)) return null;
  const out = {};
  for (const m of text.matchAll(/^\[(\d+)\] User: (.*)$/gm)) {
    const words = m[2].toLowerCase().match(/[a-z]+/g) ?? [];
    out[m[1]] = words
      .filter((w) => w in FAKE_ALIASES)
      .map((w) => FAKE_ALIASES[w])
      .join(' ');
  }
  return JSON.stringify(out);
}

/**
 * A fake model's reply to MoMo's memory pass over its main chat (electron/momo/memoryPass.cjs with openLoopsPass.cjs):
 * each user line that starts "NOECHO " becomes a fact, and one that also says "by …" an open loop quoting it, due an hour
 * after it was said (so a nudge is due at once); null for any other prompt.
 */
export function fakeLoopsReply(text) {
  if (!/^Read what the user and MoMo said below/.test(text) || !text.includes("Also keep the user's open loops")) return null;
  const loops = [];
  const ops = [];
  for (const m of text.matchAll(/^User \[\w{3} (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})\]: (.*)$/gm)) {
    if (!m[6].startsWith('NOECHO ')) continue;
    const said = m[6].slice('NOECHO '.length);
    ops.push({ op: 'add', text: said, confidence: 'sure' });
    if (!/\bby\b/.test(said)) continue;
    const due = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 3600_000).toISOString().slice(0, 16);
    loops.push({
      op: 'add',
      kind: 'promise',
      text: said.replace(/^I(?:'|\u2019)ll /i, '').slice(0, 120),
      quote: said,
      due,
      confidence: 'sure',
    });
  }
  return JSON.stringify({ ops, loops });
}

/** A fake model's reply to MoMo's nudge check (electron/momo/nudges.cjs): every candidate kept, as "Reminder: <loop>". */
export function fakeNudgeReply(text) {
  if (!/^You decide whether MoMo should bring these up/.test(text)) return null;
  const send = [...text.matchAll(/^- \[(n\d+)\] "([^"]*)"/gm)].map((m) => ({ id: m[1], text: `Reminder: ${m[2]}` }));
  return JSON.stringify({ send });
}

/**
 * A fake model's reply to MoMo's memory pass (electron/momo/memoryPass.cjs): each user line that starts "NOECHO " becomes
 * a fact in the user's words; null for any other prompt.
 */
export function fakeFactsReply(text) {
  if (!/^Read what the user and MoMo said below/.test(text)) return null;
  const ops = [...text.matchAll(/^User: NOECHO (.+)$/gm)].map((m) => ({ op: 'add', text: m[1], confidence: 'sure' }));
  return JSON.stringify({ ops });
}

/**
 * A fake model's reply to a line starting "NOECHO ": "Noted." instead of the echo, so what the user said is in their
 * message alone (an open loop's quote must be in nothing else the chat holds, and an echo would hold it).
 */
export const fakeQuietReply = (text) => (/^NOECHO /m.test(text) ? 'Noted.' : null);

/** STUBREPLY: the CLI's own stub record as the reply (MoMo must not draw it, #4926). */
export const fakeStubReply = (text) => (text.includes('STUBREPLY') ? 'No response requested.' : null);

/** OPTIONSREPLY: a question that ends with MoMo's answer-chips line (shared/momoOptions.mjs). */
export const fakeOptionsReply = (text) => (text.includes('OPTIONSREPLY') ? 'Shall I move your 3 pm?\nOptions: A | B | C' : null);

/** A fake model's reply to any of MoMo's data-only background prompts (aliases, memory pass, nudge check), or to NOECHO, else null. */
export const fakeMomoReply = (text) =>
  fakeAliasReply(text) ??
  fakeLoopsReply(text) ??
  fakeFactsReply(text) ??
  fakeNudgeReply(text) ??
  fakeQuietReply(text) ??
  fakeStubReply(text) ??
  fakeOptionsReply(text);
