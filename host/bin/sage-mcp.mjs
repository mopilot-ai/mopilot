#!/usr/bin/env node
// The portable sage-mcp executable: a harness starts it as a stdio MCP server; it bridges to the Host's tool socket.
import { runShim } from '../src/sageMcpShim.mjs';

// the harness went away while a reply was on its way: nothing is left to serve
process.stdout.on('error', () => process.exit(0));
process.exitCode = await runShim({ env: process.env, stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
