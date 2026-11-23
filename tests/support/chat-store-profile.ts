// Temporary chat-store profile folders shared by ownership and edge-case tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptFixture } from './transcript-fixture.ts';

export function tmp(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'chats-edge-'));
  const fixture = transcriptFixture(d);
  t.after(() => fixture.cleanup());
  fs.mkdirSync(path.join(d, 'threads'));
  return { d, threads: path.join(d, 'threads'), ui: path.join(d, 'ui-state.json'), own: fixture.own, stopWith: fixture.stopWith };
}
