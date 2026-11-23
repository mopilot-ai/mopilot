// MoMo bridges built in parallel PRs (#2183 main chat, #2159 memory), typed here by the parts of their published contracts MoMo's settings and setup use, and undefined until this build's preload has them, so a screen that needs one says it isn't available instead of failing.
import type { MomoRoleBrain } from '../../shared/momoPrefs.mjs';
import { native } from './native';

/** What a main chat brain change did (#2183's MomoBrainChange). */
export interface MomoBrainChangeView {
  brain: MomoRoleBrain;
  chatId: string | null;
  applied: 'saved' | 'now' | 'nextMessage' | 'newChat';
  warning: string | null;
}
/** window.native.momoChat (#2183): the main chat's brain; each call throws `not_allowed` while MoMo is off. */
export interface MomoChatBridge {
  getBrain(): Promise<MomoRoleBrain | null>;
  setBrain(brain: MomoRoleBrain): Promise<MomoBrainChangeView>;
  onBrainChanged(cb: (brain: MomoRoleBrain | null) => void): () => void;
}
/** #2159's MomoMemoryResult. */
export type MomoMemoryResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: string };
/** window.native.momoMemory (#2159), as far as setup uses it: MoMo's persona document. */
export interface MomoMemoryBridge {
  files(): Promise<MomoMemoryResult<{ persona: string }>>;
  writeFile(name: 'persona', text: string): Promise<MomoMemoryResult>;
  onChanged(cb: () => void): () => void;
}

type Optional = { momoChat?: MomoChatBridge; momoMemory?: MomoMemoryBridge };
const optional = () => native as unknown as Optional;

export const momoChatBridge = () => optional().momoChat;
export const momoMemoryBridge = () => optional().momoMemory;
