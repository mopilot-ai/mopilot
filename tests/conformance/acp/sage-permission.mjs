#!/usr/bin/env node
// #1319 G9 for each installed basic ACP harness: one cheap prompted turn that calls MoPilot's echo tool, recording
// whether the harness's permission request carries the sage_<nonce> server name (isSageToolCall), with the transport
// it got the tools over. Writes <out>/<id>@<version>.sage-permission.json per harness found. Release-only: it drives
// the real harnesses (scripts/release-suites.cjs).
//   node tests/conformance/acp/sage-permission.mjs [--out <dir>] [id ...]
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureSageMcp } from '../../../scripts/build-sage-mcp.mjs';
import { REPO } from '../lib/common.mjs';
import { app } from '../lib/acp.mjs';
import { probeSagePermission } from '../lib/acpSagePermission.mjs';

const { requireRelease } = createRequire(import.meta.url)('../../../scripts/release-suites.cjs');
requireRelease('The ACP sage-permission check', 'drives the real ACP harnesses installed here, one prompted turn each');
const argv = process.argv.slice(2);
const out = path.resolve(argv[0] === '--out' ? argv.splice(0, 2)[1] : path.join(REPO, 'tests/conformance/acp/results'));
if (!ensureSageMcp({ log: console.error })) throw new Error('sage-mcp could not be built (macOS with a swift toolchain)');
for (const id of argv.length ? argv : app().quirks.ids()) {
  const r = await probeSagePermission(id);
  console.log(`${id}: ${r.verdict}${r.version ? ` v${r.version}` : ''} (${r.transport})${r.error ? ` · ${r.error}` : ''}`);
  if (r.verdict === 'missing') continue;
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${id}@${r.version ?? 'unknown'}.sage-permission.json`), `${JSON.stringify(r, null, 2)}\n`);
}
process.exit(0);
