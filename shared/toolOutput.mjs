// Inline tool output shared by desktop cards and the Chrome panel: text and actual MCP, Anthropic or Codex images.
const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/\r\n]+={0,2}$/;

export function imageSrc(block) {
  const mime = block?.mimeType ?? block?.source?.media_type ?? block?.source?.mime_type;
  const data = block?.data ?? (block?.source?.type === 'base64' ? block.source.data : null);
  const src = typeof data === 'string' && IMAGE_MIME.test(mime ?? '') ? `data:${mime};base64,${data}` : block?.imageUrl;
  return typeof src === 'string' && IMAGE_DATA_URL.test(src) ? src : null;
}

export function toolOutput(item, skipText) {
  if (item?.error?.message) return { text: item.error.message, images: [] };
  const images = [];
  const lines = [];
  const blocks = item?.result ? (item.result.content ?? []) : (item?.contentItems ?? []);
  for (const block of blocks) {
    if (block?.type === 'image' || block?.type === 'inputImage') {
      const src = imageSrc(block);
      if (src) images.push(src);
      else lines.push('Image preview unavailable');
    } else if (block?.type === 'text' || typeof block?.text === 'string') {
      if (!skipText?.(block.text)) lines.push(block.text);
    } else lines.push(JSON.stringify(block, null, 2));
  }
  return { text: lines.join('\n'), images };
}
