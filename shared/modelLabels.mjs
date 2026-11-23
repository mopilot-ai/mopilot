// How a model and a reasoning effort are named, in the app's composer (src/lib/format.ts) and the Chrome side panel's menu (electron/app/chromePanelOptions.cjs).
import { ownTable } from './ownTable.mjs';

/** "gpt-6.1-sol" / "GPT-6.1-Sol" -> "GPT-6.1 Sol" */
export function modelLabel(displayName) {
  if (!displayName) return 'Model';
  const name = displayName.replace(/^gpt/i, 'GPT');
  return name
    .replace(/-(?=[A-Za-z])/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/^Gpt/, 'GPT');
}

export const EFFORT_LABELS = ownTable({
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
});

export function effortLabel(e) {
  if (!e) return '';
  return EFFORT_LABELS[e] ?? e[0].toUpperCase() + e.slice(1);
}
