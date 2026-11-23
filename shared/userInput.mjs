// A typed message and its attachments as the harness's user input items (Codex's UserInput shape): main sends them to
// Codex (electron/harness/codexParams.cjs) and shows them in a Claude turn it translates (electron/harness/items/claude.cjs);
// a window shows them in the turn it starts (src/store/send.ts). One shape, so the three agree.
import { withChatReferences } from './chatReferences.mjs';
import { withSelections } from './selections.mjs';
import { withTabMentions } from './tabMentions.mjs';

/** A skill chip goes ahead of a message's text as a command, so nothing may go ahead of it. */
export const hasSkill = (/** @type {unknown} */ attachments) => Array.isArray(attachments) && attachments.some((a) => a?.kind === 'skill');

/**
 * @param {string} text
 * @param {Array<{ kind: string, name?: string, path?: string }>} [attachments]
 * @param {{ tabsFor?: string }} [o] tabsFor: the plugin a referenced Chrome tab becomes a mention of (Codex's browser plugin)
 */
export function userInput(text, attachments = [], { tabsFor } = {}) {
  const input = [];
  const body = withChatReferences(
    withSelections(
      tabsFor ? withTabMentions(text, tabsFor) : text,
      attachments.filter((a) => a.kind === 'selection'),
    ),
    attachments,
  );
  if (body.trim()) input.push({ type: 'text', text: body, text_elements: [] });
  for (const a of attachments) {
    // shared memories are sent as their harness takes them (shared/computerHistory.mjs), never shown as typed
    if (a.kind === 'selection' || a.kind === 'session' || a.kind === 'computerHistory') continue;
    if (a.kind === 'audio') input.push({ type: 'localAudio', path: a.path });
    else if (a.kind === 'image') input.push({ type: 'localImage', path: a.path });
    else if (a.kind === 'skill') input.push({ type: 'skill', name: a.name, path: a.path });
    else input.push({ type: 'mention', name: a.name, path: a.path });
  }
  return input;
}
