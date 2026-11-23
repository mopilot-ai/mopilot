// Codex account authentication files, default home and usage-window normalization.
const { fs } = require('../../platform/ports/fs.cjs');
const path = require('node:path');
const os = require('node:os');
const { noteIgnored } = require('../../ignored.cjs');
const { writePrivate } = require('../../platform/fsutil.cjs');
const { AuthVault, PLAIN } = require('./authVault.cjs');

const defaultHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

function jwtClaims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** A home's sign-in as JSON text: through its vault for an added account (encrypted at rest), else its auth.json. */
function readAuthText(home) {
  const vault = AuthVault.of(home);
  return vault ? vault.read(home) : fs.readFileSync(path.join(home, PLAIN), 'utf8');
}

/**
 * Saves a home's sign-in: encrypted for an added account (throws without the OS key), else as the CLI's own auth.json,
 * which is Codex's file in Codex's format (the CLI reads it there).
 */
function writeAuth(/** @type {string} */ home, /** @type {string | Buffer} */ text) {
  const vault = AuthVault.of(home);
  if (vault) vault.write(home, text);
  else writePrivate(path.join(home, PLAIN), text);
}

/** Reads a home's sign-in: ChatGPT tokens, or an API key. */
function readAuth(home) {
  try {
    const text = readAuthText(home);
    if (text == null) return null;
    const a = JSON.parse(text);
    if (a?.tokens?.access_token) {
      const id = jwtClaims(a.tokens.id_token);
      const acc = jwtClaims(a.tokens.access_token);
      const auth = id['https://api.openai.com/auth'] || acc['https://api.openai.com/auth'] || {};
      return {
        kind: 'chatgpt',
        accessToken: a.tokens.access_token,
        chatgptAccountId: a.tokens.account_id || auth.chatgpt_account_id || '',
        email: id.email || acc['https://api.openai.com/profile']?.email || null,
        planType: auth.chatgpt_plan_type || null,
        exp: acc.exp || 0,
      };
    }
    if (a?.OPENAI_API_KEY) return { kind: 'apiKey', apiKey: a.OPENAI_API_KEY };
  } catch (error) {
    // no auth.json (ENOENT): not signed in; an unreadable one reads the same, and is recorded
    noteIgnored('read a Codex sign-in', error, ['ENOENT']);
  }
  return null;
}

/** Usage is "reached" when the backend says so or a window is full; it lifts at the latest reset. */
function limitInfo(snap) {
  if (!snap) return null;
  const wins = [snap.primary, snap.secondary].filter(Boolean);
  const full = wins.filter((w) => w.usedPercent >= 100);
  const reached = !!snap.rateLimitReachedType || full.length > 0;
  const resets = (full.length ? full : wins).map((w) => w.resetsAt).filter(Boolean);
  return {
    primary: snap.primary ?? null,
    secondary: snap.secondary ?? null,
    used: wins.length ? Math.max(...wins.map((w) => w.usedPercent ?? 0)) : null,
    reached,
    resetsAt: reached && resets.length ? Math.max(...resets) : null,
    at: Date.now(),
  };
}

module.exports = { defaultHome, readAuth, readAuthText, writeAuth, limitInfo };
