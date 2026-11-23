// Which folder-relative paths a phone may see: no hidden name (a dot-name), except a short allowlist of tool and CI folders and ignore or editor files whose contents are project configuration, never secrets (an .env file or anything under .git stays out; .vscode and .devcontainer can hold tokens in launch or env settings, so they stay out too).

/** Dot-folders whose files may be read (anything deeper that is hidden again is not). */
const DIRS = new Set(['.github', '.gitlab', '.husky', '.storybook', '.changeset', '.circleci']);
/** Dot-files that may be read, in any folder. */
const FILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.nvmrc',
  '.node-version',
  '.prettierrc',
  '.prettierignore',
  '.eslintrc',
  '.eslintignore',
  '.dockerignore',
  '.browserslistrc',
  '.mailmap',
]);

/** Files that hold a key or a store of secrets, by extension; a backup copy of one (`.bak`, `.old`, `~`) and a `.json` form of Terraform's variables are the same file. */
const SECRET_EXTENSIONS = /\.(pem|key|p8|p12|pfx|jks|keystore|ppk|gpg|kdbx|tfvars|tfstate|env)(\.json)?(\.(bak|backup|old|orig|save)|~)?$/i;
/** Private keys by name (a public `.pub` is not one). */
const PRIVATE_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(?!.*\.pub$)/i;
/** Names that are credentials whatever they hold: `credentials`, `secrets`, a service account's key file, Rails' master key. */
const SECRET_NAME =
  /^(credentials?|secrets?)(\.(json|ya?ml|toml|ini|txt|xml|properties|conf|cfg|env))?$|^(service[-_]?account.*\.json|client_secret.*\.json|google-services\.json|master\.key|\.?netrc|\.?pgpass)$/i;

/** Whether the file name looks like a secret: not shown to a phone even when its folder is (the agent can read it, a phone's chat view does not need to). */
function secretLooking(/** @type {string} */ name) {
  const base = name.trimEnd();
  return SECRET_EXTENSIONS.test(base) || PRIVATE_KEY.test(base) || SECRET_NAME.test(base);
}

/** Whether the path (folder-relative, either separator) may be shown. */
function visible(/** @type {string} */ rel) {
  const segs = rel.split(/[\\/]/);
  // a key's own name, and a folder that is one (`server.key/`, `keys.pem/`): the extensions and key names are checked on every segment, the credential-looking names on the file
  if (
    secretLooking(segs[segs.length - 1]) ||
    segs.slice(0, -1).some((seg) => SECRET_EXTENSIONS.test(seg.trimEnd()) || PRIVATE_KEY.test(seg))
  )
    return false;
  const hidden = segs.flatMap((seg, at) => (seg.startsWith('.') ? [{ seg, at }] : []));
  if (!hidden.length) return true;
  if (hidden.length > 1) return false;
  const { seg, at } = hidden[0];
  if (seg === '.' || seg === '..' || seg.startsWith('.env')) return false;
  return at === segs.length - 1 ? FILES.has(seg) : at === 0 && DIRS.has(seg);
}

module.exports = { visible, secretLooking, DIRS, FILES };
