// A working MoPilot session must survive agents editing its checkout. Live UI updates are an
// explicit developer choice: store and shared-module updates can otherwise reload the whole page.
export function devServerOptions(env = process.env) {
  return { port: 5199, strictPort: true, hmr: env.MOPILOT_DEV_HMR === '1' };
}
