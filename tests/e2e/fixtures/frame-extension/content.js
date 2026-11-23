// E2E fixture: inject a password manager's foreign frame only after the test proves MoPilot attached to this login document.
// The frame sits in a closed shadow root, as password managers keep theirs, so the page guard (frameGuard.mjs) cannot empty
// it: Chrome sees the extension frame load and detaches MoPilot's debugger every time. In an open tree the guard can win
// that race, and the detach this journey needs would then depend on timing.
if (document.querySelector('input[type="password"]')) {
  document.addEventListener(
    'mopilot-test-frame',
    () => {
      const host = document.createElement('div');
      host.id = 'injected-menu'; // the visible, removable part: the journey dismisses the menu by this id
      const frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('frame.html');
      frame.id = 'injected-menu-frame';
      host.attachShadow({ mode: 'closed' }).append(frame);
      document.body.append(host);
    },
    { once: true },
  );
  document.documentElement.dataset.mopilotFrameReady = 'true';
}
