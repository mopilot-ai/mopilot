// What the continue dialog asks to carry, read from its request (moved out of ipc/host.cjs to keep that registrar small).

/** What the dialog asks to carry: the source's uncommitted changes, the new files the user confirmed and how many unpushed commits they agreed to publish; null when it asks for none. @param {any} v */
const carryOf = (v) =>
  v && typeof v === 'object'
    ? {
        confirmed: v.confirmed === true,
        untracked: Array.isArray(v.untracked) ? v.untracked.filter((/** @type {unknown} */ f) => typeof f === 'string') : [],
        unpushed: Number.isSafeInteger(v.unpushed) && v.unpushed > 0 ? v.unpushed : 0,
      }
    : null;

module.exports = { carryOf };
