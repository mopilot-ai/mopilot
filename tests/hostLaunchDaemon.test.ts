// Keep running after restart on a Mac (shared/host/launchDaemon.mjs, shared/host/launchd.mjs): what the Host reports is checked before it reaches a root shell, the plist runs the Host as the user at boot, and the root scripts set that user themselves, load and unload the daemon, and paste as one command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import {
  DAEMON_PLIST,
  parseDaemonInfo,
  renderDaemonPlist,
  sudoCommand,
  turnOffScript,
  turnOnScript,
} from '../shared/host/launchDaemon.mjs';
// @ts-ignore: plain ESM without declarations
import { launchdStart } from '../shared/host/launchd.mjs';

const info = {
  user: 'jane',
  home: '/Users/jane',
  node: '/Users/jane/.mopilot-host/runtime/current/bin/node',
  bin: '/Users/jane/.mopilot-host/current/host/bin/mopilot-host.mjs',
  dataDir: '/Users/jane/Library/Application Support/mopilot-host',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
};

test('what the Host reports is taken only when it names a user other than root and absolute one-line paths', () => {
  assert.deepEqual(parseDaemonInfo(`${JSON.stringify(info)}\n`), info);
  // extra keys from a newer Host are dropped, never passed on
  assert.deepEqual(parseDaemonInfo(JSON.stringify({ ...info, extra: 1 })), info);
  // an empty PATH is allowed (the plist then sets none)
  assert.deepEqual(parseDaemonInfo(JSON.stringify({ ...info, path: '' })), { ...info, path: '' });
  for (const bad of [
    'not json',
    'null',
    '"text"',
    JSON.stringify({ ...info, user: 'root' }),
    JSON.stringify({ ...info, user: "jane'; rm -rf /" }),
    JSON.stringify({ ...info, user: 7 }),
    JSON.stringify({ ...info, home: 'Users/jane' }),
    JSON.stringify({ ...info, node: '/n\n<key>UserName</key>' }),
    JSON.stringify({ ...info, bin: 42 }),
    JSON.stringify({ ...info, dataDir: `/${'d'.repeat(1100)}` }),
    JSON.stringify({ ...info, path: 'a\nb' }),
    JSON.stringify({ ...info, path: 5 }),
    JSON.stringify({ ...info, path: 'p'.repeat(9000) }),
  ])
    assert.equal(parseDaemonInfo(bad), null, bad.slice(0, 60));
});

test('the plist runs the Host as the user at boot, kept alive, logging next to its data, with markup in values escaped', () => {
  const plist = renderDaemonPlist({ ...info, dataDir: '/Users/jane/A&B <data>' });
  assert.match(plist, /<key>Label<\/key><string>ai\.mopilot\.host<\/string>/);
  assert.match(plist, /<key>UserName<\/key><string>jane<\/string>/);
  assert.match(plist, /<key>MOPILOT_HOST_SUPERVISED<\/key><string>system<\/string>/);
  assert.match(plist, /<key>HOME<\/key><string>\/Users\/jane<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>\s*<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<string>serve<\/string>\s*<string>--data-dir<\/string>\s*<string>\/Users\/jane\/A&amp;B &lt;data&gt;<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key><string>\/Users\/jane\/A&amp;B &lt;data&gt;\/host\.log<\/string>/);
  // no GroupName: launchd takes the user's own group
  assert.doesNotMatch(plist, /GroupName/);
  assert.doesNotMatch(renderDaemonPlist({ ...info, path: '' }), /<key>PATH<\/key>/);
});

test('turning on as root: the user is set by the script, never root, the agent and any older daemon unloaded, then the daemon loaded', () => {
  const plist = renderDaemonPlist(info);
  const script = turnOnScript({ plist, user: 'jane', sameUser: true });
  // the plist travels as base64 of exactly what was rendered
  const b64 = /printf %s '([A-Za-z0-9+/=]+)'/.exec(script)?.[1] as string;
  assert.equal(Buffer.from(b64, 'base64').toString('utf8'), plist);
  assert.match(script, /^U='jane'$/m);
  assert.match(script, /\[ "\$uid" -gt 0 \] \|\| exit 3/);
  // over ssh only the user who ran sudo may be the one it runs as
  assert.match(script, /\[ "\$SUDO_USER" = "\$U" \] \|\| exit 3/);
  assert.match(script, /\/usr\/bin\/plutil -replace UserName -string "\$U" "\$t"/);
  assert.match(script, /\/usr\/bin\/plutil -remove GroupName/);
  assert.match(script, /\/usr\/sbin\/chown root:wheel "\$t" && \/bin\/chmod 644 "\$t"/);
  assert.match(script, /bootout system\/ai\.mopilot\.host.*bootout gui\/\$uid\/ai\.mopilot\.host.*bootout user\/\$uid\/ai\.mopilot\.host/);
  assert.ok(script.endsWith(`/bin/mv -f "$t" ${DAEMON_PLIST} && /bin/launchctl bootstrap system ${DAEMON_PLIST} && echo turned-on`));
  // only system tools by absolute path run as root: nothing from the user's home
  assert.doesNotMatch(script, /mopilot-host\.mjs|\.mopilot-host/);
  // a command copied for an administrator leaves the same-user check out
  assert.doesNotMatch(turnOnScript({ plist, user: 'jane', sameUser: false }), /SUDO_USER/);
  for (const user of ['root', "ja'ne", '', '-x'])
    assert.throws(() => turnOnScript({ plist, user, sameUser: true }), /cannot run the Host/, user);
});

test('turning off as root unloads the daemon and removes its plist', () => {
  const script = turnOffScript();
  assert.match(script, /\/bin\/launchctl bootout system\/ai\.mopilot\.host/);
  assert.ok(script.endsWith(`/bin/rm -f ${DAEMON_PLIST} && echo turned-off`));
});

test('a root script pastes as one line, its quotes kept for the shell', () => {
  assert.equal(sudoCommand("a 'b'\nc"), `sudo /bin/sh -c 'a '\\''b'\\''; c'`);
  const line = sudoCommand(turnOnScript({ plist: renderDaemonPlist(info), user: 'jane', sameUser: false }));
  assert.ok(!line.includes('\n'));
  assert.ok(line.startsWith("sudo /bin/sh -c '"));
});

test('starting the Host on a Mac that runs it as a system daemon restarts that Host instead of loading an agent beside it', () => {
  const start = launchdStart('"$HOME/Library/LaunchAgents/ai.mopilot.host.plist"');
  assert.match(
    start,
    new RegExp(`^if \\[ -f ${DAEMON_PLIST.replace(/\./g, '\\.')} \\]; then pkill -TERM -U "\\$\\(id -u\\)" -f 'mopilot-host\\.mjs serve'`),
  );
  assert.match(
    start,
    /else U=\$\(id -u\); D=gui\/\$U;.*launchctl bootstrap "\$D" "\$HOME\/Library\/LaunchAgents\/ai\.mopilot\.host\.plist" && launchctl kickstart -k "\$D\/ai\.mopilot\.host" \|\| \{ case "\$D" in user\/\*\) echo .*; false; \}; fi$/,
  );
});
