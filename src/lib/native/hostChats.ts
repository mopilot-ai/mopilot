// window.native.hostChats's types (what this Mac knows of every machine's chats), merged into NativeApi; the calls are declared in electron/bridge/hostChats.cjs.
/** One chat of a machine as its Host lists it. */
export type HostChatRow = {
  chatId: string;
  title: string;
  harness: string;
  createdAt: number;
  updatedAt: number;
  epoch: number;
  rev: number;
  state: 'idle' | 'running' | 'attention';
  folder?: string;
  startedBy?: string;
};

/** One machine's chats: `stale` is the last list of a machine that does not answer now, `partial` a list its Host could not read in full, `unsupported` a Host that does not list chats, `truncated` that older chats are left out. */
export type HostChatIndex = {
  machineId: string;
  state: 'loading' | 'ready' | 'partial' | 'failed' | 'stale' | 'unsupported';
  truncated: boolean;
  rows: HostChatRow[];
};

declare module '../native' {
  interface NativeApi {
    hostChats: {
      list(): Promise<HostChatIndex[]>;
      onChanged(cb: (index: HostChatIndex[]) => void): () => void;
    };
  }
}
