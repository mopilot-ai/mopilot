// How a harness's model list is grouped wherever it is shown: the main models, then the other versions behind "more".
import { type HarnessModel } from './types';

/** The models to show first and the rest (pinned versions), in the harness's own order, for the picker and Settings alike. */
export function groupModels(models: HarnessModel[]): { main: HarnessModel[]; more: HarnessModel[] } {
  return { main: models.filter((m) => !m.more), more: models.filter((m) => m.more) };
}
