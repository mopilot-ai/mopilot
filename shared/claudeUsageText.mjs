// Parse Claude plan windows once for desktop and remote account surfaces, retaining the original measurement time.
import { resetTime } from './claudeResetTime.mjs';

/**
 * Parse the CLI's `/usage` text ("Current session: 8% used · resets Oct 9 at 12:29am (…)").
 * It's display text, not an API: anything unrecognized is ignored.
 */
/** @param {string} text @param {number} [at] */
export function parseUsageText(text, at = Date.now()) {
  /** @type {{ label: string, usedPercent: number, resetsAt: number | null, resetsText: string | null }[]} */
  const windows = [];
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n?/g, '\n');
  // Accept both a compact line and the CLI's heading/bar/percentage layout.
  const headings = [...clean.matchAll(/^\s*Current[ \t]+(session|week)\b(?:[ \t]+\(([^)]+)\))?[ \t]*:?[ \t]*/gim)];
  for (let i = 0; i < headings.length; i++) {
    const m = headings[i];
    const block = clean.slice(m.index + m[0].length, headings[i + 1]?.index ?? clean.length).split(/^[ \t]*Extra usage\b/im)[0];
    const percent = block.match(/(?<![-.\d])(\d+(?:\.\d+)?)\s*%[ \t]*used/i);
    if (!percent) continue;
    const usedPercent = Number(percent[1]);
    if (!Number.isFinite(usedPercent) || usedPercent > 100) continue;
    const scope = m[2] && !/^all models$/i.test(m[2]) ? ` ${m[2]}` : '';
    const reset = block.match(/resets?[ \t]+([^\n(]+)(?:\(([^)\n]+)\))?/i);
    const resetsText = reset?.[1]?.trim() || null;
    windows.push({
      label: m[1].toLowerCase() === 'session' ? '5h' : `Weekly${scope}`,
      usedPercent,
      // printed just now, in the zone it names: a cached answer's figures are older, its reset time is not
      resetsAt: resetsText ? resetTime(resetsText, reset?.[2], Date.now()) : null,
      resetsText,
    });
  }
  return windows.length ? { windows, status: null, at } : null;
}
