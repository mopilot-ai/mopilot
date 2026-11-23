// Window-side recorder: each animation frame in which the sidebar's project groups differ from the previous frame is kept (time since the page started, and per group its name, chat rows and whether it shows the empty note); read through window.__sidebarFrames.
const { contextBridge } = require('electron');

if (process.isMainFrame) {
  const frames = [];
  let last = '';
  let ticks = 0;
  const groupsNow = () =>
    [...document.querySelectorAll('.project-group')].map((g) => [
      g.querySelector('.project-row')?.getAttribute('aria-label') ?? '',
      g.querySelectorAll('.thread-row').length,
      g.querySelector('.empty-note')?.textContent === 'No active chats' ? 1 : g.querySelector('.empty-note') ? 2 : 0,
    ]);
  const tick = () => {
    ticks++;
    const groups = groupsNow();
    const key = JSON.stringify(groups);
    if (key !== last) {
      last = key;
      frames.push({ t: Math.round(performance.now() * 10) / 10, groups });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  contextBridge.exposeInMainWorld('__sidebarFrames', {
    read: () => ({ ticks, frames }),
  });
}
