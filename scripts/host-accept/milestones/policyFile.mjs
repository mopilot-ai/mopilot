// The Host's managed-policy file on the machine under test: where it lives, whether the run may write it (a root-owned file needs `sudo -n`, which never prompts), writing it as root or as the user, and taking it away again, also after a failed step.
import { managedPolicyPath } from '../../../shared/managedPolicy.mjs';
import { expect } from '../steps.mjs';

const quote = (/** @type {string} */ s) => `'${s}'`;

/** The path the Host reads on this machine (a Host on macOS reads its own folder, not the app's). @param {any} ctx */
export const policyFileOf = (ctx) => managedPolicyPath({ platform: ctx.state.os === 'Darwin' ? 'darwin' : 'linux', product: 'host' });

/** Why this run cannot write a root-owned file, or null when it can: `sudo -n` must work without a password. @param {any} ctx */
export async function sudoGap(ctx) {
  const probe = await ctx.m.run('sudo -n true');
  return probe.code === 0
    ? null
    : 'sudo -n is not allowed here without a password, so a root-owned policy file cannot be written (the run never prompts)';
}

/**
 * Write the policy file: owned by root and not group- or world-writable (the Host trusts it), or owned by the user and writable (the Host must refuse it). The file is the run's from now on, so cleanup removes it.
 * @param {any} ctx @param {object} doc @param {'root' | 'user'} owner
 */
export async function writeManaged(ctx, doc, owner) {
  const file = policyFileOf(ctx);
  const dir = file.slice(0, file.lastIndexOf('/'));
  const root = `root:${ctx.state.os === 'Darwin' ? 'wheel' : 'root'}`;
  const done = await ctx.m.run(
    `sudo -n mkdir -p ${quote(dir)} && sudo -n tee ${quote(file)} >/dev/null && sudo -n chown ${owner === 'root' ? root : '"$(id -un)"'} ${quote(file)} && sudo -n chmod ${owner === 'root' ? '644' : '666'} ${quote(file)}`,
    Buffer.from(JSON.stringify(doc)),
  );
  ctx.state.policyFile = file;
  expect(done.code === 0, `The policy file could not be written (${done.stderr.trim()}).`);
}

/** Remove the policy file this run wrote, if any; a missing one is fine. @param {any} ctx */
export async function removePolicyFile(ctx) {
  if (!ctx.state.policyFile) return;
  await ctx.m.run(`sudo -n rm -f ${quote(ctx.state.policyFile)}`);
  ctx.state.policyFile = '';
}
