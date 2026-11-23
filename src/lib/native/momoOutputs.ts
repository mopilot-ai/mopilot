// window.native.momoOutputs's types (the Outputs section of MoMo's right panel, #2139), merged into NativeApi; the calls are declared in electron/bridge/momoOutputs.cjs.
import type { MomoSourcesResult } from './contracts/momoSources';

/** One file MoMo saved, as the panel lists it: `gone` when it is no longer on the disk, `fromPrivate` when the chat had read the user's data first. */
export interface MomoOutput {
  id: string;
  name: string;
  type: string;
  size: number;
  /** when it was saved, ms since the epoch */
  at: number;
  note: string;
  fromPrivate: boolean;
  gone: boolean;
}

declare module '../native' {
  interface NativeApi {
    momoOutputs: {
      /** newest first */
      list(): Promise<MomoSourcesResult<{ files: MomoOutput[] }>>;
      /** the default app opens it */
      open(id: string): Promise<MomoSourcesResult>;
      /** Finder shows it */
      reveal(id: string): Promise<MomoSourcesResult>;
      /** main's save dialog; cancelled: true when the user closed it */
      saveCopy(id: string): Promise<MomoSourcesResult<{ cancelled: boolean }>>;
      /** deletes the file and its entry */
      remove(id: string): Promise<MomoSourcesResult<{ removed: boolean }>>;
      onChanged(cb: () => void): () => void;
    };
  }
}
