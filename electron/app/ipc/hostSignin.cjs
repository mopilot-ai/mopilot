// Machine sign-in and agent install IPC actions and snapshots, registered through the Host access gate; operation identities stay in main.
/** @param {{ handle: (channel: string, fn: (...args: any[]) => any) => void, service: () => any }} o */
function registerHostSignin({ handle, service }) {
  handle('host:signin', (id, harness, recoveryKey) => service().signIn(String(id ?? ''), String(harness ?? ''), recoveryKey));
  handle('host:signinViews', () => service().signInViews());
  handle('host:signinInput', (id, harness, text) => service().signInInput(String(id ?? ''), String(harness ?? ''), String(text ?? '')));
  handle('host:signinCancel', (id, harness) => service().cancelSignIn(String(id ?? ''), String(harness ?? '')));
  handle('host:agentInstall', (id, harness) => service().installAgent(String(id ?? ''), String(harness ?? '')));
  handle('host:agentInstallCancel', (id, harness) => service().cancelInstall(String(id ?? ''), String(harness ?? '')));
}

module.exports = { registerHostSignin, registeredBy: 'host' };
