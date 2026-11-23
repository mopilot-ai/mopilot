// The side pane's panels that are tested on their own, as stand-ins for the side pane's tests (sidePaneUI, sidePaneDrag):
// each test gives its stub, which gets the panel's tag and export name; a panel a test draws differently it stubs itself.
import { mock } from 'node:test';

type Panels = [file: string, exports: Record<string, string>][];
const PANELS: Panels = [
  ['panels/FilesPanel.tsx', { FilesPanel: 'files', FilePreview: 'file' }],
  ['panels/SkillPanel.tsx', { SkillPanel: 'skill' }],
  ['panels/PlanUsage.tsx', { PlanUsage: 'plan-usage' }],
  ['panels/BrowserPanel.tsx', { BrowserPanel: 'browser' }],
  ['composer/Composer.tsx', { Composer: 'composer' }],
  ['thread/ThreadView.tsx', { ThreadView: 'thread' }],
  ['tasks/TasksTab.tsx', { TasksTab: 'tasks' }],
];

export function stubPanels(stub: (tag: string, panel: string) => unknown, more: Panels = []) {
  for (const [file, exports] of [...PANELS, ...more])
    mock.module(new URL(`../../src/components/${file}`, import.meta.url).href, {
      namedExports: Object.fromEntries(Object.entries(exports).map(([name, tag]) => [name, stub(tag, name)])),
    });
}
