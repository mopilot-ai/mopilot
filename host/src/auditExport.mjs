// `mopilot-host audit export [--since <date>]` (plan W3): the audit record's lines as written, one JSON object per line, for an admin on the machine or a log shipper; `--verify` checks the hash chain instead.
import path from 'node:path';
import { verifyChain } from '../../shared/host/audit.mjs';
import { createAudit } from './audit.mjs';

/**
 * @param {object} o
 * @param {string} o.dataDir @param {string[]} o.argv the whole command line
 * @param {(line: string) => void} o.out @param {(line: string) => void} o.err
 * @param {Parameters<typeof createAudit>[0]['io']} [o.io]
 * @returns {number} the exit code
 */
export function auditCommand({ dataDir, argv, out, err, io }) {
  const at = argv.indexOf('audit');
  if (argv[at + 1] !== 'export') {
    err('Usage: mopilot-host audit export [--since <date>] [--verify] [--data-dir <dir>]');
    return 1;
  }
  const i = argv.indexOf('--since');
  const since = i < 0 ? 0 : Date.parse(argv[i + 1] ?? '');
  if (!Number.isFinite(since)) {
    err('--since needs a date such as 2026-11-01.');
    return 1;
  }
  const lines = createAudit({ dir: path.join(dataDir, 'audit'), io }).exportText(since);
  if (argv.includes('--verify')) {
    const { ok, brokenAt } = verifyChain(lines);
    out(ok ? `The chain holds for ${lines.length} lines.` : `The chain breaks at line ${brokenAt}.`);
    return ok ? 0 : 2;
  }
  for (const l of lines) out(l);
  return 0;
}
