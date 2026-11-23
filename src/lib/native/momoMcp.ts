// window.native.momoMcp's types (the coding-side MCP servers in Settings › MoMo › Sources, #2999), merged into NativeApi; the calls are declared in electron/bridge/momoMcp.cjs.
import type { MomoMcpResult, MomoMcpServer } from './contracts/momoMcp';

declare module '../native' {
  interface NativeApi {
    momoMcp: {
      /** available: false when this Mac can't encrypt MoMo's data (nothing can be allowed then) */
      list(): Promise<MomoMcpResult<{ servers: MomoMcpServer[]; available: boolean }>>;
      allow(key: string): Promise<MomoMcpResult>;
      remove(key: string): Promise<MomoMcpResult>;
      setTool(key: string, tool: string, on: boolean): Promise<MomoMcpResult>;
      onChanged(cb: () => void): () => void;
    };
  }
}
