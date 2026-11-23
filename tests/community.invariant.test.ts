// The community link: the apps open mopilot.ai/discord (a redirect the site can repoint) and never carry a Discord invite themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMUNITY_URL } from '../shared/community.mjs';
import { treeFiles } from '../scripts/source-tree.mjs';

test('the community link is the site redirect, and no app source carries a raw Discord invite', () => {
  assert.equal(COMMUNITY_URL, 'https://mopilot.ai/discord');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const raw = /discord\.gg\/|discord(app)?\.com\/invite/i;
  for (const dir of ['electron', 'src', 'shared', 'mobile/src']) {
    let files: string[] = [];
    try {
      files = treeFiles(`${root}${dir}`, /\.(c|m)?[jt]sx?$/);
    } catch {
      continue; // a tree this checkout doesn't have
    }
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), raw, `${f} carries a raw Discord invite: use COMMUNITY_URL`);
  }
});
