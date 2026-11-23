// The host-chat flag as the entry test sees it: a stand-in the runtime factory is handed.
export const hostChatFlag = { load: async () => undefined, on: () => false, told: () => undefined, subscribe: () => () => undefined };
