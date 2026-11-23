// Recognises a shell command that starts MoPilot on this computer (a dev, test or built instance), for the Claude Code hook in release-suites.cjs.
// AGENTS.md keeps app checks off the user's Mac: they run as fake-based specs on GitHub's macOS runners
// (scripts/ci-cuj.mjs) or in the virtual machine (scripts/vm-exec.sh). The hook lets those two through before asking
// this module, and a release session (MOPILOT_RELEASE=1) skips the hook altogether.

/** Shell text in quotes, which never runs here unless the command hands it to another shell. */
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
/** Where one simple command ends and the next begins. */
const SEPARATOR = /[;&|\n()`]/;
/** What may come before a command's own name: an environment assignment, or a wrapper that runs the rest. */
const PREFIX =
  /^\s*(?:(?:nohup|exec|env|time|command|caffeinate|sudo|nice|arch|xargs)\s+(?:(?:-[un]\s+(?!-)\S+|-\S+)\s+)*|timeout\s+(?:-\S+\s+)*\S+\s+|[A-Za-z_]\w*=\S*\s+)*/;
/** A test instance's switches (electron/app/backgroundMode.cjs, electron/platform/testChats.cjs), set for a command or exported. */
const TEST_INSTANCE_ENV = /(?:^|\s)(?:SAGE_E2E_BACKGROUND|MOPILOT_TEST_RUN)=/;
/** npm's options that take a value, before its command: npm --prefix . run dev */
const NPM_OPTIONS = String.raw`(?:\s+(?:--prefix|-C|--cwd|--dir|--filter|-w|--workspace)(?:=\S+|\s+\S+)|\s+-\S+)*`;
/** The portal under web/ has its own dev and start scripts, which start no app: a cd there, or npm --prefix web. */
const CD = /^\s*cd\s+(\S+)/;
const WEB = /(?:^|\/)web\/?$/;
const PREFIX_WEB = /--prefix[= ](?:\S*\/)?web\/?(?=\s|$)/;
/** A shell reading its commands from a pipe: … | bash, … | sh -s */
const PIPED_TO_SHELL = /\|\s*(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s+-\S+)*\s*(?:$|[;&|)\n])/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s*$)/gm;
/** The end of a command that runs text it is handed: zsh -lc …, bash <<EOF, eval … */
const RUNS_TEXT = /(?:^|[\s;&|(])(?:(?:ba|z|da|k)?sh(?:\s+-\S+)*|eval)\s*$/;

/** The command without here-documents, except one handed to a shell, whose text runs. @param {string} command */
const withoutHeredocs = (command) =>
  command.replace(HEREDOC, (doc, _q, _tag, offset) =>
    RUNS_TEXT.test(command.slice(command.lastIndexOf('\n', offset) + 1, offset)) ? doc : '',
  );

/** The command with each quoted string's text blanked, keeping every other character where it was. @param {string} command */
const blankQuotes = (command) => command.replace(QUOTED, (q) => `${q[0]}${'_'.repeat(q.length - 2)}${q[q.length - 1]}`);

/** A word as the shell reads it, without its quotes. @param {string} word */
const unquote = (word) => word.replace(/^(['"])(.*)\1$/, '$2');

/**
 * Whether one simple command starts the app. `code` has its quoted text blanked; `raw` is the same text with it.
 * @param {string} code @param {string} raw @param {boolean} inWeb
 */
function segmentLaunches(code, raw, inWeb) {
  const skip = /** @type {RegExpExecArray} */ (PREFIX.exec(code))[0].length;
  const prefix = code.slice(0, skip);
  if (TEST_INSTANCE_ENV.test(prefix) || (/^\s*export\s/.test(code) && TEST_INSTANCE_ENV.test(code))) return true;
  // Electron as plain Node (a script, not the app)
  if (/(?:^|\s)ELECTRON_RUN_AS_NODE=1\s/.test(prefix)) return false;
  // a word may hold escaped spaces: /Applications/MoPilot\ Code.app/…
  const words = code.slice(skip).match(/^(?:\\.|[^\s\\])+/);
  if (!words) return false;
  const nameEnd = skip + words[0].length;
  let name = unquote(raw.slice(skip, nameEnd));
  let rest = code.slice(nameEnd);
  const rawRest = raw.slice(nameEnd);
  // npx electron ., npx --yes electron .
  if (/^(?:npx|pnpx|bunx)$/.test(name)) {
    const next = /^(?:\s+-\S+)*\s+((?:\\.|[^\s\\])+)/.exec(rest);
    if (!next) return false;
    name = unquote(raw.slice(nameEnd + next[0].length - next[1].length, nameEnd + next[0].length));
    rest = rest.slice(next[0].length);
  }
  // Electron from node_modules or a package: electron ., ./node_modules/.bin/electron, …/MacOS/Electron
  if (/^(?:\S*\/)?electron(?:@\S+)?$/i.test(name)) return !/^\s+(?:--version|-v|--help|-h)\s*$/.test(rest);
  // a built app's own executable, the installed one included (a debugging port makes it a test instance)
  if (/\.app\/Contents\/MacOS\//.test(name)) return true;
  // npm run dev, npm start, npm run -s start; npm exec electron, yarn electron
  if (/^(?:npm|pnpm|yarn|bun)$/.test(name)) {
    if (new RegExp(`^${NPM_OPTIONS}(?:\\s+(?:exec|x))?(?:\\s+-\\S+)*(?:\\s+--)?\\s+electron(?:@\\S+)?(?=\\s|$)`).test(rest)) return true;
    if (inWeb || PREFIX_WEB.test(rest)) return false;
    return new RegExp(`^${NPM_OPTIONS}(?:\\s+run(?:-script)?${NPM_OPTIONS})?\\s+(?:dev|start)(?=\\s|$)`).test(rest);
  }
  // the dev setup itself
  if (name === 'node') return /^(?:\s+-\S+)*\s+(?:\.\/)?scripts\/dev\.mjs(?=\s|$)/.test(rest);
  // a built package, or the app by name; opening the installed app as the mopilot-update skill does is its own install step
  if (/^(?:\S*\/)?open$/.test(name)) {
    const app = /\.app(?=["'\/\s]|$)/i.test(rawRest) || /(?:^|\s)-[a-z]*[ab]\s+['"]?\S*(?:mopilot|sage)/i.test(rawRest);
    return app && !/^\s+(['"]?)\/Applications\/MoPilot(?:(?: |\\ )Code)?\.app\/?\1\s*$/.test(rawRest);
  }
  return false;
}

/**
 * Whether a shell command starts MoPilot on this computer. Here-documents and quoted text are left out first,
 * as in release-suites.cjs, unless the command hands text to another shell; then that text is read as commands too.
 * @param {string} command
 * @param {RegExp} shellInput release-suites.cjs's test for a command that hands text to another shell
 */
function launchesAppHere(command, shellInput) {
  const raw = withoutHeredocs(command);
  const code = blankQuotes(raw);
  // the folder each command runs in, as far as a cd before it says
  let inWeb = false;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    if (i < code.length && !SEPARATOR.test(code[i])) continue;
    const segment = code.slice(start, i);
    const cd = CD.exec(segment);
    if (cd) inWeb = WEB.test(cd[1]);
    else if (segmentLaunches(segment, raw.slice(start, i), inWeb)) return true;
    start = i + 1;
  }
  // bash -c "npm run dev", eval 'electron .', "$(npm start)": that quoted text is code; a quoted argument is not
  const piped = PIPED_TO_SHELL.test(code);
  if (!piped && !shellInput.test(raw)) return false;
  return [...raw.matchAll(QUOTED)].some((m) => {
    const text = m[0].slice(1, -1);
    // a substitution runs inside double quotes only
    const substitutes = m[0][0] === '"' && /\$\(|`/.test(text);
    return (piped || RUNS_TEXT.test(raw.slice(0, m.index)) || substitutes) && launchesAppHere(text, shellInput);
  });
}

const HOST_APP_REASON =
  'Blocked by the repository hook (.claude/settings.json): this command starts MoPilot on this computer (a dev, ' +
  'test or built instance), and AGENTS.md keeps app checks off the user’s Mac. Reproduce the bug as a fake-based ' +
  'Playwright spec under tests/e2e and run it on GitHub’s macOS runners (node scripts/ci-cuj.mjs --branch <b> --spec ' +
  '<glob>), or run the check in the isolated virtual machine (scripts/vm-exec.sh <command>); a check that needs real ' +
  'logins, computer use or real windows runs only there. If no virtual machine is available, say so and ask the user ' +
  'instead of launching here; if the user wants the app started on their Mac, give them the command to run.';

module.exports = { launchesAppHere, HOST_APP_REASON };
