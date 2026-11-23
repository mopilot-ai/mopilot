// The endpoints the production entry test's build carries: a development build's by default (a test sets `__phoneEndpointsDev = false` for a store build), so the test sees the entry hand them to the runtime.
export const endpoints = {
  relayUrl: 'ws://192.168.1.2:8787/v1/ws',
  accountOrigin: 'http://192.168.1.2:8787',
  get dev() {
    return (globalThis as any).__phoneEndpointsDev ?? true;
  },
};
