// Loading the Codex config into the store, recording a read error instead of throwing.

import type { CodexConfigView } from './state';
import { errorText } from '../lib/ignored';

/** Read configuration without coupling retry/error handling to the live session store. */
export function createConfigLoader(
  read: () => Promise<{ config: unknown }>,
  set: (patch: { config?: CodexConfigView; configError: string | null }) => void,
) {
  return async () => {
    try {
      const result = await read();
      set({ config: result.config as CodexConfigView, configError: null });
    } catch (error) {
      set({ configError: errorText(error) });
    }
  };
}
