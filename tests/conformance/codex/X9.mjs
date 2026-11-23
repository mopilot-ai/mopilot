// Per-thread model_providers + modelProvider. No turns are sent; the providers point at 127.0.0.1:9.
import fs from 'node:fs';
import path from 'node:path';
import { open, errMsg, sleep } from '../lib/codex.mjs';

export const id = 'X9';
export const title = 'Per-thread model_providers + modelProvider';
export const timeoutMs = 180000;

const prov = { name: 'Sage Test', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses' };

export default async function run(ctx) {
  // auth.command marker script: records that it ran, prints a fake token
  const dir = ctx.cwd('authcmd');
  const script = path.join(dir, 'auth.sh');
  fs.writeFileSync(script, `#!/bin/sh\necho ran >> "${dir}/marker-$1"\necho sage-fake-not-a-secret\n`, { mode: 0o755 });
  const marker = (tag) => fs.existsSync(path.join(dir, `marker-${tag}`));
  const pick = (r) => (r.error ? { error: errMsg(r) } : { modelProvider: r.result.modelProvider });
  const start = (c, extra) => c.request('thread/start', { cwd: ctx.cwd('t'), model: 'sage-test-model', ephemeral: true, ...extra });

  const o = {};
  const c = await open(ctx, 'thread');
  o.nested = pick(await start(c, { modelProvider: 'sagetest', config: { model_providers: { sagetest: prov } } }));
  o.dotted = pick(
    await start(c, {
      modelProvider: 'sagetest2',
      config: {
        'model_providers.sagetest2.name': 'Sage Test 2',
        'model_providers.sagetest2.base_url': prov.base_url,
        'model_providers.sagetest2.wire_api': 'responses',
      },
    }),
  );
  o.viaConfigKey = pick(await start(c, { config: { model_provider: 'sagetest3', model_providers: { sagetest3: prov } } }));
  o.undefinedProvider = pick(await start(c, { modelProvider: 'nosuchprovider' }));
  o.threadAuth = pick(
    await start(c, {
      modelProvider: 'sagethr',
      config: { model_providers: { sagethr: { ...prov, auth: { command: script, args: ['thread'] } } } },
    }),
  );
  await sleep(3000);
  o.threadAuthRan = marker('thread');
  await c.close();

  const c2 = await open(ctx, 'launch', {
    args: [
      '-c',
      'model_providers.sagel.name="L"',
      '-c',
      `model_providers.sagel.base_url="${prov.base_url}"`,
      '-c',
      'model_providers.sagel.wire_api="responses"',
      '-c',
      `model_providers.sagel.auth.command="${script}"`,
      '-c',
      'model_providers.sagel.auth.args=["launch"]',
    ],
  });
  o.launch = pick(await start(c2, { modelProvider: 'sagel' }));
  await sleep(3000);
  o.launchAuthRan = marker('launch');
  return ctx.result(o, {
    'nested per-thread provider is selected': o.nested.modelProvider === 'sagetest',
    'dotted per-thread provider is selected': o.dotted.modelProvider === 'sagetest2',
    'config.model_provider selects it': o.viaConfigKey.modelProvider === 'sagetest3',
    'undefined provider is an error': /not found/.test(o.undefinedProvider.error ?? ''),
    'launch -c provider is selected': o.launch.modelProvider === 'sagel',
    'auth.command runs eagerly at thread/start (thread and launch)': o.threadAuthRan && o.launchAuthRan,
  });
}
