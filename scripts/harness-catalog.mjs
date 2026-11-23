// Generates the immutable ACP catalog from one repository-owned descriptor per harness, without a shared roster.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DESCRIPTORS = 'shared/harnesses';
export const OUTPUT = 'shared/harness-catalog.generated.json';
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const strings = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);

/** Reject malformed static contracts before any consumer can offer a launch or install command. */
export function validateDescriptor(value, name) {
  const bad = (field) => {
    throw new Error(`${name}: invalid harness ${field}`);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad('descriptor');
  if (typeof value.id !== 'string' || !ID.test(value.id) || `${value.id}.json` !== name) bad('id');
  for (const field of ['label', 'vendor', 'docsUrl']) if (typeof value[field] !== 'string' || !value[field]) bad(field);
  if (!value.docsUrl.startsWith('https://')) bad('docsUrl');
  if (!strings(value.bins) || !value.bins.length) bad('bins');
  if (typeof value.enabled !== 'boolean') bad('enabled');
  if (!value.install || typeof value.install.docs !== 'string' || !value.install.docs.startsWith('https://')) bad('install.docs');
  if (!Array.isArray(value.install.methods)) bad('install.methods');
  for (const method of value.install.methods) {
    if (!['script', 'brew', 'npm', 'winget', 'powershell'].includes(method?.via)) bad('install.via');
    if (typeof method.command !== 'string' || !method.command.trim()) bad('install.command');
    if (!strings(method.os) || !method.os.length || method.os.some((os) => !['darwin', 'linux', 'win32'].includes(os))) bad('install.os');
    if (method.via === 'npm' && (typeof method.npm !== 'string' || !method.npm)) bad('install.npm');
    if (method.via === 'brew' && (typeof method.brew?.name !== 'string' || typeof method.brew.cask !== 'boolean')) bad('install.brew');
  }
  for (const field of ['instructionsFiles', 'skillRoots', 'dataNotes', 'tested'])
    if (value[field] !== undefined && !strings(value[field])) bad(field);
  if (!value.acp || typeof value.acp !== 'object' || Array.isArray(value.acp)) bad('acp');
  if (value.runtimeQuirks !== undefined && typeof value.runtimeQuirks !== 'boolean') bad('runtimeQuirks');
  if (!value.runtimeQuirks && !strings(value.acp.args)) bad('acp.args');
  if (!Array.isArray(value.acp.privacyDefaults) || !strings(value.acp.privacyDefaults)) bad('acp.privacyDefaults');
  if (!Number.isSafeInteger(value.acp.admission?.handshakeTimeoutMs) || value.acp.admission.handshakeTimeoutMs <= 0) bad('acp.admission');
  if (value.acp.admission.requireResume !== undefined && typeof value.acp.admission.requireResume !== 'boolean')
    bad('acp.admission.requireResume');
  if (value.acp.admission.blockedVersions !== undefined && !strings(value.acp.admission.blockedVersions))
    bad('acp.admission.blockedVersions');
  if (value.developer !== undefined && typeof value.developer !== 'boolean') bad('developer');
  if (value.order !== undefined && !Number.isSafeInteger(value.order)) bad('order');
  return value;
}

/** Directory names are the roster; ordering is stable and independent of filesystem enumeration. */
export function readCatalog(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => validateDescriptor(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')), name))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

/** Atomic replacement, with a unique temp name: concurrent preparations always publish one complete catalog. */
export function generateCatalog(root = ROOT, io = fs) {
  const content = `${JSON.stringify(readCatalog(path.join(root, DESCRIPTORS)), null, 2)}\n`;
  const output = path.join(root, OUTPUT);
  if (io.existsSync(output) && io.readFileSync(output, 'utf8') === content) return false;
  const temp = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    io.writeFileSync(temp, content);
    io.renameSync(temp, output);
  } finally {
    io.rmSync(temp, { force: true });
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) generateCatalog(process.argv[2]);
