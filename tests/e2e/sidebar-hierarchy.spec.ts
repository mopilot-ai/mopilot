// The thread sidebar's tiers in the real app: sessions are the brightest text, only a session takes the selected pill, and a name its row cuts short fades.
// e2e-covers: src/styles/app/sidebar.css src/styles/app/sidebar-families.css src/styles/app/sidebar-metrics.css
// e2e-covers: src/components/sidebar/ProjectGroup.tsx src/components/sidebar/ThreadRow.tsx src/styles/app/thread-metrics.css
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures/app';

const LONG = 'Change the repository to be open source and update the readme, the licence and every badge accordingly';
const names = [LONG, 'Short one', 'Third session', 'Fourth session', 'Fifth session', 'Sixth session', 'Seventh session'];
const ids = names.map((_, i) => `019c0000-0000-7000-8000-${String(i).padStart(12, '0')}`);

/** How opaque an element's ink is: the tiers differ by the alpha of one ink colour. */
const alpha = (color: string) => {
  const parts = color.match(/[\d.]+/g)!.map(Number);
  return parts.length > 3 ? parts[3] : 1;
};

for (const fontSize of [14, 24]) {
  test.describe(`sidebar tiers at font ${fontSize}`, () => {
    test.use({
      harnesses: 'codex',
      seed: {
        codexThreads: ids.map((id, i) => ({ id, name: names[i], cwd: 'work/tiers', turns: ['Ready'] })),
        uiState: {
          summaryOpen: true,
          prefs: { fontSize, zoomLevel: 0, chatSort: 'manual', chatOrder: { tiers: ids } },
        },
        files: ({ home, userData }) => {
          const folder = path.join(home, 'work', 'tiers');
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(
            path.join(userData, 'projects.json'),
            JSON.stringify({ projects: [{ id: 'tiers', name: 'tiers', path: folder }] }),
          );
        },
      },
    });

    test('headings, labels and the foot recede behind sessions; the pill and the fade belong to sessions', async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1024, height: 682 });
      const sidebar = page.getByRole('complementary');
      const group = sidebar.locator('.project-group').filter({ has: page.locator('.project-row .side-row-label', { hasText: /^tiers$/ }) });
      const heading = group.locator('.project-row');
      const row = (at: number) => group.locator(`[data-sidebar-chat="${ids[at]}"]`);
      const foot = group.locator('.show-more');
      const projects = sidebar.locator('.side-label', { hasText: /^Projects$/ });
      // capitals set the section label apart from the headings under it
      await expect(projects).toHaveCSS('text-transform', 'uppercase');
      const style = (target: ReturnType<typeof page.locator>, property: string) =>
        target.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
      const away = () => page.mouse.move(700, 400);

      await expect(row(0)).toBeVisible();
      await expect(foot).toHaveText('Show 2 more');

      // the home page of this project: its heading is the current row, in full ink and with no pill
      await heading.hover();
      await heading.getByRole('button', { name: 'New chat in tiers' }).click();
      await away();
      await expect(heading).toHaveClass(/selected/);
      // polled: the hover wash fades out over the row's transition
      await expect.poll(async () => alpha(await style(heading, 'background-color'))).toBe(0);
      await expect.poll(async () => alpha(await style(heading, 'color'))).toBe(1);
      await page.screenshot({ path: testInfo.outputPath(`tiers-home-font${fontSize}.png`) });

      // an open session takes the pill, and the heading goes back behind the sessions
      await row(1).click();
      await away();
      await expect(row(1)).toHaveClass(/selected/);
      await expect(heading).not.toHaveClass(/selected/);
      await expect.poll(async () => alpha(await style(row(1), 'background-color'))).toBe(1);
      await expect.poll(async () => alpha(await style(heading, 'background-color'))).toBe(0);
      const ink = {
        session: alpha(await style(row(2), 'color')),
        heading: alpha(await style(heading, 'color')),
        label: alpha(await style(projects, 'color')),
        foot: alpha(await style(foot, 'color')),
        // the heading's chevron is the dim ink by its own rule: the heading now matches it, and the label and foot sit under it
        chevron: alpha(await style(heading.locator('.project-disclosure'), 'color')),
      };
      expect(ink.heading).toBe(ink.chevron);
      expect(ink.label).toBeLessThan(ink.chevron);
      expect(ink.foot).toBeLessThan(ink.chevron);
      expect(ink.heading).toBeLessThan(ink.session);
      expect(ink.label).toBeLessThan(ink.heading);
      expect(ink.foot).toBeLessThan(ink.heading);

      // a name the row cuts short fades at the cut; one that fits keeps its last letters
      const fade = (at: number) =>
        row(at)
          .locator('.side-row-label')
          .evaluate((element) => {
            const css = getComputedStyle(element);
            return {
              clipped: element.scrollWidth > element.clientWidth,
              fade: css.getPropertyValue('--label-fade').trim(),
              overflow: css.textOverflow,
              mask: css.webkitMaskImage,
            };
          });
      const long = await fade(0);
      const short = await fade(1);
      expect(long.clipped).toBe(true);
      expect(long.fade).toBe('18px');
      expect(long.overflow).toBe('clip');
      expect(long.mask).toContain('linear-gradient');
      expect(short.clipped).toBe(false);
      expect(short.fade).toBe('0px');
      await testInfo.attach('tiers', { body: JSON.stringify({ ink, long, short }), contentType: 'application/json' });
      await page.screenshot({ path: testInfo.outputPath(`tiers-chat-font${fontSize}.png`) });

      // a renamed session: while the old name crossfades out, the shorter name coming in fits and keeps its last letters
      await row(1).evaluate((element) => {
        const frames: { fade: string; clipped: boolean }[] = [];
        (window as unknown as { leavingFrames: typeof frames }).leavingFrames = frames;
        const sample = () => {
          const label = element.querySelector('.side-row-label');
          if (label?.querySelector('.morph-out'))
            frames.push({
              fade: getComputedStyle(label).getPropertyValue('--label-fade').trim(),
              clipped: label.scrollWidth > label.clientWidth,
            });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      await row(1).dblclick();
      const input = row(1).getByRole('textbox');
      await input.fill('Tiny');
      await input.press('Enter');
      await expect(row(1).locator('.side-row-label')).toHaveText('Tiny');
      await expect(row(1).locator('.morph-out')).toHaveCount(0);
      const leaving = await page.evaluate(
        () => (window as unknown as { leavingFrames: { fade: string; clipped: boolean }[] }).leavingFrames,
      );
      await testInfo.attach('rename crossfade', { body: JSON.stringify(leaving), contentType: 'application/json' });
      expect(leaving.length, 'the crossfade was seen').toBeGreaterThan(0);
      expect(leaving.filter((frame) => frame.clipped || frame.fade !== '0px')).toEqual([]);
    });
  });
}
