#!/usr/bin/env node
// The mopilot-host executable: hands argv to the ops command dispatcher and exits with its code.
import { main } from '../src/cli.mjs';

// the terminal's lines can answer a sign-in prompt (the code Claude Code asks to be pasted)
process.exitCode = await main(process.argv.slice(2), { stdin: process.stdin });
// the Host is done: whatever still holds the event loop (a handle a harness left) must not keep a stopped Host alive
setTimeout(() => process.exit(), 5000).unref();
