// The side panel's Dictate (sidePanel.mjs), as the app's (src/components/ui/Dictation.tsx): the mic records, a second click stops, MoPilot transcribes the clip on the chat's dictation services in turn (electron/app/chromePanelDictate.cjs) and the text goes in the box. Chrome asks for the microphone on its own page (mic.html), once.
import { recordingToWav, toBase64 } from './panelAudio.mjs';

/** What the button says in each state. */
export const MIC = Object.freeze({
  idle: { label: 'Dictate', on: false },
  starting: { label: 'Starting…', on: false },
  recording: { label: 'Stop dictating', on: true },
  transcribing: { label: 'Transcribing…', on: false },
});

export class PanelDictate {
  /**
   * @param {object} o
   * @param {any} o.document
   * @param {any} o.chrome
   * @param {any} o.g the page: navigator (its microphone), MediaRecorder, Blob, AudioContext, OfflineAudioContext
   * @param {(method: string, params?: object) => Promise<any>} o.request one request to MoPilot
   * @param {() => any} [o.target] selected recipient and material model/account choices
   * @param {(text: string) => void} o.onText the words, for the box
   * @param {(text: string) => void} o.onError the panel's error line
   */
  constructor(o) {
    this.o = o;
    this.clientId = globalThis.crypto.randomUUID();
    this.capture = null;
    this.run = 0;
    this.generation = 0;
    o.g.addEventListener?.('pagehide', () => {
      clearTimeout(this.timer);
      this.run++;
      if (this.rec) {
        this.rec.onstop = null;
        this.rec.stream.getTracks().forEach((t) => t.stop());
      }
      void this.release();
    });
    /** @type {'idle' | 'starting' | 'recording' | 'transcribing'} */
    this.state = 'idle';
    /** @type {any} the recorder while it records */
    this.rec = null;
    const $ = (/** @type {string} */ id) => o.document.getElementById(id);
    this.$ = $;
    $('mic').addEventListener('click', () => void this.toggle());
    this.render();
  }

  async release() {
    const capture = this.capture;
    this.capture = null;
    await this.o
      .request('dictationEnd', { capture, clientId: this.clientId, generation: this.generation })
      .catch((error) => console.warn('MoPilot: release speech capture:', error));
  }
  render() {
    const m = MIC[this.state];
    const b = this.$('mic');
    b.setAttribute('aria-label', m.label);
    b.title = m.label;
    b.setAttribute('aria-pressed', String(m.on));
    b.className = `icon mic ${this.state}`;
    b.disabled = this.state === 'starting' || this.state === 'transcribing';
  }

  /** The mic clicked: record, or stop and transcribe what was said. */
  async toggle() {
    if (this.state === 'recording') return this.rec.stop();
    if (this.state !== 'idle') return;
    // held while the engine and the microphone are asked for: a second click starts no second recorder
    this.state = 'starting';
    this.render();
    const attempt = ++this.run;
    this.generation = attempt;
    const target = this.o.target?.() ?? {};
    const owner = JSON.stringify(target);
    const failed = (/** @type {string} */ text) => {
      void this.release();
      this.state = 'idle';
      this.render();
      this.o.onError(text);
    };
    const { g, chrome } = this.o;
    let wav;
    try {
      const reply = await this.o.request('dictationEngine', { ...target, capture: true, clientId: this.clientId, generation: attempt });
      // MoPilot says when a service it may try reads WAV; one that doesn't say reads WAV only on this Mac's
      wav = typeof reply?.wav === 'boolean' ? reply.wav : reply?.engine === 'local';
      this.capture = reply?.capture;
      if (!this.capture || attempt !== this.run || owner !== JSON.stringify(this.o.target?.() ?? {}))
        throw new Error('The speech input owner changed. Dictate again.');
    } catch (e) {
      return failed(String(/** @type {Error} */ (e).message));
    }
    let stream;
    try {
      stream = await g.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (attempt !== this.run) return;
      const err = /** @type {Error} */ (e);
      // a side panel can't show Chrome's ask: the extension's own page asks, once
      if (err?.name === 'NotAllowedError') {
        await Promise.resolve(chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') })).catch((/** @type {unknown} */ error) =>
          console.warn("MoPilot: couldn't open the microphone page:", error),
        );
        return failed('Allow the microphone in the tab that opened, then dictate again.');
      }
      return failed(err?.name === 'NotFoundError' ? 'No microphone found.' : String(err?.message ?? err));
    }
    if (attempt !== this.run) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mime = g.MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const chunks = /** @type {Blob[]} */ ([]);
    let rec;
    try {
      rec = new g.MediaRecorder(stream, { mimeType: mime });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      return failed(String(e.message));
    }
    rec.ondataavailable = (/** @type {any} */ e) => chunks.push(e.data);
    rec.onstop = () => void this.finish(stream, new g.Blob(chunks, { type: mime }), wav, attempt, owner);
    try {
      rec.start();
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      return failed(String(e.message));
    }
    this.timer = setTimeout(() => rec.stop(), 120_000);
    this.timer.unref?.();
    this.rec = rec;
    this.state = 'recording';
    this.render();
  }

  /** Recording stopped: the clip transcribed, its text into the box. */
  async finish(
    /** @type {any} */ stream,
    /** @type {Blob} */ blob,
    /** @type {boolean} */ wav,
    attempt = this.run,
    owner = JSON.stringify(this.o.target?.() ?? {}),
  ) {
    clearTimeout(this.timer);
    for (const t of stream.getTracks()) t.stop();
    this.rec = null;
    this.state = 'transcribing';
    this.render();
    try {
      if (attempt !== this.run || owner !== JSON.stringify(this.o.target?.() ?? {}))
        throw new Error('This recording belongs to an earlier composer');
      const clip = new Uint8Array(await blob.arrayBuffer());
      // some services read WAV, not the webm the recorder makes: both go, and each service takes its own; the clip kept is the recorder's
      const audio = wav ? await recordingToWav(blob, this.o.g) : clip;
      const r = await this.o.request('transcribe', {
        capture: this.capture,
        clientId: this.clientId,
        audio: toBase64(audio),
        mime: wav ? 'audio/wav' : 'audio/webm',
        ...(wav ? { clip: toBase64(clip) } : {}),
      });
      if (attempt !== this.run || owner !== JSON.stringify(this.o.target?.() ?? {})) return;
      if (r?.text) this.o.onText(String(r.text));
      if (r?.saveError) this.o.onError(String(r.saveError));
    } catch (e) {
      // a failure with nothing to say still says the recording wasn't transcribed
      this.o.onError(String(/** @type {Error} */ (e)?.message || "Couldn't transcribe the recording"));
    } finally {
      await this.release();
      this.state = 'idle';
      this.render();
    }
  }
}
