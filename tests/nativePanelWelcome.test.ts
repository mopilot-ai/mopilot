// A native fixture cannot click onboarding before its initial storage read has rendered the visible consent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completePanelFirstRun } from './e2e/fixtures/nativePanelWelcome.ts';
import type { NativePanel } from './e2e/fixtures/extensionChrome.ts';

test('native onboarding waits for visible consent, then uses ordered trusted clicks before sending', async () => {
  const events: string[] = [];
  const probes = { welcome: 0, intro: 0, slide: 0, composer: 0 };
  const clicks: string[] = [];
  const panel: Pick<NativePanel, 'inPanel' | 'click'> = {
    inPanel: async (expression: string) => {
      if (expression.includes("'welcome'")) {
        events.push('welcome');
        return ++probes.welcome >= 3;
      }
      if (expression.includes("'intro'")) {
        assert.deepEqual(clicks, ['#consent-ok']);
        events.push('intro');
        return ++probes.intro < 2;
      }
      if (expression.includes("'intro-next'")) {
        assert.deepEqual(clicks, ['#consent-ok', '#intro-next']);
        events.push('slide');
        return ++probes.slide < 2 ? 'Next' : 'Let’s go';
      }
      assert.ok(expression.includes("'composer'"));
      assert.deepEqual(clicks, ['#consent-ok', '#intro-next', '#intro-next']);
      events.push('composer');
      return ++probes.composer < 2;
    },
    click: async (selector: string) => {
      assert.ok(probes.welcome >= 3, 'the storage read has not finished while the consent is hidden');
      if (selector === '#intro-next') assert.equal(clicks.length === 1 ? probes.intro : probes.slide, 2);
      events.push(selector);
      clicks.push(selector);
    },
  };
  await completePanelFirstRun(panel);
  assert.deepEqual(clicks, ['#consent-ok', '#intro-next', '#intro-next']);
  assert.deepEqual(events, [
    'welcome',
    'welcome',
    'welcome',
    '#consent-ok',
    'intro',
    'intro',
    '#intro-next',
    'slide',
    'slide',
    '#intro-next',
    'composer',
    'composer',
  ]);
});
