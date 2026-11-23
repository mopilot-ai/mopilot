// The phone creates Expo's racing lazy AppContext services once at module registration (#4338): a local module's OnCreate reads each, and the module is autolinked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mobile = path.join(import.meta.dirname, '..', 'mobile');
const pkg = path.join(mobile, 'modules', 'mopilot-startup');
const read = (...parts: string[]) => readFileSync(path.join(...parts), 'utf8');
// the AppContext services read from concurrent async functions: fileSystem (expo-sqlite, expo-file-system, expo-asset, the pickers,
// expo-audio) and permissions (notifications on expo.modules.AsyncFunctionQueue)
const SERVICES = ['fileSystem', 'permissions'];

test('the startup module is an autolinked Apple module with its own pod', () => {
  const config = JSON.parse(read(pkg, 'expo-module.config.json')) as { platforms: string[]; apple: { modules: string[] } };
  assert.deepEqual(config.platforms, ['apple']);
  assert.deepEqual(config.apple.modules, ['MoPilotStartupModule']);
  const podspec = read(pkg, 'ios', 'MoPilotStartup.podspec');
  assert.match(podspec, /s\.name\s+=\s+'MoPilotStartup'/);
  assert.match(podspec, /s\.dependency 'ExpoModulesCore'/);
  // autolinking scans mobile/modules unless the app points it elsewhere or excludes the package
  const manifest = JSON.parse(read(mobile, 'package.json')) as {
    expo?: { autolinking?: { nativeModulesDir?: string; exclude?: string[]; apple?: { exclude?: string[] } } };
  };
  const autolinking = manifest.expo?.autolinking ?? {};
  assert.equal(autolinking.nativeModulesDir ?? './modules', './modules');
  assert.ok(![...(autolinking.exclude ?? []), ...(autolinking.apple?.exclude ?? [])].includes('mopilot-startup'));
});

test('OnCreate reads every racing AppContext service before JS can call a module', () => {
  const swift = read(pkg, 'ios', 'MoPilotStartupModule.swift');
  assert.match(swift, /class MoPilotStartupModule: Module/);
  const onCreate = swift.match(/OnCreate \{([\s\S]*?)\n {4}\}/)?.[1];
  assert.ok(onCreate, 'the module defines OnCreate');
  for (const name of SERVICES)
    assert.match(onCreate, new RegExp(`_ = self\\.appContext\\?\\.${name}\\b`), `${name} is created in OnCreate`);
});
