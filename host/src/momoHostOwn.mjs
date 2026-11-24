// The Host's own files a SERVICE may keep (home lane): a file sealed with the Host's key rather than MoMo's data key, so a move does not carry it and a Reset keeps it (the names are in HOST_OWN, host/src/momoHome.mjs). A service reaches the folder and the key by NAME, and only for these names: the rest of what the Host seals with its own key (the grant, the home record, the chat registry) is not a service's.

/** The names a service may keep beside the Host's own files, each with why it stays. */
export const SERVICE_HOST_OWN = Object.freeze({
  'google-revoke-owed.json':
    'a Google refresh token the Host still owes a revoke for: it must survive a Reset and must not travel to another machine',
});

/** @param {{ dir: string, safeStorage: any }} storage the Host's own folder and key */
export const hostOwnStorageOf =
  (storage) =>
  /** @param {string} name @returns {{ dir: string, safeStorage: any }} */
  (name) => {
    if (!Object.hasOwn(SERVICE_HOST_OWN, name)) throw new Error(`${name} is not a file a service may keep with the Host's key.`);
    return { dir: storage.dir, safeStorage: storage.safeStorage };
  };
