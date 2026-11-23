#!/usr/bin/env node
// Generates the two harness matrices from data, never by hand:
//   docs/harness-matrix.md           what a reader of the repo sees
//   src/harness/matrix.generated.json  what the harness pages and Copy diagnostics (Settings → About) read
// Inputs: the registry (src/harness/registry.ts), the bindings per semantic (electron/harness/bindings.cjs
// resolved the way shared/caps.mjs does), the conformance results (conformance/results/<kind>@<version>.json)
// the basic-tier admission results (tests/conformance/results/acp-admission.json) and the harness version contract
// runs (tests/conformance/results/contract/<kind>@<version>.json, bench/README.md#harness-version-contract) with what
// each failing item means in plain words (tests/conformance/results/contract-findings.json).
//   npm run harness-matrix            write both files
//   npm run harness-matrix -- --check exit 1 when a committed file is stale (tests/harnessMatrix.test.ts does the same)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadAdmission } from './harness-admission-records.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_MD = path.join(ROOT, 'docs/harness-matrix.md');
export const OUT_JSON = path.join(ROOT, 'src/harness/matrix.generated.json');
const RESULTS_DIR = path.join(ROOT, 'conformance/results');
const CONTRACT_DIR = path.join(ROOT, 'tests/conformance/results/contract');
const FINDINGS_FILE = path.join(ROOT, 'tests/conformance/results/contract-findings.json');

// the TypeScript sources import each other without extensions
export function resolveTs(specifier, context, next) {
  try {
    return next(specifier, context);
  } catch (e) {
    if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(specifier + '.ts', context);
    throw e;
  }
}
registerHooks({ resolve: resolveTs });
const require = createRequire(import.meta.url);

/** Which conformance checks back each semantic, per first-class harness. Every id must exist in the results (the test checks). */
export const CHECKS_FOR = {
  codex: {
    goal: ['X2'],
    plan: ['X3'],
    review: ['X4'],
    compact: ['X5'],
    shell: ['X6'],
    tasks: ['X10'],
    rename: ['X8'],
    fork: ['X8'],
    rewind: ['X8'],
    archive: ['X8'],
    search: ['X8'],
    model: ['X1'],
    effort: ['X1'],
    speed: ['X1'],
    skills: ['X11'],
    mcp: ['X11'],
    status: ['X11'],
    feedback: ['X11'],
    textGen: ['X9'],
    computerUse: ['X7', 'X12', 'X14'],
    browser: ['X7', 'X14'],
  },
  claude: {
    goal: ['C4', 'C17', 'C18'],
    plan: ['C7'],
    review: ['C13'],
    init: ['C13'],
    compact: ['C12'],
    multiAgent: ['C6'],
    deepReasoning: ['C5'],
    tasks: ['C8'],
    temporary: ['C10'],
    skills: ['C3'],
    workflows: ['C3'],
    rename: ['C14'],
    fork: ['C14'],
    rewind: ['C14'],
    mcp: ['C14'],
    status: ['C14'],
    textGen: ['C1', 'C2'],
    computerUse: ['C9', 'C16'],
    browser: ['C9', 'C16'],
  },
};

/** Contract of the basic tier (design basicTierContract), in the words Settings uses. */
export const BASIC_CONTRACT = {
  admission: [
    'The harness is found on your PATH and its quirks file declares privacy defaults and an admission check.',
    'The privacy check the quirks declare passes before the harness starts (dsh: --dump-config shows its session log is off).',
    'initialize succeeds (ACP v1).',
    'session/new with the MoPilot tool server succeeds and the server says hello within 10 seconds.',
    'Anything else keeps the harness out of the picker, and Settings says "Installed · Can\'t run in MoPilot" with the reason.',
  ],
  guaranteed: [
    "Sign-in through the harness's own methods, in a terminal inside Settings when it needs one.",
    'New chats in a local folder or a worktree; text and image prompts (images when the harness accepts them); streamed messages, thinking, tool calls and diffs.',
    "Approvals: the harness's own options on one common card; MoPilot's own tools are allowed once per action.",
    'Stop, and Esc, send session/cancel.',
    'Reopening a chat after a restart shows the full history and can carry on.',
    'Computer use and browser control, with the same tools, approval card, no-go list, takeover rules and Esc stop as the first-class harnesses.',
    "MoPilot's plugins: their MCP servers in session/new (local ones unless its quirks refuse them, remote ones when the harness advertises http or sse), and their skills and commands in the / menu and over plugin_skills. Their hooks, agents and app connectors don't run.",
    'Title, rename, archive, pin, unread, project, search, export and copy session ID; terminal panel, @ files, Files panel, instruction file editor, notifications.',
    "The harness's default uploads and telemetry are switched off at launch and checked first.",
  ],
  ifDeclared: [
    "The harness's own slash commands pass through as typed (goal, review, init, compact, skills and so on) once it lists them.",
    'Plan chip: only when its quirks mark which mode or option is plan.',
    "Modes and permissions under the harness's own names; model and thinking-level options as generic controls.",
    'Fork from a message when the harness can fork; the context ring when it reports usage; Copy resume command when its quirks provide it.',
  ],
  notProvided: [
    'MoPilot does not fill in goal, plan, review, init, compact, ! shell, one-turn deeper thinking or speed tiers.',
    'No goal bar, task panel, temporary chats, hand-over between harnesses (new chat with a summary only), rewind or message editing.',
    'No managed providers, keys, MoPilot credits, multiple accounts, account switching or usage bars.',
    'No Extensions, MCP or Skills pages of their own: plugins come from the shared Plugins page, and scheduled tasks run on it through MoPilot.',
    'MoPilot does not ship or pin the harness: you install it, and its own terminal chats show in the sidebar.',
  ],
};

const SOURCE_NOTES = [
  "Browser and computer control work for every harness. Codex threads use Codex's own Browser and Computer use (the bundled unified-computer-use plugin), and Claude Code sessions on a claude.ai subscription start with --chrome (Claude in Chrome), each with its own approvals, but only where that vendor runtime is installed on this Mac; MoPilot then hides its own equivalent tools. Everywhere else (managed and helper Codex threads, other Claude logins with --no-chrome, a missing runtime, basic-tier harnesses) MoPilot's own browser_* and desktop_* tools are the fallback. The user is never asked to open the ChatGPT or Claude desktop apps.",
  "A Codex user's own node_repl or connector tools can still appear in a Codex thread; the helper's event tap covers them.",
  "Plugins are installed once, in MoPilot's store (~/.mopilot/plugins), and reach each harness in its own form: Claude Code loads each plugin folder through the Agent SDK (a CLI without --plugin-dir gets their skills over plugin_skills instead), Codex installs them from MoPilot's own marketplaces (also seen by its app and CLI), and basic-tier harnesses get their MCP servers and, from MoPilot, their skills and commands. A plugin a harness already turns on itself is left to it.",
];

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** The conformance result files, by kind. File names are <kind>@<version>.json. */
export function loadResults(dir = RESULTS_DIR) {
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const m = /^(\w+)@(.+)\.json$/.exec(f);
    if (!m) continue;
    const d = readJson(path.join(dir, f));
    const counts = {};
    for (const c of d.checks) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;
    out.push({
      kind: m[1],
      version: m[2],
      file: `conformance/results/${f}`,
      date: String(d.updatedAt ?? '').slice(0, 10),
      counts,
      checks: Object.fromEntries(d.checks.map((c) => [c.id, { title: c.title, verdict: c.verdict }])),
    });
  }
  return out;
}

/**
 * What each failing contract item means to a user, by item key (`conformance:X4`, `edge:codex:checkout`) or by its
 * scenario on any cell (`edge:checkout`): one plain sentence, and the issue that tracks it or the pull request that
 * fixed it. A finding nobody tracks is refused, so Copy diagnostics never names a problem without its way out.
 * @param {string} [file]
 * @returns {Record<string, { says: string, issue?: number, fixedBy?: number }>}
 */
export function loadFindings(file = FINDINGS_FILE) {
  const all = readJson(file).findings;
  const where = path.relative(ROOT, file);
  if (!all || typeof all !== 'object') throw new Error(`${where} has no findings object`);
  const number = (n) => n === undefined || Number.isInteger(n);
  for (const [key, f] of Object.entries(all))
    if (typeof f?.says !== 'string' || !f.says.trim() || !number(f.issue) || !number(f.fixedBy) || (f.issue ?? f.fixedBy) === undefined)
      throw new Error(`${where}: ${key} needs says (a sentence) and an issue or fixedBy number`);
  return all;
}

/** The finding for a failing item: its own key first, then its scenario on any cell (edge:codex:tls → edge:tls). */
export function findingFor(findings, key) {
  const own = Object.hasOwn(findings, key) ? findings[key] : undefined;
  const parts = key.split(':');
  const anyCell = parts.length === 3 ? `${parts[0]}:${parts[2]}` : null;
  return own ?? (anyCell && Object.hasOwn(findings, anyCell) ? findings[anyCell] : undefined);
}

/**
 * The version contract runs, newest first per harness: version, verdict, the day it finished, how many failures were
 * new or known, the CM rows of the new ones, what each failing item means (findings) and, when incomplete, why. No
 * folder yet means no runs. A failing item without a finding stops the generator and names itself.
 * @param {string} [dir]
 * @param {() => ReturnType<typeof loadFindings>} [findings] read only when a run has a failing item
 */
export function loadContracts(dir = CONTRACT_DIR, findings = () => loadFindings()) {
  if (!fs.existsSync(dir)) return [];
  /** @type {ReturnType<typeof loadFindings> | undefined} */
  let described;
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const d = readJson(path.join(dir, f));
      // a file the page could not show stops the generator and names itself, never a blank Settings page
      if (
        typeof d?.kind !== 'string' ||
        typeof d.label !== 'string' ||
        typeof d.version !== 'string' ||
        !['pass', 'fail', 'incomplete'].includes(d.verdict)
      )
        throw new Error(`${path.join(path.relative(ROOT, dir), f)} is not a contract result (kind, label, version, verdict)`);
      return { ...d, file: f };
    })
    .map((d) => ({
      kind: d.kind,
      label: d.label,
      version: d.version,
      verdict: d.verdict,
      date: String(d.finishedAt ?? '').slice(0, 10),
      regressions: (d.regressions ?? []).length,
      known: (d.known ?? []).length,
      failingRows: d.failingRows ?? [],
      // a known item failed in the baseline too: Copy diagnostics says it is not new
      found: [...(d.regressions ?? []), ...(d.known ?? [])].map((key, i) => {
        const f = findingFor((described ??= findings()), key);
        if (!f) throw new Error(`${d.file}: ${key} failed; describe it in ${path.relative(ROOT, FINDINGS_FILE)}`);
        return { key, ...f, ...(i >= (d.regressions ?? []).length ? { known: true } : {}) };
      }),
      incomplete: d.incomplete ?? [],
    }));
}

/** A version that failed or errored a check is not clean; everything else counts as tested. */
export const cleanVersion = (r) => !r.counts.fail && !r.counts.error;

/** What the registry's versions should be for a kind: the oldest clean tested version is min; knownBad stays a manual list. */
export function deriveVersions(results, kind, compare, knownBad = []) {
  const tested = results
    .filter((r) => r.kind === kind && cleanVersion(r))
    .map((r) => r.version)
    .sort(compare);
  return { min: tested[0], knownBad, tested };
}

const verdictText = (checks, ids) => ids.map((id) => `${id} ${checks[id]?.verdict ?? 'missing'}`).join(', ');

export async function buildMatrix() {
  const { REGISTRY } = await import(pathToFileURL(path.join(ROOT, 'src/harness/registry.ts')).href);
  const { SEMANTICS, resolveCaps } = await import(pathToFileURL(path.join(ROOT, 'shared/caps.mjs')).href);
  const { FEATURE_LABEL, whyText } = await import(pathToFileURL(path.join(ROOT, 'src/harness/caps.ts')).href);
  const { codexBindings, claudeBindings } = require('../electron/harness/bindings.cjs');
  return assembleMatrix({
    REGISTRY,
    SEMANTICS,
    resolveCaps,
    FEATURE_LABEL,
    whyText,
    bindings: { codex: codexBindings(undefined), claude: claudeBindings() },
    results: loadResults(),
    admission: loadAdmission(),
    contracts: loadContracts(),
  });
}

/** The matrix from its inputs: the registry, the capability resolver and labels, each harness's bindings, the conformance and admission results. */
export function assembleMatrix({
  REGISTRY,
  SEMANTICS,
  resolveCaps,
  FEATURE_LABEL,
  whyText,
  bindings,
  results,
  admission,
  contracts = /** @type {any[]} */ ([]),
}) {
  const first = ['codex', 'claude'].map((kind) => {
    const info = REGISTRY[kind];
    const r = results.filter((x) => x.kind === kind).at(-1);
    return {
      kind,
      label: info.label,
      vendor: info.vendor,
      channel: info.channel,
      versions: info.versions,
      result: r ? { file: r.file, version: r.version, date: r.date, counts: r.counts } : null,
    };
  });
  const labelOf = (k) => REGISTRY[k].label;
  const caps = Object.fromEntries(Object.entries(bindings).map(([k, b]) => [k, resolveCaps({ tier: 'first', bindings: b })]));
  const cell = (kind, s) => {
    const b = caps[kind][s];
    const checks = (results.filter((x) => x.kind === kind).at(-1) ?? { checks: {} }).checks;
    const ids = CHECKS_FOR[kind][s] ?? [];
    const c = { via: b.via, detail: '', source: '', verified: verdictText(checks, ids) };
    switch (b.via) {
      case 'rpc':
        c.detail = b.method;
        c.source = labelOf(kind);
        break;
      case 'passthrough':
        c.detail = b.template;
        c.source = labelOf(kind);
        break;
      case 'config':
        c.detail = b.value === true || b.value === undefined ? b.option : `${b.option} = ${JSON.stringify(b.value)}`;
        c.source = labelOf(kind);
        break;
      case 'polyfill':
        c.detail = b.engine;
        c.source = 'MoPilot';
        break;
      case 'route':
        c.detail = labelOf(b.to);
        c.source = labelOf(b.to);
        break;
      case 'none':
        c.detail = b.why.code;
        c.source = '-';
        c.why = whyText(b.why, { label: labelOf(kind), semantic: s });
        break;
    }
    return c;
  };
  const semantics = SEMANTICS.map((s) => ({
    semantic: s,
    label: FEATURE_LABEL[s],
    codex: cell('codex', s),
    claude: cell('claude', s),
  }));

  const basic = Object.values(REGISTRY)
    .filter((h) => h.tier === 'basic')
    .map((h) => {
      const id = h.kind.slice('acp:'.length);
      const a = admission.harnesses[id];
      const p = a?.probeWithQuirksFixes;
      return {
        id,
        label: h.label,
        vendor: h.vendor,
        probedVersion: a?.version ?? null,
        // the version the harness itself reports (what the app sees once it runs); dsh's says 0.0.1 for 0.2.0-rc.2
        agentVersion: a?.probeWithQuirksFixes?.version ?? a?.initialize?.agentInfo?.version ?? null,
        verified: h.versions.tested.length > 0 ? h.versions.tested.join(', ') : 'unverified',
        admission: p?.state ?? 'not probed',
        reason: p?.reason ?? null,
        initialize: a?.initialize ? 'ok' : 'not probed',
        imagePrompts: a?.initialize?.agentCapabilities?.promptCapabilities?.image ?? null,
        privacyGate: h.admission?.privacyGate ? (a?.privacyGate?.ok ? 'pass' : 'fail') : 'none declared',
        sageTools: a?.sessionNew
          ? a.sessionNew.sageMcpHello
            ? 'hello received'
            : a.sessionNew.ok
              ? 'no hello'
              : 'session/new failed'
          : 'not probed',
        privacyDefaults: h.privacyDefaults ?? [],
      };
    });

  // registry order (first-class, then basic), each harness's newest version first
  const order = Object.keys(REGISTRY);
  // a harness the registry no longer has is left out
  const sorted = contracts
    .filter((c) => order.includes(c.kind))
    .sort((a, b) => (a.kind === b.kind ? compareVersionsDesc(a.version, b.version) : order.indexOf(a.kind) - order.indexOf(b.kind)));
  return {
    first,
    semantics,
    contracts: sorted,
    notes: SOURCE_NOTES,
    contract: BASIC_CONTRACT,
    basic,
    admissionPlatform: admission.platform,
    admissionNote: admission.how,
  };
}

const esc = (s) => String(s).replace(/\|/g, '\\|');
/** Newest first, by the same order as electron/harness/versions.cjs. @param {string} a @param {string} b */
const compareVersionsDesc = (a, b) => require('../electron/harness/versions.cjs').compareVersions(b, a);
const code = (s) => (s ? `\`${esc(s)}\`` : '');
const NATIVE = new Set(['rpc', 'passthrough', 'config']);
const bindingText = (c) => {
  if (c.via === 'none') return `none: ${esc(c.why)}`;
  const kind = NATIVE.has(c.via) ? `native (${c.via})` : c.via;
  return `${kind} ${code(c.detail)}`;
};

export function renderMarkdown(m) {
  const L = [];
  L.push('<!-- Generated by scripts/gen-matrix.mjs (npm run harness-matrix). Do not edit by hand. -->', '');
  L.push('# Harness matrix', '');
  L.push(
    'Two tables. The first covers the first-class harnesses (Codex and Claude Code): what each of the semantics MoPilot offers is bound to, what controls it, and the conformance checks that back it. The second covers the basic tier: the contract every basic harness is admitted against, and the admission result per harness.',
    '',
  );
  L.push('## First-class harnesses', '');
  L.push('| Harness | Channel | Min version | Known bad | Tested versions | Conformance run |', '| --- | --- | --- | --- | --- | --- |');
  for (const h of m.first) {
    const r = h.result;
    const run = r
      ? `${code(r.file)} (${r.date}): ${Object.entries(r.counts)
          .map(([v, n]) => `${n} ${v}`)
          .join(', ')}`
      : 'none';
    L.push(
      `| ${h.label} | ${h.channel} | ${code(h.versions.min)} | ${h.versions.knownBad.map(code).join(', ') || 'none'} | ${h.versions.tested.map(code).join(', ')} | ${run} |`,
    );
  }
  L.push(
    '',
    'A CLI above its minimum version and not on the known-bad list works as usual and shows as "unverified" here; only a capability whose runtime probe fails is greyed out.',
    '',
  );
  L.push(
    "Binding kinds: **native** is the harness doing it itself (`rpc` a protocol method, `passthrough` its own slash command typed as-is, `config` one of its settings); **polyfill** is MoPilot's own implementation; **route** sends the user to the other harness; **none** says why it is missing. The Source column names what controls the entry.",
    '',
  );
  L.push(
    '| Semantic | Codex binding | Codex source | Codex checks | Claude Code binding | Claude Code source | Claude Code checks |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const s of m.semantics) {
    const x = s.codex;
    const y = s.claude;
    L.push(
      `| ${s.label} (${code(s.semantic)}) | ${bindingText(x)} | ${x.source} | ${x.verified || '-'} | ${bindingText(y)} | ${y.source} | ${y.verified || '-'} |`,
    );
  }
  L.push('');
  for (const n of m.notes) L.push(`- ${n}`);
  L.push('', '## Version contract', '');
  L.push(
    'Each new harness version is checked in the benchmark VM before it is added to the tested versions (bench/README.md, harness version contract): the conformance checks, the edge-case scenarios on the in-app browser, computer use and browser use, and the ACP admission probe.',
    '',
  );
  if (!m.contracts.length) L.push('No contract run yet.');
  else {
    L.push(
      '| Harness | Version | Result | Finished | New failures | Known failures | Failing rows |',
      '| --- | --- | --- | --- | --- | --- | --- |',
    );
    for (const c of m.contracts)
      L.push(
        `| ${c.label} | ${code(c.version)} | ${c.verdict}${c.incomplete.length ? `: ${esc(c.incomplete.join('; '))}` : ''} | ${c.date} | ${c.regressions} | ${c.known} | ${c.failingRows.join(', ') || '-'} |`,
      );
  }
  L.push('', '## Basic tier', '');
  L.push(
    `Every other harness (${m.basic.map((b) => b.label).join(', ')}) runs through one generic ACP adapter plus a quirks file. They are installed by the user, so nothing is pinned.`,
    '',
  );
  L.push('### Contract', '');
  L.push('**Admission.** A harness enters the picker only when all of these hold:', '');
  for (const t of m.contract.admission) L.push(`- ${t}`);
  L.push('', '**Guaranteed once admitted:**', '');
  for (const t of m.contract.guaranteed) L.push(`- ${t}`);
  L.push('', '**Passed through only if the harness declares it:**', '');
  for (const t of m.contract.ifDeclared) L.push(`- ${t}`);
  L.push('', '**Not provided:**', '');
  for (const t of m.contract.notProvided) L.push(`- ${t}`);
  L.push('', '### Admission results', '');
  L.push(`Probed on ${m.admissionPlatform}. ${m.admissionNote}`, '');
  L.push(
    '| Harness | Probed version | Version status | Admission | Reason | initialize | Images | Privacy check | MoPilot tools |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const b of m.basic) {
    const img = b.imagePrompts === null ? '-' : b.imagePrompts ? 'yes' : 'no';
    L.push(
      `| ${b.label} (${b.vendor}) | ${b.probedVersion ? code(b.probedVersion) : '-'} | ${b.verified} | ${b.admission} | ${esc(b.reason ?? '-')} | ${b.initialize} | ${img} | ${b.privacyGate} | ${b.sageTools} |`,
    );
  }
  L.push(
    '',
    '"signin" means the harness wants a login before it can open a session, so it has not been admitted and no turn has been run on it. "unverified" means no full conformance run exists for that version yet.',
    '',
  );
  return L.join('\n');
}

export const renderJson = (m) => JSON.stringify(m, null, 2) + '\n';

/** The command line: writes both files, or with --check returns 1 when either is stale. Returns the exit code. */
export async function main(argv, { build = buildMatrix, fsx = fs, log = console.log, error = console.error } = {}) {
  if (argv.includes('--help')) {
    log('usage: npm run harness-matrix [-- --check]');
    return 0;
  }
  const m = await build();
  const files = [
    [OUT_MD, renderMarkdown(m)],
    [OUT_JSON, renderJson(m)],
  ];
  if (argv.includes('--check')) {
    const stale = files.filter(([f, t]) => !fsx.existsSync(f) || fsx.readFileSync(f, 'utf8') !== t).map(([f]) => path.relative(ROOT, f));
    if (stale.length) {
      error(`stale: ${stale.join(', ')}; run npm run harness-matrix`);
      return 1;
    }
    return 0;
  }
  for (const [f, t] of files) fsx.writeFileSync(f, t);
  log(files.map(([f]) => path.relative(ROOT, f)).join('\n'));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
