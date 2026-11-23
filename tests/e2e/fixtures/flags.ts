// Remote switches for a launch: written to userData/flags.json, the cache electron/platform/flags.cjs reads at startup
// (the test MoPilot API never answers, so the cache stands for the whole run).
import fs from 'node:fs';
import path from 'node:path';
import type { Dirs } from './app';

const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')).version;

/** A Seed `files` step that switches the given flags (a switch only turns a feature off). */
export const remoteFlags =
  (flags: Record<string, boolean>) =>
  ({ userData }: Dirs) =>
    fs.writeFileSync(
      path.join(userData, 'flags.json'),
      JSON.stringify({ fetchedAt: Date.now(), channel: 'stable', version: VERSION, flags }),
    );

/**
 * The switches under which MoPilot's computer_* tools are offered: shared.computerUse.parityTools off (on, the
 * desktop_* tools replace them; PR #348 and #351), and Codex's own computer use (native.codex.enabled) off, so a Codex
 * Computer Use install on this Mac can't take the tools away from a Codex chat.
 */
export const COMPUTER_TOOLS = { 'shared.computerUse.parityTools': false, 'native.codex.enabled': false } as const;
