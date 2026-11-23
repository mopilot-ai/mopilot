// A chat as Markdown: the app's Share and Copy (src/session/transcript.ts) and a referenced chat's snapshot, built in the window (src/session/chatReference.ts) or in main for Chrome's side panel (electron/app/chromePanelMentions.cjs).
import { prettyCommand, parseUserText } from './userText.mjs';
import { stripDirectives } from './codexDirectives.mjs';

/** A fenced code block one backtick longer than any backtick run in `body`, so the body cannot close it. */
function fence(/** @type {string} */ lang, /** @type {string} */ body) {
  let longest = 2;
  for (const m of body.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  const ticks = '`'.repeat(longest + 1);
  return [ticks + lang, body, ticks];
}

/**
 * Render a chat as Markdown.
 * @param {string} title
 * @param {any[]} turns
 * @param {(turn: number) => string} [label] what ran each turn is called
 */
export function transcriptMarkdown(title, turns, label = () => 'Assistant') {
  const out = [`# ${title}`, ''];
  turns.forEach((t, i) => {
    const name = label(i);
    for (const it of t.items) {
      if (it.type === 'statusNote' && it.kind === 'switch') {
        out.push(`_${it.text}_`, '');
      } else if (it.type === 'userMessage') {
        const { text, annotations, chromeTab } = parseUserText(
          (it.content ?? [])
            .filter((/** @type {any} */ c) => c.type === 'text')
            .map((/** @type {any} */ c) => c.text)
            .join('\n'),
        );
        out.push('## User', '');
        for (const a of annotations) out.push(a.text.replace(/^/gm, '> '), '', ...(a.annotation ? [a.annotation, ''] : []));
        if (text) out.push(text, '');
        // the page it was sent from, in Chrome's side panel
        if (chromeTab) out.push(`_Chrome tab: ${chromeTab}_`, '');
      } else if (it.type === 'agentMessage' && it.text?.trim()) {
        out.push(
          it.phase === 'final_answer' ? `## ${name}` : `### ${name} (progress)`,
          '',
          stripDirectives(it.text, false, { streaming: t.status === 'inProgress' }),
          '',
        );
      } else if (it.type === 'commandExecution') {
        out.push(...fence('sh', `$ ${prettyCommand(it.command)}\n${(it.aggregatedOutput ?? '').trimEnd()}`), '');
      } else if (it.type === 'fileChange') {
        for (const c of it.changes ?? []) out.push(`Edited \`${c.path}\``, '', ...fence('diff', c.diff ?? ''), '');
      }
    }
  });
  return out.join('\n');
}
