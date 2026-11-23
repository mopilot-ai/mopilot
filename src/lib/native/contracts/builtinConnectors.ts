// The optional built-in connectors' shape (window.native.plugins.builtin, electron/bridge/plugins.cjs).

export type BuiltinConnector = {
  id: string;
  title: string;
  description: string;
  version: string;
  state: 'on' | 'off' | 'unavailable';
  why?: string;
};
