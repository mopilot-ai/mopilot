// The rows a chat last showed (its cache, or the saved older rows) as blocks of the same transcript list the Mac's rows fill, so that the rows both have keep their views when the Mac answers.
import { fold, isStep, type Block, type KeyedRow } from './toolRuns';

/**
 * Each saved row is one block, under the key the live transcript knows it by. A saved run (kept as its summary under `run:` and the key of its
 * first step) is a run block of one step that says the summary, the same component the live run is, so that it is not mounted again either.
 */
export const cachedBlocks = (rows: readonly KeyedRow[]): Block[] =>
  rows.map(
    (row): Block =>
      row.role === 'step' && row.key.startsWith('run:')
        ? { type: 'run', key: row.key.slice('run:'.length), steps: [row], summary: row.text, running: false }
        : { type: 'row', row },
  );

/**
 * The saved rows as the live chat will fold them: the turn (the key of your last message), how many of its steps there are (the "Worked"
 * line shows when there are any, as it does once the Mac answers), and the blocks with that turn's steps left out when it is folded.
 */
export function savedView(rows: readonly KeyedRow[], foldedTurn: string | null): { blocks: Block[]; activity: number; turnKey: string } {
  const { activity, turnKey } = fold([...rows], { running: false, foldedTurn: null });
  const turn = turnKey ? rows.findIndex((row) => row.key === turnKey) + 1 : 0;
  const folded = !!turnKey && foldedTurn === turnKey;
  return { blocks: cachedBlocks(folded ? rows.filter((row, i) => i < turn || !isStep(row)) : rows), activity, turnKey };
}
