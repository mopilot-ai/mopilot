// The app's side of the person's proof for pairing by code (Remote Run, #5576): runs native/code-pair-approve, which shows
// the system's own prompt (Touch ID or the password) and signs with a key only it holds. Main passes the Host's
// structured fields (`host.codePair.approvalText` → `fields`); the helper builds the text itself, so nothing here can make
// it sign a text the person was not shown. Without the helper, or when the person cancels, nothing is allowed.
const path = require('node:path');
const { proc } = require('../platform/ports/proc.cjs');

/** How long the person has to answer the prompt: less than the two minutes the Host's text is good for, so a late yes is not a proof the Host then refuses as run out. */
const PROMPT_MS = 100_000;
const POINT = /^[A-Za-z0-9+/]{87}=$/;
const SIG = /^[A-Za-z0-9+/]{16,200}={0,2}$/;

/** Where the helper lives: Contents/Helpers in a packaged app, native/code-pair-approve/build in a checkout. */
function approveHelperPath({ packaged = false, resourcesPath = process.resourcesPath, repoRoot = path.join(__dirname, '../..') } = {}) {
  return packaged
    ? path.join(resourcesPath, '..', 'Helpers', 'code-pair-approve')
    : path.join(repoRoot, 'native/code-pair-approve/build', 'code-pair-approve');
}

/** A refusal with the helper's own code (`not_approved`, `no_key`, `bad_fields`, `keychain`) or `no_helper`. */
const refusal = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @param {{ helper: string, run?: typeof proc.execFile, platform?: NodeJS.Platform }} o
 */
function createApprover({ helper, run = proc.execFile, platform = process.platform }) {
  /** Runs the helper once with `input` on stdin; resolves its JSON answer, rejects with its code. @param {string[]} args @param {object} [input] */
  const ask = (args, input) =>
    new Promise((resolve, reject) => {
      if (platform !== 'darwin') return reject(refusal('unsupported_platform', 'Pairing by code is available on Macs.'));
      const child = run(helper, args, { timeout: PROMPT_MS, maxBuffer: 16 * 1024 }, (error, stdout) => {
        /** @type {any} */
        let answer = null;
        let unreadable = '';
        try {
          answer = JSON.parse(String(stdout).trim());
        } catch (parseError) {
          // what it printed is not an answer: said in the refusal below
          unreadable = String(parseError);
        }
        if (answer?.error?.code) return reject(refusal(String(answer.error.code), String(answer.error.message ?? '')));
        if (error) {
          const missing = /** @type {any} */ (error).code === 'ENOENT';
          return reject(refusal(missing ? 'no_helper' : 'failed', missing ? 'The approval helper is missing.' : String(error.message)));
        }
        if (!answer || typeof answer !== 'object')
          return reject(refusal('failed', `The approval helper did not answer.${unreadable ? ` ${unreadable}` : ''}`));
        resolve(answer);
      });
      if (input) child.stdin?.end(JSON.stringify(input));
      else child.stdin?.end();
    });
  return {
    /** Makes a new approval key under a staging name and proves it is held, for `host.codePair.enrol`; `commit` or `abort` follows. @param {string} hostId */
    async enrol(hostId) {
      const a = /** @type {any} */ (await ask(['enrol', hostId]));
      if (!POINT.test(a.key) || typeof a.weak !== 'boolean' || !SIG.test(a.signature))
        throw refusal('failed', 'The approval helper answered something else.');
      return { key: a.key, weak: a.weak, signature: a.signature };
    },
    /** The person's yes over the Host's fields, after the prompt: the `approval` of `host.codePair.answer`. @param {object} fields */
    async approve(fields) {
      const a = /** @type {any} */ (await ask(['approve'], fields));
      if (!SIG.test(a.sig)) throw refusal('failed', 'The approval helper answered something else.');
      return { sig: a.sig };
    },
    /** The staged key becomes the key: only after the Host accepted the enrolment (`host.codePair.enrol`). */
    async commit() {
      await ask(['commit']);
      return { committed: true };
    },
    /** Drops the staged key: the Host refused the enrolment, or it never reached it. */
    async abort() {
      await ask(['abort']);
      return { aborted: true };
    },
    /** Removes the key (with `mopilot-host reset-approval` on the Host's side). */
    async reset() {
      await ask(['reset']);
      return { reset: true };
    },
  };
}

module.exports = { approveHelperPath, createApprover, PROMPT_MS };
