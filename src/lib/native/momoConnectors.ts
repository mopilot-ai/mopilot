// window.native.momoConnectors's types (the cloud accounts in Settings › MoMo › Sources, #2999), merged into NativeApi; the calls are declared in electron/bridge/momoConnectors.cjs.
import type { MomoConnector, MomoConnectorLevel, MomoConnectorsResult } from './contracts/momoConnectors';

declare module '../native' {
  interface NativeApi {
    momoConnectors: {
      /** available: false when this Mac can't encrypt the tokens (nothing connects then) */
      list(): Promise<MomoConnectorsResult<{ connectors: MomoConnector[]; available: boolean }>>;
      connect(id: string): Promise<MomoConnectorsResult<{ connector: MomoConnector }>>;
      cancel(id: string): Promise<MomoConnectorsResult<{ cancelled: boolean }>>;
      disconnect(id: string): Promise<MomoConnectorsResult>;
      setLevel(id: string, level: MomoConnectorLevel): Promise<MomoConnectorsResult>;
      onChanged(cb: () => void): () => void;
    };
  }
}
