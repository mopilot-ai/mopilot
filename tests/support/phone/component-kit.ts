// Shared React DOM harness for focused phone component tests.
import assert from 'node:assert/strict';
import '../dom.ts';
import './register.ts';
import { act, createElement } from 'react';
const { createRoot } = await import('react-dom/client');
export { act, createElement, createRoot };
export const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
};
export const click = async (text: string): Promise<void> => {
  // an open action sheet takes the tap first: its option of that label is picked, as a person would
  const sheet = (globalThis as any).__actionSheet;
  if (sheet?.options.includes(text)) {
    (globalThis as any).__actionSheet = undefined;
    await act(async () => sheet.pick(sheet.options.indexOf(text)));
    await flush();
    return;
  }
  // a button is named by its text, else by its accessible label, whole or by its leading words ("Open chat" for "Open chat Fix build")
  const buttons = [...document.querySelectorAll('button')];
  const label = (button: Element) => button.getAttribute('aria-label') ?? '';
  const el =
    buttons.find((button) => button.textContent === text) ??
    buttons.find((button) => label(button) === text) ??
    buttons.find((button) => label(button).startsWith(`${text} `)) ??
    // a list row is named by its name, then its value ("Notifications, On")
    buttons.find((button) => label(button).startsWith(`${text}, `));
  // Settings, MoMo, Scheduled and the recent chats live in the drawer behind Chats: a person opens it first
  const drawer = buttons.find((button) => label(button) === 'Open menu');
  if (!el && drawer) {
    await act(async () => (drawer as HTMLElement).click());
    await flush();
    if ([...document.querySelectorAll('button')].some((b) => b.textContent === text || label(b) === text)) return click(text);
  }
  assert.ok(el, `button ${text}`);
  await act(async () => el.click());
  await flush();
};
export async function inputText(placeholder: string, value: string) {
  const el = document.querySelector(`input[placeholder="${placeholder}"]`) as HTMLInputElement;
  assert.ok(el);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Whether the switch of that label (under `root`, the page by default) is on ('On' / 'Off'), or undefined when none shows. */
export const toggle = (label: string, root: ParentNode = document) => {
  const el = [...root.querySelectorAll('button[role="switch"]')].find((b) => b.getAttribute('aria-label') === label);
  return el ? (el.getAttribute('aria-checked') === 'true' ? 'On' : 'Off') : undefined;
};

/** On the pairing screen the code is pasted after "Paste code instead" (scanning is the way in); opens it when it is not open yet. */
export const openCodeEntry = async () => {
  await openScanner();
  if (document.querySelector('button[aria-label="Paste code instead"]')) await click('Paste code instead');
};

/** Add a computer opens on the camera; from the steps (How to connect), Look for my computer goes on to it. */
export const openScanner = async () => {
  if (document.querySelector('button[aria-label="Look for my computer"]')) await click('Look for my computer');
};

/** The chat list's search field waits behind its icon; opens it when it is not open yet. */
export const openSearch = async () => {
  if (!document.querySelector('input[placeholder="Search chats"]')) await click('Search chats');
};

/** In Settings a computer's Connect and Remove are on its own page: opens the first computer's row (or the one named). */
export const openComputer = async (name?: string) => {
  // rows of the screen on top (the Settings sheet), not the home list's chip under it
  const top = [...document.querySelectorAll('[data-screen]')].at(-1) ?? document;
  const rows = [...top.querySelectorAll('button')].filter((b) =>
    /, (Connected|Available|Offline|Asleep|Paired)$/.test(b.getAttribute('aria-label') ?? ''),
  );
  const row = name ? rows.find((b) => b.getAttribute('aria-label')!.startsWith(`${name}, `)) : rows[0];
  assert.ok(row, `computer row ${name ?? ''}`);
  await act(async () => (row as HTMLElement).click());
  await flush();
};

/** Settings › the account row (initials, email, "MoPilot account") opens the account page, where Delete account is. */
export const openAccount = async () => {
  const row = [...document.querySelectorAll('button')].find((b) => /MoPilot account/.test(b.textContent ?? ''));
  assert.ok(row, 'account row');
  await act(async () => (row as HTMLElement).click());
  await flush();
};
