// The app's managed-policy resolver (plan W1, #2685): the shared reader (shared/managedPolicyReader.mjs) on this app's path and the fs port. The only reader of the admin's root-owned file in this process.
const { fs: portFs } = require('./ports/fs.cjs');
const { createManagedReader } = require('../../shared/managedPolicyReader.mjs');

/** @param {Omit<Parameters<typeof createManagedReader>[0], 'product' | 'fs'> & { fs?: typeof import('node:fs') }} [o] */
const createManagedPolicy = (o = {}) => createManagedReader({ ...o, product: 'app', fs: o.fs ?? portFs });

/** @type {ReturnType<typeof createManagedPolicy> | null} */
let shared = null;
/** The one resolver of this process. */
const managedPolicy = () => (shared ??= createManagedPolicy());
/** The effective managed policy now (`state: 'none'` when there is no file). */
const effectivePolicy = () => managedPolicy().effectivePolicy();

/** One managed endpoint (`relay` or `api`), or null: only a valid file sets one, never the strict fallback. @param {'relay' | 'api'} name */
const managedEndpoint = (name) => {
  const p = effectivePolicy();
  return p.state === 'valid' ? (p.doc.endpoints?.[name] ?? null) : null;
};
/** What organization sign-in (W4) reads: the `orgAccess` block, who manages it and why a rewrite was not taken; null with no policy. */
const managedOrgAccess = () => {
  const p = effectivePolicy();
  return p.state === 'valid' ? { orgAccess: p.doc.orgAccess, organization: p.organization, problem: p.problem } : null;
};

module.exports = { createManagedPolicy, managedPolicy, effectivePolicy, managedEndpoint, managedOrgAccess };
