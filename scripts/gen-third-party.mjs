#!/usr/bin/env node
// Writes docs/THIRD-PARTY.md: the third-party components the multi-harness work added, and everything they
// pull in at run time. Versions, licenses and the dependency closure come from package-lock.json; the short
// table of direct components carries what the lockfile cannot say (what it is for, where it ships, which
// license file was read). tests/thirdParty.test.ts fails when the file is stale or a license changed.
// It also writes build/THIRD_PARTY_NOTICES.md, the file that ships in the app (opened from Settings > About):
// the component list plus the full license and NOTICE texts of the Apache-2.0 packages, ripgrep and node-pty.
//   npm run third-party            write both files
//   npm run third-party -- --check exit 1 when either is stale
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thirdPartyFeatures, featureNoticeTexts } from './third-party-features.mjs';
const FEATURES = thirdPartyFeatures();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = path.join(ROOT, 'docs/THIRD-PARTY.md');
export const NOTICES_OUT = path.join(ROOT, 'build/THIRD_PARTY_NOTICES.md');

/** Whose license and NOTICE texts the shipped notices file carries in full. `dir` is the package folder (read for LICENSE and NOTICE). */
export const NOTICE_PACKAGES = [
  { title: '@playwright/mcp', key: 'node_modules/@playwright/mcp', license: 'Apache-2.0' },
  { title: 'playwright', key: 'node_modules/@playwright/mcp/node_modules/playwright', license: 'Apache-2.0' },
  { title: 'playwright-core', key: 'node_modules/@playwright/mcp/node_modules/playwright-core', license: 'Apache-2.0' },
  { title: '@vscode/ripgrep (the wrapper that downloads and bundles rg)', key: 'node_modules/@vscode/ripgrep', license: 'MIT' },
  { title: 'node-pty', key: 'node_modules/node-pty', license: 'MIT' },
];

/** The ripgrep program itself (BurntSushi/ripgrep, 15.x) is dual-licensed; its COPYING file points at these two texts. */
export const RIPGREP_LICENSES = `ripgrep (https://github.com/BurntSushi/ripgrep) is dual-licensed: you may use it under either the Unlicense or the MIT license, at your option.

### Unlicense

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute this software, either in source code form or as a compiled binary, for any purpose, commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this software dedicate any and all copyright interest in the software to the public domain. We make this dedication for the benefit of the public at large and to the detriment of our heirs and successors. We intend this dedication to be an overt act of relinquishment in perpetuity of all present and future rights to this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org/>

### MIT

Copyright (c) 2015 Andrew Gallant

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** The components added by this work. `license` is what the package's own license file says (read, not guessed); the test compares it with the lockfile. */
export const DIRECT = [
  {
    name: '@anthropic-ai/claude-agent-sdk',
    use: 'Runs Claude Code sessions (the Claude harness).',
    ships:
      "The JavaScript only. The per-platform Claude Code binaries it can carry are left out of the app; MoPilot always runs the user's own `claude`.",
    license:
      'Proprietary: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements" at https://code.claude.com/docs/en/legal-and-compliance (LICENSE.md in the package; the license field says "SEE LICENSE IN README.md")',
    lockLicense: 'SEE LICENSE IN README.md',
    url: 'https://github.com/anthropics/claude-agent-sdk-typescript',
  },
  {
    name: '@playwright/mcp',
    use: 'Browser control through "Your Chrome" (its --extension mode), run in a utility process.',
    ships: 'In the app (JavaScript), with playwright and playwright-core.',
    license: 'Apache-2.0 (LICENSE in the package)',
    lockLicense: 'Apache-2.0',
    url: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    name: 'playwright',
    key: 'node_modules/@playwright/mcp/node_modules/playwright',
    use: 'Pulled in by @playwright/mcp.',
    ships: 'In the app (JavaScript). Its LICENSE, NOTICE and ThirdPartyNotices.txt are in the package.',
    license: 'Apache-2.0 (LICENSE and NOTICE in the package)',
    lockLicense: 'Apache-2.0',
    url: 'https://github.com/microsoft/playwright',
  },
  {
    name: 'playwright-core',
    key: 'node_modules/@playwright/mcp/node_modules/playwright-core',
    use: 'Pulled in by @playwright/mcp.',
    ships: 'In the app (JavaScript). Its LICENSE, NOTICE and ThirdPartyNotices.txt are in the package.',
    license: 'Apache-2.0 (LICENSE and NOTICE in the package)',
    lockLicense: 'Apache-2.0',
    url: 'https://github.com/microsoft/playwright',
  },
  {
    name: '@vscode/ripgrep',
    use: 'File search in the app (bundled `rg`).',
    ships:
      'Only the platform package for the build (`@vscode/ripgrep-darwin-arm64`, `-darwin-x64`, `-win32-x64`), unpacked from the asar. The bundled binary reports ripgrep 15.0.0.',
    license:
      'MIT, Copyright (c) Microsoft Corporation (LICENSE in the package). The ripgrep program inside is BurntSushi/ripgrep, dual-licensed Unlicense or MIT at your option (COPYING in its repository)',
    lockLicense: 'MIT',
    url: 'https://github.com/microsoft/vscode-ripgrep',
  },
  {
    name: 'node-pty',
    use: 'The terminal panel runs on a local pty.',
    ships:
      "The prebuild for the build's platform and architecture, unpacked from the asar. The Windows build also carries the winpty files (MIT, Ryan Prichard, deps/winpty/LICENSE) and the ConPTY files node-pty bundles (conpty.dll, OpenConsole.exe); node-pty ships no separate license file for the ConPTY files, and Windows Terminal, where they come from, is MIT.",
    license:
      'MIT (LICENSE in the package holds the notices for pty.js and node-pty: Christopher Jeffrey, Daniel Imms, Microsoft Corporation)',
    lockLicense: 'MIT',
    url: 'https://github.com/microsoft/node-pty',
  },
  {
    name: 'zod',
    use: "Schemas for MoPilot's tools in Claude sessions, and a peer dependency of the Agent SDK.",
    ships: 'In the app (JavaScript).',
    license: 'MIT (LICENSE in the package)',
    lockLicense: 'MIT',
    url: 'https://github.com/colinhacks/zod',
  },
  {
    name: '@electron/fuses',
    use: 'Turns Electron fuses off or on when the app is packaged (scripts/package.mjs, scripts/check-fuses.mjs).',
    ships: 'Not shipped: a build-time dependency only.',
    license: 'MIT (LICENSE in the package)',
    lockLicense: 'MIT',
    url: 'https://github.com/electron/fuses',
  },
  ...FEATURES.flatMap((feature) => feature.direct),
];

export const NOT_USED = [
  '`@agentclientprotocol/sdk`: the ACP client for the basic tier is written in this repository (`electron/harness/acp.cjs`).',
  "`cua-driver`, its npm SDK and `cua-perception`: not used. Computer control is MoPilot's own Swift helper (`native/helper`).",
  '`chrome-devtools-mcp`: not used. Browser control goes through `@playwright/mcp`.',
  '`@electron/rebuild`: not needed; node-pty ships N-API prebuilds.',
];

/** Files copied into this repository from another project: what, from where, and the license text that goes with them. */
export const COPIED = [
  {
    name: 'Lobe Icons (@lobehub/icons-static-svg 1.95.1)',
    what: "The basic harnesses' marks (`src/components/harnessPicker/logos.ts`): the SVG path data of 22 icons (Qoder and Qoder CN share one). Each mark is its vendor's trademark, shown only to name that agent.",
    license: 'MIT, Copyright (c) 2023 LobeHub (LICENSE in the upstream repository)',
    url: 'https://github.com/lobehub/lobe-icons',
    text: `MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  },
  {
    name: 'Vendor marks for Auggie, Autohand, Droid, oh-my-pi and Prime Agent',
    what: "Path data in `src/components/harnessPicker/logos.ts`, fitted from each vendor's own SVG where Lobe Icons has none: Augment Code's (augmentcode.com/favicon.svg), Autohand's (code-cli `assets/autohand-mark.svg`), Factory's (Factory-AI/factory `docs/favicon.svg`), oh-my-pi's (`packages/collab-web/public/favicon.svg`) and Prime Intellect's (the docs.primeintellect.ai favicon). Each mark is its vendor's trademark, shown only to name that agent.",
    license:
      'Trademarks of their owners; the Autohand and oh-my-pi files come from Apache-2.0 and MIT repositories (their license texts are below)',
    url: 'https://github.com/autohandai/code-cli, https://github.com/can1357/oh-my-pi',
  },
];

export const OWN_CODE = [
  '`native/helper` (MoPilot.app), `native/sage-mcp`, `native/auth-command` and `native/disclaim` are written in this repository and have no third-party Swift packages. `disclaim` calls a private libSystem symbol and contains no code from another project.',
];

export const USER_INSTALLED = [
  'The harness CLIs and ACP servers (Codex, Claude Code, Antigravity, dsh, opencode, Kimi Code, Qwen Code, Copilot, Cursor, Gemini, Goose and the native ACP agents in docs/native-acp-harnesses.md) are installed by the user and run under their own licenses and terms. MoPilot does not distribute them.',
  'The Playwright Extension that "Your Chrome" talks to is installed by the user from the Chrome Web Store; it is not part of the app.',
];

const lock = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')).packages;

/** Resolve a dependency name the way node does: nested node_modules first, then up the tree. */
function resolveDep(packages, from, name) {
  let base = from;
  for (;;) {
    const key = `${base}${base ? '/' : ''}node_modules/${name}`;
    if (packages[key]) return key;
    if (!base) return null;
    const i = base.lastIndexOf('/node_modules/');
    base = i < 0 ? '' : base.slice(0, i);
  }
}

/** Everything the given roots need at run time: dependencies, optional dependencies (as far as the lockfile lists them) and peers. */
export function closure(packages, roots, includeDev = false) {
  const seen = new Set();
  const todo = roots.map((r) => resolveDep(packages, '', r)).filter(Boolean);
  while (todo.length) {
    const key = todo.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const p = packages[key];
    for (const group of [p.dependencies, p.optionalDependencies, p.peerDependencies]) {
      for (const dep of Object.keys(group ?? {})) {
        const k = resolveDep(packages, key, dep);
        if (k && (includeDev || !packages[k].dev)) todo.push(k);
      }
    }
  }
  return [...seen].map((key) => ({ key, name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length), ...packages[key] }));
}

const esc = (s) => String(s).replace(/\|/g, '\\|');

export function build(packages = lock()) {
  const direct = DIRECT.map((d) => {
    const p = packages[d.key ?? `node_modules/${d.name}`];
    if (!p) throw new Error(`${d.name} is not in package-lock.json`);
    return { ...d, version: p.version, lock: p.license };
  });
  const runtimeRoots = ['@anthropic-ai/claude-agent-sdk', '@playwright/mcp', '@vscode/ripgrep', 'node-pty', 'zod'];
  const directKeys = new Set(DIRECT.map((d) => d.key ?? `node_modules/${d.name}`));
  const included = new Map(
    [
      ...closure(packages, runtimeRoots),
      ...closure(
        packages,
        FEATURES.flatMap((feature) => feature.runtimeRoots),
        true,
      ),
    ].map((p) => [p.key, p]),
  );
  const rest = [...included.values()]
    .filter((p) => !directKeys.has(p.key))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  const L = [];
  L.push('<!-- Generated by scripts/gen-third-party.mjs (npm run third-party) from package-lock.json. Do not edit by hand. -->', '');
  L.push('# Third-party components', '');
  L.push(
    'The third-party components added with the multi-harness work and feature-owned notices, with the license each one carries. Versions and licenses of npm packages are read from `package-lock.json`; license texts come from the installed packages or the indicated upstream source. Earlier components such as React, Vite and Electron are not repeated here.',
    '',
  );
  L.push('## Added components', '');
  L.push('| Component | Version | License | What it is for | What ships | Source |', '| --- | --- | --- | --- | --- | --- |');
  for (const d of direct) L.push(`| \`${d.name}\` | ${d.version} | ${esc(d.license)} | ${esc(d.use)} | ${esc(d.ships)} | ${d.url} |`);
  L.push('', '## Copied into this repository', '');
  L.push('| Component | License | What it is for | Source |', '| --- | --- | --- | --- |');
  for (const c of COPIED) L.push(`| ${esc(c.name)} | ${esc(c.license)} | ${esc(c.what)} | ${c.url} |`);
  L.push('', '## Not used', '');
  for (const t of NOT_USED) L.push(`- ${t}`);
  L.push('', '## Written in this repository', '');
  for (const t of OWN_CODE) L.push(`- ${t}`);
  L.push('', '## Installed by the user, not shipped', '');
  for (const t of USER_INSTALLED) L.push(`- ${t}`);
  L.push('', '## What the added packages pull in', '');
  L.push(
    'Runtime dependencies of the core components and the feature-owned roots, from the lockfile. Feature metadata includes renderer dependencies that ship in the JavaScript bundle even when they are development dependencies in the build project. Platform packages left out of another platform build are listed too. License is each package’s `license` field.',
    '',
  );
  L.push('| Package | Version | License |', '| --- | --- | --- |');
  for (const p of rest)
    L.push(`| [\`${p.name}\`](https://www.npmjs.com/package/${p.name}) | ${p.version} | ${esc(p.license ?? 'not stated')} |`);
  L.push('');
  return { text: L.join('\n'), direct, rest };
}

const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd() : null);

/** build/THIRD_PARTY_NOTICES.md: what ships, with the full license and NOTICE texts read from the installed packages. */
export function buildNotices({
  packages = lock(),
  root = ROOT,
  notices = NOTICE_PACKAGES,
  featureNotices = FEATURES.flatMap((feature) => feature.notices),
} = {}) {
  const { direct, rest } = build(packages);
  const L = [];
  L.push(
    '<!-- Generated by scripts/gen-third-party.mjs (npm run third-party) from package-lock.json and the installed packages. Do not edit by hand. -->',
    '',
  );
  L.push('# Third-party notices', '');
  L.push(
    'MoPilot includes the third-party software listed here. Each component is used under its own license; the full license texts of the components that require them follow the lists.',
    '',
  );
  L.push('## Components', '');
  L.push('| Component | Version | License | Source |', '| --- | --- | --- | --- |');
  for (const d of direct) L.push(`| \`${d.name}\` | ${d.version} | ${esc(d.lockLicense)} | ${d.url} |`);
  L.push('', '## Packages these components pull in', '');
  L.push('| Package | Version | License |', '| --- | --- | --- |');
  for (const p of rest) L.push(`| \`${p.name}\` | ${p.version} | ${esc(p.license ?? 'not stated')} |`);
  L.push('', '## Copied into the app', '');
  L.push('| Component | License | Source |', '| --- | --- | --- |');
  for (const c of COPIED) L.push(`| ${esc(c.name)} | ${esc(c.license)} | ${c.url} |`);
  L.push('', '## License and NOTICE texts', '');
  for (const c of COPIED) if (c.text) L.push(`### ${c.name} (MIT)`, '', '#### LICENSE', '', '```text', c.text, '```', '');
  for (const n of notices) {
    const p = packages[n.key];
    if (!p) throw new Error(`${n.key} is not in package-lock.json`);
    const license = readText(path.join(root, n.key, 'LICENSE'));
    if (!license) throw new Error(`${n.key} has no LICENSE file`);
    L.push(`### ${n.title} ${p.version} (${n.license})`, '', '#### LICENSE', '', '```text', license, '```', '');
    const notice = readText(path.join(root, n.key, 'NOTICE'));
    if (notice) L.push('#### NOTICE', '', '```text', notice, '```', '');
    if (n.title.startsWith('@vscode/ripgrep')) L.push('#### The ripgrep program', '', RIPGREP_LICENSES, '');
  }
  L.push(...featureNoticeTexts(root, featureNotices));
  return L.join('\n');
}

/** The command line: writes both files, or with --check returns 1 when either is stale. Returns the exit code. */
export function main(
  argv,
  {
    files = () => [
      [OUT, 'docs/THIRD-PARTY.md', build().text],
      [NOTICES_OUT, 'build/THIRD_PARTY_NOTICES.md', buildNotices()],
    ],
    fsx = fs,
    log = console.log,
    error = console.error,
  } = {},
) {
  const outputs = files();
  if (argv.includes('--check')) {
    for (const [file, name, text] of outputs) {
      if (!fsx.existsSync(file) || fsx.readFileSync(file, 'utf8') !== text) {
        error(`${name} is stale; run npm run third-party`);
        return 1;
      }
    }
    return 0;
  }
  for (const [file, name, text] of outputs) {
    fsx.writeFileSync(file, text);
    log(name);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
