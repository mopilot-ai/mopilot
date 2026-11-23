// The cloud acceptance run (`--milestone M4 --cloud oci --secrets <dir>`): reads the provider key, makes the signed call the app's OCI adapter makes, and either runs the dry checks (`--dry`: only GET calls) or the real run on one Always Free machine.
import { createOciCall } from '../../../shared/cloud/ociCall.mjs';
import { exitCode, formatReport } from '../report.mjs';
import { cloudDefaults } from './deps.mjs';
import { drySteps, planText } from './dry.mjs';
import { createReaders } from './readers.mjs';
import { realRun } from './real.mjs';

/**
 * @param {{ cloud: string, secrets: string, dry: boolean, milestone: string }} o
 * @param {{ out: (text: string) => unknown, root: string, deps: () => any, cloud?: Partial<import('./deps.mjs').CloudDeps> }} io
 * @param {(o: { steps: any[], ctx: any }) => Promise<any[]>} runSteps
 */
export async function cloudRun(o, io, runSteps) {
  const deps = { ...cloudDefaults(), ...io.cloud };
  const { config, sign } = deps.readSecrets(o.secrets);
  const call = createOciCall({ config, fetch: deps.fetch, sign });
  const readers = createReaders({ call, config });
  if (!o.dry) return realRun({ config, sign, call, readers, deps, io, runSteps });
  /** @type {{ root: string, cloud: { config: typeof config, readers: typeof readers, look: { ads: string[] } | null } }} */
  const ctx = { root: io.root, cloud: { config, readers, look: null } };
  const rows = await runSteps({ steps: drySteps(), ctx });
  const ads = ctx.cloud.look?.ads ?? [];
  io.out(`${formatReport({ target: `oci ${config.region} (dry: GET calls only)`, rows })}${planText({ config, ads })}`);
  return exitCode(rows);
}
