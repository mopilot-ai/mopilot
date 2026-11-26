// Translate ACP prompt suggestion updates into the first complete textual prompt the composer can offer.

function acpPromptSuggestion(update) {
  if (update.sessionUpdate === 'prompt_suggestions_update' && Array.isArray(update.suggestions)) {
    for (const entry of update.suggestions) {
      const blocks = entry?.prompt;
      if (!Array.isArray(blocks) || !blocks.every((block) => block?.type === 'text' && typeof block.text === 'string')) continue;
      const text = blocks
        .map((block) => block.text)
        .join('')
        .trim();
      if (text) return text;
    }
    return null;
  }
  const list = update.sessionUpdate === 'session_info_update' && update._meta?.promptSuggestions?.suggestions;
  if (Array.isArray(list)) return list.find((entry) => typeof entry?.text === 'string' && entry.text.trim())?.text ?? null;
  return undefined;
}

module.exports = { acpPromptSuggestion };
