// Process entry for `node relay/src/bin.mjs` and the Docker image.
import { run } from './main.mjs';
import { installProcessGuards } from './processGuards.mjs';

installProcessGuards();
await run(process.env);
