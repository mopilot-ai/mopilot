// claude link browser control matrix cases using shared fake surfaces.
import {
  test,
  assert,
  switchingChat,
  world,
  DIALOG,
  claude,
  ipc,
  until,
  tick,
  chatState,
  stripOf,
  claudeChrome,
  INIT,
  chromeUse,
  chromeResult,
} from './fixture.ts';

export function registerClaudeLink() {
  /* Browser use: Claude in Chrome                                           */
  /* ====================================================================== */

  test('CM-B06: Claude in Chrome link: still connecting at start, a drop on a tool error, back on a working tool, gone when the session ends', async () => {
    const { store } = chatState(() => ({ kind: 'claude', id: 'b06', key: 'claude:b06' }));
    const { key, q } = await claudeChrome('b06', 'chat-b06');
    try {
      // the server is still connecting when the session starts: down, but not a drop, so no strip
      q.dialog = { ...DIALOG, connected: false };
      q.push(INIT);
      await until('the first reading', () => store.get('chat-b06').chromeLink !== null);
      assert.deepEqual([store.get('chat-b06').chromeLink.connected, store.get('chat-b06').chromeLink.dropped], [false, false]);
      assert.equal(stripOf(store.get('chat-b06')), null);
      // connected (Settings opened: every live session reads its link again)
      q.dialog = { ...DIALOG };
      await claude.chromeLinks(true);
      assert.equal(store.get('chat-b06').chromeLink.connected, true);
      // a Claude in Chrome tool says the extension went away: a drop, shown above the composer
      q.dialog = { ...DIALOG, connected: false };
      q.push(chromeUse('t1'));
      q.push(chromeResult('t1', true, 'Browser extension is not connected'));
      await until('the drop', () => store.get('chat-b06').chromeLink?.dropped === true);
      assert.equal(stripOf(store.get('chat-b06')), 'chromeLink');
      // an error about something else is not a drop and reads nothing
      const reads = q.dialogReads;
      q.push(chromeUse('t2'));
      q.push(chromeResult('t2', true, 'Element not found'));
      await tick();
      assert.equal(q.dialogReads, reads);
      // a tool works again while the link reads as down: read again, and the strip goes
      q.dialog = { ...DIALOG };
      q.push(chromeUse('t3'));
      q.push(chromeResult('t3', false, 'Clicked'));
      await until('the link back', () => store.get('chat-b06').chromeLink?.connected === true);
      assert.equal(store.get('chat-b06').chromeLink.dropped, false);
      assert.equal(stripOf(store.get('chat-b06')), null);
      // down again, then the session ends: the chat has no link any more
      q.dialog = { ...DIALOG, connected: false };
      q.push(chromeUse('t4'));
      q.push(chromeResult('t4', true, 'Browser extension is not connected'));
      await until('the second drop', () => store.get('chat-b06').chromeLink?.dropped === true);
    } finally {
      await ipc('claude:control', key, 'close');
    }
    await until('the session end', () => store.get('chat-b06').chromeLink === null);
    assert.equal(stripOf(store.get('chat-b06')), null);
  });

  test('CM-B02: once the chat runs on Codex, a drop of the earlier Claude session\'s Claude in Chrome is not shown as "disconnected"', async () => {
    const w = world();
    let sw: ReturnType<typeof switchingChat> | null = null;
    const { store, scope } = chatState((chatId) => sw!.runner.ref(chatId));
    // main's segment end (electron/app/sessions.cjs): the switch hands the chat the new segment's link
    sw = switchingChat(w, { segmentEnded: (e) => scope.segmentEnded(e) });
    sw.startOnClaude('chat-b02');
    const seg = sw.chats.record('chat-b02').segments.at(-1);
    const { key, q } = await claudeChrome(seg.nativeId, 'chat-b02');
    try {
      q.push(INIT);
      await until('the link', () => store.get('chat-b02').chromeLink?.connected === true);
      // T2: Claude in Chrome loses the extension
      q.dialog = { ...DIALOG, connected: false };
      q.push(chromeUse('t1'));
      q.push(chromeResult('t1', true, 'Browser extension is not connected'));
      await until('the drop', () => store.get('chat-b02').chromeLink?.dropped === true);
      // the user moves the chat to Codex; the old CLI stays up, idle
      await sw.switchTo('chat-b02', 'codex');
      assert.equal(claude.turnApi.isLive(key), true, 'the earlier Claude CLI is still alive after the switch');
      // the Codex segment has no Claude in Chrome to reconnect: no "Claude in Chrome is disconnected" strip
      assert.notEqual(stripOf(store.get('chat-b02')), 'chromeLink');
      assert.equal(store.get('chat-b02').chromeLink, null);
      // the idle CLI reads its link again (Settings opened): it no longer reaches the Codex chat
      q.dialog = { ...DIALOG };
      await claude.chromeLinks(true);
      q.dialog = { ...DIALOG, connected: false };
      q.push(chromeUse('t2'));
      q.push(chromeResult('t2', true, 'Browser extension is not connected'));
      await until('the second drop', () => claude.chromeLinkOf(key)?.dropped === true);
      assert.equal(store.get('chat-b02').chromeLink, null);
      // back on Claude Code: the chat resumes the same CLI, and shows its link again
      await sw.switchTo('chat-b02', 'claude');
      assert.equal(store.get('chat-b02').chromeLink?.dropped, true);
      assert.equal(stripOf(store.get('chat-b02')), 'chromeLink');
    } finally {
      await ipc('claude:control', key, 'close');
    }
  });

  test('CM-B09a: archiving or clearing a chat that has since switched to Codex ends its earlier Claude CLI, whose exit hook closes the tab group', async () => {
    claude.setChromeLinkListener(null);
    for (const how of ['archive', 'clear']) {
      const chatId = `chat-b09-${how}`;
      const w = world();
      const sw = switchingChat(w);
      sw.startOnClaude(chatId);
      const { key, q } = await claudeChrome(`b09-${how}`, chatId);
      await sw.switchTo(chatId, 'codex');
      assert.equal(claude.turnApi.isLive(key), true);
      // archive (electron/app/appState.cjs:53) and /new (session:release, electron/app/ipc/sessions.cjs:124) both retire the chat
      assert.equal(claude.retireChat(chatId), 1, how);
      await until(`the ${how}d chat's CLI to end`, () => q.log.includes('close'));
      // its input closed first, so the CLI ran its exit hooks (closing a blank Claude in Chrome group) before the SDK closed it
      assert.deepEqual(q.log, ['eof', 'exit hooks', 'close'], how);
      assert.equal(claude.turnApi.isLive(key), false);
    }
  });

  test("CM-B09b: deleting a switched chat deletes its earlier Claude segment's session, ending that CLI gracefully first", async () => {
    const w = world();
    const sw = switchingChat(w);
    sw.startOnClaude('chat-b09-delete');
    const { key, q } = await claudeChrome('b09-delete', 'chat-b09-delete');
    await sw.switchTo('chat-b09-delete', 'codex');
    // main's ChatDeletion (chats:delete) deletes each earlier segment's native chat: claude.deleteSession for a Claude one
    assert.equal(await claude.deleteSession('b09-delete'), true);
    assert.deepEqual(q.log, ['eof', 'exit hooks', 'close']);
    assert.equal(claude.turnApi.isLive(key), false);
    assert.ok((globalThis as any).__matrixDeleted.includes('b09-delete'));
  });
}
