// The program Claude Code's `apiKeyHelper` runs on a Host: prints the organization lease's token the Host holds (./orgKeyHelper.mjs printKey), or exits non-zero with nothing printed.
import { printKey } from './orgKeyHelper.mjs';

process.exitCode = await printKey({ env: process.env, stdout: process.stdout });
