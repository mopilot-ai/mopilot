// Read published development fixture lines and JSONL logs without accepting an in-progress write as complete.
import fs from 'node:fs';

/** The first committed marker line, or null while its newline is still pending. @param {string | null} text */
export function firstPublishedLine(text) {
  if (text === null) return null;
  const end = text.indexOf('\n');
  return end < 0 ? null : text.slice(0, end);
}

export function readJsonLineLog(/** @type {string} */ file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .slice(0, -1)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
