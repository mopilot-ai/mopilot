#!/usr/bin/env node
// Load, soak and chaos harness for the relay (relay/): paired Mac and phone sockets, bursts, killed sockets and restarts, and a check that no accepted frame is lost, duplicated or reordered. See relay/README.md.
import { run } from './relay-load/cli.mjs';

await run(process.argv.slice(2));
