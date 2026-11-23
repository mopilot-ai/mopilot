#!/usr/bin/env node
// One admission probe per basic harness installed on this machine, as the app runs it: the quirks'
// privacy check, initialize, session/new with a sage_<nonce> server in a temp folder, and sage-mcp's
// hello. No prompt is sent, so nothing is billed. Prints one line per harness and writes
// tests/conformance/acp/results/<id>@<version>.json for each one found (--out <dir> writes there instead).
//   node tests/conformance/acp/probe.mjs [--out <dir>] [id ...]
import path from 'node:path';
import { REPO } from '../lib/common.mjs';
import { probeInstalled } from '../lib/acp.mjs';

const argv = process.argv.slice(2);
const out = argv[0] === '--out' ? argv.splice(0, 2)[1] : null;
await probeInstalled(argv, {
  outDir: out ? path.resolve(out) : path.join(REPO, 'tests/conformance/acp/results'),
  onResult: (id, r) => console.log(`${id}: ${r.state}${r.version ? ` v${r.version}` : ''}${r.reason ? ` · ${r.reason}` : ''}`),
});
process.exit(0);
