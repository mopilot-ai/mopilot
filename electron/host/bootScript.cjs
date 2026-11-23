// The install script Add by command serves (#2709): a POSIX shell script that a far machine runs with `curl … | sh -s -- <code>`.
// It does what the SSH installer does (install.cjs, installRuntime.cjs, with the same commands, so a machine added either way has
// the same files): checks the system, puts MoPilot's pinned Node under ~/.mopilot-host (SHA-256 checked), downloads the app's own
// Host bundle for the machine's core build through the relay (checked against the hash written here), unpacks it, joins the app (`mopilot-host enroll`, the
// one-time code handed over on standard input by the shell's own printf, never echoed or written to a file), then writes and
// starts the service. Every failure is one line saying why.
const { nodeBuild } = require('./nodeRuntime.cjs');
const { runtimeCommands, HOST_NODE } = require('./installRuntime.cjs');
const { bundleCommands, startCommand, BUNDLE_BIN } = require('./install.cjs');
const { coreProbeCommand } = require('../../shared/host/coreBuild.mjs');

/** The systems the script installs on: what `uname -sm` prints, as nodeRuntime.cjs names them. */
const UNAMES = ['Darwin arm64', 'Darwin x86_64', 'Linux x86_64', 'Linux aarch64', 'Linux arm64'];

/** @param {string} s */
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * @param {object} o
 * @param {string} o.bundleUrl where the bundles are fetched (the relay's boot path; a build's is `<bundleUrl>/<build>`)
 * @param {Record<string, string>} o.bundles each core build's SHA-256: the script is made before the machine is known
 * @param {{ relayUrl: string, hostId: string, secret: string, pairId: string }} o.enrollment what `enroll` is given, less the code
 * @param {string | null} [o.updateKeyPem] the app's key the Host takes updates from
 * @param {string | null} [o.reportUrl] where a failure is reported before the script exits (`<url>/<code>`, GET, best effort): the card then says why
 * @returns {string}
 */
function bootScript({ bundleUrl, bundles, enrollment, updateKeyPem = null, reportUrl = null }) {
  const runtimes = UNAMES.map((uname) => {
    const build = /** @type {NonNullable<ReturnType<typeof nodeBuild>>} */ (nodeBuild(uname));
    const c = runtimeCommands(build);
    return `  ${quote(uname)}) node_have() { ${c.have}; }; node_get() { ${c.download}; }; node_place() { ${c.place}; } ;;`;
  });
  const builds = Object.entries(bundles).map(([build, sha]) => {
    const b = bundleCommands(sha);
    const get = `mkdir -p "$HOME/.mopilot-host/incoming" && curl -fsSL --max-time 300 -o "${b.file}" ${quote(`${bundleUrl}/${build}`)}`;
    return `  ${build}) bundle_get() { ${get}; }; bundle_verify() { ${b.verify}; }; bundle_unpack() { ${b.unpack}; } ;;`;
  });
  const cli = `"${HOST_NODE}" "${BUNDLE_BIN}"`;
  // the code is the script's first argument; JSON-safe by its alphabet (base64url), checked before it is used
  const input = JSON.stringify(enrollment).replace(/%/g, '%%').replace(/}$/, ',"code":"%s"}');
  const body = [
    `code="\${1:-}"`,
    `case "$code" in ''|*[!A-Za-z0-9_-]*) fail usage 'Run the whole command MoPilot showed, with the code at its end.' ;; esac`,
    `[ "\${#code}" -eq 22 ] || fail usage 'Run the whole command MoPilot showed, with the code at its end.'`,
    `command -v tar >/dev/null 2>&1 || fail tar 'This machine needs tar.'`,
    `command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || fail sha 'This machine needs sha256sum or shasum.'`,
    `uname_sm="$(uname -sm)"`,
    'case "$uname_sm" in',
    ...runtimes,
    `  *) fail os "MoPilot runs on macOS and Linux (64-bit Intel or ARM); this machine is $uname_sm." ;;`,
    'esac',
    `echo 'MoPilot: getting Node…' >&2`,
    `if [ "$(node_have)" != have ]; then node_get || fail node_download 'Could not download Node for this machine.'; [ "$(node_place)" = placed ] || fail node_run 'The Node MoPilot brings does not run on this machine.'; fi`,
    `build="$(${coreProbeCommand(`"${HOST_NODE}"`)} </dev/null 2>/dev/null)"`,
    'case "$build" in',
    ...builds,
    `  *) fail no_build "MoPilot has no Host build for this machine ($build)." ;;`,
    'esac',
    `echo 'MoPilot: getting the Host…' >&2`,
    `bundle_get || fail download 'Could not download the Host from MoPilot. Keep MoPilot open on your Mac and run the command again.'`,
    `(bundle_verify) >/dev/null || fail checksum 'The Host download does not match its checksum.'`,
    `(bundle_unpack) >/dev/null || fail unpack 'The Host could not be unpacked.'`,
    `echo 'MoPilot: joining your Mac…' >&2`,
    `printf ${quote(`${input}\\n`)} "$code" | ${cli} enroll || exit 1`,
    `${cli} install </dev/null >/dev/null || fail service 'The Host service could not be written.'`,
    ...(updateKeyPem
      ? [
          `printf '%s' ${quote(updateKeyPem)} | ${cli} trust-update-key >/dev/null || fail update_key 'The Host could not keep this app as its update source.'`,
        ]
      : []),
    `os="$(uname -s)"`,
    `if [ "$os" = Darwin ]; then ${startCommand('Darwin')}; else ${startCommand('Linux')}; fi >/dev/null 2>&1 || fail start 'The Host service could not be started.'`,
    `echo 'MoPilot: this machine is ready. Go back to MoPilot on your Mac.' >&2`,
  ];
  const report = reportUrl ? `curl -fsS --max-time 10 -o /dev/null ${quote(`${reportUrl}/`)}"$1" </dev/null >/dev/null 2>&1; ` : '';
  // all of it in one function called on the last line: `sh` reads a piped script as it runs, so without it a command that reads
  // standard input would eat the rest of the script, and a download cut short would run half of it
  return [
    '#!/bin/sh',
    '# MoPilot Host installer (Add by command). It installs into ~/.mopilot-host for this user only and needs no root.',
    'set -u',
    // `fail <code> <line>`: the line on this terminal, the code to the relay (so the app's card says why), then stop
    `fail() { echo "MoPilot: $2" >&2; ${report}exit 1; }`,
    'mopilot_install() {',
    ...body.map((l) => `  ${l}`),
    '}',
    'mopilot_install "$@"',
    '',
  ].join('\n');
}

/**
 * The line the user runs on the far machine. The script comes through the relay, so the line carries its SHA-256 and runs it only when
 * it matches: a relay that served anything else runs nothing. What did not match is shown, never run: the relay's own one-line answer
 * (the app is away, the command was used) is a script that only prints `MoPilot: …`, and that text is all that is shown of it.
 * @param {{ scriptUrl: string, scriptSha256: string, code: string }} o
 */
function bootCommand({ scriptUrl, scriptSha256, code }) {
  return (
    `f=$(mktemp) && curl -fsSL ${quote(scriptUrl)} -o "$f"; ` +
    `if (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | grep -q '^${scriptSha256} '; then sh "$f" ${code}; r=$?; ` +
    `else grep -o "MoPilot: [^']*" "$f" >&2 || echo 'MoPilot: the installer could not be checked. Run the command again.' >&2; r=1; fi; rm -f "$f"; [ "$r" = 0 ]`
  );
}

module.exports = { bootScript, bootCommand, UNAMES };
