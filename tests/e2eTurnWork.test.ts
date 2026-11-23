// E2E completed-work ownership against controlled locator boundaries: streamed replies are not turn completion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';
import { deferred } from './support/async-scenarios.ts';
import { openCompletedTurnWork } from './e2e/fixtures/turnWork.ts';

type Turn = { message: string; completed: boolean; open: boolean; noClass?: boolean };
type Fixture = {
  turns: Turn[];
  changed: ReturnType<typeof deferred<void>>;
  clicks: string[];
  waits: string[];
};

/** A lazy locator boundary: a completed header only exists after its fixture turn completes. */
class FakeLocator {
  fixture: Fixture;
  pick: () => Turn[];
  kind: string;

  constructor(fixture: Fixture, pick: () => Turn[], kind: string) {
    this.fixture = fixture;
    this.pick = pick;
    this.kind = kind;
  }

  getByRole(role: string, options?: { name: RegExp }) {
    if (role === 'main') return new FakeLocator(this.fixture, this.pick, 'main');
    assert.equal(role, 'button');
    return new FakeLocator(
      this.fixture,
      () => this.pick().filter((turn) => turn.completed && options!.name.test('Worked for 0s')),
      'button',
    );
  }

  getByText(message: string, options: { exact: boolean }) {
    return new FakeLocator(
      this.fixture,
      () => this.pick().filter((turn) => (options.exact ? turn.message === message : turn.message.includes(message))),
      'message',
    );
  }

  locator(selector: string) {
    assert.equal(selector, '.turn');
    return new FakeLocator(this.fixture, this.pick, 'turn');
  }

  filter({ has }: { has: FakeLocator }) {
    return new FakeLocator(this.fixture, () => this.pick().filter((turn) => has.pick().includes(turn)), this.kind);
  }

  last() {
    return new FakeLocator(this.fixture, () => this.pick().slice(-1), this.kind);
  }

  async waitFor(options: { state: string }) {
    assert.equal(options.state, 'visible');
    this.fixture.waits.push(this.kind);
    if (!this.pick().length) await this.fixture.changed.promise;
    assert.equal(this.pick().length, 1, 'strict locator requires one matching turn/control');
  }

  async getAttribute(name: string) {
    assert.equal(name, 'class');
    const [turn] = this.pick();
    assert.ok(turn);
    return turn.noClass ? null : `worked-for${turn.open ? ' open' : ''}`;
  }

  async click() {
    const targets = this.pick();
    assert.equal(targets.length, 1, 'a click must resolve exactly one control');
    const [turn] = targets;
    assert.ok(turn.completed, 'a completed-work click cannot precede completion');
    this.fixture.clicks.push(turn.message);
    turn.open = !turn.open;
  }
}

function fixture(turns: Turn[]) {
  const state: Fixture = { turns, changed: deferred<void>(), clicks: [], waits: [] };
  const page = new FakeLocator(state, () => state.turns, 'page') as unknown as Page;
  return { state, page };
}

test('the current reply can precede completion: older and newer unrelated completed turns are never clicked', async () => {
  const message = `RUNCMDTIMEOUT two 'quoted' [exact]`;
  const previous = { message: 'RUNCMDFAIL one', completed: true, open: true };
  const current = { message, completed: false, open: false };
  const { state, page } = fixture([
    previous,
    { message: `${message} suffix`, completed: true, open: false },
    current,
    { message: 'unrelated later turn', completed: true, open: false },
  ]);
  const pending = openCompletedTurnWork(page, message);
  await Promise.resolve();
  assert.deepEqual(state.clicks, []);
  assert.deepEqual(state.waits, ['turn', 'button']);
  assert.equal(previous.open, true);
  current.completed = true;
  state.changed.resolve();
  const scoped = (await pending) as unknown as FakeLocator;
  assert.deepEqual(scoped.pick(), [current]);
  assert.deepEqual(state.clicks, [message]);
  assert.equal(current.open, true);
  assert.equal(previous.open, true);
});

test('an already completed closed turn opens, including a control without a class attribute', async () => {
  for (const noClass of [false, true]) {
    const current = { message: 'RUNCMD fine', completed: true, open: false, noClass };
    const { state, page } = fixture([current]);
    await openCompletedTurnWork(page, current.message);
    assert.deepEqual(state.clicks, [current.message]);
    assert.equal(current.open, true);
  }
});

test('opening already-open completed work is idempotent', async () => {
  const current = { message: 'RUNCMDFAIL one', completed: true, open: true };
  const { state, page } = fixture([current]);
  await openCompletedTurnWork(page, current.message);
  await openCompletedTurnWork(page, current.message);
  assert.deepEqual(state.clicks, []);
  assert.equal(current.open, true);
});

test('two rendered identical messages are rejected before choosing the only completed header', async () => {
  const { state, page } = fixture([
    { message: 'repeated', completed: true, open: true },
    { message: 'repeated', completed: false, open: false },
  ]);
  await assert.rejects(openCompletedTurnWork(page, 'repeated'), /strict locator/);
  assert.deepEqual(state.waits, ['turn']);
  assert.deepEqual(state.clicks, []);
  assert.equal(state.turns[0].open, true);
});

test('failed completion or missing-turn waits propagate without clicking a fallback', async () => {
  for (const present of [false, true]) {
    const { state, page } = fixture([
      { message: 'previous', completed: true, open: true },
      ...(present ? [{ message: 'current', completed: false, open: false }] : []),
    ]);
    const pending = openCompletedTurnWork(page, 'current');
    await Promise.resolve();
    state.changed.reject(new Error('locator wait failed'));
    await assert.rejects(pending, /locator wait failed/);
    assert.deepEqual(state.clicks, []);
    assert.equal(state.turns[0].open, true);
  }
});
