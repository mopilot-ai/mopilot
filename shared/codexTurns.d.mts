import type { Turn } from '../src/protocol/v2/Turn';
import type { ThreadItem } from '../src/protocol/v2/ThreadItem';
import type { TurnState } from './model/store';

/** The app-server's `Turn`, as thread/turns/list and turn/started send it (items may be left out). */
export type ServerTurn = Pick<Turn, 'id' | 'status' | 'error' | 'startedAt' | 'completedAt' | 'durationMs'> & {
  items?: ThreadItem[];
  diff?: string;
};

export function turnFromServer(t: ServerTurn): TurnState;
