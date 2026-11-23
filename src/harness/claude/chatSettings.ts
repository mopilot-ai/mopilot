// A Claude chat's own model and effort in the window: read from its session when it opens, kept from the new-chat default when it starts.
// The window store comes from the caller (harness/claude.ts), which owns it here.
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import { claudeModelFor } from '../claudeTranslate';
import { claudeSessionId, type HarnessModel } from '../types';

type Settings = { model?: string | null; effort?: string | null };
/** What these read and write of the window store (structural, so this module doesn't reach into the store). */
export type ChatSettingsStore = {
  getState(): {
    chatConfig: Record<string, Settings | undefined>;
    claude: { models: HarnessModel[] };
    prefs: { claudeSelection: { model: string | null; effort: string | null } };
  };
  patchRuntime(id: string, update: (r: { settings?: Settings | null }) => { settings?: Settings }): void;
  setChatConfig(id: string, patch: Settings): void;
};

/**
 * Show an existing chat with the model and effort it actually runs on, not the new-chat default. `running(nativeId)`:
 * its CLI runs a model it was told this run, which the transcript doesn't know yet.
 */
export async function loadSessionSettings(
  store: ChatSettingsStore,
  chatId: string,
  nativeId: string,
  running: (nativeId: string) => boolean,
) {
  // unread: the chat shows the new-chat default until its next turn reports the model
  const ss = await native.claude
    .sessionSettings(claudeSessionId(nativeId))
    .catch((error) => (noteIgnored("read a Claude Code chat's model and effort", error), null));
  if (!ss) return;
  const config = store.getState().chatConfig[chatId];
  const model = claudeModelFor(config?.model ?? ss.model, store.getState().claude.models);
  store.patchRuntime(chatId, (r) =>
    r.settings?.model && r.settings.model !== model && running(nativeId)
      ? {}
      : { settings: { model, effort: config?.effort ?? ss.effort } },
  );
}

/** A new chat starts from the new-chat model and effort and keeps its own from here on: another chat's pick moves only those. */
export function keepNewChatSelection(store: ChatSettingsStore, chatId: string) {
  const { model, effort } = store.getState().prefs.claudeSelection;
  store.setChatConfig(chatId, { model, effort });
}
