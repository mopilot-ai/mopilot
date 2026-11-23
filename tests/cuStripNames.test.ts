// The computer-use strips name the app as a person reads it (lib/appNames.ts): its display name and icon from main, "your computer" before an app is known, and a common app's name for a bundle id.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, render, resetStore, setStore, native, settle } from './support/thread-kit.ts';

mockStore({ threadTitle: (t: any) => t?.name ?? 'New chat' });
const { useSessions } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
const { ComputerActivity } = await import('../src/components/thread/ComputerActivity.tsx');
const { AppControlStrip } = await import('../src/components/thread/AppControlStrip.tsx');
const { resetAppNames } = await import('../src/lib/appNames.ts');

const T = 'c1';
const ICONS: Record<string, string> = { Safari: 'data:safari', Notes: 'data:notes' };
native.computer = { appIdentity: async (app: string) => (ICONS[app] ? { name: app, bundleId: null, icon: ICONS[app] } : null) };
const session = (patch: object) => useSessions.setState({ sessions: { [T]: { ...EMPTY_SESSION, ...patch } as any } });
const title = (host: HTMLElement) => host.querySelector('.elsewhere-title')?.textContent;
const entry = (o: object) => ({
  bundleId: 'com.apple.Notes',
  app: 'Notes',
  title: null,
  windowId: 1,
  thumbnail: null,
  at: 1,
  takenOver: false,
  ...o,
});

beforeEach(() => {
  resetStore();
  resetAppNames();
});

test('full screen: "your computer" before an app, then the app with its icon; an unnamed bundle id reads "App"', async () => {
  session({ computer: { app: 'your Mac', state: 'active', read: null } });
  const v = await render(h(ComputerActivity, { threadId: T }));
  assert.equal(title(v.host), 'Using your computer · Esc to stop');
  await settle(() => session({ computer: { app: 'Safari', state: 'active', read: null } }));
  await settle();
  assert.equal(v.host.querySelector('img.cu-activity-app-icon')?.getAttribute('src'), 'data:safari');
  await settle(() => session({ computer: { app: 'com.example.thing', state: 'active', read: null } }));
  await settle();
  assert.equal(title(v.host), 'Using App · Esc to stop');
  assert.equal(v.host.querySelector('img.cu-activity-app-icon'), null);
  await v.unmount();
});

test('background: the working dot without a thumbnail, the app icon before its name; a nameless entry uses its bundle id', async () => {
  session({ appControl: { apps: [entry({})] } });
  const v = await render(h(AppControlStrip, { threadId: T }));
  await settle();
  // no thumbnail: the working dot, and the app's icon before its name
  assert.ok(v.host.querySelector('.elsewhere-icon .cu-activity-dot'));
  assert.equal(v.host.querySelector('.elsewhere-title img')?.getAttribute('src'), 'data:notes');
  await settle(() => session({ appControl: { apps: [entry({ thumbnail: 'data:thumb' })] } }));
  assert.ok(v.host.querySelector('img.cu-app-thumb'));
  assert.equal(v.host.querySelector('.elsewhere-title img')?.getAttribute('src'), 'data:notes');
  await settle(() => session({ appControl: { apps: [entry({ app: '', bundleId: 'com.apple.TextEdit', takenOver: true })] } }));
  assert.equal(title(v.host), 'You took over TextEdit');
  assert.ok(v.host.querySelector('.elsewhere-title svg'), 'no icon: the window glyph');
  await v.unmount();
});

test('before an app is named: "your computer" when taken over or waiting; the holder by its title when this window knows it', async () => {
  session({ computer: { app: 'your Mac', state: 'takeover' } });
  const v = await render(h(ComputerActivity, { threadId: T }));
  assert.equal(title(v.host), 'You took over your computer');
  setStore({ threads: { other: { id: 'other', name: 'Trip' } } } as any);
  await settle(() => session({ computer: { app: 'your Mac', state: 'waiting', holder: 'other' } }));
  assert.equal(title(v.host), 'Your computer · in use by \u201cTrip\u201d');
  await settle(() => session({ computer: { app: 'Notes', state: 'waiting', holder: 'gone' } }));
  assert.equal(title(v.host), 'Notes · in use by another chat');
  await v.unmount();
});

test('background: an app the user took over stays on the strip after the agent acts in another; a title equal to the app name is dropped', async () => {
  // the agent acted in Notes since the user took TextEdit over: Notes is first in the list
  session({ appControl: { apps: [entry({ at: 2 }), entry({ app: 'TextEdit', bundleId: 'com.apple.TextEdit', takenOver: true })] } });
  const v = await render(h(AppControlStrip, { threadId: T }));
  await settle();
  assert.equal(title(v.host), 'You took over TextEdit');
  assert.ok([...v.host.querySelectorAll('button')].some((b) => b.textContent === 'Done, continue'));
  await settle(() =>
    session({ appControl: { apps: [entry({ title: 'Notes' }), entry({ app: 'TextEdit', bundleId: 'com.apple.TextEdit' })] } }),
  );
  assert.equal(title(v.host), 'Using Notes · +1');
  await settle(() => session({ appControl: { apps: [entry({ title: 'Groceries' })] } }));
  assert.equal(title(v.host), 'Using Notes · Groceries');
  await v.unmount();
});
