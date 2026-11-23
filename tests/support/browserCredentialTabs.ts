// In-memory credential tab and BrowserTabs fixtures shared by form and Host-ownership regression tests.
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ToolError } = require('../../electron/capabilities/contract/registry.cjs');
/**
 * A tab whose page agent answers the credential ops from `page`: frames by session id, each with an
 * origin and fields; focusing records the frame, inserted text lands in the focused field.
 */
export function makeTab(o: any = {}) {
  const wc: any = new EventEmitter();
  const tab: any = {
    id: 't1',
    chatId: 'c1',
    wc,
    backend: wc,
    href: o.url ?? 'https://a.example/login',
    get url() {
      return this.href;
    },
    frames: new Map(Object.keys(o.frames ?? {}).map((sid) => [sid, { sessionId: sid }])),
    sent: [] as any[],
    typed: {} as Record<string, string>,
    focused: null as string | null,
    page: {
      '': { origin: 'https://a.example', fields: [] as any[] },
      ...(o.frames ?? {}),
      ...(o.top ? { '': o.top } : {}),
    },
    agentImpl: null as any,
    frameOf(ref: string) {
      for (const [sid, f] of Object.entries<any>(this.page)) if (f.fields.some((x: any) => x.ref === ref)) return sid;
      if (ref === 'ref_other') return 'S9';
      throw new ToolError(`${ref} is stale`, 'stale_ref');
    },
    async agent(op: string, args: any, sid: string) {
      if (this.agentImpl) {
        const r = await this.agentImpl(op, args, sid);
        if (r !== undefined) return r;
      }
      const frame = this.page[sid];
      if (op === 'credentialFields') {
        if (frame.fail) throw new Error('frame gone');
        if (args.refs) {
          if (args.refs.includes('ref_stale')) return { error: 'stale', ref: 'ref_stale' };
          if (args.refs.includes('ref_button')) return { error: 'not_credential', ref: 'ref_button' };
          return { origin: frame.origin, fields: frame.fields.filter((f: any) => args.refs.includes(f.ref)) };
        }
        return { origin: frame.origin, fields: frame.fields };
      }
      if (op === 'credentialFocus') {
        if (args.origin !== frame.origin) return { error: 'origin' };
        this.focused = args.ref;
        return { ok: true };
      }
      if (op === 'credentialCheck') {
        const length = (this.typed[args.ref] ?? '').length;
        return args.submit ? { length, submitted: !o.noForm } : { length };
      }
      throw new Error(`unexpected op ${op}`);
    },
    async send(method: string, params: any, sid: string) {
      this.sent.push([method, params, sid]);
      if (method === 'Input.insertText' && this.focused && !o.dropText) this.typed[this.focused] = params.text;
    },
  };
  return tab;
}

export const LOGIN = [
  { ref: 'ref_1', kind: 'username', label: 'Email' },
  { ref: 'ref_2', kind: 'password', label: 'Password' },
];

/** A fake BrowserTabs around one tab. */
export function makeTabs(tab: any) {
  const calls: any[] = [];
  return {
    calls,
    o: { platform: 'darwin' },
    run: async (_t: any, fn: () => any) => fn(),
    ready: async (...a: any[]) => {
      calls.push(['ready', ...a.slice(1)]);
    },
    settle: async () => {
      calls.push(['settle']);
    },
    resolve: async () => tab,
    requestSignin: async (_t: any, o: any) => {
      calls.push(['requestSignin', o.reason]);
      return 'done';
    },
    state: () => 'STATE',
  };
}
