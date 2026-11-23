// The control matrix, group A (docs/control-plane/matrix.md): the ControllerPlan names MoPilot's own Chrome (#1319 G2):
// the chrome_* tools on any session, and the Chrome backend MoPilot serves a native Codex thread's plugin, make
// MoPilot's Chrome connection the controller of the user's Chrome, never a vendor. decidePlan, planInputs and the
// switch sheet's lines are real; the tools and the harnesses' state are fakes.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { type World, world } from './support/control-matrix-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { planInputs } = require('../electron/session/controllerPlan.cjs');
const { decidePlan, planChanges, changeLines, vendorChromeOf } = require('../shared/controllerPlan.mjs');

const names = (w: World) => w.r.list().map((t: { name: string }) => t.name);

describe('the plan names MoPilot’s own Chrome (#1319 G2)', () => {
  test('CM-A11: chrome_* on a Claude Code, managed Codex or ACP session make MoPilot’s Chrome connection the controller of the user’s Chrome', () => {
    const vendor = { chrome: null, computer: null };
    const plan = decidePlan({ channel: true, tools: ['browser_navigate', 'chrome_navigate'], yourChrome: false, vendor });
    assert.equal(plan.bu, 'mopilot-chrome');
    // not a vendor: the credential route and "Continue in Chrome" name no vendor for it
    assert.equal(vendorChromeOf(plan), null);
    // a vendor controller of Chrome still wins (chrome_* are hidden beside it); without the channel nothing controls it
    assert.equal(
      decidePlan({ channel: true, tools: ['chrome_navigate'], yourChrome: false, vendor: { chrome: 'claude-in-chrome', computer: null } })
        .bu,
      'claude-in-chrome',
    );
    assert.equal(decidePlan({ channel: false, tools: ['chrome_navigate'], yourChrome: false, vendor }).bu, null);
    // a switch from Your Chrome to MoPilot's connection says so on the switch sheet
    const lines = changeLines(planChanges({ iab: null, cu: null, bu: 'your-chrome' }, { iab: null, cu: null, bu: 'mopilot-chrome' }));
    assert.deepEqual(lines, [
      "After the switch, your Chrome is controlled by MoPilot's Chrome connection instead of MoPilot's Your Chrome tools.",
    ]);
  });

  test('CM-A12: a native Codex thread MoPilot serves its Chrome backend to has MoPilot’s connection for Chrome, loaded or about to load', () => {
    const w = world();
    const live = {
      codexLoaded: (id: string) => (id === 'th-loaded' ? { chrome: true, computer: false, iab: false, tools: true } : null),
      codexNow: { chrome: true, computer: false },
    };
    const backend = { served: new Set(['th-loaded']), on: true };
    const inputs = planInputs({
      tools: () => names(w),
      yourChrome: () => false,
      claude: { channel: () => true, nativeChromeOf: () => null, nativeChromeFor: () => false },
      codex: {
        channel: () => true,
        loadedPath: live.codexLoaded,
        nativeSurfaces: () => live.codexNow,
        iabAvailable: () => false,
        chromeBackend: () => ({ serves: (id: string) => backend.served.has(id), available: () => backend.on }),
      },
      acp: { channel: () => true },
    });
    const planOf = (id: string | null) => decidePlan(inputs({ kind: 'codex', id, key: null }, 'chat'));
    assert.equal(planOf('th-loaded').bu, 'mopilot-chrome');
    // a thread that loaded without it keeps the vendor plugin; a thread about to load gets what a new one would
    backend.served.clear();
    assert.equal(planOf('th-loaded').bu, 'codex-browser-plugin');
    assert.equal(planOf(null).bu, 'mopilot-chrome');
    backend.on = false;
    assert.equal(planOf(null).bu, 'codex-browser-plugin');
    // before tools open there is no backend set yet: the vendor's, as before
    const early = planInputs({
      tools: () => names(w),
      yourChrome: () => false,
      claude: { channel: () => true, nativeChromeOf: () => null, nativeChromeFor: () => false },
      codex: {
        channel: () => true,
        loadedPath: () => null,
        nativeSurfaces: () => live.codexNow,
        iabAvailable: () => false,
        chromeBackend: () => null,
      },
      acp: { channel: () => true },
    });
    assert.equal(decidePlan(early({ kind: 'codex', id: null, key: null }, 'chat')).bu, 'codex-browser-plugin');
  });
});
