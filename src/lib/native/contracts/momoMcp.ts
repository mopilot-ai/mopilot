// The coding-side MCP servers as Settings › MoMo › Sources gets them (#2999 C0, electron/momo/mcp/proxy.cjs list, electron/momo/mcp/ipc.cjs).

/** One tool of a server: `readOnly` is the server's own claim; `isNew`: listed since the server was allowed (off until turned on); `blocked`: why it is never offered. */
export type MomoMcpTool = {
  key: string;
  name: string;
  description: string;
  readOnly: boolean;
  on: boolean;
  isNew: boolean;
  blocked: string | null;
};

/** One server coding chats configure: allowed into MoMo or not, and its client's state. */
export type MomoMcpServer = {
  key: string;
  name: string;
  from: string;
  transport: 'stdio' | 'http';
  allowed: boolean;
  status: 'off' | 'starting' | 'ready' | 'failed';
  error: string | null;
  tools: MomoMcpTool[];
};

export type MomoMcpResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: string };
