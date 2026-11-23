// Observe accepted running turns from the fake Codex's persisted state, never from its pre-admission request log.
import fs from 'node:fs';
import path from 'node:path';

/** The fake saves its actual turn after admission; a parent carrying an escaped child brief cannot satisfy this. */
export function hasRunningCodexTurn(log, text) {
  const prefix = `${path.basename(log)}.`;
  for (const name of fs.readdirSync(path.dirname(log)).filter((name) => name.startsWith(prefix) && name.endsWith('.state.json'))) {
    let records;
    try {
      records = JSON.parse(fs.readFileSync(path.join(path.dirname(log), name), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
    if (!Array.isArray(records)) continue;
    if (
      records.some(
        (record) =>
          Array.isArray(record?.turns) &&
          record.turns.some(
            (turn) =>
              turn?.status === 'inProgress' &&
              Array.isArray(turn.items) &&
              turn.items.some(
                (item) =>
                  item?.type === 'userMessage' &&
                  Array.isArray(item.content) &&
                  item.content.some((part) => part?.type === 'text' && typeof part.text === 'string' && part.text.includes(text)),
              ),
          ),
      )
    )
      return true;
  }
  return false;
}
