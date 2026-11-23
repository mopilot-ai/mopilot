// Bounded tool-call details and one real screenshot preview for Chrome-panel step disclosures.
const { toolOutput, imageSrc } = require('../../../shared/toolOutput.mjs');
const { prefixUnits } = require('../../../shared/textPrefix.mjs');
const { toolInvocation, isInvocationServer } = require('../../../shared/toolInvocation.mjs');
const shortened = (text, max) => (text.length > max ? `${prefixUnits(text, max - 1)}…` : text);

function preview(value, depth = 0) {
  if (typeof value === 'string') return shortened(value, 600);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '[Nested value]';
  if (Array.isArray(value)) return value.slice(0, 12).map((v) => preview(v, depth + 1));
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 12)
        .map(([k, v]) => [k, preview(v, depth + 1)]),
    );
  return String(value);
}

function stepDetails(item) {
  item = toolInvocation(item);
  const raw = String(item.tool ?? '');
  const chrome = item.server
    ? ['mopilot_chrome', 'claude-in-chrome'].includes(item.server) || (isInvocationServer(item.server) && /^chrome_/.test(raw))
    : /^(?:mcp__(?:mopilot_chrome|claude-in-chrome)__|chrome_)/.test(raw);
  const blocks = item.result?.content ?? item.contentItems;
  const output = toolOutput({
    error: item.error,
    contentItems: Array.isArray(blocks)
      ? blocks
          .slice(0, 20)
          .filter((b) => b?.type === 'image' || b?.type === 'inputImage' || typeof b?.text === 'string')
          .map((b) => (typeof b.text === 'string' ? { ...b, text: shortened(b.text, 2000) } : b))
      : [],
  });
  const args = item.arguments ?? item.command;
  const text = [
    args === undefined ? '' : `Input (preview)\n${JSON.stringify(preview(args), null, 2)}`,
    output.text ? `Result (preview)\n${shortened(output.text, 2000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const thumbnail = imageSrc({ imageUrl: item.panelThumbnail }) ?? output.images.at(-1);
  return {
    ...(text ? { detail: shortened(text, 4000) } : {}),
    ...(chrome ? { surface: 'chrome' } : {}),
    ...(chrome && typeof thumbnail === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(thumbnail) && thumbnail.length <= 400_000
      ? { thumbnail }
      : {}),
  };
}

module.exports = { stepDetails };
