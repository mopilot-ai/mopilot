// What the fake Claude CLI's chat sessions received, apart from the app's background queries (title helper, /usage probe, extensions).
import type { Harness } from './app';

/**
 * pid -> argv of every fake Claude process that ran a chat session (not a probe or helper). The app also starts
 * title helpers and /usage probes on its own schedule, so "the last user message in the log" may be one of those.
 * The summary handoff's unpersisted fork (--fork-session) resumes the chat but is not it.
 */
export function claudeChatProcesses(h: Harness) {
  const out = new Map<number, string[]>();
  for (const e of h.claudeLog())
    if (e.kind === 'argv' && e.argv.some((a) => /^--(session-id|resume)=/.test(a)) && !e.argv.includes('--fork-session'))
      out.set(e.pid, e.argv);
  return out;
}

/** The user messages chat sessions received, in order. */
export function claudeChatMessages(h: Harness): any[] {
  const chats = claudeChatProcesses(h);
  return h
    .claudeLog()
    .filter((e) => e.kind === 'in' && chats.has(e.pid) && e.msg.type === 'user')
    .map((e) => (e as { msg: any }).msg);
}

/** A user message's text: its string content, or its blocks' text joined. */
export function claudeTextOf(m: any): string {
  if (!m) throw new Error('no chat session received a message (no fake Claude process started with --session-id= or --resume=)');
  return typeof m.message.content === 'string' ? m.message.content : m.message.content.map((b: any) => b.text ?? '').join('');
}

/** Every user message any fake Claude process received, chat or not: for checking that something never reached Claude. */
export const claudeAllUserTexts = (h: Harness): string[] =>
  h
    .claudeLog()
    .filter((e) => e.kind === 'in' && e.msg?.type === 'user')
    .map((e) => claudeTextOf((e as { msg: any }).msg));
