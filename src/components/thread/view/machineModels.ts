// A machine's model list and reset time in the forms the failed-turn box needs: another model to use, and when a limit starts over.
import type { MachineModel } from '../../../../shared/host/models.mjs';
import { resetText } from '../../../harness/usageWindows';

/** The machine's model to use instead: its default, else its first, other than the refused ones; undefined when it has no other. */
export function otherModel(models: readonly MachineModel[], refused: ReadonlySet<string>): MachineModel | undefined {
  return [models.find((m) => m.default), ...models].find((m) => m && !refused.has(m.id));
}

/** When a limit starts over, from the machine login's `limitedUntil` (seconds or milliseconds); null when unknown or past. */
export function limitResetNote(limitedUntil: number | null | undefined): string | null {
  if (!limitedUntil) return null;
  return resetText({ resetsAt: limitedUntil > 1e12 ? limitedUntil / 1000 : limitedUntil });
}
