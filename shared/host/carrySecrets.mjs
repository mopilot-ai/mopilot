// What a carry never takes (docs: design/host/index.html, package 3.5): files whose names say they hold secrets, and the plan of what a carry would send, read from git's status. Pure.

/** Names (the last path segment) of files that usually hold credentials. Matched without regard to case. */
const SECRET_NAMES = [
  // .env, .env.local, prod.env, secrets.env, and direnv's .envrc
  /^\.env($|\.|rc$)/,
  /\.env$/,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx|p8|gpg|asc)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)/,
  /^credentials?($|[-_.])/,
  /^\.(npmrc|yarnrc\.yml|netrc|pypirc|git-credentials|pgpass|htpasswd|dockercfg|s3cfg|boto|vault_pass|bash_history|zsh_history)$/,
  // infrastructure state and variables hold keys and passwords in the clear
  /\.(tfvars|tfstate)(\.|$)/,
  /^kubeconfig/,
  /^wp-config\.php$/,
  /^firebase-adminsdk-/,
  /^authkey_/,
  // configuration files named for what they hold: auth.json, service-account.json, tokens.yaml
  /(^|[-_.])(auth|token|tokens|secret|secrets|credential|credentials|apikey|api-key|service[-_]?account)([-_.][^/]*)?\.(json|ya?ml|toml|ini|txt)$/,
];
/** Folders whose whole content is credentials. */
const SECRET_DIRS = /(^|\/)(\.(ssh|aws|gnupg|kube|docker|secrets?)|secrets?)\//;

/** Whether a path (relative to the repository, `/`-separated) looks like it holds a secret. @param {string} p */
export function isSecretPath(p) {
  const lower = p.toLowerCase();
  return SECRET_DIRS.test(lower) || SECRET_NAMES.some((re) => re.test(lower.slice(lower.lastIndexOf('/') + 1)));
}

/**
 * What git's `status --porcelain=v1 -z -uall` lists, as a plan: the paths a carry would send (`send`, of which `untracked` are new files git has never seen) and the ones it never sends (`skipped`); `stage` is exactly what a carry stages: `send` and the old names of renames.
 * @param {string} statusZ
 */
export function planOf(statusZ) {
  const parts = statusZ.split('\0');
  /** @type {string[]} */ const send = [];
  /** @type {string[]} */ const untracked = [];
  /** @type {string[]} */ const skipped = [];
  /** @type {string[]} */ const stage = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const file = entry.slice(3);
    // a rename or copy is followed by the path it came from
    const from = /[RC]/.test(xy) ? parts[++i] : null;
    // a secret renamed to a plain name is still the secret
    if (isSecretPath(file) || (from !== null && isSecretPath(from))) skipped.push(file);
    else {
      send.push(file);
      stage.push(file);
      // the old name of a rename goes with it, so the target loses the file it should
      if (from && xy.includes('R')) stage.push(from);
      if (xy === '??') untracked.push(file);
    }
  }
  return { send, untracked, skipped, stage };
}
