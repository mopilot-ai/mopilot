// Loaded into the app's main process before it starts (the `mainRequire` fixture option) by specs that ask as a paired phone: keeps main's real RemoteService on `globalThis.__remoteService`, so a spec reaches it without a relay.
const path = require('node:path');

if (process.type === 'browser') {
  const service = require(path.resolve(__dirname, '../../../electron/remote/service.cjs'));
  const { RemoteService } = service;
  service.RemoteService = class extends RemoteService {
    constructor(o) {
      super(o);
      globalThis.__remoteService = this;
    }
  };
}
