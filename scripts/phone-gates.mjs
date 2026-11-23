// DEV ONLY: entry of the phone gates (design/phone-on-orca/measure.md): node scripts/phone-gates.mjs <gate> --bundle-id <separate build> ...
import { main } from './phone-gates/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
