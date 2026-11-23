// OMP's structured tool results provide stdout and explicit exit metadata without treating background work as exited.
const contentText = (block) => (block?.type === 'content' && block.content?.type === 'text' ? block.content.text : undefined);
function normalizeUpdate(update) {
  if (update?.sessionUpdate !== 'tool_call_update') return update;
  if (!Array.isArray(update.content)) return update;
  const echo = contentText(update.content[0]);
  if (typeof echo !== 'string' || !echo.startsWith('$ ')) return update;
  const raw = update.rawOutput && typeof update.rawOutput === 'object' && !Array.isArray(update.rawOutput) ? update.rawOutput : {};
  const texts = (Array.isArray(raw.content) ? raw.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text);
  const streams = [raw.stdout, raw.stderr].filter((text) => typeof text === 'string');
  const text = streams.length
    ? streams.join('\n')
    : ([raw.output, raw.output_for_prompt, update.rawOutput].find((value) => typeof value === 'string') ?? texts.join('\n'));
  const exitCode = [raw.exitCode, raw.exit_code, raw.details?.exitCode].find(Number.isSafeInteger) ?? null;
  const output = { ...raw, output: text, exitCode };
  const content = [
    { type: 'content', content: { type: 'text', text } },
    ...update.content.slice(1).filter((block) => !texts.includes(contentText(block)) && contentText(block) !== text),
  ];
  return { ...update, content, rawOutput: output };
}

// These internal errors mean provider configuration is missing, rather than a failed tool call.
module.exports = {
  normalizeUpdate,
  setup: {
    reason: 'Configure an oh-my-pi provider in its terminal first',
    error: /No model selected\.|No API key found for /,
    matchesError: (error) =>
      error?.code === -32603 &&
      typeof error.data?.details === 'string' &&
      (error.data.details.startsWith('No model selected.\n\nUse /login') || error.data.details.startsWith('No API key found for ')),
  },
};
