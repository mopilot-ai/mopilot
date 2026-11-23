// The uninstall survey (electron/chrome-extension/src/uninstallSurvey.mjs): Chrome is told the survey's page, with the extension's version; none while there is no survey.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';

const { setSurvey, SURVEY_URL } = await import('../electron/chrome-extension/src/uninstallSurvey.mjs');
const tick = () => new Promise((r) => setTimeout(r, 0));

test('the uninstall survey: the page with the version; nothing without one; a refusal is logged', async () => {
  const chrome: any = fakeChromeApi();
  const set: string[] = [];
  const logged: string[] = [];
  chrome.runtime.setUninstallURL = async (u: string) => set.push(u);
  const log = (w: string) => logged.push(w);
  assert.equal(setSurvey(chrome, log, ''), false);
  // the company's form, with the version
  assert.equal(SURVEY_URL, 'https://docs.google.com/forms/d/e/1FAIpQLSdRfOfFB0O756gnXpopyqYIp1GFmRya5gD_ceMKWQtJiVTLpA/viewform');
  assert.equal(setSurvey(chrome, log), true);
  await tick();
  assert.equal(set.at(-1), `${SURVEY_URL}?v=0.3.0`);
  assert.equal(setSurvey(chrome, log, 'https://forms.example/s?id=1'), true);
  await tick();
  assert.equal(set.at(-1), 'https://forms.example/s?id=1&v=0.3.0');
  chrome.runtime.setUninstallURL = async () => {
    throw new Error('Invalid URL');
  };
  setSurvey(chrome, log, 'https://forms.example/s');
  await tick();
  assert.deepEqual(logged, ['set the uninstall survey']);
  // a malformed address is logged, never thrown into the worker's start
  assert.equal(setSurvey(chrome, log, 'forms.example/no-scheme'), true);
  await tick();
  assert.deepEqual(logged, ['set the uninstall survey', 'set the uninstall survey']);
});
