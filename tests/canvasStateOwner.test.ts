// Shared preview generations retain failed edits, merge atomic field commits and synchronize authoritative controls across storage events.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { retainCanvasState } from '../src/lib/canvas/stateOwner.ts';
import { canvasStorageKey, readCanvasState, saveCanvasValue } from '../src/lib/canvas/persistence.ts';

test('live siblings share revisions, independent fields survive, and same-field commits explicitly use the latest writer', () => {
  localStorage.clear();
  const one = retainCanvasState('/repo/a:plan.canvas.tsx', localStorage),
    two = retainCanvasState('/repo/a:plan.canvas.tsx', localStorage);
  const other = retainCanvasState('/repo/a:plan.canvas.tsx/other', localStorage);
  const seen: any[] = [];
  const unsubscribe = two.subscribe((snapshot) => seen.push(snapshot));
  try {
    one.set('view', 'Roadmap');
    two.set('filter', 'open');
    one.set('view', 'Evidence');
    assert.deepEqual(two.read().state, { view: 'Evidence', filter: 'open' });
    assert.deepEqual(readCanvasState(localStorage, '/repo/a:plan.canvas.tsx'), { view: 'Evidence', filter: 'open' });
    assert.deepEqual(other.read().state, {});
    assert.equal(seen.at(-1).state.view, 'Evidence');
    assert.ok(seen.at(-1).revision > seen[0].revision);
    one.release();
    two.set('filter', 'closed');
    assert.equal(two.read().state.filter, 'closed');
    unsubscribe();
  } finally {
    two.release();
    other.release();
  }
  const reopened = retainCanvasState('/repo/a:plan.canvas.tsx', localStorage);
  try {
    assert.deepEqual(reopened.read().state, { view: 'Evidence', filter: 'closed' });
  } finally {
    reopened.release();
  }
});

test('failed writes remain visible to a replacement generation and recover without overwriting other windows fields', () => {
  localStorage.clear();
  const one = retainCanvasState('/pending', localStorage),
    two = retainCanvasState('/pending', localStorage);
  const blocked = mock.method(localStorage, 'setItem', () => {
    throw Error('quota');
  });
  try {
    one.set('view', 'Evidence');
    assert.equal(two.read().state.view, 'Evidence');
    assert.match(two.read().notice, /could not be saved/);
    blocked.mock.restore();
    saveCanvasValue(localStorage, '/pending', 'external', 'accepted');
    one.set('view', 'Targets');
    assert.deepEqual(two.read().state, { external: 'accepted', view: 'Targets' });
    assert.equal(two.read().notice, '');
    assert.throws(() => one.set('unsupported', undefined), /JSON data/);
    const cyclic: any = {};
    cyclic.self = cyclic;
    assert.throws(() => one.set('cycle', cyclic));
    assert.deepEqual(two.read().state, { external: 'accepted', view: 'Targets' });
  } finally {
    blocked.mock.restore();
    one.release();
    two.release();
  }
});

test('cross-window notifications read the latest committed values and ignore stale event contents or unrelated storage', () => {
  localStorage.clear();
  const owner = retainCanvasState('/shared', localStorage);
  const seen: any[] = [];
  const off = owner.subscribe((snapshot) => seen.push(snapshot));
  try {
    owner.read();
    saveCanvasValue(localStorage, '/shared', 'view', 'Roadmap');
    saveCanvasValue(localStorage, '/shared', 'view', 'Evidence');
    window.dispatchEvent(
      new window.StorageEvent('storage', { storageArea: localStorage, key: canvasStorageKey('/shared', 'view'), newValue: '"obsolete"' }),
    );
    assert.equal(owner.read().state.view, 'Evidence');
    assert.equal(seen.at(-1).state.view, 'Evidence');
    const count = seen.length;
    window.dispatchEvent(new window.StorageEvent('storage', { storageArea: sessionStorage, key: canvasStorageKey('/shared', 'view') }));
    window.dispatchEvent(new window.StorageEvent('storage', { storageArea: localStorage, key: canvasStorageKey('/other', 'view') }));
    assert.equal(seen.length, count);
    localStorage.clear();
    window.dispatchEvent(new window.StorageEvent('storage', { key: null }));
    assert.deepEqual(owner.read().state, {});
    off();
  } finally {
    owner.release();
  }
});

test('unreadable fields retain raw evidence and valid siblings; unavailable storage remains an honest transient preview', () => {
  localStorage.clear();
  const bad = canvasStorageKey('/partial', 'bad');
  localStorage.setItem(bad, '{broken');
  saveCanvasValue(localStorage, '/partial', 'view', 'Evidence');
  const partial = retainCanvasState('/partial', localStorage);
  try {
    assert.deepEqual(partial.read().state, { view: 'Evidence' });
    assert.match(partial.read().notice, /could not be read/);
    assert.equal(localStorage.getItem(bad), '{broken');
  } finally {
    partial.release();
  }
  const unavailable = {
    get length() {
      throw Error('blocked');
    },
    setItem() {
      throw Error('blocked');
    },
  } as unknown as Storage;
  const blocked = retainCanvasState('/blocked', unavailable);
  try {
    assert.match(blocked.read().notice, /could not be read/);
    blocked.set('view', 'Evidence');
    assert.equal(blocked.read().state.view, 'Evidence');
    assert.match(blocked.read().notice, /could not be saved/);
  } finally {
    blocked.release();
  }
});
