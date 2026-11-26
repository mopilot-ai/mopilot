// Read one predicted user prompt from a completed Codex turn's context.
const { noteIgnored } = require('../ignored.cjs');

const PREDICT =
  'Predict the next message the user is likely to type in this conversation. Output only a short, editable prompt in the user’s language and voice. Return an empty response if there is no clear follow-up. Do not answer the user or use tools.';

/** @param {InstanceType<typeof import('./codex.cjs').CodexAdapter>} codex */
async function samplePromptSuggestion(codex, threadId, turnId) {
  if (!codex?.request || codex.isolation?.applies({ threadId })) return null;
  try {
    const result = await codex.request(
      'thread/sample',
      { threadId, expectedTurnId: turnId, prompt: PREDICT, disableMcp: true },
      { timeoutMs: 8000, background: true },
    );
    return result?.sourceTurnId === turnId && typeof result.text === 'string' ? result.text : null;
  } catch (error) {
    noteIgnored('read a Codex composer prediction', error);
    return null;
  }
}

module.exports = { samplePromptSuggestion };
