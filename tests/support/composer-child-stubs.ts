// The Composer's children that are tested on their own, as stand-ins for the Composer's tests (composer-setup.ts imports
// this): MoMo's Dictate, the hand-off, blocked and errand strips, the browser credential sheet, the "@" menu's browser
// tabs. Usage data is stubbed at the account-view boundary so the real ring can render in the composer.
import { createElement as h } from 'react';
import { mock } from 'node:test';
import type { HarnessId, UsageWindow } from '../../src/harness/types.ts';
import { mockTsx } from './composer-kit.ts';

const at = (path: string) => new URL(`../../src/components/${path}`, import.meta.url);
const none = () => null;
export const composerUsageWindows: Partial<Record<HarnessId, UsageWindow[]>> = {};

mock.module('../../src/session/harness/chatAccountView.ts', {
  namedExports: { useChatAccountView: (harness: HarnessId) => ({ windows: composerUsageWindows[harness] ?? [] }) },
});
mock.module('../../src/session/harness/planUsage.ts', { namedExports: { refreshPlanUsage: async () => undefined } });

mockTsx(at('momo/MomoDictation.tsx'), { MomoDictation: () => h('button', { className: 'stub-momo-dictate' }, 'dictate') });
mockTsx(at('thread/HandoffStrip.tsx'), { HandoffStrip: none });
mockTsx(at('thread/BlockedStrip.tsx'), { BlockedStrip: none });
mockTsx(at('composer/ErrandStrip.tsx'), { ErrandStrip: none });
mockTsx(at('thread/BrowserCredentialSheet.tsx'), { BrowserCredentialSheet: none });
mockTsx(at('composer/BrowserTabMentions.tsx'), { useBrowserTabMentions: () => [], BrowserTabRows: none });
