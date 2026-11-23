// The hosted service a release build of the phone talks to: none in the open-source edition. A private build has
// mobile/src/private/service.ts (MoPilot's account and relay), which Metro bundles in this file's place
// (mobile/config/privateModules.js). Empty addresses: the phone signs in nowhere, so it never asks a relay for anything.
export const PRODUCTION: { relayUrl: string; accountOrigin: string } = { relayUrl: '', accountOrigin: '' };
