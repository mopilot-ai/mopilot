// Basic-tier harness list, renderer side (src/session/harness/acp.ts): detection, re-checks, sign-in, and looking again
// when the window regains focus or a view that offers the harnesses opens.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset, tick } from './support/harness-logic-fakes.ts';

const acp = await import('../src/session/harness/acp.ts');

const harness = (o: any = {}) => ({ id: 'kimi', label: 'Kimi Code', state: 'ready', authMethods: [], login: null, bin: null, ...o });

beforeEach(() => reset());

test('detection lists harnesses; a failed list still marks them listed', async () => {
  fx.native.acp = { harnesses: async () => [harness()] };
  await acp.detectBasicHarnesses();
  assert.equal(fx.state.basicHarnesses.length, 1);
  assert.equal(fx.state.basicListed, true);
  reset();
  fx.native.acp = {
    harnesses: async () => {
      throw new Error('x');
    },
  };
  await acp.detectBasicHarnesses();
  assert.deepEqual(fx.state.basicHarnesses, []);
  assert.equal(fx.state.basicListed, true);
  // a view that offers them (Settings, the harness menu) lists them afresh when it opens
  fx.native.acp = { harnesses: async () => [harness({ id: 'opencode' })] };
  acp.useFreshBasics();
  await tick();
  assert.equal(fx.state.basicHarnesses[0].id, 'opencode');
});

test("recheck marks the probed harnesses checking, then takes main's answer or reports the error", async () => {
  fx.state.basicHarnesses = [harness(), harness({ id: 'qwen' }), harness({ id: 'gone', state: 'missing' })];
  let seen: any;
  fx.native.acp = {
    recheck: async (id: any) => ((seen = fx.state.basicHarnesses.map((h: any) => h.state)), [harness({ id: id ?? 'all' })]),
  };
  await acp.recheckBasic('kimi');
  assert.deepEqual(seen, ['checking', 'ready', 'missing']);
  assert.deepEqual(called('toast'), [], 'found: nothing to say');
  fx.state.basicHarnesses = [harness(), harness({ id: 'qwen' }), harness({ id: 'gone', state: 'missing' })];
  await acp.recheckBasic();
  assert.deepEqual(seen, ['checking', 'checking', 'missing']);
  assert.equal(fx.state.basicHarnesses[0].id, 'all');
  fx.native.acp = {
    recheck: async () => {
      throw new Error('probe failed');
    },
  };
  await acp.recheckBasic();
  fx.native.acp = {
    recheck: async () => {
      throw 'raw';
    },
  };
  await acp.recheckBasic();
  assert.deepEqual(called('toast'), [
    ['probe failed', 'error'],
    ['raw', 'error'],
  ]);
});

test('a re-check of a harness that is still missing says so, since its row shows no Checking… state', async () => {
  fx.state.basicHarnesses = [harness({ state: 'missing' })];
  fx.native.acp = { recheck: async () => [harness({ state: 'missing' }), harness({ id: 'qwen', label: 'Qwen', state: 'missing' })] };
  await acp.recheckBasic('kimi');
  await acp.recheckBasic();
  assert.deepEqual(called('toast'), [["Kimi Code still isn't found. Install it, or set its path"]]);
  fx.native.acp = { recheck: async () => [harness({ state: 'checking', bin: '/b/kimi' })] };
  await acp.recheckBasic('kimi');
  assert.equal(called('toast').length, 1, 'found this time: no toast');
});

test("loginCommand: the method's terminal auth, else the quirks login, else none", () => {
  const term = { id: 'term', _meta: { 'terminal-auth': { command: 'kimi', args: ['login'], label: 'Kimi sign-in' } } };
  assert.deepEqual(acp.loginCommand(harness({ authMethods: [term] }) as any, 'term'), {
    command: ['kimi', 'login'],
    title: 'Kimi sign-in',
  });
  const bare = { id: 'b', _meta: { 'terminal-auth': { command: 'kimi' } } };
  assert.deepEqual(acp.loginCommand(harness({ authMethods: [bare] }) as any, 'b'), { command: ['kimi'], title: 'Kimi Code login' });
  assert.deepEqual(acp.loginCommand(harness({ login: ['kimi', 'auth', 'login'], bin: '/usr/bin/kimi' }) as any, null), {
    command: ['/usr/bin/kimi', 'auth', 'login'],
    title: 'Kimi Code login',
  });
  assert.equal(acp.loginCommand(harness({ login: ['kimi'], authMethods: [{ id: 'x' }] }) as any, 'x'), null);
});

test("loginCommand: ACP's terminal auth method runs the harness's own binary with its args and env", () => {
  // Qwen Code 0.25.2 puts it in _meta; ACP's own shape has it at the top (Kimi Code 2.2.0 sends both kinds)
  const qwen = { id: 'openai', name: 'Use OpenAI API key', _meta: { type: 'terminal', args: ['--auth-type=openai'] } };
  assert.deepEqual(acp.loginCommand(harness({ label: 'Qwen Code', bin: '/u/qwen', authMethods: [qwen] }) as any, 'openai'), {
    command: ['/u/qwen', '--auth-type=openai'],
    title: 'Qwen Code login',
  });
  const top = { id: 'login', type: 'terminal', args: ['--login', 7], env: { KIMI_X: '1', BAD: 2 } };
  assert.deepEqual(acp.loginCommand(harness({ bin: '/u/kimi', authMethods: [top] }) as any, 'login'), {
    command: ['/u/kimi', '--login'],
    title: 'Kimi Code login',
    env: { KIMI_X: '1' },
  });
  // terminal-auth's own command comes first, and its env goes with it; its bare name is the binary found here
  const both = { ...top, _meta: { 'terminal-auth': { command: 'kimi', args: ['login'], env: { A: 'b' } } } };
  assert.deepEqual(acp.loginCommand(harness({ bin: '/u/kimi', authMethods: [both] }) as any, 'login'), {
    command: ['/u/kimi', 'login'],
    title: 'Kimi Code login',
    env: { A: 'b' },
  });
  // no args, an env with nothing usable, or no binary found
  // another command by a bare name keeps its own; on Windows the harness's kimi.exe found here is used
  const other = { id: 'o', _meta: { 'terminal-auth': { command: 'node', args: ['x'] } } };
  assert.deepEqual(acp.loginCommand(harness({ bin: '/u/kimi', authMethods: [other] }) as any, 'o')?.command, ['node', 'x']);
  const win = { id: 'w', _meta: { 'terminal-auth': { command: 'kimi' } } };
  assert.deepEqual(acp.loginCommand(harness({ bin: 'C:\\k\\kimi.exe', authMethods: [win] }) as any, 'w')?.command, ['C:\\k\\kimi.exe']);
  assert.deepEqual(acp.loginCommand(harness({ bin: '/u/kimi', authMethods: [{ id: 't', type: 'terminal', env: [] }] }) as any, 't'), {
    command: ['/u/kimi'],
    title: 'Kimi Code login',
  });
  assert.equal(acp.loginCommand(harness({ authMethods: [qwen] }) as any, 'openai'), null);
  assert.equal(acp.loginCommand(harness({ bin: '/u/x', authMethods: [{ id: 'k', _meta: { type: 'key' } }] }) as any, 'k'), null);
});

test('an authenticate that leaves the harness signed out says so, with its reason when it has one', async () => {
  fx.native.acp = {
    authenticate: async () => ({
      harnesses: [harness({ id: 'goose', state: 'signin', reason: 'Sign in to Goose first' })],
      cancelled: false,
    }),
  };
  await acp.authenticateBasic(harness({ id: 'goose', label: 'Goose' }) as any, 'goose-provider');
  fx.native.acp = {
    authenticate: async () => ({
      harnesses: [harness({ id: 'goose', state: 'signin', reason: null }), harness({ state: 'signin' })],
      cancelled: false,
    }),
  };
  await acp.authenticateBasic(harness({ id: 'goose', label: 'Goose' }) as any, 'goose-provider');
  assert.deepEqual(called('toast'), [
    ['Goose is still signed out: Sign in to Goose first', 'error'],
    ['Goose is still signed out', 'error'],
  ]);
});

test("authenticate over ACP: main's list on success, the reason without IPC noise on failure", async () => {
  fx.native.acp = { authenticate: async () => ({ harnesses: [harness({ state: 'ready' })], cancelled: false }) };
  await acp.authenticateBasic(harness() as any, 'oauth');
  assert.equal(fx.state.basicHarnesses[0].state, 'ready');
  fx.native.acp = {
    authenticate: async () => {
      throw new Error("Error invoking remote method 'acp:auth': Error: denied");
    },
  };
  await acp.authenticateBasic(harness() as any, 'oauth');
  fx.native.acp = {
    authenticate: async () => {
      throw 'nope';
    },
  };
  await acp.authenticateBasic(harness() as any, 'oauth');
  assert.deepEqual(called('toast'), [
    ['Kimi Code: denied', 'error'],
    ['Kimi Code: nope', 'error'],
  ]);
});

test('a cancelled sign-in takes the list as it is and says nothing', async () => {
  fx.native.acp = { authenticate: async () => ({ harnesses: [harness({ state: 'signin' })], cancelled: true }) };
  await acp.authenticateBasic(harness() as any, 'oauth');
  assert.equal(fx.state.basicHarnesses[0].state, 'signin');
  assert.deepEqual(called('toast'), []);
});

test('a second click while the sign-in waits asks main nothing more; once it ends a click asks again', async () => {
  const asked: string[] = [];
  let finish!: (r: any) => void;
  fx.native.acp = {
    authenticate: (id: string, m: string) => (asked.push(`${id} ${m}`), new Promise((r) => (finish = r))),
  };
  const first = acp.authenticateBasic(harness() as any, 'oauth');
  await acp.authenticateBasic(harness() as any, 'other');
  assert.deepEqual(asked, ['kimi oauth']);
  finish({ harnesses: [harness({ state: 'admitted' })], cancelled: false });
  await first;
  // a failed one is over too
  fx.native.acp.authenticate = async (id: string, m: string) => {
    asked.push(`${id} ${m}`);
    throw new Error('denied');
  };
  await acp.authenticateBasic(harness() as any, 'oauth');
  await acp.authenticateBasic(harness() as any, 'oauth');
  assert.deepEqual(asked, ['kimi oauth', 'kimi oauth', 'kimi oauth']);
});

test('Cancel asks main to stop waiting; a failure to reach it says so; a failed list of sign-ins is ignored', async () => {
  const cancels: string[] = [];
  fx.native.acp = { cancelSignIn: async (id: string) => (cancels.push(id), true) };
  await acp.cancelBasicSignIn('kimi');
  assert.deepEqual(cancels, ['kimi']);
  assert.deepEqual(called('toast'), []);
  fx.native.acp.cancelSignIn = async () => {
    throw new Error("Error invoking remote method 'acp:cancelSignIn': Error: gone");
  };
  await acp.cancelBasicSignIn('kimi');
  assert.deepEqual(called('toast'), [["Couldn't cancel the sign-in: gone", 'error']]);
  const { followBasicSignIns } = await import('../src/session/harness/acpSignIn.ts');
  fx.state.basicSignIns = { kimi: 'oauth' };
  fx.native.acp = {
    onSignIns: () => {},
    signIns: async () => {
      throw new Error('no window');
    },
  };
  followBasicSignIns();
  await tick();
  assert.deepEqual(fx.state.basicSignIns, { kimi: 'oauth' });
});

test('a harness installed while the app ran shows once the window regains focus, without a restart', async () => {
  let onHarnesses: any;
  const win = new EventTarget();
  (globalThis as any).window = win;
  fx.native.acp = {
    onEvent: () => {},
    onHarnesses: (h: any) => (onHarnesses = h),
    harnesses: async () => [],
    list: async () => [],
    onSignIns: (cb: any) => (onSignIns = cb),
    signIns: async () => ({ kimi: 'oauth' }),
  };
  let onSignIns: any;
  acp.startAcp();
  await tick();
  // the sign-ins under way follow main: its answer at start, then each push
  assert.deepEqual(fx.state.basicSignIns, { kimi: 'oauth' });
  onSignIns({});
  assert.deepEqual(fx.state.basicSignIns, {});
  // installed while the app ran: the window regaining focus asks main again, so it shows without a restart
  fx.native.acp.harnesses = async () => [harness({ state: 'checking', bin: '/b/kimi' })];
  onHarnesses([harness({ state: 'missing' })]);
  win.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(fx.state.basicHarnesses[0].state, 'checking');
  // answers and pushes come in the order main built them: a push that arrives first is older and the answer wins
  let answer!: (l: any[]) => void;
  fx.native.acp.harnesses = () => new Promise((r) => (answer = r));
  const pending = acp.detectBasicHarnesses();
  onHarnesses([harness({ state: 'admitted', bin: '/old/kimi' })]);
  answer([harness({ state: 'missing' })]);
  await pending;
  assert.equal(fx.state.basicHarnesses[0].state, 'missing');
  onHarnesses([harness({ state: 'admitted' })]);
  // a focus while the app quits or main is busy: the list stays as it was
  fx.native.acp.harnesses = async () => {
    throw new Error('gone');
  };
  win.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(fx.state.basicHarnesses[0].state, 'admitted');
});
