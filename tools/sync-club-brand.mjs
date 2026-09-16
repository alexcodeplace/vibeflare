#!/usr/bin/env node
/** Copy the verified Club runtime package, or check the vendored copy without Club. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'apps/ui/public/assets/club');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const check = process.argv.includes('--check');
const argument = process.argv.indexOf('--source');
const source = check ? target : argument >= 0 && process.argv[argument + 1];
if (!source) throw new Error('Usage: node tools/sync-club-brand.mjs --source <club>/public/assets/club | --check');
const manifestBytes = readFileSync(join(source, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.runtimeOnly !== true || !Array.isArray(manifest.files) || !manifest.files.length) {
  throw new Error('Expected the Club runtime-only manifest, not the large canonical editing archive.');
}
let total = 0;
const seen = new Set();
// Validate the complete package BEFORE copying anything.
for (const file of manifest.files) {
  const relative = file.target.replace(/^public\/assets\/club\//, '');
  if (!/^(?:[a-z0-9-]+\/)*[a-z0-9-]+\.(svg|webp)$/.test(relative) || seen.has(relative)) {
    throw new Error(`Unsafe or duplicate asset path: ${file.target}`);
  }
  seen.add(relative);
  const path = join(source, relative);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Symlink not accepted: ${relative}`);
  const bytes = readFileSync(path);
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`Asset checksum mismatch: ${relative}`);
  if (relative.endsWith('.svg') && /<(?:script|foreignObject|image|feImage)\b|<!ENTITY|<!DOCTYPE|\son\w+\s*=|(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(bytes.toString())) {
    throw new Error(`Unexpected executable or external SVG content: ${relative}`);
  }
  total += bytes.length;
}
if (total > 3 * 1024 * 1024) throw new Error('Runtime asset package exceeded the 3 MiB review budget.');
if (!check) {
  for (const relative of seen) {
    const destination = join(target, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, relative), destination);
  }
  copyFileSync(join(source, 'manifest.json'), join(target, 'manifest.json'));
  writeFileSync(join(root, 'docs/design/club-asset-provenance.json'), JSON.stringify({
    sourceRepository: 'alexcodeplace/spargax-club',
    sourceDirectory: resolve(source),
    importedAt: new Date().toISOString(),
    sourceManifestSha256: sha256(manifestBytes),
    assetCount: seen.size, bytes: total,
    note: 'Copied byte-for-byte from Club runtime assets. Canonical light/dark source paths and per-file hashes are preserved in the asset manifest.'
  }, null, 2) + '\n');
} else {
  const provenance = JSON.parse(readFileSync(join(root, 'docs/design/club-asset-provenance.json')));
  if (provenance.sourceManifestSha256 !== sha256(manifestBytes)) throw new Error('Source manifest checksum mismatch.');
}
console.log(`${check ? 'Verified' : 'Copied'} ${seen.size} Club assets, ${total.toLocaleString()} bytes.`);
