// Selected text, response annotations and diff comments as context around the prompt, the same in the renderer's echo and every harness.
import { formatDiffComments } from './diffComments.mjs';

/** Keep the renderer's message echo and every harness's outgoing context identical. */
export function withSelections(prompt, selections) {
  if (!selections.length) return prompt;
  const diffComments = selections.filter((s) => typeof s !== 'string' && s.diff);
  const annotations = selections.filter((s) => typeof s !== 'string' && !s.diff && (s.annotationId || s.annotation !== undefined));
  const snippets = selections.filter((s) => !annotations.includes(s) && !diffComments.includes(s));
  let context = '';
  if (annotations.length) {
    const json = JSON.stringify(
      annotations.map((s) => ({ text: s.text ?? '', ...(s.annotation ? { annotation: s.annotation } : {}) })),
    ).replace(/</g, '\\u003c');
    context += `\n# Response annotations:\n<response-annotations>\n${json}\n</response-annotations>\n`;
  }
  context += formatDiffComments(diffComments);
  if (snippets.length) {
    // JSON keeps arbitrary snippet headings and unfinished Markdown from becoming transport boundaries.
    const json = JSON.stringify(snippets.map((s) => (typeof s === 'string' ? s : (s.text ?? '')))).replace(/</g, '\\u003c');
    context += `\n# Selected text:\n<selected-text>\n${json}\n</selected-text>\n`;
  }
  return `${context}\n## My request:\n${prompt}\n`;
}
