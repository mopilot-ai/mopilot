// The install words one module says for the Mac and the phone (shared/host/installWords.mjs): the Mac's lines and controls read the same ones the phone's sheet does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { INSTALL_WORDS, MAX_TEXT, installLine, installStatus, installText } from '../shared/host/installWords.mjs';
import { installLine as macInstallLine } from '../src/lib/hostInstall.ts';
import { TAIL_STATES } from '../shared/host/machineLine.mjs';

test('the Mac’s line is the shared one, state by state, as it always read', () => {
  assert.equal(macInstallLine, installLine);
  const line = (state: string, error: string | null = null) => installLine({ state, harness: 'codex', error });
  assert.equal(installLine(undefined), '');
  assert.equal(line('queued'), 'Waiting to install Codex…');
  assert.equal(line('running'), 'Installing Codex…');
  assert.equal(line('checking'), 'Checking Codex…');
  assert.equal(line('installed'), 'Codex installed.');
  assert.equal(line('cancelled'), '');
  assert.equal(line('failed'), "Couldn't install Codex.");
  assert.equal(line('failed', 'npm could not find the package.'), 'npm could not find the package.');
  assert.equal(line('unreachable', 'The machine did not answer.'), 'The machine did not answer.');
  assert.equal(installLine({ state: 'failed', harness: 'claude' }), "Couldn't install Claude Code.");
});

test('the machine’s text is one bounded line, and anything else is nothing', () => {
  assert.equal(installText('  npm\n\u0007warn  '), 'npm warn');
  assert.equal(installText('x'.repeat(MAX_TEXT + 50)).length, MAX_TEXT);
  assert.equal(installText(42), '');
  assert.equal(installText(undefined), '');
});

test('the phone’s states in the same words, with what the person can do next', () => {
  const view = (state: string, extra: object = {}) => ({ state, harness: 'codex', error: null, line: '', ...extra });
  assert.equal(installStatus(undefined), null);
  assert.equal(installStatus(view('idle')), null);
  assert.equal(installStatus(view('cancelled')), null);
  assert.equal(installStatus(view('nonsense')), null);
  assert.deepEqual(installStatus(view('starting')), { text: 'Waiting to install Codex…', action: 'cancel' });
  assert.deepEqual(installStatus(view('installing')), { text: 'Installing Codex…', action: 'cancel' });
  // the machine's own progress line rides along, unless it says what the line already does
  assert.deepEqual(installStatus(view('installing', { line: 'Fetching the package…' })), {
    text: 'Installing Codex…',
    action: 'cancel',
    details: 'Fetching the package…',
  });
  assert.deepEqual(installStatus(view('installing', { line: 'Installing Codex…' })), { text: 'Installing Codex…', action: 'cancel' });
  assert.deepEqual(installStatus(view('checking')), { text: 'Checking Codex…' });
  assert.deepEqual(installStatus(view('done')), { text: 'Codex installed.' });
  assert.deepEqual(installStatus(view('failed', { error: 'npm could not find the package.' })), {
    text: 'npm could not find the package.',
    action: 'retry',
  });
  assert.deepEqual(installStatus(view('unreachable')), { text: "Couldn't install Codex.", action: 'retry' });
});

test('the labels, and the sentences for the ways an install ends without the machine’s own reason, are read from here by the Mac', () => {
  assert.equal(INSTALL_WORDS.install('Codex'), 'Install Codex');
  assert.deepEqual(
    [INSTALL_WORDS.installing, INSTALL_WORDS.cancel, INSTALL_WORDS.retry, INSTALL_WORDS.done],
    ['Installing…', 'Cancel', 'Try again', 'Done'],
  );
  // the Mac's service reads the sentences from this module, not a copy of its own
  const source = readFileSync(new URL('../electron/host/machineInstall.cjs', import.meta.url), 'utf8');
  for (const key of ['lost', 'failed', 'tooLong', 'oldHost']) assert.match(source, new RegExp(`INSTALL_WORDS\\.${key}\\b`));
  assert.doesNotMatch(source, /'The machine lost|'The install (failed|took)|'Update the Host on/);
  // the row's button says the same
  const state = (TAIL_STATES as any[]).find((s) => s.id === 'install');
  const machine = { agents: [{ id: 'codex', label: 'Codex', state: 'missing' }], installable: ['codex'] };
  assert.equal(state.line(machine, {}).action.label, INSTALL_WORDS.install('Codex'));
});
