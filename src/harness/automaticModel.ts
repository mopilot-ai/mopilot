// The model menu's Automatic choice carries current capabilities while saving no concrete model id.
import type { HarnessModel } from './types';

export function automaticModel(models: HarnessModel[]): HarnessModel | undefined {
  const recommended = models.find((m) => m.isDefault) ?? models[0];
  return recommended ? { ...recommended, id: '', label: 'Automatic', description: undefined, more: false } : undefined;
}
