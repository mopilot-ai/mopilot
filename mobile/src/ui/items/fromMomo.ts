// Folds MoMo's chat rows (messages, reminders, day lines) into the same item union as a coding chat; a MoMo row nobody knows is kept as text.
import type { MomoRow } from '../../momo/chatRows';
import { itemOfRow } from './fromRows';
import type { Item } from './types';

export function itemOfMomoRow(row: MomoRow): Item {
  switch (row.kind) {
    case 'nudge':
      return { kind: 'nudge', id: row.key, loopId: row.nudge.loopId, title: row.nudge.title, quote: row.nudge.quote, why: row.nudge.why };
    case 'day':
      return { kind: 'day', id: row.key, label: row.label };
    case 'message':
      return itemOfRow({ ...row.row, key: row.key });
    default:
      return { kind: 'unknown', id: (row as { key?: string }).key ?? 'unknown', text: '' };
  }
}

export const itemsFromMomoRows = (rows: readonly MomoRow[]): Item[] => rows.map(itemOfMomoRow);
