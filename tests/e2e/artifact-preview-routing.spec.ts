// Linked HTML and existing TSX plans render on each harness without changing their source or exposing the app bridge.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect } from './fixtures/app';

for (const family of [
  { label: 'Codex', harnesses: 'codex', acp: {} },
  { label: 'Claude Code', harnesses: 'claude', acp: {} },
  { label: 'ACP', harnesses: 'none', acp: { kimi: { resume: true } } },
] as const)
  test.describe(`artifact preview on ${family.label}`, () => {
    if (family.label === 'ACP') test.skip(process.platform !== 'darwin', 'ACP admission requires the macOS bridge');
    test.use({ harnesses: family.harnesses, acp: family.acp, seed: { uiState: { prefs: { fontSize: 24, zoomLevel: 0 } } } });
    test('opens HTML and existing canvas plans as rendered interactive artifacts and retains the original source', async ({
      page,
      harness,
    }, testInfo) => {
      test.setTimeout(90_000);
      const folder = path.join(harness.dir, 'home', 'artifact-project');
      const output = path.join(folder, 'artifacts', 'linux-feasibility.html');
      const original = path.join(harness.dir, 'home', '.cursor', 'projects', 'artifact-project', 'canvases', 'linux.canvas.tsx');
      const source = `import { Stack, H1, Table, Pill, CollapsibleSection, useCanvasState, useHostTheme } from 'cursor/canvas';
        type Task = { title: string; days: number };
        const tasks: Task[] = [{title:'Repair quarantined journeys',days:3},{title:'Harden recovery',days:2}];
        export default function Plan() {
          const theme=useHostTheme(); const [view,setView]=useCanvasState('view','Roadmap');
          return <Stack style={{color:theme.text.primary}}><H1>Repository health improvement plan</H1>
            <Pill active={view==='Roadmap'} onClick={()=>setView('Roadmap')}>Roadmap</Pill>
            <Pill active={view==='Evidence'} onClick={()=>setView('Evidence')}>Evidence</Pill>
            {view==='Roadmap'?<><Table headers={['Task','Days']} rows={tasks.map(task=>[task.title,task.days])}/>
              <CollapsibleSection title="Acceptance targets">Original repro passes</CollapsibleSection></>:<p>32 captured incidents</p>}
          </Stack>;
        }`;
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.writeFileSync(original, source);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(
        output,
        '<main><h1>MoPilot on Linux</h1><p id="scope" aria-live="polite">Coding desktop</p>' +
          '<button type="button" aria-pressed="false">Include desktop control</button></main>' +
          '<script>const button=document.querySelector("button");button.addEventListener("click",()=>{' +
          'const expanded=button.getAttribute("aria-pressed")!=="true";button.setAttribute("aria-pressed",String(expanded));' +
          'document.getElementById("scope").textContent=expanded?"Coding desktop and desktop control":"Coding desktop";});</script>',
      );
      await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
      await harness.app.evaluate(({ dialog }, project) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [project] })) as any;
      }, folder);
      await page.getByRole('complementary').getByRole('button', { name: 'Add a project folder' }).click();
      // Claude's scripted MCP call reads initialize's real instructions from the SDK server; every fake logs what it receives.
      const probe = family.label === 'Claude Code' ? 'MCPCALL artifact-routing\n\n' : '';
      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`${probe}[Linux feasibility](${pathToFileURL(output).href})`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const received = () =>
        JSON.stringify(
          family.label === 'Codex' ? harness.codexLog() : family.label === 'Claude Code' ? harness.claudeLog() : harness.acpLog('kimi'),
        );
      await expect.poll(received).toContain('Artifact previews in MoPilot:');
      await expect.poll(received).toContain('.canvas.tsx files have a sandboxed compatibility preview');
      const link = page.locator('.assistant-message').getByRole('link', { name: 'Linux feasibility', exact: true });
      await expect(link).toBeVisible();
      await page.setViewportSize({ width: 1024, height: 682 });
      await link.click();
      const frame = page.frameLocator('iframe[title="HTML preview"]');
      await expect(frame.getByRole('heading', { name: 'MoPilot on Linux', exact: true })).toBeVisible();
      await expect(frame.locator('#scope')).toHaveText('Coding desktop');
      // Playwright checks the button inside its frame; the pane spring can still move that frame after the hit test.
      // Wait for the actual animation, including a retarget after layout, before sending the one physical click.
      await expect.poll(() => page.locator('.side-pane').evaluate((pane) => pane.getAnimations().length)).toBe(0);
      const toggle = frame.getByRole('button', { name: 'Include desktop control', exact: true });
      await toggle.click();
      await expect(frame.locator('#scope')).toHaveText('Coding desktop and desktop control');
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await toggle.click();
      await expect(frame.locator('#scope')).toHaveText('Coding desktop');
      await page.getByRole('button', { name: 'View source', exact: true }).click();
      await expect(page.locator('.file-preview')).toContainText('<main>');
      await page.getByRole('button', { name: 'View rendered', exact: true }).click();
      await expect(frame.getByRole('heading', { name: 'MoPilot on Linux', exact: true })).toBeVisible();
      expect(fs.readFileSync(original, 'utf8')).toBe(source);
      expect(output.startsWith(`${folder}${path.sep}`)).toBe(true);
      expect(await frame.locator('body').evaluate(() => typeof (window as any).native)).toBe('undefined');
      await page.screenshot({ path: testInfo.outputPath('artifact-preview.png') });

      await page.getByRole('textbox', { name: 'Message', exact: true }).fill(`[Repository health plan](${pathToFileURL(original).href})`);
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.locator('.assistant-message').getByRole('link', { name: 'Repository health plan', exact: true }).click();
      const canvas = page.frameLocator('iframe[title="Canvas preview"]').last();
      await expect(canvas.getByRole('heading', { name: 'Repository health improvement plan' })).toBeVisible();
      await expect(canvas.getByRole('table')).toContainText('Repair quarantined journeys');
      const disclosure = canvas.getByRole('button', { name: 'Acceptance targets', exact: false });
      await disclosure.click();
      await expect(canvas.getByText('Original repro passes')).toBeVisible();
      await disclosure.click();
      await expect(canvas.getByText('Original repro passes')).toHaveCount(0);
      await canvas.getByRole('button', { name: 'Evidence', exact: true }).click();
      await expect(canvas.getByText('32 captured incidents')).toBeVisible();
      await page.getByRole('button', { name: 'View source', exact: true }).click();
      await expect(page.locator('.file-preview')).toContainText('cursor/canvas');
      await page.getByRole('button', { name: 'View rendered', exact: true }).click();
      await expect(canvas.getByText('32 captured incidents')).toBeVisible();
      await page.getByRole('button', { name: 'Refresh preview', exact: true }).click();
      // A refresh stages a second hidden iframe beside the shown one (PreviewSwap) and drops the old one once the
      // new canvas is ready. `.last()` points at the staged frame, so wait for the swap to finish (one frame, no
      // "Refreshing preview…" status) before interacting; otherwise the click races the frame being replaced.
      await expect(page.getByText('Refreshing preview…')).toHaveCount(0);
      await expect(page.locator('iframe[title="Canvas preview"]')).toHaveCount(1);
      await expect(canvas.getByText('32 captured incidents')).toBeVisible();
      await canvas.getByRole('button', { name: 'Roadmap', exact: true }).click();
      await expect(canvas.getByRole('table')).toContainText('Harden recovery');
      expect(await canvas.locator('body').evaluate(() => typeof (window as any).native)).toBe('undefined');
      expect(fs.readFileSync(original, 'utf8')).toBe(source);
      await page.screenshot({ path: testInfo.outputPath('canvas-plan-preview.png') });
    });
  });
