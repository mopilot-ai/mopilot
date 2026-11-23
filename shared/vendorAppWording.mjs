// Vendor messages that tell the user to open or relaunch a vendor desktop app (ChatGPT, the Codex app, the Claude app), rewritten in MoPilot's words.
//
// Vendor plugins and tools (Codex's computer use and Browser plugin, Claude in Chrome, Claude's computer
// use) were written for their own desktop apps, so their errors say "relaunch ChatGPT" or "open the Claude
// app". In MoPilot those apps are not what runs the tool, and the user should never be sent to one:
// each such sentence becomes MoPilot's own advice, and the problem offers MoPilot's actions
// (try again, Settings → Computer use). Any other text is left as the vendor sent it.

/** What MoPilot says instead of sending the user to a vendor desktop app. */
export const MOPILOT_ADVICE = 'Try again in MoPilot. If it keeps failing, check Settings → Computer use.';

const VENDOR_APP = String.raw`(?:the\s+)?(?:ChatGPT(?:\s+(?:desktop\s+)?app(?:lication)?)?|Codex\s+(?:desktop\s+)?app(?:lication)?|Claude(?!\s+(?:Code|in\s+Chrome))(?:\s+(?:desktop\s+)?app(?:lication)?|\s+Desktop|\s+for\s+(?:Mac|desktop))?)`;
/** A sentence that sends the user to a vendor desktop app: open, relaunch, restart, update it, or make sure it runs. */
const ASKS = new RegExp(
  String.raw`\b(?:(?:quit\s+and\s+)?(?:re-?launch|restart|re-?open|open|launch|start|update|install|sign\s+in\s+to|log\s+in\s+to)\s+${VENDOR_APP}\b|(?:make\s+sure|ensure|check\s+that)\s+${VENDOR_APP}\s+is\s+(?:open|running|installed|up\s+to\s+date)\b|${VENDOR_APP}\s+(?:is\s+not|isn't)\s+(?:open|running)\b)`,
  'i',
);

/** A text's sentences with what separates them, so it can be put back together as it was. */
const pieces = (text) => text.split(/((?<=[.!?])\s+|\n+)/);

/**
 * `text` with every sentence that sends the user to a vendor desktop app replaced by MoPilot's
 * advice (once), or null when it has none.
 * @param {unknown} text
 * @returns {string | null}
 */
export function rewordVendorApp(text) {
  if (typeof text !== 'string' || !ASKS.test(text)) return null;
  const parts = pieces(text);
  let advised = false;
  const out = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i];
    const sep = parts[i + 1] ?? '';
    if (!ASKS.test(sentence)) {
      out.push(sentence, sep);
      continue;
    }
    // said once: a later such sentence goes, its separator (a line break) taking the place of the one before it
    if (advised) out[out.length - 1] = sep;
    else out.push(MOPILOT_ADVICE, sep);
    advised = true;
  }
  return out.join('').trim();
}
