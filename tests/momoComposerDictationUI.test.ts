// The composer's Dictate button (src/components/momo/ComposerDictation.tsx): MoMo's own in MoMo's chats, the app's in any other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { render } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

stubStore({ useStore: (sel: any) => sel({ momoChats: { mc: 'main' } }) });
installNativeStub({ speech: { available: async () => true } });
mockSource('src/components/ui/Dictation.tsx', { Dictation: () => h('button', { 'data-dictate': 'app' }) });
mockSource('src/components/momo/MomoDictation.tsx', { MomoDictation: () => h('button', { 'data-dictate': 'momo' }) });
const { ComposerDictation } = await import('../src/components/momo/ComposerDictation.tsx');

test('MoMo’s chats dictate on this Mac only; every other chat, and a new one, with the app’s own', async () => {
  for (const [threadId, which] of [
    ['mc', 'momo'],
    ['c1', 'app'],
    [null, 'app'],
  ] as const) {
    const r = await render(h(ComposerDictation, { threadId, onText: () => undefined }));
    assert.equal(r.host.querySelector('[data-dictate]')!.getAttribute('data-dictate'), which, String(threadId));
    await r.unmount();
  }
});
