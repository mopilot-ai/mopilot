// The bug report dialog's data: the chat snapshot it sends, and the report as a file (its event: ./bugReportEvent).
import { chatKind } from '../store/chats';
import { get as getState, threadTitle } from '../store/core';
import { acpModelName } from './harness/acp';
import { sessionOf } from '../store/session/useSession';
import { labelAt, transcriptMarkdown } from './transcript';
import { isMomoChat } from '../lib/momoChats';
import type { BugReport } from '../lib/native/app';

/** The chat part of a report, read once when the dialog opens: a chat closed or changed later doesn't change it. */
export interface ChatSnapshot {
  /** false when there is no chat (or it is gone): the dialog says "No chat attached" */
  attached: boolean;
  harness: string | null;
  model: string | null;
  transcript: string;
}

/**
 * The chat as it is now: its Markdown transcript from the turns every harness normalizes to (labelled by the harness
 * that ran each one, so a chat that switched harness reads right), the harness it is on now and its model.
 */
export function chatSnapshot(threadId: string | null, s = getState()): ChatSnapshot {
  const thread = threadId ? s.threads[threadId] : undefined;
  // a MoMo chat is personal (memory, calendar, mail): its transcript never goes into a report
  if (!threadId || !thread || isMomoChat(s.momoChats, threadId)) return { attached: false, harness: null, model: null, transcript: '' };
  return {
    attached: true,
    harness: chatKind(threadId, s),
    model: s.runtime[threadId]?.settings?.model ?? acpModelName(sessionOf(threadId).acp?.configOptions) ?? null,
    transcript: transcriptMarkdown(
      threadTitle(thread),
      s.runtime[threadId]?.turns ?? [],
      labelAt(threadId, s.segments[threadId], s.runtime[threadId]?.turnsAbove),
    ),
  };
}

/** A code fence one backtick longer than any run of backticks in `body`, so the body cannot end it. */
function fenced(body: string, lang = ''): string[] {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return [ticks + lang, body, ticks];
}

/** The report as a Markdown file, for "Save report to file" when it can't be sent. */
export function reportFileText(r: BugReport): string {
  const head: [string, string | null][] = [
    ['Kind', r.kind],
    ['App', `MoPilot ${r.appVersion} (${r.channel})`],
    ['OS', `${r.os} ${r.arch}`],
    ['Harness', r.harness ? `${r.harness}${r.harnessVersion ? ` ${r.harnessVersion}` : ''}` : null],
    ['Model', r.model],
    ['Install', r.installId],
  ];
  return [
    '# MoPilot bug report',
    '',
    ...head.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## What happened',
    '',
    r.description || '(no description)',
    '',
    '## Environment',
    '',
    ...fenced(JSON.stringify({ ...r.env, errorFingerprints: r.errorFingerprints }, null, 2), 'json'),
    '',
    '## Diagnostics',
    '',
    ...fenced(r.diagnostics),
    '',
    '## Transcript',
    '',
    r.transcript || '(no chat attached)',
    '',
  ].join('\n');
}

/** The file name a saved report is offered under. */
export const reportFileName = (now = new Date()) => `mopilot-bug-report-${now.toISOString().slice(0, 10)}.md`;
