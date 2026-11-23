// Writes the Homebrew cask (mopilot-ai/homebrew-tap Casks/mopilot.rb) for the Mac build the stable update feed serves.
//   node scripts/homebrewCask.mjs --feed <stable.json> --current <the tap's Casks/mopilot.rb> --out <file>
// .github/release-repo/homebrew-tap.yml runs it on every push of updates/stable.json to the release repository. The cask
// follows /download: the newest plain version whose macOS arm64 and x64 builds are both at 100% rollout and hosted on
// the release repository's GitHub release, with the SHA-256 the release registered for each zip. A rollout change below
// 100% changes nothing; a pause or withdrawal of that version moves the cask back to the one /download then serves.
// It prints `changed=<true|false>` and `version=<v>` (for $GITHUB_OUTPUT) and writes --out only when the cask changes.
// It only reads files: the workflow installs the written cask on macOS runners before it pushes it to the tap.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RELEASE_REPO = 'mopilot-ai/mopilot-code-release';
export const FEED_URL = `https://raw.githubusercontent.com/${RELEASE_REPO}/main/updates/stable.json`;
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARCHES = /** @type {const} */ (['arm64', 'x64']);

/** The zip URL the cask names for `version` on `arch` (the cask spells it with #{version} and #{arch}). */
export const zipUrl = (version, arch) => `https://github.com/${RELEASE_REPO}/releases/download/v${version}/MoPilot-${version}-${arch}.zip`;

/** [major, minor, patch], or null for anything but a plain version (a tagged dogfood build never reaches the cask). */
const rank = (version) => {
  const m = VERSION.exec(typeof version === 'string' ? version : '');
  return m ? [+m[1], +m[2], +m[3]] : null;
};

const higher = (a, b) => {
  const i = a.findIndex((n, k) => n !== b[k]);
  return i >= 0 && a[i] > b[i];
};

/**
 * The Mac build /download serves from a stable feed: { version, sha256: { arm64, x64 } }, or null when no version has
 * both architectures at 100% on GitHub. An entry that is malformed, below 100% or hosted elsewhere is skipped.
 */
export function servedMacBuild(feed) {
  const lists = [feed?.releases, feed?.promotions].map((l) => (Array.isArray(l) ? l : []));
  /** @type {Map<string, Record<string, string>>} */
  const byVersion = new Map();
  for (const r of lists.flat()) {
    if (!r || r.platform !== 'darwin' || r.rolloutPct !== 100 || !rank(r.version) || !ARCHES.includes(r.arch)) continue;
    if (!SHA256.test(r.sha256 ?? '') || r.url !== zipUrl(r.version, r.arch)) continue;
    byVersion.set(r.version, { ...byVersion.get(r.version), [r.arch]: r.sha256 });
  }
  /** @type {{ version: string, sha256: { arm64: string, x64: string } } | null} */
  let best = null;
  for (const [version, sha256] of byVersion)
    if (ARCHES.every((a) => sha256[a]) && (!best || higher(rank(version), rank(best.version))))
      best = { version, sha256: { arm64: sha256.arm64, x64: sha256.x64 } };
  return best;
}

/** The cask's Ruby source for `build` (see servedMacBuild). */
export function renderCask({ version, sha256 }) {
  return `# Written by MoPilot's release workflow from the stable update feed on each stable release: edits here are replaced.
cask "mopilot" do
  arch arm: "arm64", intel: "x64"

  version "${version}"
  sha256 arm:   "${sha256.arm64}",
         intel: "${sha256.x64}"

  url "https://github.com/${RELEASE_REPO}/releases/download/v#{version}/MoPilot-#{version}-#{arch}.zip",
      verified: "github.com/${RELEASE_REPO}/"
  name "MoPilot"
  desc "Desktop home for coding agents"
  homepage "https://mopilot.ai/"

  # The newest version at 100% rollout on both architectures, as this cask is written from the feed.
  livecheck do
    url "${FEED_URL}"
    strategy :json do |json|
      live = (json["releases"].to_a + json["promotions"].to_a).select do |item|
        item.is_a?(Hash) && item["platform"] == "darwin" && item["rolloutPct"] == 100 &&
          item["version"].to_s.match?(/^\\d+\\.\\d+\\.\\d+$/)
      end
      live.group_by { |item| item["version"] }
          .select { |_, items| items.any? { |i| i["arch"] == "arm64" } && items.any? { |i| i["arch"] == "x64" } }
          .keys
    end
  end

  # The app updates itself in /Applications between brew upgrades.
  auto_updates true
  depends_on macos: :ventura

  app "MoPilot.app"

  # ~/.mopilot is left alone: it holds the user's agent worktrees, plugins and connectors.
  zap trash: [
    "~/Library/Application Support/MoPilot",
    "~/Library/Caches/ai.mopilot.code",
    "~/Library/Caches/ai.mopilot.code.ShipIt",
    "~/Library/HTTPStorages/ai.mopilot.code",
    "~/Library/Logs/MoPilot",
    "~/Library/Preferences/ai.mopilot.code.plist",
    "~/Library/Saved Application State/ai.mopilot.code.savedState",
  ]
end
`;
}

/** The value after `--name`, or ''. */
const flag = (argv, name) => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? '') : '');

/**
 * Runs the command line (see the top of this file). Returns the exit code: 0 (written or unchanged, or no build to
 * name), 1 for a feed that can't be read, 2 for a missing flag. A cask left as it is is never rewritten.
 */
export function main(argv, { log = console.log, error = console.error, fs = { existsSync, readFileSync, writeFileSync } } = {}) {
  const feedPath = flag(argv, '--feed');
  const currentPath = flag(argv, '--current');
  const outPath = flag(argv, '--out');
  if (!feedPath || feedPath.startsWith('--') || !currentPath || currentPath.startsWith('--') || !outPath || outPath.startsWith('--')) {
    error('Usage: homebrewCask --feed <stable.json> --current <Casks/mopilot.rb> --out <file>');
    return 2;
  }
  let feed;
  try {
    feed = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
  } catch (e) {
    error(`Reading ${feedPath} failed: ${e.message}`);
    return 1;
  }
  const build = servedMacBuild(feed);
  const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : '';
  const was = /^ {2}version "([^"]+)"$/m.exec(current)?.[1] ?? '';
  if (!build) {
    error('The feed serves no Mac build on both architectures: the cask is left as it is');
    log('changed=false');
    log(`version=${was}`);
    return 0;
  }
  const cask = renderCask(build);
  const changed = cask !== current;
  if (changed) fs.writeFileSync(outPath, cask);
  log(`changed=${changed}`);
  log(`version=${build.version}`);
  if (changed) error(`Cask ${was ? `${was} → ` : ''}${build.version}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
