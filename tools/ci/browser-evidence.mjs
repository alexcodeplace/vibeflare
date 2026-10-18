#!/usr/bin/env node
// Bounded, checksum-addressed screenshots in CI logs; hosted artifacts forbidden.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
const MAX_FILES = 32, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const root = resolve(process.argv[2] ?? 'apps/ui/test-results');
const fail = message => { console.error('VIBEFLARE_BROWSER_EVIDENCE_ERROR ' + message); process.exitCode = 1; };
function collect(dir, output) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('symlink inside browser evidence');
    if (stat.isDirectory()) collect(path, output);
    else if (stat.isFile() && name.endsWith('.png')) {
      if (++output.count > MAX_FILES) throw new Error('browser screenshot file cap exceeded');
      if (stat.size > MAX_FILE_BYTES) throw new Error('browser screenshot byte cap exceeded');
      output.total += stat.size;
      if (output.total > MAX_TOTAL_BYTES) throw new Error('browser screenshot total cap exceeded');
      const bytes = readFileSync(path);
      if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
        throw new Error('non-PNG browser evidence');
      output.files.push({ path: relative(root, path).split('\\').join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes });
    }
  }
}
try {
  if (!existsSync(root)) {
    console.log('VIBEFLARE_BROWSER_EVIDENCE_V1 ' + JSON.stringify({
      status: 'no-test-results', source: process.env.GITHUB_SHA ?? null, files: [] }));
  } else {
    const state = { count: 0, total: 0, files: [] };
    collect(root, state);
    console.log('VIBEFLARE_BROWSER_EVIDENCE_V1 ' + JSON.stringify({
      status: state.count ? 'retained-in-log' : 'no-screenshots',
      source: process.env.GITHUB_SHA ?? null,
      files: state.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes: bytes.length })) }));
    for (const file of state.files) {
      const chunks = file.bytes.toString('base64').match(/.{1,4096}/g) ?? [];
      chunks.forEach((data, index) => console.log('VIBEFLARE_BROWSER_PNG_V1 ' +
        JSON.stringify({ path: file.path, sha256: file.sha256, index, count: chunks.length, data })));
    }
  }
} catch (error) { fail(String(error.message)); }
