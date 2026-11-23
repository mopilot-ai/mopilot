// A fake relay socket for Mobile Remote's tests: the WebSocket shape electron/remote/relayClient.cjs drives, recording what the Mac sends and letting a test play the relay.

export class FakeSocket {
  sent: any[] = [];
  closed: number[] = [];
  throwOnSend = false;
  throwOnClose = false;
  onopen: any = null;
  onmessage: any = null;
  onclose: any = null;
  onerror: any = null;
  url: string;
  headers: Record<string, string>;
  constructor(url: string, headers: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  send(text: string) {
    if (this.throwOnSend) throw new Error('socket is closed');
    this.sent.push(JSON.parse(text));
  }
  close(code?: number) {
    if (this.throwOnClose) throw new Error('already closed');
    this.closed.push(code ?? 0);
  }
  open() {
    this.onopen?.();
  }
  recv(m: unknown) {
    this.onmessage?.({ data: typeof m === 'string' ? m : JSON.stringify(m) });
  }
  hello(pairs: unknown[] = []) {
    this.open();
    this.recv({ t: 'hello', device: 'mac-1', kind: 'desktop', pairs });
  }
  serverClose(code: number) {
    this.onclose?.({ code });
  }
  sentOf(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}
