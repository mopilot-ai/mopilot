// The self-hosting files and the code agree: every setting the relay reads is in the README's reference, the example env file only names settings the relay knows, the image is built from the relay folder alone and never takes the env file, and the compose file and Dockerfile point at paths and endpoints that exist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { REPO } from './support/scripts-shared-cli.ts';
import { APNS_SETTING_NAMES } from '../relay/src/config.mjs';

/** the folders whose change can break this test without an import edge */
export const GUARDS = ['relay/'];

const read = (rel: string) => readFileSync(`${REPO}/${rel}`, 'utf8');
const readme = read('relay/README.md');
const configSource = read('relay/src/config.mjs');
const read_ = [...configSource.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
// the APNs sets read their names off a prefix (APNS_, APNS2_), so config.mjs lists them itself
const known = new Set([...read_, ...APNS_SETTING_NAMES]);
/** read by the compose file itself, not the relay */
const COMPOSE_ONLY = new Set(['POSTGRES_PASSWORD']);

test('every setting the relay reads is in the README reference', () => {
  assert.ok(known.size > 30, `found ${known.size} settings in config.mjs`);
  const undocumented = [...known].filter((name) => !new RegExp(`\`${name}\``).test(readme));
  assert.deepEqual(undocumented, [], 'add them to the Configuration table in relay/README.md');
});

test('the example env file names only settings the relay (or the compose file) reads, and every line is KEY=VALUE or a comment', () => {
  const lines = read('relay/selfhost.env.example').split('\n');
  const names: string[] = [];
  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    assert.ok(m, `not KEY=VALUE: ${line}`);
    names.push(m[1]);
  }
  assert.deepEqual(
    names.filter((n) => !known.has(n) && !COMPOSE_ONLY.has(n)),
    [],
  );
  assert.ok(names.includes('POSTGRES_PASSWORD'));
});

test('the image is built from the relay folder only: its files exist, the env file is left out of the context, and the health check is an endpoint the relay serves', () => {
  const docker = read('relay/Dockerfile');
  for (const copied of docker.matchAll(/^COPY (?:--from=\w+ )?(\S+)/gm)) {
    if (copied[1].startsWith('/') || copied[1] === './node_modules') continue;
    assert.ok(existsSync(`${REPO}/relay/${copied[1]}`), `COPY ${copied[1]}`);
  }
  const ignore = read('relay/.dockerignore')
    .split('\n')
    .filter((l) => l && !l.startsWith('#'));
  assert.equal(ignore[0], '*', 'everything is left out unless it is let back in');
  assert.ok(!ignore.some((l) => /env/.test(l) && l.startsWith('!')), 'the env file is never let back in');
  const health = /wget -qO- http:\/\/127\.0\.0\.1:8787(\/\w+)/.exec(docker)?.[1];
  assert.match(read('relay/src/ops.mjs'), new RegExp(`path === '${health}'`));
  assert.match(docker, /STOPSIGNAL SIGTERM/);
  assert.match(docker, /USER node/);
});

test('the compose file builds the relay folder, passes the env file through, keeps the port on the host and gives the relay time to stop', () => {
  const compose = read('relay/docker-compose.selfhost.yml');
  assert.match(compose, /context: \.\n/);
  assert.doesNotMatch(compose, /^name:/m, "a project name of its own would leave an existing deployment's database volume behind");
  assert.match(compose, /env_file: selfhost\.env/);
  assert.match(compose, /"127\.0\.0\.1:8787:8787"/);
  const grace = Number(/stop_grace_period: (\d+)s/.exec(compose)?.[1]);
  const shutdown = Number(/`SHUTDOWN_SECONDS` \| `(\d+)`/.exec(readme)?.[1]);
  assert.ok(grace > shutdown, `stop_grace_period ${grace}s must exceed SHUTDOWN_SECONDS ${shutdown}`);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /restart: unless-stopped/);
});
