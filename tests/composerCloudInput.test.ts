// Cloud send input preservation, route ownership, and supported text/reference/local behavior.
import { test, beforeEach } from 'node:test';
import { act } from 'react';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';
import { controlledReads, deferred } from './support/async-scenarios.ts';
import { sessionToken } from '../src/lib/sessionMentions.ts';
import type { Attachment } from '../src/store/types.ts';

beforeEach(() => reset());
const env = { id: 'env', label: 'My env' };
const attachmentKinds = {
  audio: { kind: 'audio', path: '/clip.wav', name: 'Audio message', mimeType: 'audio/wav' },
  file: { kind: 'file', path: '/notes.txt', name: 'notes.txt' },
  image: { kind: 'image', path: '/image.png', name: 'image.png', previewUrl: 'data:image/png;base64,eA==' },
  skill: { kind: 'skill', path: '/skill', name: 'skill', displayName: 'Skill', textOffset: 0 },
  selection: { kind: 'selection', path: '', name: 'Selection', text: 'quoted text', annotation: 'keep comment' },
  session: { kind: 'session', path: 'chat-id', name: 'Chat', text: 'orphaned chat chip' },
  computerHistory: { kind: 'computerHistory', path: '', name: 'Computer History', text: 'private history' },
} satisfies Record<Attachment['kind'], Attachment>;
const page: Attachment = { kind: 'image', path: '/page.png', name: 'Annotated page', pageUrl: 'https://example.com', text: 'page marks' };
const unsupported: Attachment[] = [...Object.values(attachmentKinds), page];
function cloudDraft(text: string, attachments: Attachment[] = []) {
  fx.caps.cloud = 'native';
  store.set({ newChatCloudEnv: env, drafts: { home: { text, attachments, goal: false } } });
}

for (const attachment of unsupported) {
  for (const text of ['', '  Keep exactly\nthis text  ']) {
    test(`Cloud rejects ${attachment.name} ${text ? 'mixed' : 'attachment-only'} input without reading or clearing, including repeat`, async () => {
      const attachments = [attachment];
      cloudDraft(text, attachments);
      let reads = 0;
      fx.refs = async () => (reads++, []);
      const m = await mountComposer();
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          await m.key('Enter');
          await settle();
          assert.equal(all('cloudExec').length, 0);
          assert.equal(all('send').length, 0);
          assert.equal(reads, 0);
          assert.equal(m.text, text);
          assert.equal(store.get().drafts.home.text, text);
          assert.equal(store.get().drafts.home.attachments, attachments);
          assert.match(last('toast')?.[1] ?? '', /Cloud.*attachments.*remove.*local/i);
          assert.ok(all('draft').every((event) => event[2].text === text && event[2].attachments === attachments));
        }
      } finally {
        await m.unmount();
      }
    });
  }
}

test('Cloud rejects mixed typed references and unsupported chips, then removal permits the original text', async () => {
  const text = `Read ${sessionToken('chat-id', 'Chat')}`;
  cloudDraft(text, [attachmentKinds.file, attachmentKinds.session]);
  fx.refs = async () => [{ ...attachmentKinds.session, text: 'fresh snapshot' }];
  const m = await mountComposer();
  try {
    await m.key('Enter');
    await settle();
    assert.equal(all('cloudExec').length, 0);
    await click($('.attachment.file .attachment-remove'));
    await m.key('Enter');
    await settle();
    assert.equal(all('cloudExec').length, 1);
    assert.match(last('cloudExec')![2], /fresh snapshot/);
    assert.ok(last('cloudExec')![2].endsWith(text));
  } finally {
    await m.unmount();
  }
});

test('text-only and typed-reference-only Cloud prompts preserve the existing exec contract', async () => {
  for (const text of ['  Plain text  ', sessionToken('chat-id', 'Chat')]) {
    reset();
    cloudDraft(text);
    fx.refs = async () => (text.includes('@') ? [{ ...attachmentKinds.session, text: 'fresh snapshot' }] : []);
    const m = await mountComposer();
    try {
      await m.key('Enter');
      await settle();
      assert.equal(all('cloudExec').length, 1);
      assert.equal(last('cloudExec')!.length, 3);
      assert.equal(last('cloudExec')![1], env.id);
      assert.ok(last('cloudExec')![2].endsWith(text));
      assert.equal(m.text, '');
      assert.equal(all('send').length, 0);
    } finally {
      await m.unmount();
    }
  }
});

for (const change of ['environment', 'local', 'harness', 'capability']) {
  test(`Cloud preparation retired by ${change} change preserves input and performs no send`, async () => {
    cloudDraft('Keep my route');
    const references = deferred<Attachment[]>();
    fx.refs = () => references.promise;
    const m = await mountComposer();
    try {
      await m.key('Enter');
      if (change === 'environment') store.set({ newChatCloudEnv: { id: 'other', label: 'Other' } });
      if (change === 'local') store.set({ newChatCloudEnv: null });
      if (change === 'harness') store.set({ newHarness: 'claude' });
      if (change === 'capability') fx.caps.cloud = 'none';
      await m.rerender();
      await act(async () => references.resolve([]));
      assert.equal(all('cloudExec').length, 0);
      assert.equal(all('send').length, 0);
      assert.equal(m.text, 'Keep my route');
      fx.refs = async () => [];
      await m.key('Enter');
      await settle();
      assert.equal(all('cloudExec').length + all('send').length, 1, 'retry uses the selected route');
    } finally {
      await m.unmount();
    }
  });
}

test('local preparation cannot silently switch to Cloud and discard its chips', async () => {
  const attachments = [attachmentKinds.file];
  cloudDraft('Local input', attachments);
  store.set({ newChatCloudEnv: null });
  const references = deferred<Attachment[]>();
  fx.refs = () => references.promise;
  const m = await mountComposer();
  try {
    await m.key('Enter');
    store.set({ newChatCloudEnv: env });
    await m.rerender();
    await act(async () => references.resolve([]));
    assert.equal(all('cloudExec').length, 0);
    assert.equal(all('send').length, 0);
    assert.equal(m.text, 'Local input');
    assert.equal(store.get().drafts.home.attachments, attachments);
    await m.key('Enter');
    assert.match(last('toast')?.[1] ?? '', /Cloud.*attachments/);
  } finally {
    await m.unmount();
  }
});

test('a device removal during reference preparation keeps the first message for an explicit retry', async () => {
  const text = sessionToken('chat-id', 'Chat');
  const references = deferred<Attachment[]>();
  fx.refs = () => references.promise;
  store.set({
    newChatHost: { id: 'box', path: '/work' },
    drafts: { home: { text, attachments: [], goal: false } },
  });
  const m = await mountComposer();
  try {
    await m.key('Enter');
    await act(async () => {
      store.set({ newChatHost: null });
      references.resolve([]);
    });
    assert.equal(all('send').length, 0);
    assert.equal(all('cloudExec').length, 0);
    assert.equal(m.text, text);
    await m.key('Enter');
    await settle();
    assert.equal(all('send').length, 1);
  } finally {
    await m.unmount();
  }
});

for (const changed of [
  { id: 'other', path: '/work' },
  { id: 'box', path: '/else' },
]) {
  test(`a changed ${changed.id === 'box' ? 'folder' : 'device'} retires a reference failure before the composer paints`, async () => {
    const text = sessionToken('chat-id', 'Chat');
    const references = deferred<Attachment[]>();
    fx.refs = () => references.promise;
    store.set({ newChatHost: { id: 'box', path: '/work' }, drafts: { home: { text, attachments: [] } } });
    const m = await mountComposer();
    try {
      await m.key('Enter');
      await act(async () => {
        store.get().newChatHost = changed;
        references.reject(new Error('obsolete read'));
      });
      assert.equal(all('send').length, 0);
      assert.equal(all('toast').length, 0);
      assert.equal(m.text, text);
    } finally {
      await m.unmount();
    }
  });
}

for (const failure of [false, true]) {
  test(`a retired reference ${failure ? 'rejection' : 'success'} cannot clear replacement preparation or input`, async () => {
    cloudDraft('first');
    const reads = controlledReads<Attachment[]>();
    fx.refs = reads.read;
    const m = await mountComposer();
    try {
      await m.key('Enter');
      await m.type('second');
      await m.key('Enter');
      assert.equal(reads.requests.length, 2, 'independent replacement input is not blocked by a retired read');
      await act(async () => {
        if (failure) reads.requests[0].reject(new Error('retired failure'));
        else reads.requests[0].resolve([]);
      });
      await m.key('Enter');
      assert.equal(reads.requests.length, 2, 'the current read still owns pending state');
      assert.equal(all('toast').length, 0);
      assert.equal(m.text, 'second');
      await act(async () => reads.requests[1].resolve([]));
      assert.deepEqual(last('cloudExec'), ['cloudExec', env.id, 'second']);
    } finally {
      for (const request of reads.requests) request.resolve([]);
      await settle();
      await m.unmount();
    }
  });
}

test('two Enter events before paint prepare and execute the same Cloud submission once', async () => {
  cloudDraft('Once');
  const reads = controlledReads<Attachment[]>();
  fx.refs = reads.read;
  const m = await mountComposer();
  try {
    await act(async () => {
      for (let i = 0; i < 2; i++) m.editor().dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      for (const request of reads.requests) request.resolve([]);
    });
    assert.equal(reads.requests.length, 1);
    assert.equal(all('cloudExec').length, 1);
  } finally {
    await m.unmount();
  }
});

for (const family of ['codex', 'claude', 'acp']) {
  test(`local ${family} retains supported attachments and page expansion with a selected Cloud environment`, async () => {
    const attachments = [...unsupported.filter((attachment) => attachment.kind !== 'session')];
    cloudDraft('Local context', attachments);
    fx.caps.cloud = 'none';
    store.set({ newHarness: family === 'acp' ? 'codex' : family, newBasic: family === 'acp' ? 'basic' : null });
    const m = await mountComposer();
    try {
      await m.key('Enter');
      await settle();
      assert.equal(all('cloudExec').length, 0);
      assert.equal(all('send').length, 1);
      const sent = last('send')![3] as Attachment[];
      for (const attachment of attachments.filter((item) => !item.pageUrl)) assert.ok(sent.includes(attachment));
      assert.ok(sent.some((item) => item.kind === 'image' && item.path === page.path));
      assert.ok(sent.some((item) => item.kind === 'selection' && item.text?.includes('page marks')));
    } finally {
      await m.unmount();
    }
  });
}

for (const failure of [false, true]) {
  test(`reference ${failure ? 'rejection' : 'success'} after unmount sends and reports nothing`, async () => {
    cloudDraft('Retired');
    const references = deferred<Attachment[]>();
    fx.refs = () => references.promise;
    const m = await mountComposer();
    await m.key('Enter');
    await m.unmount();
    await act(async () => {
      if (failure) references.reject(new Error('retired'));
      else references.resolve([]);
    });
    assert.equal(all('send').length + all('cloudExec').length + all('toast').length, 0);
    assert.equal(store.get().drafts.home.text, 'Retired');
  });
}

for (const failure of [false, true]) {
  test(`replacement success remains current after older ${failure ? 'failure' : 'success'}`, async () => {
    cloudDraft('first');
    const reads = controlledReads<Attachment[]>();
    fx.refs = reads.read;
    const m = await mountComposer();
    try {
      await m.key('Enter');
      await m.type('second');
      await m.key('Enter');
      await act(async () => reads.requests[1].resolve([]));
      await m.type('new typing');
      await act(async () => {
        if (failure) reads.requests[0].reject(new Error('old failure'));
        else reads.requests[0].resolve([]);
      });
      assert.deepEqual(all('cloudExec'), [['cloudExec', env.id, 'second']]);
      assert.equal(m.text, 'new typing');
      assert.equal(all('toast').length, 1);
    } finally {
      for (const request of reads.requests) request.resolve([]);
      await settle();
      await m.unmount();
    }
  });
}

test('an authoritative route change after reference resolution but before dispatch retains the draft', async () => {
  cloudDraft('Still mine');
  const references = deferred<Attachment[]>();
  fx.refs = () => references.promise;
  const m = await mountComposer();
  try {
    await m.key('Enter');
    await act(async () => {
      references.resolve([]);
      await Promise.resolve();
      store.set({ newChatCloudEnv: { id: 'changed', label: 'Changed' } });
    });
    assert.equal(all('cloudExec').length + all('send').length, 0);
    assert.equal(m.text, 'Still mine');
  } finally {
    await m.unmount();
  }
});

test('a current reference failure retains input and permits a successful retry', async () => {
  cloudDraft('retry');
  fx.refs = async () => {
    throw new Error('unavailable');
  };
  const m = await mountComposer();
  try {
    await m.key('Enter');
    await settle();
    assert.equal(m.text, 'retry');
    assert.match(last('toast')![1], /Couldn't reference the chat: unavailable/);
    fx.refs = async () => [];
    await m.key('Enter');
    await settle();
    assert.deepEqual(last('cloudExec'), ['cloudExec', env.id, 'retry']);
  } finally {
    await m.unmount();
  }
});

test('a failed Cloud exec never restores over new input', async () => {
  cloudDraft('first');
  const execution = deferred();
  fx.cloudExec = () => execution.promise;
  const m = await mountComposer();
  try {
    await m.key('Enter');
    await settle();
    await m.type('new input');
    await act(async () => execution.reject(new Error('offline')));
    assert.equal(m.text, 'new input');
    assert.match(last('toast')![1], /offline/);
  } finally {
    await m.unmount();
  }
});

for (const field of ['route', 'newChatCloudEnv']) {
  test(`existing local pane send survives unrelated ${field} change`, async () => {
    const refs = deferred<Attachment[]>();
    fx.refs = () => refs.promise;
    const m = await mountComposer({ threadId: 't1', inPane: true });
    try {
      await m.type('Send to this chat');
      await m.key('Enter');
      await act(async () => store.set({ [field]: field === 'route' ? { name: 'settings' } : env }));
      await act(async () => refs.resolve([]));
      await settle();
      assert.equal(all('send').length, 1);
      assert.equal(all('send')[0][1], 't1');
    } finally {
      await m.unmount();
    }
  });
}

test('same draft retyped after an intervening edit can submit independently', async () => {
  fx.caps.cloud = 'native';
  store.set({ newChatCloudEnv: env });
  const reads = controlledReads<Attachment[]>();
  fx.refs = reads.read;
  const m = await mountComposer();
  try {
    await m.type('same');
    await m.key('Enter');
    await m.type('different');
    await m.type('same');
    await m.key('Enter');
    assert.equal(reads.requests.length, 2);
    await act(async () => reads.requests[0].resolve([]));
    assert.equal(all('cloudExec').length, 0);
    await act(async () => reads.requests[1].resolve([]));
    assert.equal(all('cloudExec').length, 1);
  } finally {
    for (const r of reads.requests) r.resolve([]);
    await settle();
    await m.unmount();
  }
});

for (const capability of ['none', 'native']) {
  test(`new local ${capability} goal send ignores inactive Cloud environment changes`, async () => {
    fx.caps.cloud = capability;
    const goal = capability === 'native';
    store.set({ drafts: { home: { text: 'Local goal or message', attachments: [], goal } } });
    const refs = deferred<Attachment[]>();
    fx.refs = () => refs.promise;
    const m = await mountComposer();
    try {
      await m.key('Enter');
      await act(async () => store.set({ newChatCloudEnv: env }));
      await act(async () => refs.resolve([]));
      await settle();
      assert.equal(all('send').length, 1);
      assert.equal(all('cloudExec').length, 0);
    } finally {
      await m.unmount();
    }
  });
}

test('an accepted chip insertion before pending preparation dispatch cannot be silently dropped', async () => {
  fx.caps.cloud = 'native';
  store.set({ newChatCloudEnv: env });
  const refs = deferred<Attachment[]>();
  fx.refs = () => refs.promise;
  const m = await mountComposer();
  const chip: Attachment = { kind: 'file', path: '/must-keep.txt', name: 'must-keep.txt' };
  try {
    await m.type('Cloud text');
    await m.key('Enter');
    await act(async () => {
      refs.resolve([]);
      await Promise.resolve();
      window.dispatchEvent(new CustomEvent('composer-insert', { detail: { threadId: null, text: '', attachments: [chip] } }));
    });
    await settle();
    assert.equal(all('cloudExec').length, 0);
    assert.equal(m.text, 'Cloud text\n');
    assert.ok(store.get().drafts.home.attachments.includes(chip));
  } finally {
    await m.unmount();
  }
});
