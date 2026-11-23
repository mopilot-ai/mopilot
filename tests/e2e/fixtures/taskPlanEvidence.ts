// Failed task-plan journeys keep the owned fake requests and authoritative session snapshots for lifecycle diagnosis.
import fs from 'node:fs';
import path from 'node:path';
import type { TestInfo } from '@playwright/test';
import type { Harness } from './app';

export async function taskPlanEvidence(harness: Harness, info: TestInfo) {
  if (info.status === info.expectedStatus) return;
  await info.attach('fake-codex-requests.json', { body: JSON.stringify(harness.codexLog(), null, 2), contentType: 'application/json' });
  const folder = path.join(harness.env.MOPILOT_USER_DATA, 'threads');
  const ids = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.v2'))
    .map((name) => decodeURIComponent(name.slice(0, -3)));
  const states = await harness.page.evaluate(async (ids) => Promise.all(ids.map((id) => window.native.session.snapshot(id))), ids);
  await info.attach('session-snapshots.json', { body: JSON.stringify(states, null, 2), contentType: 'application/json' });
}
