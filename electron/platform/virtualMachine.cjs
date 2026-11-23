// Whether MoPilot runs inside a virtual machine (the one check behind the release suites' gate and the bench's), and the VM-only bench switch that counts a benchmark VM as attended for computer use (#1600).
const { execFile } = require('node:child_process');

/** The flag the host's hypervisor sets in a macOS guest: a desktop cannot pass for a VM. */
const VM_SYSCTL = ['-n', 'kern.hv_vmm_present'];
/** sysctl by its full path: a PATH holding another `sysctl` can't make a Mac pass for a VM. */
const SYSCTL = '/usr/sbin/sysctl';

/**
 * A command's output, without blocking main's event loop.
 * @param {string} file @param {string[]} args @param {typeof execFile} [run]
 * @returns {Promise<string>}
 */
const execText = (file, args, run = execFile) =>
  new Promise((resolve, reject) => run(file, args, { encoding: 'utf8' }, (error, out) => (error ? reject(error) : resolve(String(out)))));

/**
 * The decision, for a probe of that flag: only macOS reports it, and a probe that fails is not a VM.
 * @param {string} platform @param {() => string} probe
 */
function vmFromProbe(platform, probe) {
  if (platform !== 'darwin') return false;
  try {
    return String(probe()).trim() === '1';
  } catch {
    // no such flag: not a machine we can vouch for
    return false;
  }
}

/**
 * The same decision without blocking main's event loop (the bench switch is read on computer-use calls).
 * @param {{ platform?: string, sysctl?: () => Promise<string> }} [deps]
 */
async function probeVirtualMachine({ platform = process.platform, sysctl = () => execText(SYSCTL, VM_SYSCTL) } = {}) {
  if (platform !== 'darwin') return false;
  let out;
  try {
    out = await sysctl();
  } catch {
    // no such flag: not a machine we can vouch for
    return false;
  }
  return vmFromProbe(platform, () => out);
}

/**
 * The bench switch: MOPILOT_BENCH_ATTENDED=1 counts the user as present for computer use, so a benchmark VM's driver
 * (whose input the helper rightly never counts as a person's) can run computer-use tasks. Honored only inside a
 * virtual machine, which is nobody's desktop; on a real Mac it does nothing. The machine is probed once per process,
 * and only when the switch is set.
 * @param {() => Promise<boolean>} [probe]
 * @returns {(env?: Record<string, string | undefined>, inVm?: () => Promise<boolean>) => Promise<boolean>}
 */
function makeBenchAttended(probe = probeVirtualMachine) {
  /** @type {Promise<boolean> | undefined} */
  let vm;
  return async (env = process.env, inVm = () => (vm ??= probe())) => env.MOPILOT_BENCH_ATTENDED === '1' && (await inVm());
}

const benchAttended = makeBenchAttended();

module.exports = { VM_SYSCTL, SYSCTL, execText, vmFromProbe, probeVirtualMachine, benchAttended, makeBenchAttended };
