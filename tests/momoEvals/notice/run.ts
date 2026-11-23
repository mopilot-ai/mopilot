// Runs one labelled triage item (or a thread of them) through the real notice pipeline with an oracle model and reports what the code did wrong.
import { runNoticePass, type Decision } from '../../../shared/momoNotice/pipeline.ts';
import { noticeSettings } from '../../../shared/momoNotice/limits.ts';
import { createMemoryNoticeStore, createMemoryVersionStore } from '../../../shared/momoNotice/memoryStore.ts';
import { fromDomain } from '../../../shared/momoNotice/senderCheck.ts';
import { holdsAccessSecret } from '../../../shared/momoNotice/preChecks.ts';
import { readingPrompt } from '../../../shared/momoNotice/reading.ts';
import { EVAL_PERSON } from '../../../shared/momoNotice/eval/triageEval.ts';
import type { NoticeStore, ReaderModel, VersionStore, Verdict } from '../../../shared/momoNotice/types.d.ts';
import { ITEMS, type Item } from './items.ts';

/** A weekday morning at 10:00 Pacific, outside quiet hours, with a home that has not slept. */
export const RUN_NOW = new Date('2026-10-22T17:00:00Z');
export const RUN_ZONE = 'America/Los_Angeles';

let ids = 0;

/** The correspondents the user knows: the senders of every item that expects a reply draft (a genuine DMARC pass from a known domain). */
const KNOWN_DOMAINS = [
  'hearthandco.com',
  ...new Set(ITEMS.filter((i) => i.offerReply === true && i.mail).map((i) => fromDomain(i.mail!.from) as string)),
];

export type Check = { check: string; ok: boolean; expected: string; got: string };

const outcomeFor = (verdict: Verdict) => (verdict === 'tell_now' ? 'tell_now' : verdict === 'track' ? 'watch' : 'quiet');

/** The model's answer for one item: whatever the label (or the trap) says. The tool-less reading prompt is recorded for the wrapper checks. */
function oracle(item: Item, prompts: string[]): ReaderModel {
  const verdict = item.modelSays ?? item.expected;
  const key = item.mail ? `gmail:${item.mail.threadId}` : `calendar:${item.event?.id ?? item.id}`;
  return {
    name: 'oracle',
    complete: async (prompt) => {
      prompts.push(prompt);
      return JSON.stringify({ verdict, reason: 'Labelled by the evaluation set.', matterKey: key });
    },
  };
}

export type Shared = { store: NoticeStore; versions: VersionStore };
export const freshState = (): Shared => ({ store: createMemoryNoticeStore(), versions: createMemoryVersionStore() });

/** Processes one item against `state` and returns the decision plus the prompts the model saw. */
export async function runItem(
  item: Item,
  state: Shared,
  at: Date = RUN_NOW,
): Promise<{ decision: Decision | undefined; prompts: string[] }> {
  const prompts: string[] = [];
  const loaded = item.mail ? ({ kind: 'mail', mail: item.mail } as const) : ({ kind: 'event', event: item.event! } as const);
  const change = item.mail
    ? ({ kind: 'mail', threadId: item.mail.threadId, version: `v-${item.id}` } as const)
    : ({ kind: 'event', eventId: item.event!.id, version: `v-${item.id}`, event: item.event! } as const);
  const result = await runNoticePass(
    {
      store: state.store,
      versions: state.versions,
      model: oracle(item, prompts),
      person: EVAL_PERSON,
      clock: { now: () => at },
      settings: noticeSettings(RUN_ZONE),
      history: { knownDomains: async () => KNOWN_DOMAINS },
      randomId: () => `rid-${(ids += 1)}-eval`,
      lastRunAt: new Date(at.getTime() - 60_000),
      load: async () => loaded,
    },
    [change],
  );
  return { decision: result.decisions[0], prompts };
}

/** All checks for one item; an item that follows another (`after`) is run after its predecessors in one store. */
export async function evaluateItem(item: Item): Promise<Check[]> {
  const chain: Item[] = [];
  for (let cursor: Item | undefined = item; cursor; cursor = cursor.after ? ITEMS.find((i) => i.id === cursor!.after) : undefined)
    chain.unshift(cursor);
  const state = freshState();
  let last: Awaited<ReturnType<typeof runItem>> | undefined;
  for (const step of chain) last = await runItem(step, state);
  const { decision, prompts } = last!;
  const checks: Check[] = [];
  const add = (check: string, expected: unknown, got: unknown) =>
    checks.push({
      check,
      ok: JSON.stringify(expected) === JSON.stringify(got),
      expected: JSON.stringify(expected),
      got: JSON.stringify(got),
    });
  if (!decision) {
    add('decided', true, false);
    return checks;
  }
  const verdict = item.modelSays ?? item.expected;
  const pre = item.pre ?? (item.expected === 'quiet' ? 'any' : 'none');
  if (pre === 'private') {
    add(
      'private pre-check',
      { outcome: 'quiet', decidedBy: 'rule:access-secret', private: true, modelCalls: 0 },
      {
        outcome: decision.outcome,
        decidedBy: decision.decidedBy,
        private: decision.private,
        modelCalls: prompts.length,
      },
    );
  } else {
    add('outcome', outcomeFor(verdict), decision.outcome === 'hold' ? `hold:${decision.heldFor}` : decision.outcome);
    if (pre === 'none') add('no pre-check silenced it', false, decision.decidedBy.startsWith('rule:'));
    // `private` marks a mail that holds a sign-in code or reset link (redacted before any model saw it), whether or not it was silenced
    add(
      'not private unless the mail holds a secret',
      false,
      decision.private && pre !== 'any' && !(item.mail && holdsAccessSecret(item.mail)),
    );
  }
  if (item.offerReply !== undefined && decision.outcome === 'tell_now') add('offerReply', item.offerReply, decision.offerReply);
  if (item.injection !== undefined) add('injection flagged', item.injection, decision.injection.length > 0);
  for (const prompt of prompts) {
    const starts = prompt.match(/<<<EXTERNAL_UNTRUSTED_CONTENT id="rid-\d+-eval">>>/g)?.length ?? 0;
    const ends = prompt.match(/<<<END_EXTERNAL_UNTRUSTED_CONTENT id="rid-\d+-eval">>>/g)?.length ?? 0;
    // one envelope for the item, and one more when code offers candidate matters; never an unmatched or forged one
    add('prompt has balanced data envelopes, one per block code wrote', true, starts >= 1 && starts === ends && starts <= 2);
  }
  return checks;
}

export { readingPrompt };
