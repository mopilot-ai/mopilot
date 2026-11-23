import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
let notify: () => void = () => {};
const fixture: any = {
  state: { route: { name: 'home' }, threads: { A: { title: 'Source' }, B: { title: 'Target' } } },
  calls: [],
  messages: [],
  errors: [],
  navigate: (route: any) => fixture.calls.push(['navigate', route]),
  toast: (message: string) => fixture.errors.push(message),
  native: {
    session: {
      snapshot: async (id: string) => {
        fixture.calls.push(['follow', id]);
        fixture.following = true;
        return null;
      },
    },
    peer: {
      snapshot: async () => {
        if (fixture.unfollowed && !fixture.following)
          throw new Error("Error invoking remote method 'peer:snapshot': Error: invalid_source_window");
        return fixture.messages;
      },
      capabilities: async () => fixture.capabilities ?? { peerTools: { available: true, reason: null } },
      onChanged: (cb: () => void) => {
        notify = cb;
        return () => {
          notify = () => {};
        };
      },
      directory: async () => ({ chats: fixture.directoryChats ?? [{ id: 'B', title: 'Target', archived: false }], nextCursor: null }),
      send: async (...args: any[]) => {
        fixture.calls.push(['send', ...args]);
        if (fixture.fail) throw new Error('disk full');
        return fixture.pending;
      },
      reply: async (...args: any[]) => {
        fixture.calls.push(['reply', ...args]);
      },
      cancel: async (...args: any[]) => {
        fixture.calls.push(['cancel', ...args]);
      },
      sendNow: async (...args: any[]) => {
        fixture.calls.push(['sendNow', ...args]);
      },
      resume: async (...args: any[]) => {
        fixture.calls.push(['resume', ...args]);
      },
      reconcile: async (...args: any[]) => {
        fixture.calls.push(['reconcile', ...args]);
        if (fixture.reconcileError) throw new Error(fixture.reconcileError);
      },
    },
  },
};
installNativeStub(fixture.native);
stubStore({
  navigate: (route: any) => fixture.navigate(route),
  openInSplit: () => {}, // a chat link's ⌥-click (session/openChat.ts)
  toast: (message: string) => fixture.toast(message),
  useStore: (f: any) => f(fixture.state),
  threadTitle: (t: any) => t.title,
});
const { PeerMessages } = await import('../src/components/thread/PeerMessages.tsx');
const { clearPeerDraft, patchPeerDraft, peerDraft } = await import('../src/lib/peerDrafts.ts');
const { markWindowReady, resetWindowReady } = await import('../src/lib/windowReady.ts');
// boot has told main this window is ready, as in a window that finished starting
markWindowReady();
async function mount(readOnly = false, onMessages?: (messages: any[]) => void, extra: Record<string, unknown> = {}) {
  fixture.calls = [];
  fixture.errors = [];
  fixture.fail = false;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => {
    root.render(createElement(PeerMessages, { chatId: 'A', readOnly, onMessages, ...extra }));
  });
  return {
    host,
    render: async (chatId: string, nextReadOnly = readOnly) => {
      await act(async () => root.render(createElement(PeerMessages, { chatId, readOnly: nextReadOnly, onMessages, ...extra })));
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}
// the compose dialog renders into document.body, so buttons are looked up there by their text or label
const click = async (_host: HTMLElement, text: string) => {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent === text || b.getAttribute('aria-label') === text);
  assert.ok(button, `Missing button ${text}`);
  await act(async () => {
    button.click();
  });
};
// the composer's + menu asks the chat's PeerMessages to compose with no recipient chosen
const openCompose = async (sourceChatId = 'A') => {
  await act(async () => {
    window.dispatchEvent(new window.CustomEvent('mopilot:peer-compose', { detail: { sourceChatId, targetChatId: '' } }));
  });
};
async function input(el: HTMLTextAreaElement | HTMLSelectElement, value: string) {
  await act(() => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : window.HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }) as any);
  });
}

test('empty entry sends a targeted request, while failure preserves typed message for recovery', async () => {
  fixture.messages = [];
  const m = await mount();
  try {
    await openCompose();
    await input(document.body.querySelector('select')!, 'B');
    await input(document.body.querySelector('textarea')!, 'Review the schema');
    fixture.fail = true;
    await click(m.host, 'Send');
    assert.equal(document.body.querySelector('textarea')!.value, 'Review the schema');
    assert.deepEqual(fixture.errors, ['Disk full.']);
    fixture.fail = false;
    await click(m.host, 'Send');
    assert.equal(fixture.calls[0][2].requestId, fixture.calls[1][2].requestId);
    assert.equal(fixture.calls.at(-1)[1], 'A');
    assert.equal(fixture.calls.at(-1)[2].targetChatId, 'B');
    assert.equal(document.body.querySelector('textarea') === null, true);
  } finally {
    await m.close();
  }
});

test('queued states support cancel/retry, source links navigate and read-only cards cannot send', async () => {
  fixture.messages = [
    { id: 'm', sourceChatId: 'A', targetChatId: 'B', body: 'Request', delivery: 'blocked', reply: 'awaiting', errorCode: 'login_required' },
  ];
  const m = await mount();
  try {
    assert.match(document.body.textContent!, /Blocked.*Awaiting reply/);
    // the journal's reason code reads as its line (shared/peerReasons.mjs), never the code
    assert.match(document.body.textContent!, /That chat’s harness needs a sign-in\./);
    assert.doesNotMatch(document.body.textContent!, /login_required/);
    await click(m.host, 'Target');
    assert.deepEqual(fixture.calls[0], ['navigate', { name: 'thread', id: 'B' }]);
    await click(m.host, 'Retry delivery');
    await click(m.host, 'Cancel message');
    assert.deepEqual(fixture.calls.slice(1), [
      ['resume', 'A', 'm'],
      ['cancel', 'A', 'm'],
    ]);
    fixture.messages = [{ ...fixture.messages[0], delivery: 'queued', errorCode: null }];
    await act(async () => notify());
    await click(m.host, 'Deliver now if supported');
    assert.deepEqual(fixture.calls.at(-1), ['sendNow', 'A', 'm']);
    fixture.messages = [{ ...fixture.messages[0], delivery: 'delivered', errorCode: null }];
    await act(async () => notify());
    assert.doesNotMatch(document.body.textContent!, /Retry delivery|Cancel message/);
  } finally {
    await m.close();
  }
  const view = await mount(true);
  try {
    assert.doesNotMatch(document.body.textContent!, /Send a message|Cancel message|Retry delivery|Deliver now/);
  } finally {
    await view.close();
  }
});

test('token send action preselects only its source chat recipient; received requests can reply', async () => {
  fixture.messages = [{ id: 'incoming', sourceChatId: 'B', targetChatId: 'A', body: 'Review?', delivery: 'delivered', reply: 'awaiting' }];
  const m = await mount();
  try {
    await act(async () =>
      window.dispatchEvent(new window.CustomEvent('mopilot:peer-compose', { detail: { sourceChatId: 'wrong', targetChatId: 'B' } })),
    );
    assert.equal(document.body.querySelector('textarea') === null, true);
    await act(async () =>
      window.dispatchEvent(new window.CustomEvent('mopilot:peer-compose', { detail: { sourceChatId: 'A', targetChatId: 'B' } })),
    );
    assert.equal(document.body.querySelector('select')!.value, 'B');
    await click(m.host, 'Close');
    await click(m.host, 'Reply');
    await input(document.body.querySelector('textarea')!, 'Reviewed');
    await click(m.host, 'Send');
    assert.equal(fixture.calls.at(-1)[0], 'reply');
    assert.equal(fixture.calls.at(-1)[2].messageId, 'incoming');
  } finally {
    await m.close();
  }
});

test('recipient capability failure is visible while the request can still be retained', async () => {
  fixture.messages = [];
  fixture.directoryChats = [
    {
      id: 'B',
      title: 'Target',
      archived: false,
      project: '/target-project',
      capabilities: { peerMessaging: { available: false, reason: 'login_required' } },
    },
  ];
  const m = await mount();
  try {
    await openCompose();
    await input(document.body.querySelector('select')!, 'B');
    assert.ok(document.body.textContent!.includes('Can’t deliver now. That chat’s harness needs a sign-in. Your message is kept.'));
    assert.ok(!document.body.textContent!.includes('login_required'));
    assert.ok(document.body.textContent!.includes('Project: /target-project'));
    await input(document.body.querySelector('textarea')!, 'Keep this request');
    await click(m.host, 'Send');
    assert.equal(fixture.calls.at(-1)[0], 'send');
  } finally {
    fixture.directoryChats = null;
    await m.close();
  }
});

test('missing agent bridge is explained without hiding the direct send entry', async () => {
  fixture.messages = [];
  fixture.capabilities = { peerTools: { available: false, reason: 'tool_bridge_disabled' } };
  const m = await mount();
  try {
    assert.ok(!document.body.textContent!.includes('Chat tools are off here'), 'no banner on every chat');
    await openCompose();
    assert.ok(document.body.querySelector('textarea'));
    assert.ok(document.body.textContent!.includes('Chat tools are off here. Chat tools are turned off for now.'));
    assert.ok(!document.body.textContent!.includes('tool_bridge_disabled'));
  } finally {
    fixture.capabilities = null;
    await m.close();
    clearPeerDraft('A');
  }
});

test('remount restores recipient, body and failed request identity instead of duplicating the send', async () => {
  fixture.messages = [];
  const first = await mount();
  await openCompose();
  await input(document.body.querySelector('select')!, 'B');
  await input(document.body.querySelector('textarea')!, 'Draft survives navigation');
  fixture.fail = true;
  await click(first.host, 'Send');
  const id = fixture.calls.at(-1)[2].requestId;
  await first.close();
  const next = await mount();
  try {
    assert.equal(document.body.querySelector('textarea')!.value, 'Draft survives navigation');
    assert.equal(document.body.querySelector('select')!.value, 'B');
    await click(next.host, 'Send');
    assert.equal(fixture.calls.at(-1)[2].requestId, id);
  } finally {
    await next.close();
    clearPeerDraft('A');
  }
});

test('a late acceptance cannot erase a newer draft after the composer remounts', async () => {
  fixture.messages = [];
  let accepted!: () => void;
  fixture.pending = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const first = await mount();
  await openCompose();
  await input(document.body.querySelector('select')!, 'B');
  await input(document.body.querySelector('textarea')!, 'Original send');
  await click(first.host, 'Send');
  await first.close();
  const next = await mount();
  try {
    await input(document.body.querySelector('textarea')!, 'New unsent draft');
    await act(async () => accepted());
    assert.equal(document.body.querySelector('textarea')!.value, 'New unsent draft');
    await next.close();
    const restored = await mount();
    try {
      assert.equal(document.body.querySelector('textarea')!.value, 'New unsent draft');
    } finally {
      await restored.close();
    }
  } finally {
    fixture.pending = null;
    clearPeerDraft('A');
  }
});

test('an old send settling after navigation cannot unlock a new send in the same chat', async () => {
  clearPeerDraft('A');
  clearPeerDraft('B');
  fixture.messages = [];
  let firstAccepted!: () => void;
  let secondAccepted!: () => void;
  fixture.pending = new Promise<void>((r) => {
    firstAccepted = r;
  });
  const m = await mount();
  try {
    await openCompose();
    await input(document.body.querySelector('select')!, 'B');
    await input(document.body.querySelector('textarea')!, 'First');
    await click(m.host, 'Send');
    await m.render('B');
    await m.render('A');
    await input(document.body.querySelector('textarea')!, 'Second');
    fixture.pending = new Promise<void>((r) => {
      secondAccepted = r;
    });
    await click(m.host, 'Send');
    await act(async () => firstAccepted());
    assert.equal(document.body.querySelector('textarea')!.value, 'Second');
    assert.equal(document.body.querySelector('textarea')!.readOnly, true);
    assert.ok(document.body.textContent!.includes('Sending…'));
    await act(async () => secondAccepted());
    assert.equal(document.body.querySelector('textarea') === null, true);
  } finally {
    fixture.pending = null;
    await m.close();
    clearPeerDraft('A');
    clearPeerDraft('B');
  }
});

test('a chat this window does not follow yet follows it and loads instead of showing invalid_source_window', async () => {
  fixture.messages = [];
  fixture.unfollowed = true;
  fixture.following = false;
  const m = await mount();
  try {
    assert.deepEqual(fixture.calls, [['follow', 'A']]);
    assert.doesNotMatch(document.body.textContent!, /Chat messaging unavailable/);
    assert.equal(document.body.querySelector('.peer-messages'), null, 'nothing above an empty transcript');
  } finally {
    fixture.unfollowed = false;
    await m.close();
    clearPeerDraft('A');
  }
});

test('a window that still may not speak for the chat after following it shows the error once, without looping', async () => {
  fixture.messages = [];
  fixture.unfollowed = true;
  fixture.following = false;
  const real = fixture.native.session.snapshot;
  fixture.native.session.snapshot = async (id: string) => {
    fixture.calls.push(['follow', id]);
    throw new Error('gone');
  };
  const m = await mount();
  try {
    assert.deepEqual(fixture.calls, [['follow', 'A']]);
    assert.match(document.body.textContent!, /Chat messaging unavailable: This window can’t message for that chat\./);
    // a later change asks again, without another follow
    fixture.following = true;
    await act(async () => {
      notify();
    });
    assert.doesNotMatch(document.body.textContent!, /Chat messaging unavailable/);
  } finally {
    fixture.native.session.snapshot = real;
    fixture.unfollowed = false;
    await m.close();
    clearPeerDraft('A');
  }
});

test('other load errors show at once, and an unmounted chat ignores a late refusal', async () => {
  fixture.messages = [];
  const real = fixture.native.peer.capabilities;
  fixture.native.peer.capabilities = async () => {
    throw new Error('chat_unavailable');
  };
  const m = await mount();
  try {
    assert.deepEqual(fixture.calls, []);
    assert.match(document.body.textContent!, /Chat messaging unavailable: That chat isn’t available\./);
  } finally {
    fixture.native.peer.capabilities = real;
    await m.close();
    clearPeerDraft('A');
  }
  // the refusal arrives after the chat went away: no follow, no retry
  fixture.unfollowed = true;
  fixture.following = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const snap = fixture.native.peer.snapshot;
  fixture.native.peer.snapshot = async () => {
    await gate;
    throw new Error('invalid_source_window');
  };
  const n = await mount();
  await n.close();
  release();
  await act(async () => {
    await gate;
    await new Promise((r) => setImmediate(r));
  });
  assert.deepEqual(fixture.calls, []);
  fixture.native.peer.snapshot = snap;
  fixture.unfollowed = false;
  clearPeerDraft('A');
});

test('the follow finishing after the chat went away does not ask again', async () => {
  fixture.messages = [];
  fixture.unfollowed = true;
  fixture.following = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const real = fixture.native.session.snapshot;
  fixture.native.session.snapshot = async (id: string) => {
    fixture.calls.push(['follow', id]);
    await gate;
    fixture.following = true;
    return null;
  };
  let asked = 0;
  const snap = fixture.native.peer.snapshot;
  fixture.native.peer.snapshot = async () => {
    asked++;
    return snap();
  };
  const m = await mount();
  await m.close();
  release();
  await act(async () => {
    await gate;
    await new Promise((r) => setImmediate(r));
  });
  assert.equal(asked, 1);
  fixture.native.session.snapshot = real;
  fixture.native.peer.snapshot = snap;
  fixture.unfollowed = false;
  clearPeerDraft('A');
});

test('messages report to the view, name an unknown chat without its id, and show reply state and uncertain delivery', async () => {
  fixture.messages = [
    { id: 'u', sourceChatId: 'A', targetChatId: 'Z', body: 'Lost?', delivery: 'uncertain', reply: 'none' },
    { id: 'r', sourceChatId: 'B', targetChatId: 'A', body: 'Done', delivery: 'delivered', reply: 'received' },
  ];
  const reported: string[][] = [];
  const m = await mount(false, (messages) => reported.push(messages.map((x) => x.id)));
  try {
    assert.deepEqual(reported.at(-1), ['u', 'r']);
    const lines = [...document.body.querySelectorAll('.peer-message-head')].map((d) =>
      [...d.children]
        .map((c) => c.textContent)
        .filter(Boolean)
        .join(' '),
    );
    assert.deepEqual(lines, ['To another chat Delivery unknown', 'From Target Delivered Replied']);
    await click(m.host, 'Check delivery');
    assert.deepEqual(fixture.calls, [['reconcile', 'A', 'u']]);
    // a refused action is reported, not thrown
    fixture.reconcileError = 'not_found';
    await click(m.host, 'Check delivery');
    // an unknown code reads as the generic line, never the code
    assert.deepEqual(fixture.errors, ['Couldn’t deliver the message.']);
  } finally {
    fixture.reconcileError = null;
    await m.close();
    clearPeerDraft('A');
  }
});

test('the recipient list marks archived chats, warns about a recipient without tools, and needs a recipient to send', async () => {
  fixture.messages = [];
  fixture.directoryChats = [
    {
      id: 'B',
      title: 'Target',
      archived: true,
      capabilities: { peerMessaging: { available: true, reason: null }, peerTools: { available: false, reason: 'bridge_off' } },
    },
    { id: 'C', title: 'Plain', archived: false, capabilities: { peerMessaging: { available: true, reason: null } } },
  ];
  const m = await mount();
  try {
    await openCompose();
    assert.deepEqual(
      [...document.body.querySelectorAll('option')].map((o) => o.textContent),
      ['Choose a chat', 'Target · Archived', 'Plain'],
    );
    await input(document.body.querySelector('textarea')!, 'Hello');
    const send = () => [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Send')!;
    assert.equal(send().disabled, true);
    await input(document.body.querySelector('select')!, 'B');
    assert.equal(send().disabled, false);
    // an unknown reason gets the generic line, never the code
    assert.ok(document.body.textContent!.includes('Its chat tools are off. Couldn’t deliver the message.'));
    assert.ok(!document.body.textContent!.includes('bridge_off'));
    await input(document.body.querySelector('select')!, 'C');
    assert.equal(document.body.textContent!.includes('Its chat tools are off'), false);
  } finally {
    fixture.directoryChats = null;
    await m.close();
    clearPeerDraft('A');
  }
});

test('a directory spanning pages lists every chat, and one that finishes after a chat switch is dropped', async () => {
  fixture.messages = [];
  const real = fixture.native.peer.directory;
  fixture.native.peer.directory = async (_id: string, { cursor }: any) =>
    cursor
      ? { chats: [{ id: 'C', title: 'Second page', archived: false }], nextCursor: null }
      : { chats: [{ id: 'B', title: 'Target', archived: false }], nextCursor: 'p2' };
  const m = await mount();
  try {
    await openCompose();
    assert.deepEqual(
      [...document.body.querySelectorAll('option')].map((o) => o.textContent),
      ['Choose a chat', 'Target', 'Second page'],
    );
    await click(m.host, 'Close');
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    fixture.native.peer.directory = async () => {
      await gate;
      return { chats: [{ id: 'B', title: 'Target', archived: false }], nextCursor: null };
    };
    await openCompose();
    await m.render('B');
    await act(async () => {
      release();
      await gate;
      await new Promise((r) => setImmediate(r));
    });
    assert.equal(document.body.querySelector('.peer-compose'), null);
  } finally {
    fixture.native.peer.directory = real;
    await m.close();
    clearPeerDraft('A');
    clearPeerDraft('B');
  }
});

test('older peer snapshots cannot replace newer delivery state or report stale failures', async () => {
  for (const outcome of ['success', 'failure', 'source-refusal']) {
    const real = fixture.native.peer.snapshot;
    let resolve!: (messages: any[]) => void;
    let reject!: (error: Error) => void;
    let reads = 0;
    const pending = new Promise((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    const latest = { id: 'latest', sourceChatId: 'A', targetChatId: 'B', body: 'Current message', delivery: 'delivered', reply: 'none' };
    fixture.native.peer.snapshot = () => (++reads === 1 ? pending : Promise.resolve([latest]));
    const reported: any[] = [];
    const m = await mount(false, (messages) => reported.push(messages));
    try {
      await act(async () => notify());
      assert.match(document.body.textContent!, /Current message/);
      assert.match(document.body.textContent!, /Delivered/);
      await act(async () =>
        outcome === 'success'
          ? resolve([{ ...latest, body: 'Old message', delivery: 'queued' }])
          : reject(new Error(outcome === 'source-refusal' ? 'invalid_source_window' : 'old read failed')),
      );
      assert.match(document.body.textContent!, /Current message/);
      assert.doesNotMatch(document.body.textContent!, /Old message|Queued|unavailable/);
      assert.deepEqual(reported.at(-1), [latest]);
      assert.equal(reads, 2, 'an obsolete refusal must not retry');
      assert.deepEqual(fixture.calls, [], 'an obsolete refusal must not follow the chat again');
    } finally {
      resolve([]);
      await m.close();
      fixture.native.peer.snapshot = real;
      clearPeerDraft('A');
    }
  }
});

test('a superseded follow recovery must not launch another peer read', async () => {
  const realPeer = fixture.native.peer.snapshot;
  const realSession = fixture.native.session.snapshot;
  let release!: () => void;
  let reads = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const latest = { id: 'new', sourceChatId: 'A', targetChatId: 'B', body: 'Latest', delivery: 'delivered', reply: 'none' };
  fixture.native.peer.snapshot = async () => {
    if (++reads === 1) throw new Error('invalid_source_window');
    return [latest];
  };
  fixture.native.session.snapshot = () => gate;
  const m = await mount();
  try {
    await act(async () => notify());
    assert.match(document.body.textContent!, /Latest/);
    await act(async () => release());
    assert.equal(reads, 2, 'recovery must not supersede a newer successful snapshot');
    assert.match(document.body.textContent!, /Latest/);
    assert.doesNotMatch(document.body.textContent!, /unavailable/);
  } finally {
    release();
    await m.close();
    fixture.native.peer.snapshot = realPeer;
    fixture.native.session.snapshot = realSession;
    clearPeerDraft('A');
  }
});

test('a delayed recipient picker cannot reopen a compose form after switching away and back', async () => {
  fixture.messages = [];
  const real = fixture.native.peer.directory;
  let release!: (page: any) => void;
  fixture.native.peer.directory = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const m = await mount();
  try {
    await openCompose();
    await m.render('B');
    await m.render('A');
    await act(async () => release({ chats: [{ id: 'B', title: 'Target' }], nextCursor: null }));
    assert.ok(!document.body.querySelector('.peer-compose'));
    assert.equal(peerDraft('A').open, false);
  } finally {
    await m.close();
    fixture.native.peer.directory = real;
    clearPeerDraft('A');
    clearPeerDraft('B');
  }
});

test('the newest compose request selects its recipient and stops obsolete pagination', async () => {
  clearPeerDraft('A');
  fixture.messages = [];
  const real = fixture.native.peer.directory;
  let release!: (page: any) => void;
  let reads = 0;
  fixture.native.peer.directory = () =>
    ++reads === 1
      ? new Promise((resolve) => {
          release = resolve;
        })
      : Promise.resolve({
          chats: [
            { id: 'B', title: 'Target' },
            { id: 'C', title: 'Latest recipient' },
          ],
          nextCursor: null,
        });
  const m = await mount();
  const compose = async (targetChatId: string) =>
    act(async () => {
      window.dispatchEvent(new window.CustomEvent('mopilot:peer-compose', { detail: { sourceChatId: 'A', targetChatId } }) as any);
    });
  try {
    await compose('B');
    await compose('C');
    assert.equal(document.body.querySelector('select')!.value, 'C');
    await act(async () => release({ chats: [{ id: 'B', title: 'Old recipient' }], nextCursor: 'old-next-page' }));
    assert.equal(reads, 2);
    assert.equal(document.body.querySelector('select')!.value, 'C');
    assert.equal(peerDraft('A').target, 'C');
  } finally {
    await m.close();
    fixture.native.peer.directory = real;
    clearPeerDraft('A');
  }
});

test('compose requests respect Close, Reply, chat lifetimes and read-only changes', async () => {
  for (const change of ['current', 'close', 'reply', 'returned', 'unmount', 'read-only']) {
    for (const outcome of ['success', 'failure']) {
      clearPeerDraft('A');
      clearPeerDraft('B');
      fixture.messages = [
        { id: 'incoming', sourceChatId: 'B', targetChatId: 'A', body: 'Question', delivery: 'delivered', reply: 'awaiting' },
      ];
      const real = fixture.native.peer.directory;
      const m = await mount();
      let release!: (page: any) => void;
      let reject!: (error: Error) => void;
      try {
        await openCompose();
        fixture.native.peer.directory = () =>
          new Promise((resolve, fail) => {
            release = resolve;
            reject = fail;
          });
        await act(async () => {
          window.dispatchEvent(new window.CustomEvent('mopilot:peer-compose', { detail: { sourceChatId: 'A', targetChatId: 'C' } }) as any);
        });
        if (change === 'close') await click(m.host, 'Close');
        else if (change === 'reply') await click(m.host, 'Reply');
        else if (change === 'returned') {
          await m.render('B');
          // restored drafts start their own current lookup, which must not use the old promise
          fixture.native.peer.directory = real;
          await m.render('A');
        } else if (change === 'unmount') await m.close();
        else if (change === 'read-only') await m.render('A', true);
        fixture.errors.length = 0;
        await act(async () =>
          outcome === 'failure'
            ? reject(new Error('directory refused'))
            : release({ chats: [{ id: 'C', title: 'New recipient' }], nextCursor: null }),
        );
        assert.deepEqual(fixture.errors, change === 'current' && outcome === 'failure' ? ['Directory refused.'] : []);
        if (change === 'close') {
          assert.ok(!document.body.querySelector('.peer-compose'));
          assert.equal(peerDraft('A').open, false);
        } else if (change === 'reply') {
          assert.equal(peerDraft('A').replyTo, 'incoming');
          assert.match(document.body.textContent!, /Reply to Target/);
        } else if (change === 'current' && outcome === 'success') assert.equal(peerDraft('A').target, 'C');
        else assert.notEqual(peerDraft('A').target, 'C');
      } finally {
        if (release) release({ chats: [], nextCursor: null });
        if (change !== 'unmount') await m.close();
        fixture.native.peer.directory = real;
        clearPeerDraft('A');
        clearPeerDraft('B');
      }
    }
  }
});

test('plain rejection messages remain visible when peer capabilities cannot load', async () => {
  fixture.messages = [];
  const real = fixture.native.peer.capabilities;
  fixture.native.peer.capabilities = async () => {
    throw 'bridge offline';
  };
  const m = await mount();
  try {
    assert.ok(document.body.textContent!.includes('Chat messaging unavailable: Bridge offline.'));
  } finally {
    fixture.native.peer.capabilities = real;
    await m.close();
    clearPeerDraft('A');
  }
});

test('peer error handlers accept unknown rejections and keep failed sends recoverable', async () => {
  const values: [unknown, string][] = [
    [null, 'Something went wrong.'],
    [undefined, 'Something went wrong.'],
    ['', 'Something went wrong.'],
    [0, 'Something went wrong.'],
    ['connection lost', 'Connection lost.'],
    [new Error('native failed'), 'Native failed.'],
    [{ message: 'structured failure' }, 'Structured failure.'],
    // a refusal by reason code reads as its line, never the code
    [Object.assign(new Error('queue_full'), { code: 'queue_full' }), 'That chat’s queue is full.'],
    [new Error("Error invoking remote method 'peer:send': Error: spawn codex ENOENT"), 'File or program not found.'],
  ];
  for (const action of ['load', 'compose', 'send', 'reconcile']) {
    for (const [error, expected] of values) {
      clearPeerDraft('A');
      fixture.messages = [{ id: 'unknown', sourceChatId: 'A', targetChatId: 'B', body: 'Request', delivery: 'uncertain', reply: 'none' }];
      const method = action === 'load' ? 'capabilities' : action === 'compose' ? 'directory' : action;
      const real = fixture.native.peer[method];
      const fail = async () => {
        throw error;
      };
      if (action === 'load') fixture.native.peer[method] = fail;
      const m = await mount();
      try {
        if (action === 'load') assert.ok(document.body.textContent!.includes(`Chat messaging unavailable: ${expected}`));
        else {
          if (action === 'send') {
            await openCompose();
            await input(document.body.querySelector('select')!, 'B');
            await input(document.body.querySelector('textarea')!, 'Keep this request');
          }
          fixture.native.peer[method] = fail;
          if (action === 'compose') await openCompose();
          else await click(m.host, action === 'send' ? 'Send' : 'Check delivery');
          assert.deepEqual(fixture.errors, [expected]);
          if (action === 'send') {
            assert.equal(document.body.querySelector('textarea')!.value, 'Keep this request');
            assert.equal([...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Send')!.disabled, false);
            assert.equal(peerDraft('A').body, 'Keep this request');
            fixture.native.peer[method] = real;
            await click(m.host, 'Send');
            assert.ok(!document.body.querySelector('textarea'), 'retry succeeds with the retained draft');
          }
        }
      } finally {
        await m.close();
        fixture.native.peer[method] = real;
        clearPeerDraft('A');
      }
    }
  }
});

test('a plain source-window refusal follows the chat once and retries the snapshot', async () => {
  clearPeerDraft('A');
  const real = fixture.native.peer.snapshot;
  let reads = 0;
  fixture.native.peer.snapshot = async () => {
    if (++reads === 1) throw 'invalid_source_window';
    return [];
  };
  const m = await mount();
  try {
    assert.equal(reads, 2);
    assert.deepEqual(fixture.calls, [['follow', 'A']]);
    assert.doesNotMatch(document.body.textContent!, /unavailable/);
  } finally {
    await m.close();
    fixture.native.peer.snapshot = real;
    clearPeerDraft('A');
  }
});

test('rapid peer Send clicks start one request and keep its id for failure recovery', async () => {
  for (const method of ['send', 'reply']) {
    clearPeerDraft('A');
    fixture.messages =
      method === 'reply'
        ? [{ id: 'incoming', sourceChatId: 'B', targetChatId: 'A', body: 'Question', delivery: 'delivered', reply: 'awaiting' }]
        : [];
    const real = fixture.native.peer[method];
    const calls: any[] = [];
    let release!: () => void;
    let reject!: (error: Error) => void;
    fixture.native.peer[method] = (...args: any[]) => {
      calls.push(args);
      return new Promise<void>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
    };
    const m = await mount();
    try {
      if (method === 'reply') await click(m.host, 'Reply');
      else {
        await openCompose();
        await input(document.body.querySelector('select')!, 'B');
      }
      await input(document.body.querySelector('textarea')!, 'Send once');
      const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Send')!;
      await act(() => {
        button.click();
        button.click();
      });
      assert.equal(calls.length, 1);
      assert.equal(button.disabled, true);
      await act(async () => reject(new Error('not accepted')));
      assert.deepEqual(fixture.errors, ['Not accepted.']);
      assert.equal(document.body.querySelector('textarea')!.value, 'Send once');
      assert.equal(button.disabled, false);
      await click(m.host, 'Send');
      assert.equal(calls.length, 2);
      assert.equal(calls[0][1].requestId, calls[1][1].requestId);
      await act(async () => release());
      assert.ok(!document.body.querySelector('textarea'));
    } finally {
      if (release) release();
      await m.close();
      fixture.native.peer[method] = real;
      clearPeerDraft('A');
    }
  }
});

test('a failed old send cannot show stale errors or unlock a new chat-lifetime request', async () => {
  for (const change of ['chat', 'returned', 'unmount']) {
    clearPeerDraft('A');
    clearPeerDraft('B');
    fixture.messages = [];
    let reject!: (error: Error) => void;
    let accepted: () => void = () => {};
    fixture.pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const m = await mount();
    try {
      await openCompose();
      await input(document.body.querySelector('select')!, 'B');
      await input(document.body.querySelector('textarea')!, 'Old request');
      await click(m.host, 'Send');
      if (change === 'unmount') await m.close();
      else {
        await m.render('B');
        if (change === 'returned') {
          await m.render('A');
          await input(document.body.querySelector('textarea')!, 'New request');
          fixture.pending = new Promise<void>((resolve) => {
            accepted = resolve;
          });
          await click(m.host, 'Send');
        }
      }
      await act(async () => reject(new Error('old request refused')));
      assert.deepEqual(fixture.errors, []);
      if (change === 'returned') {
        assert.equal(document.body.querySelector('textarea')!.value, 'New request');
        assert.equal(document.body.querySelector('textarea')!.readOnly, true);
        await act(async () => accepted());
        assert.ok(!document.body.querySelector('textarea'));
      }
    } finally {
      accepted();
      if (change !== 'unmount') await m.close();
      fixture.pending = null;
      clearPeerDraft('A');
      clearPeerDraft('B');
    }
  }
});

test('the compose dialog closes by Escape, Cancel or the backdrop, but not while sending, and Cmd+Enter sends', async () => {
  fixture.messages = [];
  const real = fixture.native.peer.send;
  const m = await mount();
  const dialog = () => document.body.querySelector<HTMLElement>('.peer-compose');
  const key = async (target: Element, init: Record<string, unknown>) => {
    await act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as any);
    });
  };
  const backdrop = async (target: Element) => {
    await act(async () => {
      target.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any);
    });
  };
  try {
    await openCompose();
    assert.equal(dialog()!.getAttribute('role'), 'dialog');
    assert.match(dialog()!.textContent!, /Message another chat/);
    assert.equal(m.host.contains(dialog()), false, 'the dialog floats over the app, not inside the transcript');
    await key(dialog()!, { key: 'a' });
    await backdrop(dialog()!);
    assert.ok(dialog(), 'a key or click inside the dialog keeps it open');
    await key(dialog()!, { key: 'Escape' });
    assert.equal(dialog(), null);
    assert.equal(peerDraft('A').open, false);
    await openCompose();
    await backdrop(document.body.querySelector('.sketch-backdrop')!);
    assert.equal(dialog(), null);
    await openCompose();
    await click(m.host, 'Cancel');
    assert.equal(dialog(), null);

    await openCompose();
    const textarea = () => document.body.querySelector('textarea')!;
    await key(textarea(), { key: 'Enter', metaKey: true });
    assert.equal(fixture.calls.filter((c: any[]) => c[0] === 'send').length, 0, 'nothing to send yet');
    await input(document.body.querySelector('select')!, 'B');
    await input(textarea(), 'Ship it');
    await key(textarea(), { key: 'Enter' });
    await key(textarea(), { key: 'Enter', metaKey: true, isComposing: true });
    assert.equal(fixture.calls.filter((c: any[]) => c[0] === 'send').length, 0, 'plain Enter and an input method Enter only type');
    let finish!: () => void;
    fixture.native.peer.send = (...args: any[]) => {
      fixture.calls.push(['send', ...args]);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    await key(textarea(), { key: 'Enter', ctrlKey: true });
    assert.equal(fixture.calls.filter((c: any[]) => c[0] === 'send').length, 1);
    await key(dialog()!, { key: 'Escape' });
    await backdrop(document.body.querySelector('.sketch-backdrop')!);
    assert.ok(dialog(), 'a send in flight keeps the dialog');
    await act(async () => finish());
    assert.equal(dialog(), null, 'sent: the dialog closes');
  } finally {
    fixture.native.peer.send = real;
    await m.close();
    clearPeerDraft('A');
  }
});

test('a restored reply whose request is gone still names its recipient generically', async () => {
  fixture.messages = [];
  patchPeerDraft('A', { open: true, replyTo: 'gone', body: 'Done' });
  const m = await mount();
  try {
    assert.match(document.body.querySelector('.peer-compose')!.textContent!, /Reply to the requesting chat/);
    assert.equal(document.body.querySelector('select'), null);
    assert.equal(document.body.querySelector('textarea')!.getAttribute('placeholder'), 'Write your reply');
  } finally {
    await m.close();
    clearPeerDraft('A');
  }
});

test('Escape closes the dialog wherever focus is and gives focus back; a removed opener is left alone', async () => {
  fixture.messages = [];
  const m = await mount();
  const opener = document.createElement('button');
  document.body.append(opener);
  try {
    opener.focus();
    await openCompose();
    assert.ok(document.activeElement === document.body.querySelector('textarea'), 'the message field takes focus');
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'x', bubbles: true }) as any);
    });
    assert.ok(document.body.querySelector('.peer-compose'), 'other keys leave it open');
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any);
    });
    assert.equal(document.body.querySelector('.peer-compose'), null);
    assert.ok(document.activeElement === opener, 'focus returns to the opener');
    await openCompose();
    opener.remove();
    await click(m.host, 'Cancel');
    assert.equal(document.body.querySelector('.peer-compose'), null);
  } finally {
    opener.remove();
    await m.close();
    clearPeerDraft('A');
  }
});

test('a side pane showing the chat the main view shows leaves the dialog to the main view', async () => {
  fixture.messages = [];
  fixture.state.route = { name: 'thread', id: 'A' };
  const pane = await mount(false, undefined, { inPane: true });
  try {
    await openCompose();
    assert.equal(document.body.querySelector('.peer-compose'), null);
    fixture.state.route = { name: 'thread', id: 'B' };
    await pane.render('A');
    await openCompose();
    assert.ok(document.body.querySelector('.peer-compose'), 'another chat in main: the pane owns its dialog');
  } finally {
    fixture.state.route = { name: 'home' };
    await pane.close();
    clearPeerDraft('A');
  }
});

test('a view without the composer (Quick Chat) offers its own entry, except read-only', async () => {
  fixture.messages = [];
  const m = await mount(false, undefined, { entry: true });
  try {
    await click(m.host, 'Message another chat');
    assert.ok(document.body.querySelector('.peer-compose'));
    await click(m.host, 'Cancel');
    await m.render('A', true);
    assert.equal(document.body.querySelector('.peer-entry'), null);
  } finally {
    await m.close();
    clearPeerDraft('A');
  }
});

test('a chat shown while the window is still starting asks main only once boot told it the window is ready', async () => {
  resetWindowReady();
  const snap = fixture.native.peer.snapshot;
  let reads = 0;
  fixture.native.peer.snapshot = async () => (
    reads++, [{ id: 'm1', sourceChatId: 'A', targetChatId: 'B', delivery: 'delivered', reply: 'received', body: 'Ready now' }]
  );
  try {
    const view = await mount();
    assert.equal(reads, 0);
    assert.equal(fixture.calls.filter((c: any[]) => c[0] === 'follow').length, 0, 'no follow is tried before the window is known');
    await act(async () => markWindowReady());
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    assert.equal(reads, 1);
    assert.match(view.host.textContent ?? '', /Ready now/);
    await view.close();
  } finally {
    fixture.native.peer.snapshot = snap;
    markWindowReady();
  }
});
