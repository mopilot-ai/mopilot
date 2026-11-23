#!/usr/bin/env node
// The benchmark's ACP agent (SAGE_ACP_BINS): the test fake agent (tests/fixtures/fake-acp-agent.mjs) with its replies replayed at the run's rate and tool calls between them (proxy.mjs).
import { runFake } from './proxy.mjs';

await runFake('acp', new URL('../../tests/fixtures/fake-acp-agent.mjs', import.meta.url));
