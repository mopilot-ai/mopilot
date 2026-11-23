// MoPilot's own ssh key for machines that took a password: one ed25519 key per Mac user (~/.ssh/mopilot_ed25519, no passphrase, so the tunnel can reconnect unattended), appended once to the machine's authorized_keys, and the ssh options that make a machine use exactly the key that worked for it.
const os = require('node:os');
const path = require('node:path');
const { fs } = require('../platform/ports/fs.cjs');
const { proc } = require('../platform/ports/proc.cjs');
const started = require('./started.cjs');
const { userError } = require('../../shared/userError.mjs');

const KEY_NAME = 'mopilot_ed25519';

/** @param {string} s */
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A public key line as ssh-keygen writes it: type, base64 and an optional comment, one line. @param {string} line */
const validPublicKey = (line) => /^ssh-ed25519 [A-Za-z0-9+/=]+( [^\n\r]*)?$/.test(line);

/** A key file a machine record may name: an absolute path, one line. @param {unknown} p @returns {p is string} */
const validIdentity = (p) => typeof p === 'string' && p.length <= 1024 && path.isAbsolute(p) && !/[\u0000-\u001f]/.test(p);

/** The ssh options for a machine that signs in with `identity` (a private key file), or none when its own ssh setup works. @param {string | null | undefined} identity */
const identityArgs = (identity) => (identity ? ['-i', identity, '-o', 'IdentitiesOnly=yes'] : []);

/** The command that adds `pub` to the machine's authorized_keys once, with the permissions sshd insists on. @param {string} pub */
function authorizeCommand(pub) {
  if (!validPublicKey(pub)) throw new Error('That is not an ed25519 public key.');
  const line = quote(pub);
  return (
    'umask 077 && mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && ' +
    `{ grep -qxF ${line} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${line} >> "$HOME/.ssh/authorized_keys"; } && ` +
    'chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys" && echo authorized'
  );
}

/**
 * This Mac's MoPilot key, made on first use.
 * @param {object} [o]
 * @param {string} [o.home]
 * @param {string} [o.comment] what the key says it is, in the machine's authorized_keys
 * @param {(bin: string, args: string[]) => Promise<void>} [o.keygen]
 * @returns {Promise<{ file: string, pub: string }>}
 */
async function ensureKey({ home = os.homedir(), comment = `mopilot@${os.hostname()}`, keygen = runKeygen } = {}) {
  const file = path.join(home, '.ssh', KEY_NAME);
  if (!fs.existsSync(file) || !fs.existsSync(`${file}.pub`)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // a half-made pair (one file missing) is made again whole
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.pub`, { force: true });
    await keygen('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment.replace(/\s+/g, '-'), '-f', file]);
  }
  fs.chmodSync(file, 0o600);
  const pub = fs.readFileSync(`${file}.pub`, 'utf8').trim();
  if (!validPublicKey(pub)) throw new Error(`${file}.pub is not an ed25519 public key.`);
  return { file, pub };
}

/** @param {string} bin @param {string[]} args @returns {Promise<void>} */
function runKeygen(bin, args) {
  return new Promise((resolve, reject) => {
    started.track(
      proc.execFile(bin, args, { timeout: 30_000 }, (/** @type {Error | null} */ error, _out, /** @type {string} */ err) =>
        error ? reject(new Error(`ssh-keygen failed: ${String(err || error.message).trim()}`)) : resolve(),
      ),
    );
  });
}

/** @typedef {{ code: number, stdout: string, stderr: string }} Ran */

/**
 * The step that makes a machine reachable without a password from now on, since the tunnel and heartbeat reconnect with nobody there to type it:
 * nothing when this Mac's own ssh setup already signs in, else MoPilot's key added to the machine and proved to work.
 * @param {object} o
 * @param {(command: string) => Promise<Ran>} o.run one command on the machine, over the connection already signed in
 * @param {(args: string[]) => Promise<Ran>} o.probe a fresh connection that may not prompt, with these extra ssh options
 * @param {() => Promise<{ file: string, pub: string }>} o.ensure this Mac's MoPilot key
 * @param {(file: string) => Promise<boolean>} o.consent asked, before the key is made or added, whether it may be: where it lives; false (declined, cancelled, no one there) leaves the machine and this Mac as they were
 * @returns {Promise<{ ok: boolean, output: string, identity: string }>} `identity` the key file the machine signs in with ('' for its own setup)
 */
async function keySignIn({ run, probe, ensure, consent }) {
  /** @param {Ran} r */
  const said = (r) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  if ((await probe([])).code === 0) return { ok: true, identity: '', output: 'Signs in with your own ssh key; nothing to add.' };
  /** @type {{ file: string, pub: string }} */
  let key;
  if (!(await consent(`~/.ssh/${KEY_NAME}`)))
    return {
      ok: false,
      identity: '',
      output: `You chose not to let MoPilot add its key to the machine, so it can't reconnect on its own.`,
    };
  try {
    key = await ensure();
  } catch (e) {
    return { ok: false, identity: '', output: `MoPilot couldn't make its ssh key: ${userError(e)}` };
  }
  const added = await run(authorizeCommand(key.pub));
  if (added.code !== 0 || !/^authorized$/m.test(added.stdout))
    return { ok: false, identity: '', output: `MoPilot couldn't add its key to the machine.\n${said(added)}`.trim() };
  const proved = await probe(identityArgs(key.file));
  if (proved.code !== 0)
    return {
      ok: false,
      identity: '',
      output:
        `MoPilot's key is on the machine, but the machine still won't sign in with it (does its sshd allow keys?).\n${said(proved)}`.trim(),
    };
  return {
    ok: true,
    identity: key.file,
    output: `MoPilot reconnects in the background, so it added its own key (~/.ssh/${path.basename(key.file)}); no password from now on.`,
  };
}

/** The command that takes `pub` out of the machine's authorized_keys (the rest stays as it was); nothing to do is not a failure. @param {string} pub */
function deauthorizeCommand(pub) {
  if (!validPublicKey(pub)) throw new Error('That is not an ed25519 public key.');
  return (
    'f="$HOME/.ssh/authorized_keys"; [ -f "$f" ] || { echo removed; exit 0; }; umask 077 && ' +
    `{ grep -vxF ${quote(pub)} "$f" || true; } > "$f.mopilot" && mv "$f.mopilot" "$f" && chmod 600 "$f" && echo removed`
  );
}

/**
 * Take MoPilot's key off a machine that is removed: its public half (beside `identity`) is deleted from the machine's authorized_keys, over a connection signed in with that key.
 * @param {{ identity: string, run: (command: string) => Promise<Ran> }} o
 * @returns {Promise<boolean>} whether the machine said it is gone
 */
async function revokeKey({ identity, run }) {
  const pub = fs.readFileSync(`${identity}.pub`, 'utf8').trim();
  const r = await run(deauthorizeCommand(pub));
  return r.code === 0 && /^removed$/m.test(r.stdout);
}

module.exports = {
  ensureKey,
  authorizeCommand,
  deauthorizeCommand,
  revokeKey,
  identityArgs,
  keySignIn,
  validPublicKey,
  validIdentity,
  KEY_NAME,
};
