// Collects npm failure logs from the packaged journey's own caches for encrypted CI evidence.
import fs from 'node:fs';
import path from 'node:path';

/** @param {{ scratch: string, userData: string, output: string }} o */
export function collectNpmLogs({ scratch, userData, output }) {
  const target = path.join(output, 'npm-logs');
  /** @type {{ copied: string[], errors: string[], note: string }} */
  const report = {
    copied: [],
    errors: [],
    note: 'Unpublished package caches are removed after retirement; their logs are unavailable here.',
  };
  const directory = (file) => fs.existsSync(file) && fs.lstatSync(file).isDirectory();
  const children = (dir) => (directory(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()) : []);
  const copy = (source, label) => {
    if (!directory(source)) return;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const name = path.join(label, entry.name);
      const destination = path.join(target, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(source, entry.name), destination);
      report.copied.push(name);
    }
  };
  try {
    copy(path.join(scratch, 'npm-cache/_logs'), 'fallback');
    const managed = path.join(userData, 'registry-agents/.packages');
    for (const agent of children(managed)) {
      const versions = path.join(managed, agent.name);
      for (const version of children(versions))
        copy(path.join(versions, version.name, '_logs'), path.join('managed', agent.name, version.name));
    }
  } catch (error) {
    report.errors.push(String(error));
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'collection.json'), JSON.stringify(report, null, 2));
  } catch (error) {
    report.errors.push(String(error));
  }
  return report;
}
