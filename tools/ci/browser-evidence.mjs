#!/usr/bin/env node
// Complete PNG evidence without a hosted artifact service. Inventory is bounded;
// bytes are loaded one file at a time and backpressure bounds stdout buffering.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const LIMITS = Object.freeze({ files: 256, fileBytes: 4 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024, uniqueBytes: 64 * 1024 * 1024, depth: 8 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const metadata = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
export function inventory(root, limits = LIMITS) {
  const files = [], unique = new Map(); let totalBytes = 0, uniqueBytes = 0;
  function visit(dir, depth) {
    const owner = lstatSync(dir);
    if (owner.isSymbolicLink() || !owner.isDirectory() || depth > limits.depth)
      throw new Error('unsafe browser evidence directory');
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('symlink inside browser evidence');
      if (stat.isDirectory()) { visit(path, depth + 1); continue; }
      if (!stat.isFile() || !name.endsWith('.png')) continue;
      if (files.length >= limits.files) throw new Error('browser screenshot file cap exceeded');
      if (stat.size > limits.fileBytes) throw new Error('browser screenshot byte cap exceeded');
      totalBytes += stat.size;
      if (totalBytes > limits.totalBytes) throw new Error('browser screenshot total cap exceeded');
      const bytes = readFileSync(path);
      if (!bytes.subarray(0, 8).equals(PNG) || bytes.length !== stat.size || metadata(lstatSync(path)) !== metadata(stat))
        throw new Error('invalid or changing PNG browser evidence');
      const relativePath = relative(root, path).split('\\').join('/');
      if (!relativePath || relativePath.startsWith('../') || /[\r\n]/.test(relativePath))
        throw new Error('unsafe browser evidence path');
      const sha256 = hash(bytes);
      files.push({ path: relativePath, sha256, bytes: bytes.length });
      if (!unique.has(sha256)) {
        uniqueBytes += bytes.length;
        if (uniqueBytes > limits.uniqueBytes) throw new Error('browser unique screenshot cap exceeded');
        unique.set(sha256, { path, metadata: metadata(stat), bytes: bytes.length });
      }
    }
  }
  visit(root, 0);
  return { files, unique, totalBytes, uniqueBytes };
}
export async function writeEvidence(root, identity, output) {
  if (!existsSync(root)) {
    await output('VIBEFLARE_BROWSER_EVIDENCE_V1 ' + JSON.stringify({
      status: 'no-test-results', complete: false, ...identity, files: [] }));
    return;
  }
  const record = inventory(root);
  const manifest = { status: record.files.length ? 'retaining-in-log' : 'no-screenshots',
    complete: false, ...identity, files: record.files, totalBytes: record.totalBytes,
    uniqueBytes: record.uniqueBytes, encoding: 'gzip-base64', uniqueCount: record.unique.size };
  const manifestText = JSON.stringify(manifest); const manifestSha256 = hash(manifestText);
  await output('VIBEFLARE_BROWSER_EVIDENCE_V1 ' + manifestText);
  let compressedBytes = 0;
  for (const [sha256, file] of record.unique) {
    const stat = lstatSync(file.path);
    if (stat.isSymbolicLink() || metadata(stat) !== file.metadata) throw new Error('PNG changed after inventory');
    const raw = readFileSync(file.path);
    if (raw.length !== file.bytes || hash(raw) !== sha256) throw new Error('PNG bytes changed after inventory');
    const encoded = gzipSync(raw).toString('base64');
    const count = Math.ceil(encoded.length / 4096); compressedBytes += Buffer.byteLength(encoded);
    for (let index = 0; index < count; index++) await output('VIBEFLARE_BROWSER_PNG_V1 ' + JSON.stringify({
      ...identity, sha256, encoding: 'gzip-base64', index, count, data: encoded.slice(index * 4096, (index + 1) * 4096) }));
  }
  // A pending manifest alone never proves complete retention. Consumers must
  // reconstruct every digest and match this final source-bound completion.
  await output('VIBEFLARE_BROWSER_EVIDENCE_COMPLETE_V1 ' + JSON.stringify({
    complete: true, ...identity, manifestSha256, files: record.files.length,
    uniqueCount: record.unique.size, totalBytes: record.totalBytes, encodedBytes: compressedBytes }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const source = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
    const runId = process.env.GITHUB_RUN_ID ?? null, attempt = process.env.GITHUB_RUN_ATTEMPT ?? null;
    if (!/^[a-f0-9]{40}$/.test(source) || process.env.GITHUB_ACTIONS === 'true' &&
        (process.env.GITHUB_SHA !== source || !/^[1-9][0-9]*$/.test(runId ?? '') || !/^[1-9][0-9]*$/.test(attempt ?? '')))
      throw new Error('Evidence source/run/attempt differs from actual checked Actions source');
    const output = async line => { if (!process.stdout.write(line + '\n')) await once(process.stdout, 'drain'); };
    await writeEvidence(resolve(process.argv[2] ?? join(repository, 'apps/ui/test-results')), { source, runId, attempt }, output);
  } catch (error) { console.error('VIBEFLARE_BROWSER_EVIDENCE_ERROR ' + error.message); process.exitCode = 1; }
}
