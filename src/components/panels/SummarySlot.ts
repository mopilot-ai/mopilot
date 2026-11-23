// The lane for a chat's summary panel; the home page reserves none, so its hero and composer center on the whole main area.

import { createElement, type ReactNode } from 'react';
import type { Route } from '../../store/types';

/** The summary panel's lane: only on a chat, while summary is on and the side pane is closed. */
export function SummarySlot({
  routeName,
  summaryOpen,
  diffOpen,
  children,
}: {
  routeName: Route['name'];
  summaryOpen: boolean;
  diffOpen: boolean;
  children?: ReactNode;
}) {
  // Like the official app, an empty lane on home would push the composer off center.
  if (!summaryOpen || diffOpen || routeName !== 'thread') return null;
  return createElement('div', { className: 'summary-slot' }, children);
}
