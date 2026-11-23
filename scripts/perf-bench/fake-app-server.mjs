#!/usr/bin/env node
// The benchmark's Codex (CODEX_BIN): the e2e fake app-server (tests/e2e/fixtures/fake-codex.mjs) with its replies replayed at the run's rate (proxy.mjs).
import { runFake } from './proxy.mjs';

await runFake('codex', new URL('../../tests/e2e/fixtures/fake-codex.mjs', import.meta.url));
