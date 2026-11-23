// The local background Host's stable machine identity, shared by its producer and remote-only recovery controls.
export const LOCAL_HOST_ID = 'this-mac-host';
/** Local targets cannot be offered a remote sign-in or SSH terminal. */
export const isLocalHostId = (id) => id === 'local' || id === LOCAL_HOST_ID || id.startsWith('ssh:local:');
