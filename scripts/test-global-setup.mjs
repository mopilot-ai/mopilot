// What a unit run needs once, before any test file starts (node --test-global-setup): the checkout's Rust core, which every
// test runs on (tests/support/register.ts), current and quick when it already is.
import { ensureCore } from './build-core.mjs';

/**
 * node:test calls this in the runner, with nothing.
 * @param {{ ensure?: typeof ensureCore }} [deps]
 */
export function globalSetup({ ensure = ensureCore } = {}) {
  ensure({ log: console.error });
}
