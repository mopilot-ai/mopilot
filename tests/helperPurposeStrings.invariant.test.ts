// The helper process asks macOS for privacy permissions; macOS reads the purpose string of each from the OUTERMOST app bundle,
// and aborts the helper (SIGABRT in TCC) without it (#5340). Every permission the helper's sources ask for has its string in
// HELPER_PURPOSE_STRINGS, which both the helper's Info.plist and the main app's carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELPER_PURPOSE_STRINGS, helperInfo } from '../scripts/build-helper.mjs';
import { readComputerHelperSources } from './support/native-helper-sources.ts';

/** Source marker of a permission request → the Info.plist keys macOS needs for it. */
const REQUESTS: Array<[RegExp, string[]]> = [
  [/SFSpeech/, ['NSSpeechRecognitionUsageDescription']],
  [
    /EKEventStore/,
    [
      'NSCalendarsFullAccessUsageDescription',
      'NSCalendarsUsageDescription',
      'NSRemindersFullAccessUsageDescription',
      'NSRemindersUsageDescription',
    ],
  ],
  [/AEDeterminePermissionToAutomateTarget/, ['NSAppleEventsUsageDescription']],
];
/** Requests the helper does not make today: one appearing needs its string (and a row above) first. */
const UNLISTED = /AVCaptureDevice|AVAudioEngine|AVAudioApplication|CNContactStore|CLLocationManager|PHPhotoLibrary|CBCentralManager/;

test('every permission the helper asks for has a purpose string, in the helper plist and the set the main app carries', () => {
  const src = readComputerHelperSources();
  assert.doesNotMatch(
    src,
    UNLISTED,
    'a new permission request in the helper needs its purpose string in HELPER_PURPOSE_STRINGS and a row in REQUESTS',
  );
  const info = helperInfo({ version: '1', build: '1' }) as unknown as Record<string, string>;
  for (const [marker, keys] of REQUESTS) {
    assert.match(src, marker, `${marker} no longer in the helper: drop its row`);
    for (const key of keys) {
      assert.ok(HELPER_PURPOSE_STRINGS[key as keyof typeof HELPER_PURPOSE_STRINGS], `${key} missing from HELPER_PURPOSE_STRINGS`);
      assert.equal(info[key], HELPER_PURPOSE_STRINGS[key as keyof typeof HELPER_PURPOSE_STRINGS], `${key} not in the helper's Info.plist`);
    }
  }
});
