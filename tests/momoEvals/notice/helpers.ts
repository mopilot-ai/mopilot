// Shared helpers for the notice evaluation suites: a seeded random source, a scripted model, mail builders and a pass runner over a shared store.
import { noticeSettings, type NoticeSettings } from '../../../shared/momoNotice/limits.ts';
import { createMemoryNoticeStore, createMemoryVersionStore } from '../../../shared/momoNotice/memoryStore.ts';
import { runNoticePass, type Decision, type PassResult } from '../../../shared/momoNotice/pipeline.ts';
import { EVAL_PERSON } from '../../../shared/momoNotice/eval/triageEval.ts';
import type { MailMessage, NoticeStore, ReaderModel, VersionStore, Verdict } from '../../../shared/momoNotice/types.d.ts';

/** mulberry32: a small deterministic generator, so a failing seed can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

export const mailFor = (threadId: string, extra: Partial<MailMessage> = {}): MailMessage => ({
  id: `m-${threadId}`,
  threadId,
  from: 'Ana Pereira <ana@hearthandco.com>',
  to: [EVAL_PERSON.email],
  cc: [],
  subject: `Subject ${threadId}`,
  date: '2026-10-22T10:00:00Z',
  headers: {},
  labels: ['INBOX'],
  body: 'Can you confirm today?',
  ...extra,
});

export type Home = { store: NoticeStore; versions: VersionStore };
export const newHome = (): Home => ({ store: createMemoryNoticeStore(), versions: createMemoryVersionStore() });

/** A model that answers each call from `answers` (by thread id in the prompt), defaulting to `fallback`. */
export function modelFor(answers: Record<string, { verdict: Verdict; matterKey?: string }>, fallback: Verdict = 'tell_now'): ReaderModel {
  return {
    name: 'scripted',
    complete: async (prompt) => {
      const thread = /The matterKey is gmail:([^\s,]+?)(?:\.\s|,)/.exec(prompt)?.[1] ?? '';
      const answer = answers[thread] ?? { verdict: fallback };
      return JSON.stringify({ verdict: answer.verdict, reason: 'Scripted.', matterKey: answer.matterKey ?? `gmail:${thread}` });
    },
  };
}

let version = 0;
let ids = 0;
/** One pass over `threadIds` (all mails) at `at` in `timeZone`; `lastRunAt` makes a catch-up when the gap is long. */
export async function pass(
  home: Home,
  threadIds: string[],
  at: Date,
  options: {
    timeZone?: string;
    settings?: NoticeSettings;
    /** The previous pass; by default one minute before `at`. */
    lastRunAt?: Date;
    /** The first pass after connecting: no lastRunAt at all. */
    firstConnect?: boolean;
    model?: ReaderModel;
    mails?: Record<string, Partial<MailMessage>>;
  } = {},
): Promise<PassResult> {
  const mails = new Map(threadIds.map((id) => [id, mailFor(id, options.mails?.[id])]));
  return runNoticePass(
    {
      store: home.store,
      versions: home.versions,
      model: options.model ?? modelFor({}),
      person: EVAL_PERSON,
      clock: { now: () => at },
      settings: options.settings ?? noticeSettings(options.timeZone ?? 'America/Los_Angeles'),
      history: { knownDomains: async () => ['hearthandco.com'] },
      randomId: () => `rid-${(ids += 1)}-eval`,
      ...(options.firstConnect ? {} : { lastRunAt: options.lastRunAt ?? new Date(at.getTime() - 60_000) }),
      load: async (change) => ({ kind: 'mail', mail: mails.get((change as { threadId: string }).threadId) as MailMessage }),
    },
    threadIds.map((threadId) => ({ kind: 'mail' as const, threadId, version: `v${++version}` })),
  );
}

/** The matter key a thread has in the store. */
export const matterOf = (threadId: string): string => `gmail:${threadId}`;

export const count = (decisions: Decision[], outcome: string): number => decisions.filter((d) => d.outcome === outcome).length;
