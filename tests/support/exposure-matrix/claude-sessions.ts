// claude sessions exposure matrix cases using shared fake harness and controller fixtures.
import {
  describe,
  test,
  assert,
  BU,
  CU,
  IAB,
  type World,
  world,
  claudeMod,
  ipc,
  until,
  send,
  newKey,
  presented,
  chromeArg,
  withLogin,
  wireClaude,
  closeAll,
  injection,
  sageServers,
  pluginOf,
} from './fixture.ts';

export function registerBilling() {
  /* ====================================================================== */
  /* CM-X05: Claude billing decides Claude in Chrome                         */
  /* ====================================================================== */

  describe('CM-X05: Claude billing and account', () => {
    /** Starts a session and says how it controls the user's Chrome. */
    async function chromePath(keys: string[], w: World) {
      const { q } = await send(keys[keys.push(newKey()) - 1]);
      const tools = presented(q, w);
      return { arg: chromeArg(q), yourChrome: tools.includes(BU), iab: tools.includes(IAB), cu: tools.includes(CU) };
    }

    test('CM-X05a: only a claude.ai subscription runs Claude in Chrome; an API key login, a stored key, credits and a cloud account get Your Chrome', async () => {
      const w = world();
      w.state.yourChrome = true;
      wireClaude(w);
      claudeMod.setGatewayKeyProvider(() => 'gk-matrix');
      const keys: string[] = [];
      const subscription = { arg: '--chrome', yourChrome: false, iab: true, cu: true };
      const yourChrome = { arg: '--no-chrome', yourChrome: true, iab: true, cu: true };
      const got: Record<string, unknown> = {};
      // scrubProcessEnv removes the auth variables from this process: put the whole environment back afterwards
      const envBefore = { ...process.env };
      try {
        got.subscription = await withLogin('claude.ai', () => chromePath(keys, w));
        assert.equal(claudeMod.nativeChromeFor('default'), true);
        got['API key login'] = await withLogin('api_key', () => chromePath(keys, w));
        await withLogin('claude.ai', async () => {
          await ipc('claude:setApiKey', 'sk-matrix-test');
          got['stored API key'] = await chromePath(keys, w);
          await ipc('claude:clearApiKey');
          await ipc('claude:setAuthMode', 'mopilot');
          got['MoPilot credits'] = await chromePath(keys, w);
          await ipc('claude:setAuthMode', 'subscription');
          process.env.CLAUDE_CODE_USE_BEDROCK = '1';
          claudeMod.scrubProcessEnv();
          await ipc('claude:setCloudEnv', true);
          got['cloud account'] = await chromePath(keys, w);
          await ipc('claude:setCloudEnv', false);
          got['subscription again'] = await chromePath(keys, w);
          w.flags['native.claude.chrome'] = false;
          got['switch off'] = await chromePath(keys, w);
        });
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in envBefore)) delete process.env[k];
        Object.assign(process.env, envBefore);
        await ipc('claude:setCloudEnv', false);
        await closeAll(keys);
      }
      assert.deepEqual(got, {
        subscription,
        'API key login': yourChrome,
        'stored API key': yourChrome,
        'MoPilot credits': yourChrome,
        'cloud account': yourChrome,
        'subscription again': subscription,
        'switch off': yourChrome,
      });
    });

    test('CM-X05b: a subscription chat moved onto an API key restarts on --no-chrome with Your Chrome', async () => {
      const w = world();
      w.state.yourChrome = true;
      wireClaude(w);
      const key = newKey();
      try {
        await withLogin('claude.ai', async () => {
          const first = await send(key);
          assert.equal(chromeArg(first.q), '--chrome');
          assert.equal(presented(first.q, w).includes(BU), false);
          await until('the first result', () => !claudeMod.ownBusy?.(key));
          await ipc('claude:setApiKey', 'sk-matrix-test');
          const next = await send(key);
          assert.ok(next.fresh, 'a new process on the new credentials');
          assert.equal(chromeArg(next.q), '--no-chrome');
          assert.ok(presented(next.q, w).includes(BU));
        });
      } finally {
        await ipc('claude:clearApiKey');
        await closeAll([key]);
      }
    });
  });
}

export function registerHelpers() {
  /* ====================================================================== */
  /* CM-X06: helper threads                                                  */
  /* ====================================================================== */

  describe('CM-X06: helper threads', () => {
    test('CM-X06: a helper thread never gets the vendor plugin or sage-mcp, also on a Mac with both native surfaces', () => {
      for (const hasTools of [true, false]) {
        const w = world();
        w.state.yourChrome = true;
        const { inj, sessions, load } = injection(w, { hasTools, surfaces: () => ({ chrome: true, computer: true }) });
        // the chat's own thread is native
        load('thread/start', 'cx-chat');
        assert.equal(inj.isNativeThread('cx-chat'), true);
        const before = sessions.byKey.size;
        // a title (thread/start) and a handoff note (an ephemeral thread/fork of the chat's thread)
        for (const [method, id] of [
          ['thread/start', 'cx-title'],
          ['thread/fork', 'cx-note'],
        ]) {
          const { out } = load(method, id, { helper: true });
          assert.equal(pluginOf(out), false, `${method}: plugin off`);
          assert.deepEqual(sageServers(out), [], `${method}: no sage-mcp`);
          assert.equal(inj.isNativeThread(id), false, `${method}: not a native thread`);
          assert.equal(inj.turnContext(id), null, `${method}: no native note`);
        }
        assert.equal(sessions.byKey.size, before, 'no tool session opened for a helper');
        // the chat's thread is untouched
        assert.equal(inj.isNativeThread('cx-chat'), true);
      }
    });
  });
}
