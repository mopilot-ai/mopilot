// Shared by tests/phoneReview.test.ts and tests/phoneReviewList.test.ts: the card choices, the mount helper, a fake runtime that follows one chat, and the review sheet.

import { act, createElement, createRoot, flush } from './component-kit';
export const sheetPath = '../../../mobile/src/components/ReviewSheet';
const { ReviewSheet } = await import(sheetPath);

export const choices = [
  { key: 'once', label: 'Allow once' },
  { key: 'always', label: 'Always in this chat' },
  { key: 'deny', label: 'Deny', deny: true },
];

const mounted: any[] = [];
export async function mount(node: any) {
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => root.render(node));
  await flush();
  return { host, root };
}
export const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')].map((b) => b.textContent);

export function runtimeFor(opts: { cards?: any[]; answer?: (p: any) => any; follow?: () => any } = {}) {
  const calls: Array<[string, any]> = [];
  let listener: (e: any) => void = () => {};
  const runtime: any = {
    snapshot: () => ({ selectedPair: 'p', generation: 1 }),
    onEvent: (f: any) => ((listener = f), () => calls.push(['off', null])),
    request: async (method: string, params: any) => {
      calls.push([method, params]);
      if (method === 'chat.follow')
        return (
          opts.follow?.() ?? {
            rev: 1,
            feedSeq: 0,
            session: { turn: 'awaitingUser', cards: opts.cards ?? [] },
            itemsShape: 'rows',
            items: [],
          }
        );
      if (method === 'card.answer') return opts.answer?.(params) ?? {};
      return {};
    },
  };
  return {
    runtime,
    calls,
    emit: (e: any) => act(async () => listener({ kind: 'event', chatId: 'c1', ...e })),
    raw: (e: any) => act(async () => listener(e)),
  };
}
export const sheet = (runtime: any, props: object = {}) =>
  createElement(ReviewSheet, {
    runtime,
    chatId: 'c1',
    title: 'Clean up generated files',
    subtitle: 'shop',
    openChat: () => {},
    close: () => {},
    ...props,
  });
export const CARD = { id: 'k1', rev: 1, title: 'Run this command?', detail: 'rm -rf dist coverage', choices };
