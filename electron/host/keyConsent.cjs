// The question MoPilot asks before it adds its own ssh key to a machine: what is added, to which machine, where on this Mac the key lives; only a yes lets the key be made and installed.
const { addressName } = require('../../shared/host/computerName.mjs');

/**
 * @param {(q: { destination: string } & import('./sshPrompt.cjs').SshPrompt) => Promise<string | null>} ask the window's answer ('add'), anything else declines
 * @returns {(destination: string, file: string) => Promise<boolean>}
 */
const keyConsent = (ask) => async (destination, file) => {
  const host = addressName(destination);
  const answer = await ask({
    destination,
    kind: 'keyConsent',
    host,
    publicKeyFile: `${file}.pub`,
    addsTo: '~/.ssh/authorized_keys',
    store: 'file',
    choices: ['add'],
    text: `MoPilot reconnects in the background, so it adds its own key (${file}) to ${host}.`,
  });
  return answer === 'add';
};

module.exports = { keyConsent };
