// What a question from ssh asks (a first-connect host key, a password, a key's passphrase, a yes/no, anything else), read from the text ssh hands its askpass program; and whether a failed ssh says the machine's host key changed.

/**
 * @typedef {{ kind: 'hostKey', host: string, keyType: string, fingerprint: string, text: string }
 *   | { kind: 'password', account: string, text: string }
 *   | { kind: 'passphrase', key: string, text: string }
 *   | { kind: 'confirm', text: string }
 *   | { kind: 'keyConsent', host: string, publicKeyFile: string, addsTo: string, store: 'file', choices: ['add'], text: string }
 *   | { kind: 'secret', text: string }} SshPrompt
 */

/** @param {unknown} raw @returns {SshPrompt} */
function classifyPrompt(raw) {
  const text = String(raw).trim();
  // OpenSSH 10 writes "fingerprint is: SHA256:…", older ones "fingerprint is SHA256:…"
  const key = /authenticity of host '([^']+)' can't be established\.[\s\S]*?(\S+) key fingerprint is:? (SHA256:[A-Za-z0-9+/=]+)/.exec(text);
  if (key && /\(yes\/no/.test(text))
    return { kind: 'hostKey', host: key[1].replace(/ \(.*\)$/, ''), keyType: key[2], fingerprint: key[3], text };
  if (/\(yes\/no[^)]*\)\??$/.test(text)) return { kind: 'confirm', text };
  const password = /^(\S+)'s password:$/m.exec(text) ?? /^\((\S+)\) Password:$/im.exec(text);
  if (password) return { kind: 'password', account: password[1], text };
  const passphrase = /^Enter passphrase for (?:key )?'?([^']+?)'?:$/m.exec(text);
  if (passphrase) return { kind: 'passphrase', key: passphrase[1], text };
  return { kind: 'secret', text };
}

/** ssh refused the machine because its host key is not the one on record (a reinstalled machine, or someone in between). @param {string} stderr */
const changedHostKey = (stderr) => /REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr);

module.exports = { classifyPrompt, changedHostKey };
