// IPC for adding a machine, registered by ipc/host.cjs (`registeredBy`): the add itself (ssh may ask the windows while it runs) and its cancel, which stops the add under way and undoes what it made.

/**
 * @param {object} o
 * @param {(channel: string, fn: (...args: any[]) => unknown) => void} o.handle
 * @param {() => { add: (destination: string, opts: { daemonPassword?: string }) => Promise<unknown>, cancelAdd: (destination: string) => boolean, addByCode: (code: string) => Promise<unknown>, cancelAddByCode: () => void }} o.service
 * @param {{ during: <T>(destination: string, add: () => Promise<T>) => Promise<T> }} o.prompts
 */
function registerHostAdd({ handle, service, prompts }) {
  // a Mac nobody is signed in on is added with its administrator password, straight to the machine's sudo and not kept here
  handle('host:add', (destination, opts) => {
    const d = String(destination ?? '');
    const password = opts?.daemonPassword;
    return prompts.during(d, () => service().add(d, typeof password === 'string' && password ? { daemonPassword: password } : {}));
  });
  handle('host:cancelAdd', (destination) => service().cancelAdd(String(destination ?? '')));
  // pairing by a code typed here (R2b, #5576; behind `host.codePair`)
  handle('host:addByCode', (code) => service().addByCode(String(code ?? '')));
  handle('host:cancelAddByCode', () => service().cancelAddByCode());
}

module.exports = { registerHostAdd, registeredBy: 'host' };
