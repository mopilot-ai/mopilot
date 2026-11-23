// window.native.momoMemory's types (MoMo's Memory tab, #2139), merged into NativeApi; the calls are declared in electron/bridge/momoMemory.cjs.
import type {
  MomoFact,
  MomoLoop,
  MomoLoopAct,
  MomoMemoryChange,
  MomoMemoryFile,
  MomoMemoryLimits,
  MomoMemoryResult,
} from './contracts/momoMemory';

declare module '../native' {
  interface NativeApi {
    momoMemory: {
      /** every fact, expired ones too; with a query, the unexpired ones that match */
      list(q?: { query?: string }): Promise<MomoMemoryResult<{ facts: MomoFact[]; unreadable: number; now: number }>>;
      /** a fact the user typed (source 'user'); saved: false when the same text is kept already */
      add(text: string): Promise<MomoMemoryResult<{ fact: MomoFact; saved: boolean }>>;
      /** expiresAt: null brings an expired fact back */
      update(
        id: string,
        patch: { text?: string; confidence?: MomoFact['confidence']; expiresAt?: null },
      ): Promise<MomoMemoryResult<{ fact: MomoFact }>>;
      forget(id: string): Promise<MomoMemoryResult>;
      /** unreadable: the documents that can't be decrypted on this Mac (read as empty) */
      files(): Promise<MomoMemoryResult<{ aboutYou: string; persona: string; unreadable: MomoMemoryFile[] }>>;
      writeFile(name: MomoMemoryFile, text: string): Promise<MomoMemoryResult>;
      /** the newest changes to the facts first */
      changes(): Promise<MomoMemoryResult<{ changes: MomoMemoryChange[] }>>;
      /** fails (with why) when a fact it touched changed since */
      undo(changeId: string): Promise<MomoMemoryResult<{ change: MomoMemoryChange }>>;
      /** facts a newer one replaced, the latest replaced first */
      past(): Promise<MomoMemoryResult<{ facts: MomoFact[] }>>;
      /** null before the background pass runs */
      background(): Promise<MomoMemoryResult<{ limits: MomoMemoryLimits | null }>>;
      /** the open loops, and the latest closed ones */
      loops(): Promise<MomoMemoryResult<{ open: MomoLoop[]; closed: MomoLoop[]; now: number }>>;
      loopAct(id: string, act: MomoLoopAct): Promise<MomoMemoryResult<{ loop: MomoLoop }>>;
      onChanged(cb: () => void): () => void;
    };
  }
}
