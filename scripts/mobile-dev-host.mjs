#!/usr/bin/env node
// DEV ONLY: lets a real phone pair with and drive a stand-in for the Mac without launching MoPilot. Listens on the LAN with no TLS; see mobile/README.md and scripts/mobile-dev-host/cli.mjs.
import { run } from './mobile-dev-host/cli.mjs';

await run(process.argv.slice(2));
