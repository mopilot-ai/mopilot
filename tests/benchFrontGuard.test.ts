// The benchmark VM's GUI driver sends keys and clicks only to the app it brought to the front (#1561): the guard's
// AppleScript and error (bench/lib/frontGuard.mjs), gui.mjs's keys and clicks, and the vendor-app turns that stop
// instead of typing into another app. child_process is faked: `front` is the app System Events reports in front.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Call = { cmd: string; args: string[]; ok?: boolean; input?: string };
const calls: Call[] = [];
let front = 'ChatGPT';
/** what to do after a script runs (an app coming to the front mid-turn) */
let after: ((script: string) => void) | null = null;
let failOther: string | null = null;
/** how many sheets the front window reports */
let sheets = 0;
/** the GUI user's clipboard (gui.paste reads it back before Cmd+V) */
let clipboard = '';

const refusal = (name: string) =>
  Object.assign(new Error('Command failed: launchctl asuser 501 osascript'), {
    status: 1,
    stderr: `0:212: execution error: ${name} (9001)\n`,
  });

mock.module('node:child_process', {
  exports: {
    execFileSync(file: string, args: string[] = [], opts: { input?: string } = {}) {
      if (file === 'sleep') return '';
      // launchctl asuser <uid> <cmd> ...args
      const cmd = args[2];
      const rest = args.slice(3);
      const call: Call = { cmd, args: rest, input: opts.input };
      calls.push(call);
      if (cmd === 'pbcopy') clipboard = opts.input ?? '';
      if (cmd === 'pbpaste') return clipboard;
      if (cmd !== 'osascript') return '';
      const script = rest.filter((_, i) => i % 2 === 1).join('\n');
      if (failOther) throw Object.assign(new Error('Command failed'), { stderr: failOther });
      // the composer-focus walk (JXA over stdin) reports the focus took
      if (rest.includes('JavaScript')) return 'ok';
      if (script.includes('get bounds of window of desktop')) return '2400\n';
      const want = /if n is not "((?:[^"\\]|\\.)*)"/.exec(script);
      if (want && JSON.parse(`"${want[1]}"`) !== front) throw refusal(front);
      call.ok = true;
      after?.(script);
      if (script.includes('count of sheets')) return `${sheets}\n`;
      if (script.includes('of window 1 of p')) return '10, 20, 800, 600\n';
      return '';
    },
  },
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'front-guard-home-'));
process.env.HOME = home;
const { FRONT_ERROR, NotFrontmost, appleString, frontFailure, guardedScript } = await import('../bench/lib/frontGuard.mjs');
const gui = await import('../bench/drivers/gui.mjs');
const desktop = await import('../bench/drivers/desktop.mjs');
const { vendorTurn, archiveChat } = await import('../bench/drivers/mgbDesktop.mjs');

const ARM = { app: 'ChatGPT', transcripts: 'codex', newChat: 'cmd+n', composer: null };
/** the osascript scripts that ran (a refused one did nothing) */
const sent = () => calls.filter((c) => c.cmd === 'osascript' && c.ok).map((c) => c.args.filter((_, i) => i % 2 === 1).join('\n'));
const keyCodes = () => sent().flatMap((s) => /key code (\d+)/.exec(s)?.[1] ?? []);
const clicks = () => calls.filter((c) => c.cmd === '/opt/homebrew/bin/cliclick').map((c) => c.args[0]);

beforeEach(() => {
  calls.length = 0;
  front = 'ChatGPT';
  after = null;
  failOther = null;
  sheets = 0;
  clipboard = '';
});

test('guardedScript checks the frontmost process by name or displayed name, then acts, in one System Events call', () => {
  assert.deepEqual(guardedScript('ChatGPT', 'key code 36'), [
    'tell application "System Events"',
    'set p to first application process whose frontmost is true',
    'set n to (name of p) as text',
    `if n is not "ChatGPT" and ((displayed name of p) as text) is not "ChatGPT" then error n number ${FRONT_ERROR}`,
    'key code 36',
    'end tell',
  ]);
  // a check alone has no action line
  assert.equal(guardedScript('ChatGPT').length, 5);
  // quotes and backslashes in a name stay inside the AppleScript string
  assert.equal(appleString('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
});

test("frontFailure reads the guard's refusal from osascript's error, and passes any other failure on unchanged", () => {
  const e = frontFailure('ChatGPT', refusal('Google Chrome'));
  assert.ok(e instanceof NotFrontmost);
  assert.equal(e.code, 'not_frontmost');
  assert.equal(e.want, 'ChatGPT');
  assert.equal(e.front, 'Google Chrome');
  assert.match(e.message, /^ChatGPT is not the frontmost app \(Google Chrome is\), so nothing was sent\.$/);
  // the number in the message alone (no stderr) is read too
  assert.equal(frontFailure('Claude', new Error('0:9: execution error: Finder (9001)')).front, 'Finder');
  const other = Object.assign(new Error('boom'), { stderr: '0:9: execution error: Not authorized (-1743)' });
  assert.equal(frontFailure('ChatGPT', other), other);
  assert.equal(frontFailure('ChatGPT', null), null);
});

test('gui: keys and clicks before any app was brought to the front send nothing', async () => {
  // a fresh module: no app activated yet
  const fresh = await import(`../bench/drivers/gui.mjs?fresh=${Date.now()}`);
  assert.throws(() => fresh.key(36), { code: 'no_target' });
  assert.throws(() => fresh.clickAt(1, 2), { code: 'no_target' });
  assert.deepEqual(calls, []);
});

test('gui: keys, keystrokes and clicks go to the activated app while it is in front', () => {
  gui.activate('ChatGPT');
  assert.match(sent()[0], /^tell application "ChatGPT" to activate$/);
  gui.key(9, 'command down');
  gui.keystroke('3');
  gui.clickAt(10.4, 20.6);
  gui.rightClickAt(5, 6);
  gui.click(600, 300);
  assert.deepEqual(keyCodes(), ['9']);
  assert.ok(sent().some((s) => s.includes('key code 9 using {command down}')));
  assert.ok(sent().some((s) => s.endsWith('keystroke "3"\nend tell')));
  // the screenshot space is 1200 px wide over a 2400 pt desktop
  assert.deepEqual(clicks(), ['c:10,21', 'rc:5,6', 'c:1200,600']);
});

test('gui: with another app in front, a key, keystroke or click throws NotFrontmost and sends nothing to it', () => {
  gui.activate('ChatGPT');
  front = 'Google Chrome';
  for (const act of [() => gui.key(36), () => gui.keystroke('x'), () => gui.clickAt(1, 1), () => gui.rightClickAt(1, 1)])
    assert.throws(act, (e: any) => e instanceof NotFrontmost && e.front === 'Google Chrome' && e.want === 'ChatGPT');
  assert.deepEqual(clicks(), []);
  // any other osascript failure is passed on as it was
  failOther = 'execution error: Not authorized (-1743)';
  assert.throws(
    () => gui.key(36),
    (e: any) => e.stderr === failOther,
  );
});

test('gui: focusProcess brings a process to the front by its process name, and keys then go only to it', () => {
  gui.focusProcess('Electron');
  assert.match(sent()[0], /set frontmost of first process whose name is "Electron" to true/);
  front = 'Electron';
  gui.key(53);
  front = 'ChatGPT';
  assert.throws(() => gui.key(53), { code: 'not_frontmost' });
});

test('desktopTurn: another app in front stops the turn before the message is pasted or sent', () => {
  front = 'Google Chrome';
  const r: any = desktop.desktopTurn({ arm: ARM, prompt: 'hello (ref t1)', tag: 't1', timeoutS: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.notSent, true);
  assert.equal(r.front, 'Google Chrome');
  assert.equal(r.file, null);
  assert.deepEqual(keyCodes(), [], 'no Esc, Cmd+N, paste or Return reached any app');
});

test('desktopTurn: an app that comes to the front after Return is named, and the closing Esc is not sent to it', () => {
  after = (script) => {
    if (script.includes('key code 36')) front = 'Finder';
  };
  const r: any = desktop.desktopTurn({
    arm: { ...ARM, modelKeys: { 'GPT-6 Luna': '2' } },
    prompt: 'p',
    tag: 't2',
    timeoutS: 0,
    model: 'GPT-6 Luna',
  });
  assert.equal(r.ok, false);
  assert.equal(r.front, 'Finder');
  // Esc, Cmd+N, the model picker, Cmd+A, Delete, Cmd+V, Return: and no Esc afterwards
  assert.deepEqual(keyCodes(), ['53', '45', '34', '0', '51', '9', '36']);
  assert.ok(sent().some((s) => s.includes('keystroke "2"')));
});

test('desktopTurn: a failure that is not a refusal is not hidden', () => {
  failOther = 'execution error: Not authorized (-1743)';
  assert.throws(
    () => desktop.desktopTurn({ arm: ARM, prompt: 'p', tag: 't3', timeoutS: 0 }),
    (e: any) => e.stderr === failOther,
  );
});

const CARD = { id: 'c1', name: 'mcp__computer-use__request_access' };
const returns = () => keyCodes().filter((c) => c === '36').length;
type Answered = Map<string, { tries: number; sentAt: number; obstructed: boolean; confirmed: boolean }>;

test('approveAccess: the shortcut counts only once the card leaves the pending slot', () => {
  const answered: Answered = new Map();
  assert.equal(desktop.approveAccess(ARM, null, answered, 0), 0, 'nothing pending');
  assert.equal(desktop.approveAccess(ARM, { id: 'x', name: 'Bash' }, answered, 0), 0, 'not an access card');
  assert.equal(desktop.approveAccess(ARM, CARD, answered, 0), 0, 'sent, not yet confirmed');
  assert.equal(returns(), 1);
  assert.equal(desktop.approveAccess(ARM, CARD, answered, 1000), 0, 'not re-sent within the retry window');
  assert.equal(returns(), 1);
  assert.deepEqual(desktop.unansweredApprovals(answered), [{ id: 'c1', tries: 1, obstructed: false, denied: false }]);
  assert.equal(desktop.approveAccess(ARM, null, answered, 2000), 1, 'its result arrived');
  assert.equal(desktop.approveAccess(ARM, null, answered, 3000), 0, 'counted once');
  assert.deepEqual(desktop.unansweredApprovals(answered), []);
  // a confirmed card that shows up in a later poll is not answered again
  assert.equal(desktop.approveAccess(ARM, CARD, answered, 99_000), 0);
  assert.equal(returns(), 1);
});

test('approveAccess: a Save sheet covering the card gets no shortcut, is recorded, and the card is answered once it is gone', () => {
  const answered: Answered = new Map();
  sheets = 1;
  assert.equal(desktop.approveAccess(ARM, CARD, answered, 0), 0);
  assert.equal(returns(), 0, 'no Cmd+Return into the sheet');
  assert.deepEqual(desktop.unansweredApprovals(answered), [{ id: 'c1', tries: 0, obstructed: true, denied: false }]);
  sheets = 0;
  desktop.approveAccess(ARM, CARD, answered, 3000);
  assert.equal(returns(), 1);
  assert.equal(desktop.approveAccess(ARM, null, answered, 4000), 1);
});

test('approveAccess: an ignored shortcut is sent again, at most APPROVAL_TRIES times, then stays unanswered', () => {
  const answered: Answered = new Map();
  for (let i = 0; i < 6; i++) desktop.approveAccess(ARM, CARD, answered, i * (desktop.APPROVAL_RETRY_MS + 1));
  assert.equal(returns(), desktop.APPROVAL_TRIES);
  assert.deepEqual(desktop.unansweredApprovals(answered), [{ id: 'c1', tries: desktop.APPROVAL_TRIES, obstructed: false, denied: false }]);
});

test('approveAccess: an app in front other than the arm sends nothing and is tried again; other failures are not hidden', () => {
  const answered: Answered = new Map();
  front = 'Google Chrome';
  assert.equal(desktop.approveAccess(ARM, CARD, answered, 0), 0);
  assert.deepEqual(desktop.unansweredApprovals(answered), [{ id: 'c1', tries: 0, obstructed: false, denied: false }]);
  front = 'ChatGPT';
  desktop.approveAccess(ARM, CARD, answered, 1);
  assert.equal(returns(), 1);
  failOther = 'execution error: Not authorized (-1743)';
  assert.throws(
    () => desktop.approveAccess(ARM, { ...CARD, id: 'c2' }, answered, 2),
    (e: any) => e.stderr === failOther,
  );
});

test('frontSheetCount: reads the sheets of the front window, and a non-number as none', () => {
  sheets = 2;
  assert.equal(gui.frontSheetCount(), 2);
  sheets = 0;
  assert.equal(gui.frontSheetCount(), 0);
  // not a count, or no window to read: unknown, which counts as covered
  sheets = Number.NaN;
  assert.equal(gui.frontSheetCount(), 1);
  failOther = 'execution error: Invalid index. (-1719)';
  assert.equal(gui.frontSheetCount(), 1);
  failOther = null;
  // another app in front is a refusal for the caller, not "covered"
  front = 'Some Other App';
  assert.throws(
    () => gui.frontSheetCount(),
    (e: any) => e.code === 'not_frontmost',
  );
});

test('a card answered just before a question or a stop is still confirmed', () => {
  const run = claudeRun('tagH');
  run.prompt('go (ref tagH)');
  run.card();
  after = (script) => {
    if (answeredScript(script)) {
      run.grant();
      // the card is answered and the agent asks a question in the same poll
      run.add({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { question: 'which?' } }] },
      });
    }
  };
  const r: any = desktop.desktopTurn({ arm: CLAUDE, prompt: 'p', tag: 'tagH', timeoutS: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.approvals, 1);
  assert.deepEqual(r.unanswered, []);

  // the same through the follow-up message path
  const next = claudeRun('tagI');
  next.prompt('one (ref tagI)');
  next.end();
  let n = 0;
  after = (script) => {
    if (answeredScript(script)) {
      next.grant();
      next.add({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { question: 'which?' } }] },
      });
    } else if (script.includes('key code 36') && ++n === 2) {
      next.prompt('two');
      next.card();
    }
  };
  const v: any = vendorTurn({ arm: CLAUDE, prompts: ['one (ref tagI)', 'two'], tag: 'tagI', timeoutS: 5 });
  assert.equal(v.approvals, 1);
  assert.equal(v.driverError, false);
  assert.deepEqual(v.askLog, ['which?']);
});

/** A Claude transcript in the fake HOME holding the run tag, and helpers to append the app's records to it. */
function claudeRun(tag: string) {
  front = 'Claude';
  const dir = path.join(home, '.claude/projects/p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${tag}.jsonl`);
  const add = (d: unknown) => fs.appendFileSync(file, `${JSON.stringify(d)}\n`);
  const prompt = (text: string) => add({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  const card = () =>
    add({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'mcp__computer-use__request_access', input: {} }] },
    });
  const end = () =>
    add({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
  const grant = () =>
    add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'granted' }] } });
  return { file, prompt, card, end, add, grant };
}
const CLAUDE = { app: 'Claude', transcripts: 'claude', newChat: 'cmd+n', composer: null };
const answeredScript = (s: string) => s.includes('key code 36 using {command down}');

test('desktopTurn: an access card answered in the app is confirmed when the turn ends, with nothing left unanswered', () => {
  const run = claudeRun('tagA');
  run.prompt('go (ref tagA)');
  run.card();
  after = (script) => {
    if (answeredScript(script)) {
      run.grant();
      run.end();
    }
  };
  const r: any = desktop.desktopTurn({ arm: CLAUDE, prompt: 'p', tag: 'tagA', timeoutS: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.approvals, 1);
  assert.deepEqual(r.unanswered, []);
});

test('desktopTurn: a Save sheet over the access card gets no shortcut and the stopped turn names the unanswered card', () => {
  const run = claudeRun('tagB');
  run.prompt('go (ref tagB)');
  run.card();
  sheets = 1;
  const r: any = desktop.desktopTurn({ arm: CLAUDE, prompt: 'p', tag: 'tagB', timeoutS: 0.05 });
  assert.equal(r.ok, false);
  assert.equal(r.approvals, 0);
  assert.deepEqual(r.unanswered, [{ id: 'c1', tries: 0, obstructed: true, denied: false }]);
  assert.equal(returns(), 1, 'only the prompt Return, no approval shortcut');
});

test('vendorTurn: an obstructed approval makes the run invalid (driver error), not a model result', () => {
  const run = claudeRun('tagC');
  run.prompt('go (ref tagC)');
  run.card();
  sheets = 1;
  const r: any = vendorTurn({ arm: CLAUDE, prompts: ['go (ref tagC)'], tag: 'tagC', timeoutS: 0.05 });
  assert.equal(r.driverError, true);
  assert.equal(r.error, 'access approval not delivered (a native sheet covered the card)');
  assert.equal(r.ok, false);
  sheets = 0;
  const quiet = claudeRun('tagD');
  quiet.prompt('go (ref tagD)');
  quiet.card();
  const ignored: any = vendorTurn({ arm: CLAUDE, prompts: ['go (ref tagD)'], tag: 'tagD', timeoutS: 0.05 });
  assert.equal(ignored.error, 'access approval not delivered', 'an ignored shortcut is named without a sheet');
});

test('vendorTurn: a later message whose card is answered, covered, or never sent is handled in the follow-up turn', () => {
  const run = claudeRun('tagE');
  run.prompt('one (ref tagE)');
  run.end();
  let sentPrompts = 0;
  after = (script) => {
    if (answeredScript(script)) {
      run.grant();
      return run.end();
    }
    if (script.includes('key code 36')) {
      if (++sentPrompts === 2) {
        run.prompt('two');
        run.card();
      }
    }
  };
  const ok: any = vendorTurn({ arm: CLAUDE, prompts: ['one (ref tagE)', 'two'], tag: 'tagE', timeoutS: 5 });
  assert.equal(ok.ok, true);
  assert.equal(ok.approvals, 1);
  assert.equal(ok.driverError, false);

  // covered by a sheet: the follow-up phase stops unanswered and the run is invalid
  const cov = claudeRun('tagF');
  cov.prompt('one (ref tagF)');
  cov.end();
  sheets = 1;
  let covSent = 0;
  after = (script) => {
    if (script.includes('key code 36') && !answeredScript(script) && ++covSent === 2) {
      cov.prompt('two');
      cov.card();
    }
  };
  const bad: any = vendorTurn({ arm: CLAUDE, prompts: ['one (ref tagF)', 'two'], tag: 'tagF', timeoutS: 0.05 });
  assert.equal(bad.driverError, true);
  assert.match(bad.error, /native sheet/);

  // the message never reaches the transcript: not sent, nothing pending
  const lost = claudeRun('tagG');
  lost.prompt('one (ref tagG)');
  lost.end();
  after = null;
  let t = 0;
  const realNow = Date.now;
  Date.now = () => (t += 30_000);
  try {
    const miss: any = vendorTurn({ arm: CLAUDE, prompts: ['one (ref tagG)', 'two'], tag: 'tagG', timeoutS: 600 });
    assert.equal(miss.driverError, true);
    assert.equal(miss.error, 'message 2 never reached the app');
  } finally {
    Date.now = realNow;
  }
});

test('a card the app denied after a sent shortcut is not an approval; the run is invalid and says so', () => {
  const answered: Answered = new Map();
  desktop.approveAccess(ARM, CARD, answered, 0);
  assert.equal(desktop.approveAccess(ARM, null, answered, 1, ['c1']), 0, 'the card left pending by being denied');
  assert.deepEqual(desktop.unansweredApprovals(answered), [{ id: 'c1', tries: 1, obstructed: false, denied: true }]);
  // a card denied that was never seen pending (sibling result first, old reader) is still listed
  const unseen: Answered = new Map();
  assert.equal(desktop.confirmApprovals(null, unseen, ['c9']), 0);
  assert.deepEqual(desktop.unansweredApprovals(unseen), [{ id: 'c9', tries: 0, obstructed: false, denied: true }]);

  const run = claudeRun('tagJ');
  run.prompt('go (ref tagJ)');
  run.card();
  after = (script) => {
    if (answeredScript(script)) {
      run.add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'user_denied' }] } });
      run.end();
    }
  };
  const r: any = vendorTurn({ arm: CLAUDE, prompts: ['go (ref tagJ)'], tag: 'tagJ', timeoutS: 5 });
  assert.equal(r.driverError, true);
  assert.equal(r.error, 'access approval denied by the app (the card timed out unanswered)');
  assert.equal(r.approvals, 0);
});

test("vendorTurn: a first message refused by the guard is the driver's error, naming the app in front", () => {
  front = 'Google Chrome';
  const r: any = vendorTurn({ arm: ARM, prompts: ['one (ref t4)', 'two'], tag: 't4', timeoutS: 5 });
  assert.equal(r.driverError, true);
  assert.equal(r.error, 'Google Chrome was in front, so the first message was not sent');
  assert.equal(r.ok, false);
});

test("frontWindowBounds reads the activated app's window in the call that checks it is in front, and refuses another app's", () => {
  gui.activate('ChatGPT');
  assert.deepEqual(gui.frontWindowBounds(), [10, 20, 800, 600]);
  front = 'Google Chrome';
  assert.throws(() => gui.frontWindowBounds(), { code: 'not_frontmost' });
});

test('settleApps sends its Esc only once the app it raised is the frontmost process', () => {
  gui.settleApps(['Finder']);
  const jxa = calls.find((c) => c.cmd === 'osascript' && c.args.includes('JavaScript'))?.input ?? '';
  const check = jxa.indexOf('se.processes.whose({frontmost:true})()');
  assert.ok(check > 0, 'the frontmost check is there');
  assert.ok(check < jxa.indexOf('se.keyCode(53)'), 'and comes before the Esc');
  assert.match(jxa, /if \(!f\.length \|\| f\[0\]\.name\(\)!==n\) continue;/);
});

test('archiveChat: with another app in front the chat is left unarchived and nothing is typed', () => {
  front = 'Google Chrome';
  assert.equal(archiveChat({ ...ARM, archive: 'shift-cmd-a' }, {}), false);
  assert.deepEqual(keyCodes(), []);
});
