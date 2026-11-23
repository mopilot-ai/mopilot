#!/usr/bin/env node
// The benchmark's Claude Code CLI (CLAUDE_BIN): the e2e fake CLI (tests/e2e/fixtures/fake-claude.mjs) with its replies replayed at the run's rate (proxy.mjs).
import { runFake } from './proxy.mjs';

await runFake('claude', new URL('../../tests/e2e/fixtures/fake-claude.mjs', import.meta.url));
