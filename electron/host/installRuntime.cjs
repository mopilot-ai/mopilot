// The Node step of adding a machine: MoPilot's pinned Node put under ~/.mopilot-host/runtime (kept from before, uploaded from this Mac's cache, or downloaded on the machine), or the machine's own Node 22+ where the official build cannot run; `runtime/current` points at the one the Host runs on.
const { userError } = require('../../shared/userError.mjs');
const { nodeBuild } = require('./nodeRuntime.cjs');

const RUNTIME = '$HOME/.mopilot-host/runtime';
/** The node the Host runs on, once this step passed. */
const HOST_NODE = `${RUNTIME}/current/bin/node`;
/** The oldest Node of the machine's own the Host runs on (host/package.json engines). */
const NODE_MAJOR = 22;

/** The commands that check, bring and place one build on the machine. @param {NonNullable<ReturnType<typeof nodeBuild>>} build */
function runtimeCommands(build) {
  const dir = `${RUNTIME}/${build.name}`;
  const file = `${RUNTIME}/incoming/${build.file}`;
  const current = `${RUNTIME}/current`;
  const runs = `"${dir}/bin/node" --version 2>/dev/null | grep -qx '${build.version}'`;
  return {
    have: `if ${runs}; then ln -sfn "${dir}" "${current}" && echo have; else echo need; fi`,
    upload: `mkdir -p "${RUNTIME}/incoming" && cat > "${file}"`,
    download:
      `mkdir -p "${RUNTIME}/incoming" && { curl -fsSL --max-time 110 -o "${file}" '${build.url}' 2>/dev/null || wget -q -T 110 -O "${file}" '${build.url}' 2>/dev/null; } ` +
      `|| { rm -f "${file}"; echo 'The machine could not download ${build.url} (no curl or wget, or no internet).' >&2; exit 1; }`,
    place:
      `h=$( (sha256sum "${file}" 2>/dev/null || shasum -a 256 "${file}") | cut -d' ' -f1 ); ` +
      `if [ "$h" != "${build.sha256}" ]; then rm -f "${file}"; echo 'The Node archive on the machine does not match its checksum.' >&2; exit 1; fi; ` +
      `rm -rf "${dir}.tmp" && mkdir -p "${dir}.tmp" && tar -xzf "${file}" --no-same-owner -C "${dir}.tmp" && rm -rf "${dir}" && mv "${dir}.tmp/${build.name}" "${dir}" && rm -rf "${dir}.tmp" "${file}" ` +
      `|| { rm -rf "${dir}.tmp" "${file}"; exit 1; }; ` +
      `if ${runs}; then ln -sfn "${dir}" "${current}" && echo placed; else echo cannot-run; fi`,
    // the login shell's PATH, where a Node installed by Homebrew, nvm and the like is found
    system:
      `n=$("\${SHELL:-/bin/sh}" -lic 'command -v node' 2>/dev/null | tail -n 1); ` +
      `m=$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null); ` +
      `if [ -n "$n" ] && [ "\${m:-0}" -ge ${NODE_MAJOR} ] 2>/dev/null; then mkdir -p "${RUNTIME}/system/bin" && ln -sfn "$n" "${RUNTIME}/system/bin/node" && ln -sfn "${RUNTIME}/system" "${current}" && "$n" --version; else exit 1; fi`,
  };
}

/**
 * Put the Host's Node on the machine. Never rejects.
 * @param {object} o
 * @param {(command: string, input?: Buffer) => Promise<{ code: number, stdout: string, stderr: string }>} o.run one command on the machine
 * @param {string} o.uname what `uname -sm` printed there
 * @param {{ get: (build: NonNullable<ReturnType<typeof nodeBuild>>) => Promise<Buffer> } | null} o.cache this Mac's copy of the builds (nodeRuntime.cjs), or none
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
async function setUpNode({ run, uname, cache }) {
  const build = nodeBuild(uname);
  if (!build) return { ok: false, output: `MoPilot needs a 64-bit Intel or ARM machine; this one is ${uname.trim()}.` };
  const c = runtimeCommands(build);
  /** @param {{ code: number, stdout: string, stderr: string }} r */
  const said = (r) => [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  if (/^have$/m.test((await run(c.have)).stdout)) return { ok: true, output: `Node ${build.version}, already on the machine` };

  let how = '';
  let why = '';
  /** @type {{ code: number, stdout: string, stderr: string } | null} */
  let placed = null;
  if (cache) {
    try {
      const bytes = await cache.get(build);
      const up = await run(c.upload, bytes);
      // an upload damaged on the way fails the machine's checksum; the machine's own download is the next try
      const unpacked = up.code === 0 ? await run(c.place) : up;
      if (unpacked.code === 0) {
        placed = unpacked;
        how = `uploaded from this Mac (${Math.ceil(bytes.length / (1024 * 1024))} MB)`;
      } else why = said(unpacked);
    } catch (e) {
      why = userError(e);
    }
  }
  if (!placed) {
    const down = await run(c.download);
    if (down.code !== 0)
      return {
        ok: false,
        output: `Neither this Mac nor the machine could get Node ${build.version}.\n${[why, said(down)].filter(Boolean).join('\n')}`,
      };
    placed = await run(c.place);
    if (placed.code !== 0) return { ok: false, output: said(placed) || `Node ${build.version} could not be unpacked on the machine.` };
    how = 'downloaded on the machine';
  }
  if (/^placed$/m.test(placed.stdout)) return { ok: true, output: `Node ${build.version}, ${how}` };

  // an official build that does not start (Linux older than glibc 2.28, or musl): the machine's own Node is the fallback
  const own = await run(c.system);
  if (own.code === 0) return { ok: true, output: `Node ${build.version} does not run here; using the machine's Node ${own.stdout.trim()}` };
  return {
    ok: false,
    output: `Node ${build.version} does not run on this machine (Linux needs glibc 2.28 or newer), and it has no Node ${NODE_MAJOR} or newer of its own.`,
  };
}

module.exports = { setUpNode, runtimeCommands, HOST_NODE };
