// The interface text lookups: what the build's wrapped strings call, and the catalog they read (docs/i18n.md).
// the namespace, since a sentence is the one use and every module can reach this file: it must load beside a partial stand-in
import * as React from 'react';
import { fillHoles, HOLE } from '../../shared/i18n/languages.mjs';

let messages = new Map<string, string>();

/** Set before the app's modules load, so a module-level `label: 'Save'` reads this language too. */
export function installLanguage({ tag, messages: catalog }: { tag: string; messages: Record<string, string> }) {
  messages = new Map(Object.entries(catalog));
  // picks the right CJK glyphs, and tells the browser what the spell checker and screen readers should expect
  document.documentElement.lang = tag;
}

/** A wrapped string: its translation, or the English it was written in. `{0}` holes take `args`. */
export function __t(text: string, args?: readonly unknown[]): string {
  const message = messages.get(text) ?? text;
  return args ? fillHoles(message, args) : message;
}

/** A wrapped sentence with elements inside: the holes stay React nodes, in the order the translation puts them. */
export function __tj(text: string, args: readonly React.ReactNode[]): React.ReactNode {
  const parts = (messages.get(text) ?? text).split(HOLE);
  return React.createElement(React.Fragment, null, ...parts.map((part, i) => (i % 2 ? args[Number(part)] : part)));
}

/** For text the build can't see, such as a string held in a variable: the same lookup, and the check collects it. */
export const t = __t;
