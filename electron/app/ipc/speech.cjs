// Register main-owned speech choices/capture and immutable audio messages on the shared preload bridge.
const path = require('node:path');
const { registerSpeechWindows } = require('../../platform/speechWindows.cjs');
const { createSpeech } = require('../../platform/speech.cjs');
const { createAudioPending } = require('../../platform/audioPending.cjs');
const { createAudioOwnership } = require('../../platform/audioOwnership.cjs');
const { createAudioDispatch } = require('../../platform/audioDispatch.cjs');
const { createAudioAssets } = require('../../platform/audioAssets.cjs');
const { startVoice, stopVoice } = require('../../session/voice.cjs');
const { ignoring, noteIgnored } = require('../../ignored.cjs');
const { createSpeechStreams } = require('../../platform/speechStream.cjs');
const { SPEECH_WAIT_MS } = require('../../../shared/speech.mjs');

/** The remote switch that turns each service's stream off. */
const STREAM_SWITCH = {
  local: 'shared.dictation.local',
  chatgpt: 'shared.dictation.chatgptStream',
};
const { harnessCaps } = require('../../session/harnessCaps.cjs');

/**
 * @param {{ handle: (channel: string, fn: (event: any, ...args: any[]) => unknown) => void, on: (channel: string, fn: (event: any, ...args: any[]) => void) => void }} ipcMain
 * @param {{ live: any, app: { getPath: (name: string) => string }, readState: () => any, isFlagEnabled: (key: string) => boolean }} deps
 */
function register(ipcMain, { live, app, readState, isFlagEnabled }) {
  const windows = registerSpeechWindows(ipcMain, (owner) => {
    ownership.close(owner);
    streams.close(owner);
    void speech.close(owner).catch(ignoring('end voice when its page retires'));
    try {
      pending.close(owner);
    } catch (error) {
      ignoring('recover audio from the retired page')(error);
    }
  });
  const handle = (channel, fn) => ipcMain.handle(channel, (event, token, ...args) => fn(windows.owner(event, token), ...args));
  const assets = createAudioAssets(() => path.join(app.getPath('userData'), 'audio-messages'));
  const dispatch = createAudioDispatch(() => path.join(app.getPath('userData'), 'audio-dispatch'));
  Object.assign(live.acpHost, { audioDispatch: dispatch });
  const pending = createAudioPending(
    () => app.getPath('userData'),
    Date.now,
    (record, target) => {
      const c = record.claim;
      return (
        !c ||
        (speech.owner(c.chatId, c.hint) === c.owner &&
          (c.chatId ? target === c.chatId : !c.hint.kind || live.controller.ref(target).kind === c.hint.kind))
      );
    },
  );
  Object.assign(live.acpHost, { audioPending: pending });
  live.controller.audioPending = pending;
  live.acpTurns.audioPending = pending;
  try {
    pending.recover(live.controller, dispatch);
  } catch (error) {
    ignoring('restore pending audio; the saved file remains unchanged')(error);
  }
  handle('speech:hold', (owner, key, draft, id = null, hint = {}) => {
    return pending.hold(key, draft, { chatId: id, hint, owner: speech.owner(id, hint) }, owner);
  });
  handle('speech:finishTransfer', (_owner, id, preserve) => pending.finishTransfer(id, preserve === true));
  const ownership = createAudioOwnership(() => app.getPath('userData'), assets, live.acpHost, live.controller.state);
  live.audioOwnership = ownership;
  const collect = () => ownership.collect().catch(ignoring('collect unreferenced audio messages'));
  void collect();
  const cleanup = setInterval(collect, 3_600_000);
  cleanup.unref();
  handle('speech:drafts', (owner) => {
    return ownership.drafts(owner);
  });
  handle('speech:draft', (owner, key, draft) => {
    if (live.chatDeletion?.isDeleted(key)) throw new Error('This chat was deleted. Its old audio draft was not restored.');
    ownership.set(key, draft, owner);
    void collect();
  });
  live.acpTurns.readAudio = (file) => assets.read(file);
  const speech = createSpeech({
    enabled: () => isFlagEnabled('shared.dictation.enabled'),
    localEnabled: () => isFlagEnabled('shared.dictation.local'),
    prefs: () => readState().prefs ?? {},
    ref: (id) => [live.controller.ref(id), live.chats.record(id).meta.config],
    identity: (id) => {
      const a = live.accounts.view();
      return [
        a.active,
        id ? a.chatAccounts[live.controller.nativeOf(id)] : null,
        live.accounts.loginEpoch,
        live.identity.instances().map((i) => [i.id, i.account, i.active, i.status]),
      ];
    },
    localStatus: async (language, launch = true) => {
      if (process.platform !== 'darwin') return { unsupported: true };
      try {
        const h = live.computerUse.helper;
        if (!launch && !h.running) return null;
        await h.start();
        return await h.speechStatus(language);
      } catch {
        return null;
      }
    },
    accounts: async () => ({
      chatgpt: !!(await live.accounts.chatgptHeaders()),
      credits: !!live.mopilot?.gatewayKey(),
    }),
    caps: (id, hint) =>
      id
        ? live.capsService.get(id, hint)
        : hint.kind
          ? harnessCaps(live.capsService, hint.kind, live.acpAdmission, live.capabilityHealth)
          : null,
  });
  live.speech = speech;
  handle('speech:options', (_owner, id, hint) => speech.options(id, hint));
  handle('speech:available', (_owner, id, hint) => speech.available(id, hint));
  handle('speech:begin', (owner, id, hint) => {
    const capture = speech.begin(owner, id, hint);
    return capture;
  });
  handle('speech:conversation', async (owner, id, params) => {
    if (!speech.unchanged(owner, id)) throw new Error('This chat or account changed. Start voice again.');
    if (!speech.owns(owner, id, live.controller.chatOf(params?.threadId)))
      throw new Error('Native conversation must use the capture’s original chat');
    speech.attach(owner, id, () => stopVoice(live.codex, params.threadId));
    return startVoice(
      { controller: live.controller, caps: live.capsService, codex: live.codex, current: () => speech.unchanged(owner, id) },
      params,
    );
  });
  handle('speech:current', (owner, id) => speech.current(owner, id));
  handle('speech:end', (owner, id) => {
    if (speech.current(owner, id)) streams.cancel(id);
    return speech.end(owner, id);
  });
  // this Mac's streaming dictation: the window's microphone frames in, each new guess back to that window only
  const streams = createSpeechStreams({
    helper: () => live.computerUse.helper,
    noteIgnored,
    chatgptHeaders: () => live.accounts.chatgptHeaders(),
    WebSocket: globalThis.WebSocket,
  });
  ipcMain.handle('speech:streamStart', async (event, token, id, language, engine = 'local') => {
    const owner = windows.owner(event, token);
    if (!speech.current(owner, id)) throw new Error('This voice input was cancelled');
    const switchOf = STREAM_SWITCH[engine];
    if (!switchOf) throw new Error('This dictation service has no stream');
    if (!isFlagEnabled('shared.dictation.enabled') || !isFlagEnabled(switchOf))
      throw new Error('Streaming dictation is turned off in this app');
    const sender = event.sender;
    await streams.start(
      owner,
      id,
      language,
      (msg) => {
        if (!sender.isDestroyed()) sender.send('speech:stream', { id, ...msg });
      },
      engine,
    );
  });
  handle('speech:streamAudio', (owner, id, bytes) => {
    if (!speech.current(owner, id)) return;
    // a service pinned elsewhere, or a stream switched off, while recording: nothing more goes to this one
    const engine = streams.engineOf(id);
    const pin = readState().prefs?.dictationEngine;
    if (engine && ((pin && pin !== engine) || !isFlagEnabled(STREAM_SWITCH[engine]))) return streams.cancel(id);
    streams.audio(id, bytes);
  });
  handle('speech:streamFinish', (owner, id) => {
    if (!speech.current(owner, id)) throw new Error('This voice input was cancelled');
    return streams.finish(id);
  });
  handle('speech:streamCancel', (_owner, id) => streams.cancel(id));
  handle('speech:save', (owner, id, bytes) => {
    if (!speech.unchanged(owner, id)) throw new Error('This voice input belongs to an earlier chat or account');
    return assets.save(bytes);
  });
  handle('speech:read', async (_owner, file) => {
    const audio = await assets.read(file);
    return `data:${audio.mimeType};base64,${audio.data}`;
  });
  handle('speech:transcribe', (owner, id, bytes, mime, language, engine, waitMs) => {
    if (engine === 'local' && !isFlagEnabled('shared.dictation.local')) throw new Error('On-device recognition is turned off in this app');
    if (!['local', 'chatgpt', 'credits'].includes(engine)) throw new Error('Choose an explicit dictation service');
    const current = () => {
      if (!speech.current(owner, id)) throw new Error('This voice input was cancelled');
    };
    current();
    // the window waits this long for the answer (dictationSend.ts); the request is stopped once it no longer does
    const wait = Number.isFinite(waitMs) && waitMs > 0 ? Math.min(waitMs, SPEECH_WAIT_MS) : SPEECH_WAIT_MS;
    const gaveUp = new AbortController();
    const timer = setTimeout(() => gaveUp.abort(), wait);
    return live.dictation
      .transcribe({ bytes, mime, language, engine, current, chatId: speech.chatOf(owner, id), signal: gaveUp.signal })
      .finally(() => clearTimeout(timer));
  });
}
module.exports = { register };
