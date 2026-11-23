// The Expo native test must build the app scheme, never an unrelated Pod scheme from workspace ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectAppScheme } from '../design/mobile-remote/spike/expo/appScheme.mjs';

test('selects the project-named app scheme even when Pod schemes come first', () => {
  assert.equal(
    selectAppScheme(['Pods.xcodeproj', 'MoPilotRemoteSpike.xcodeproj'], ['EXConstants', 'Pods-MoPilotRemoteSpike', 'MoPilotRemoteSpike']),
    'MoPilotRemoteSpike',
  );
});
test('rejects a missing app project, ambiguous projects or a missing exact scheme', () => {
  assert.throws(() => selectAppScheme(['Pods.xcodeproj'], ['EXConstants']));
  assert.throws(() => selectAppScheme(['One.xcodeproj', 'Two.xcodeproj'], ['One']));
  assert.throws(() => selectAppScheme(['App.xcodeproj'], ['App-extra', 'EXConstants']));
});
