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
      /** `open`: the chats this window has open or selected, which the first read of a run never lets go of. */
      list(open?: string[]): Promise<HostChatIndex[]>;
      onChanged(cb: (index: HostChatIndex[]) => void): () => void;
      /** Takes a chat only the machine's Host lists into this Mac's list (it runs there; this Mac follows it); the app's id for the chat. Main takes the id and the folder from its own index of that machine, and refuses a machine that is offline or a chat the machine does not list. */
      open(machineId: string, chatId: string): Promise<{ chatId: string }>;
      /** Takes back a chat that was taken in and never reached this window (no record here, bound to that machine): it is unbound and no longer followed; nothing changes on the machine. */
      release(machineId: string, chatId: string): Promise<{ released: boolean }>;
    };
  }
}
