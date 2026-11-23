// A panel thread with a fake document and explicitly answered pending reads.
import { PanelThread } from '../../electron/chrome-extension/src/panelThread.mjs';
import { el } from './side-panel-page.ts';

/** A thread on a fake document; each read waits for the test to answer it. */
export function thread() {
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const reads: { answer: (r: any) => void }[] = [];
  const t = new PanelThread({
    document,
    request: () => new Promise((answer) => reads.push({ answer })),
    onError: () => undefined,
    onOpen: () => undefined,
  });
  const read = async (r: any) => {
    const again = t.read();
    reads.at(-1)!.answer({ rows: [], ...r });
    await again;
  };
  return {
    t,
    els,
    reads,
    read,
    data: () => els.chat.dataset,
    line: () => [els['progress-text'].textContent, els['progress-dot'].className],
  };
}
