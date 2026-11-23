// The New chat screen mounted alone for component tests, and the taps its tests share: chips, sheet rows, + and the mic.
import { useState } from 'react';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush, click, inputText } from './component-kit';
import { fakeDraft } from './drafts';
const modulePath = '../../../mobile/src/screens/NewChat';
const linkPath = '../../../mobile/src/macLink';
const { NewChat } = await import(modulePath);
const { MacLinkProvider } = await import(linkPath);

export const PROMPT = 'Describe a task or ask a question';
const mounted: any[] = [];
export async function mount(runtime: any, media: any, extra: any = {}, snap?: any) {
  // one screen at a time: the click helpers search the whole document
  for (const old of mounted.splice(0)) await act(async () => old.root.unmount()), old.host.remove();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  const opened: string[] = [];
  const sents: { text: string; warning?: string }[] = [];
  // what the app is told when Start is tapped (the text) and when the Mac refuses it (null)
  const sendings: (string | null)[] = [];
  let backs = 0;
  // the app owns the first message; this stands in for it
  const Owner = () => {
    const [drafts] = useState(() => fakeDraft(''));
    const screen = createElement(NewChat, {
      runtime,
      media,
      open: (id: string, sent: { text: string; warning?: string }) => (opened.push(id), sents.push(sent)),
      sending: (text: string | null) => sendings.push(text),
      back: () => backs++,
      drafts,
      ...extra,
    });
    return snap ? createElement(MacLinkProvider, { state: snap, runtime }, screen) : screen;
  };
  await act(async () => root.render(createElement(Owner)));
  await flush();
  return { host, root, opened, sents, sendings, backs: () => backs };
}
export const has = (host: HTMLElement, re: RegExp, message = `the screen shows ${re}`) => assert.match(host.textContent!, re, message);
export const button = (host: HTMLElement, title: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === title || b.getAttribute('aria-label') === title) as
    | HTMLButtonElement
    | undefined;
export const chip = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? '').startsWith(`${label}, `)) as HTMLButtonElement;
export const tap = async (el: HTMLElement) => {
  await act(async () => el.click());
  await flush();
};
export const typeIn = (text: string) => inputText(PROMPT, text);
/** A sheet's row, named exactly; the sheet is drawn after the page, so the last match is the row and not a chip or the pill. */
export const row = async (title: string) => {
  const el = [...document.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label') === title).at(-1);
  assert.ok(el, `row ${title}`);
  await tap(el as HTMLElement);
};
/** The + sheet, then the Camera tile or the Photos button at its top right ('Photo library' names the full picker). */
export const attach = async (row: string) => {
  await click('Add to session');
  await click(row === 'Photo library' ? 'Photos' : row);
};
/** The thumbnail of an attached file in the composer, by its name and what the strip says of it ('attached', 'sending 0%', 'failed: …'). */
export const tile = (host: HTMLElement, name: string, state: string) => host.querySelector(`[aria-label="${name}, ${state}"]`);
/** The mic opens the dictation sheet holding the voice note's own controls. */
export const dictate = async () => {
  if (!document.querySelector('button[aria-label="Record voice note"]')) await click('Dictate');
  await click('Record voice note');
};
