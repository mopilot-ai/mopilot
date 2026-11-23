// window.native.momoSources's types (Settings › MoMo › Sources, #2139), merged into NativeApi; the calls are declared in electron/bridge/momoSources.cjs.
import type { MomoSource, MomoWrite, MomoSourceGrant, MomoSourceId, MomoSourceLevel, MomoSourcesResult } from './contracts/momoSources';

declare module '../native' {
  interface NativeApi {
    momoSources: {
      /** available: false when this Mac can't encrypt MoMo's data (nothing connects then) */
      list(): Promise<MomoSourcesResult<{ sources: MomoSource[]; available: boolean; waiting?: MomoSourceId[] }>>;
      /** a connected source's calendars, lists or folders (shown), for its row */
      detail(id: MomoSourceId): Promise<MomoSourcesResult<{ items: string[] }>>;
      /** asks macOS first for Calendar and Reminders; connected: false when it refused (grant says why) */
      connect(id: MomoSourceId): Promise<
        MomoSourcesResult<{
          connected: boolean;
          grant: MomoSourceGrant;
          asked?: boolean;
          waiting?: boolean;
          noPrompt?: boolean;
          reset?: boolean;
          requestError?: string;
        }>
      >;
      /** forgets the source and deletes MoMo's copies of it */
      disconnect(id: MomoSourceId): Promise<MomoSourcesResult>;
      setLevel(id: MomoSourceId, level: MomoSourceLevel): Promise<MomoSourcesResult>;
      /** main's folder dialog; cancelled: true when the user closed it */
      addFolder(): Promise<MomoSourcesResult<{ cancelled: boolean; folders: string[] }>>;
      removeFolder(path: string): Promise<MomoSourcesResult<{ folders: string[] }>>;
      /** macOS's Privacy & Security pane for Calendar or Reminders */
      openPrivacy(id: MomoSourceId): Promise<MomoSourcesResult>;
      /** reads the grant now and connects when the switch went on; connected says where the source stands after */
      recheck(id: MomoSourceId): Promise<MomoSourcesResult<{ connected: boolean }>>;
      /** stops waiting for the user to turn on the macOS switch a connect opened */
      cancelConnect(id: MomoSourceId): Promise<MomoSourcesResult<{ cancelled: boolean }>>;
      /** what MoMo wrote to Calendar and Reminders in the last 30 days, newest first */
      writes(): Promise<MomoSourcesResult<{ writes: MomoWrite[] }>>;
      /** the user's own Undo of one write; the error says why not (changed since, no connection, a helper that can't delete) */
      undoWrite(id: string): Promise<MomoSourcesResult>;
      onChanged(cb: () => void): () => void;
    };
  }
}
