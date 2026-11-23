// The computer-use calls a fake harness's prompt asks for ("CUCALL <tool> <json>" / "MCPCU <tool> <json>" lines), shared by fake-codex, fake-claude and fake-codex-mcp; a message from another chat (<mopilot-peer-message>) asks for the calls its body holds.

/** Each message from another chat in the prompt (shared/peerPrompt.mjs: a JSON payload) as its body, on lines of its own. */
const peerBodies = (text) =>
  text.replace(/<mopilot-peer-message>\n(.*)\n<\/mopilot-peer-message>/g, (_whole, payload) => {
    try {
      return `\n${JSON.parse(payload).body ?? ''}\n`;
    } catch {
      return '';
    }
  });

/**
 * A switched chat's first message quotes the earlier chat in a <sage-handoff> block: the calls quoted there are not this
 * turn's. A peer message is read as the lines its body holds.
 */
const withoutHandoff = (text) => peerBodies(text.replace(/<sage-handoff[\s\S]*?<\/sage-handoff>/g, ''));

/** Every "<keyword> <tool> <json>" line of the prompt, in order (matchAll results: [line, tool, json]). */
export const callLines = (text, keyword = 'CUCALL') => [
  ...withoutHandoff(text).matchAll(new RegExp(`^${keyword} (\\S+) (\\{.*\\})$`, 'gm')),
];

/** The first CUCALL anywhere in the prompt (inside a sentence too), its JSON taken to the line's last "}" so nested objects stay whole. */
const INLINE_CALL = /(?<!SUB)CUCALL (\S+) (\{.*\})/;

/** The prompt's CUCALL lines, each run in order; with none, the first CUCALL anywhere in it (#2460). */
export function cuCallsOf(text) {
  const lines = callLines(text);
  return lines.length > 0 ? lines : [INLINE_CALL.exec(withoutHandoff(text))].filter((m) => m !== null);
}
