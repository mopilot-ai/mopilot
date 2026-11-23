// The motion bench's native fixture app's pure text (#3810): its Info.plist, the open command, the quit script and the pid file read.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtureInfoPlist, openFixtureAppCommand, parsePidFile, QUIT_FIXTURE_SCRIPT } from '../bench/lib/motion/fixtureApp.mjs';

test('the Info.plist names a regular, high-resolution app with the fixture id and executable', () => {
  const plist: string = fixtureInfoPlist();
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\n\s+<string>ai\.mopilot\.motionfixture<\/string>/);
  assert.match(plist, /<key>CFBundleName<\/key>\n\s+<string>Motion fixture<\/string>/);
  assert.match(plist, /<key>CFBundleDisplayName<\/key>\n\s+<string>Motion fixture<\/string>/);
  assert.match(plist, /<key>CFBundleExecutable<\/key>\n\s+<string>motionfixture<\/string>/);
  assert.match(plist, /<key>LSUIElement<\/key>\n\s+<false\/>/);
  assert.match(plist, /<key>NSHighResolutionCapable<\/key>\n\s+<true\/>/);
  assert.match(plist, /^<\?xml[^]*<\/plist>\n$/);
});

test('the open command starts a new instance with the url and pid file as arguments, quoted', () => {
  assert.equal(
    openFixtureAppCommand('/b/My App.app', 'http://127.0.0.1:1/?m=a b', '/tmp/p.pid'),
    'rm -f "/tmp/p.pid"; open -na "/b/My App.app" --args "http://127.0.0.1:1/?m=a b" "/tmp/p.pid"',
  );
});

test('the quit script targets the fixture app by its name', () => {
  assert.equal(QUIT_FIXTURE_SCRIPT, 'tell application "Motion fixture" to quit');
});

test('a pid file yields its pid; a missing, empty or odd one yields null', () => {
  assert.equal(parsePidFile('4242\n'), 4242);
  assert.equal(parsePidFile(null), null);
  assert.equal(parsePidFile(''), null);
  assert.equal(parsePidFile('abc'), null);
  assert.equal(parsePidFile('1'), null);
  assert.equal(parsePidFile('0'), null);
});
