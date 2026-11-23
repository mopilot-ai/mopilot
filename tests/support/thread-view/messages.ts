// Conversation-view UI unit cases for messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  render,
  settle,
  impl,
  callsTo,
  moduleCalls,
  setStore,
  window,
  tabToken,
  clipboard,
  T,
  text,
  user,
  reply,
  turn,
  chat,
  view,
  withTimers,
  setClipboardFailure,
} from './fixture.ts';

export function registerMessages() {
  test('reply actions: copy, direct good/bad ratings without a bug button, and fork from here', async () => {
    chat([turn('t1', [user('u', 'q'), reply('a', 'Answer')])]);
    // rateReply thanks or reports the failure itself (tests/chatActions.test.ts) and resolves to whether it went through
    impl['chat:rateReply'] = async () => true;
    const v = await render(view());
    const copy = v.$('.message-actions [aria-label="Copy"]')!;
    const fire = await withTimers(() => copy.click());
    assert.deepEqual(clipboard, ['Answer']);
    assert.equal(copy.parentElement!.dataset.tooltip, 'Copied');
    await fire();
    assert.equal(copy.parentElement!.dataset.tooltip, 'Copy');
    assert.deepEqual(
      v.$$('.message-actions button').map((button) => button.getAttribute('aria-label')),
      ['Copy', 'Good response', 'Bad response', 'Fork chat from here'],
    );
    const good = v.$('[aria-label="Good response"]')!;
    const bad = v.$('[aria-label="Bad response"]')!;
    assert.equal(good.getAttribute('aria-pressed'), 'false');
    assert.equal(bad.getAttribute('aria-pressed'), 'false');
    await settle(() => good.click());
    assert.deepEqual(callsTo('chat:rateReply'), [[T, 'good']]);
    assert.deepEqual(callsTo('store:toast'), [], 'the view does not thank on top of rateReply');
    assert.match(good.className, /\bon\b/);
    assert.equal(good.getAttribute('aria-pressed'), 'true');
    assert.equal(bad.getAttribute('aria-pressed'), 'false');
    await settle(() => bad.click());
    assert.deepEqual(callsTo('chat:rateReply')[1], [T, 'bad']);
    assert.equal(good.getAttribute('aria-pressed'), 'false');
    assert.equal(bad.getAttribute('aria-pressed'), 'true');
    // a rating that failed to upload clears the thumb again
    impl['chat:rateReply'] = async () => false;
    await settle(() => good.click());
    assert.equal(good.getAttribute('aria-pressed'), 'false');
    assert.doesNotMatch(good.className, /\bon\b/);
    assert.equal(bad.getAttribute('aria-pressed'), 'false');
    assert.deepEqual(callsTo('chat:reportBadReply'), []);
    assert.ok(!v.$('.menu'));
    impl['store:forkThread'] = async () => 'fork';
    await settle(() => v.$('[aria-label="Fork chat from here"]')!.click());
    assert.deepEqual(callsTo('store:forkThread'), [[T, 't1']]);
    // a fork that fails says so, instead of an unhandled rejection
    impl['store:forkThread'] = () => Promise.reject(new Error('no session'));
    impl['store:toastFailure'] = (what: string) => (e: Error) => moduleCalls.push(['failed', [what, e.message]]);
    await settle(() => v.$('[aria-label="Fork chat from here"]')!.click());
    assert.deepEqual(callsTo('failed'), [["Couldn't fork the chat", 'no session']]);
    // the thumbs are never off: rating a reply is the consent to send it, whatever the sharing choice
    await settle(() => setStore({ prefs: { shareUsageData: false } }));
    for (const button of [good, bad]) {
      assert.equal((button as HTMLButtonElement).disabled, false);
      assert.equal(button.parentElement!.dataset.tooltip, button === good ? 'Good response' : 'Bad response');
    }
    assert.ok(!v.$('.menu'));
    await v.unmount();
  });

  const RICH = [
    '# Files mentioned by the user:',
    '## a.ts: /repo/a.ts',
    '## shot.png: /tmp/shot.png',
    '# Selected text:',
    '## Selection 1',
    'quoted bit',
    '# Response annotations:',
    '<response-annotations>[{"text":"q1","annotation":"c1"},{"text":"q2"}]</response-annotations>',
    '# Diff comments:',
    '',
    '## User Comment 1',
    'File: src/a.ts',
    'Side: R',
    'Lines: 4-5',
    'Diff hunk:',
    '```diff',
    '+new',
    '```',
    'Comment:',
    'rename',
    '',
    '## User Comment 2',
    'File: src/b.ts',
    'Side: L',
    'Lines: 9',
    'Comment:',
    'why?',
    '',
    '## My request:',
    'see https://x.com/a and [Chat A](session://abc) then [Chat B](session://def) ok',
  ].join('\n');

  test('a user message shows its images, mentions, selections, files, quotes and links', async () => {
    const msg = {
      id: 'u',
      type: 'userMessage',
      content: [
        { type: 'text', text: RICH },
        { type: 'localImage', path: '/tmp/shot.png' },
        { type: 'image', url: 'https://img/1.png' },
        { type: 'image' },
        { type: 'mention', name: 'helper', path: '/repo/helper.ts' },
        { type: 'skill', name: 'review', path: '/skills/review' },
      ],
    };
    chat([turn('t1', [msg])]);
    const v = await render(view());
    await settle();
    assert.deepEqual(
      v.$$('.user-images [data-stub="ZoomableImage"]').map((i) => i.dataset.src),
      ['data:/tmp/shot.png', 'https://img/1.png'],
    );
    assert.equal(text(v.$('.mention-chip:not(.file)')), '@helper');
    assert.equal(v.$('[data-stub="SkillLink"]')!.dataset.path, '/skills/review');
    assert.ok(v.$('.user-selections [data-stub="SelectionChip"]'));
    const files = v.$$('.mention-chip.file');
    assert.deepEqual(
      files.map((f) => f.textContent),
      ['a.ts'],
    ); // the image is shown as an image
    // a real link: Tab reaches it, and Enter opens the file like a click (the window doesn't navigate)
    assert.equal(files[0].tagName, 'A');
    assert.equal(files[0].getAttribute('href'), '/repo/a.ts');
    const opened = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    await settle(() => files[0].dispatchEvent(opened as any));
    assert.equal(opened.defaultPrevented, true);
    assert.deepEqual(callsTo('open:openMessageLink')[0].slice(0, 2), ['/repo/a.ts', undefined]);
    assert.deepEqual(
      v
        .$$('.user-annotation')
        .map((a) => [text(a.querySelector('.user-annotation-quote')), a.querySelector('.user-annotation-comment')?.textContent ?? null]),
      [
        ['q1', 'c1'],
        ['q2', null],
        ['+new', 'rename'],
        ['', 'why?'],
      ],
    );
    // a diff comment names its file and lines, and quotes its hunk as code
    assert.deepEqual(
      v.$$('.user-annotation-file').map((f) => f.textContent),
      ['src/a.ts · Lines 4-5', 'src/b.ts · Line 9'],
    );
    assert.equal(v.$$('.user-annotation-quote.code').length, 2);
    const bubble = v.$('.user-bubble')!;
    assert.equal(text(bubble), 'see https://x.com/a and Chat A then Chat B ok');
    const sessions = [...bubble.querySelectorAll('a.composer-session-token')] as HTMLElement[];
    assert.equal(sessions[0].getAttribute('href'), '#thread=abc');
    await settle(() => sessions[1].click());
    assert.deepEqual(callsTo('store:navigate'), [[{ name: 'thread', id: 'def' }]]);
    await settle(() => (bubble.querySelector('a.bubble-link:not(.composer-session-token)') as HTMLElement).click());
    assert.equal(callsTo('open:openMessageLink')[1][0], 'https://x.com/a');
    await v.unmount();
  });

  test('a sent browser-tab reference renders as a chip beside chat references and URLs', async () => {
    const token = tabToken({ where: 'app', tabId: 'preview', title: 'Preview [v2]', url: 'http://localhost:5173/' });
    chat([turn('t1', [user('u1', `See [Chat](session://abc) and ${token} https://example.test`)])]);
    const v = await render(view());
    const chip = v.$('.user-bubble .composer-tab-token')!;
    assert.equal(chip.tagName, 'SPAN');
    assert.equal(chip.textContent, 'Preview [v2]');
    assert.equal(chip.getAttribute('title'), 'http://localhost:5173/');
    assert.equal(v.$('.user-bubble a.composer-session-token')!.getAttribute('href'), '#thread=abc');
    assert.equal(v.$('.user-bubble a.bubble-link:not(.composer-session-token)')!.getAttribute('href'), 'https://example.test');
    await v.unmount();
  });

  test("a link in a user's bubble ends before the sentence's period or the bracket around it", async () => {
    chat([turn('t1', [user('u1', 'Open https://x.test/page. Then (https://y.test/q).')])]);
    const v = await render(view());
    const bubble = v.$('.user-bubble')!;
    assert.deepEqual(
      [...bubble.querySelectorAll('a.bubble-link')].map((a) => a.getAttribute('href')),
      ['https://x.test/page', 'https://y.test/q'],
    );
    assert.equal(text(bubble), 'Open https://x.test/page. Then (https://y.test/q).');
    await v.unmount();
  });

  test('voice messages, the copy button, and a message with no content', async () => {
    const voice = '<realtime_delegation><input>turn on the lights</input></realtime_delegation>';
    const flush = '<realtime_delegation><source>transcript_tail_flush</source></realtime_delegation>';
    chat([
      turn('t1', [user('u1', voice), user('u2', flush), { id: 'u3', type: 'userMessage', content: [] }]),
      turn('t2', [user('u4', 'plain')]),
    ]);
    const v = await render(view());
    assert.equal(text(v.$('.user-bubble.voice')), ' Voiceturn on the lights');
    assert.equal(text(v.$('.voice-ended')), ' Voice session ended');
    assert.ok(!v.$$('.user-message')[2].querySelector('.user-bubble'));
    const copy = v.$$('.user-actions button')[0];
    const fire = await withTimers(() => copy.click());
    assert.deepEqual(clipboard, [voice]);
    assert.equal(copy.parentElement!.dataset.tooltip, 'Copied');
    await fire();
    assert.equal(copy.parentElement!.dataset.tooltip, 'Copy');
    // a message with nothing but attachments has no text, and copying it still confirms
    const empty = v.$$('.user-message')[2].querySelector('.user-actions button') as HTMLElement;
    const fireEmpty = await withTimers(() => empty.click());
    assert.deepEqual(clipboard, [voice, '']);
    assert.equal(empty.parentElement!.dataset.tooltip, 'Copied');
    await fireEmpty();
    assert.equal(empty.parentElement!.dataset.tooltip, 'Copy');
    // a copy that didn't reach the clipboard says so, and doesn't claim Copied
    setClipboardFailure(new Error('clipboard busy'));
    impl['store:toastFailure'] = (what: string) => (e: Error) => moduleCalls.push(['failed', [what, e.message]]);
    try {
      await settle(() => copy.click());
      await settle(() => v.$('.message-actions [aria-label="Copy"]')?.click());
      assert.equal(copy.parentElement!.dataset.tooltip, 'Copy');
      assert.deepEqual(callsTo('failed')[0], ["Couldn't copy", 'clipboard busy']);
    } finally {
      setClipboardFailure(null);
    }
    // only the last turn's message can be edited
    assert.equal(v.$$('[aria-label="Edit message"]').length, 1);
    await v.unmount();
  });

  test('editing a message rewinds the chat and puts the text and selections back in the composer', async () => {
    const sel = '# Selected text:\n## Selection 1\nfirst\n## Selection 2\nsecond\n## My request:\nredo this';
    chat([turn('t1', [user('u', sel)])]);
    const v = await render(view());
    const edit = () => settle(() => v.$('[aria-label="Edit message"]')!.click());
    impl['sem:runSemantic'] = async () => ({ ok: true, value: true });
    await edit();
    assert.deepEqual(callsTo('sem:runSemantic'), [[T, 'rewind', 't1']]);
    assert.deepEqual(callsTo('store:giveBackToComposer'), [
      [
        T,
        'redo this',
        [
          { kind: 'selection', path: '', name: 'Selection', text: 'first' },
          { kind: 'selection', path: '', name: 'Selection', text: 'second' },
        ],
      ],
    ]);
    impl['sem:runSemantic'] = async () => ({ ok: true, value: false });
    await edit();
    assert.equal(callsTo('store:giveBackToComposer').length, 1);
    impl['sem:runSemantic'] = async () => ({ ok: false, reason: 'busy' });
    await edit();
    assert.deepEqual(callsTo('store:toast'), [['refused rewind: busy', 'error']]);
    impl['sem:runSemantic'] = async () => {
      throw new Error('gone');
    };
    await edit();
    impl['sem:runSemantic'] = async () => {
      throw 'raw';
    };
    await edit();
    assert.deepEqual(callsTo('store:toast').slice(1), [
      ["Couldn't edit: gone", 'error'],
      ["Couldn't edit: raw", 'error'],
    ]);
    assert.equal(callsTo('store:giveBackToComposer').length, 1, 'refused or rejected rewinds never restore input');
    // a message before the first checkpoint cannot be edited; nor a pending or running one
    impl['store:editBlockedFor'] = () => 'No checkpoint for this message';
    await settle(() => chat([turn('t1', [user('u', 'x')])]));
    assert.equal((v.$('[aria-label="Edit message"]') as HTMLButtonElement).disabled, true);
    assert.equal(v.$('[aria-label="Edit message"]')!.parentElement!.dataset.tooltip, 'No checkpoint for this message');
    await settle(() => chat([turn('pending-1', [user('u', 'x')])]));
    assert.ok(!v.$('[aria-label="Edit message"]'));
    await settle(() => chat([turn('t1', [user('u', 'x')], { status: 'inProgress' })]));
    assert.ok(!v.$('[aria-label="Edit message"]'));
    await v.unmount();
  });
}
