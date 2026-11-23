// A Codex chat's own model, effort and Fast (WP5-6, D-29, D-57). Pure, so it can be tested alone.
import type { ChatConfig } from '../lib/chatMeta';

type Defaults = { model: string | null; effort: string | null; serviceTier: string | null };

/** The chat's own value where it set one (a key that is there, even null, wins), else the default. */
export function codexChatSelection(prefs: Defaults, own: ChatConfig | null | undefined): Defaults {
  const pick = (k: keyof Defaults) => (own && k in own ? (own[k] ?? null) : (prefs[k] ?? null));
  return { model: pick('model'), effort: pick('effort'), serviceTier: pick('serviceTier') };
}
