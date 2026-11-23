// The iOS notification extension reads title keys under the keychain service names expo-secure-store really stores them under (a real iPhone fell back to the fixed title on every sealed push because it asked for a name that never existed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const library = new URL('../mobile/node_modules/expo-secure-store/ios/SecureStoreModule.swift', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
// the keychain lookup lives in the opener the extension and the Live Activity widget share
const nse = read('../mobile/plugins/Shared/SealedTitle.swift');

test('the extension asks for the suffixed service name expo-secure-store stores under, and the bare one for keys an older build stored', () => {
  assert.ok(nse.includes('["\\(service):no-auth", service].map'));
  // the suffix is ":no-auth" only while the app never asks for authentication; ":auth" would be a service the extension does not read
  assert.doesNotMatch(read('../mobile/src/push/production.ts'), /requireAuthentication/);
});

test('expo-secure-store stores an item under "<service>:no-auth"', {
  skip: !existsSync(library) && 'expo-secure-store is not installed',
}, () => {
  const swift = readFileSync(library, 'utf8');
  // the library stores an item under "<service>:no-auth" (or ":auth"), never under the bare service ...
  assert.ok(swift.includes('service.append(":\\(requireAuthentication ? "auth" : "no-auth")")'));
  // ... because every write passes requireAuthentication, which is false unless asked for
  assert.ok(swift.includes('var setItemQuery = query(with: key, options: options, requireAuthentication: options.requireAuthentication)'));
});

test('the app and the extension name the same keychain service', () => {
  const app = /TITLE_KEY_SERVICE = '([^']+)'/.exec(read('../mobile/src/push/production.ts'))?.[1];
  const extension = /<key>MPKeychainService<\/key><string>([^<]+)<\/string>/.exec(read('../mobile/plugins/nseFiles.js'))?.[1];
  assert.ok(app, 'the app names a service');
  assert.equal(extension, app);
  assert.ok(nse.includes('?? "mopilot-push"'), 'the extension default is the same name');
});
