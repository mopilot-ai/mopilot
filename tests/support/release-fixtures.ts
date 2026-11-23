// Fakes shared by the scripts/release.mjs tests: the package, out/, a file system, notarytool's verdict and the
// macOS build's own tools.
import path from 'node:path';
import { recorder } from './scripts-shared-cli.ts';

export const pkg = { productName: 'MoPilot', version: '1.2.0' };
export const out = path.resolve('out');

export function fakeFs(files: Record<string, string>) {
  return {
    existsSync: (f: string) => f in files,
    readFileSync: (f: string) => files[f] ?? 'artifact',
    statSync: () => ({ size: 2048 }),
    rmSync: recorder(),
  };
}

export const response = (ok: boolean, body: unknown, status = ok ? 200 : 500) => ({
  ok,
  status,
  text: async () => String(body),
  json: async () => body,
});

export const accepted = (cmd: string, args: string[]) =>
  cmd === 'xcrun' && args[0] === 'notarytool' ? JSON.stringify({ id: 'sub-1', status: 'Accepted' }) : undefined;
export const COMMIT = 'c'.repeat(40);
export const NOTARY_ENV = { MOPILOT_SIGN_IDENTITY: 'Dev ID', APPLE_API_KEY: 'k', APPLE_API_KEY_ID: 'kid', APPLE_API_ISSUER: 'iss' };
// The macOS build's own tools: the launch check passes, and the DMG step runs as one recorded `dmgbuild` command.
export const MAC = {
  entitlements: () => {},
  dmgbuild: async () => '/bin/dmgbuild',
  dmgTool: ({ dmg, title, tool }: any, { exec }: any) => exec('dmgbuild', [tool, title, dmg]),
};
