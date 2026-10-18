#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Only fixed, public dependency evidence. Never accept an arbitrary file list.
const FILES = ['source-sha.txt', 'pnpm-lock.yaml', 'backports-tests.log', 'audit.json'];
export function securityEvidence(root, expected) {
  if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error('Invalid qualified source');
  const directory = lstatSync(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe evidence root');
  const collected = [];
  for (const name of FILES) {
    const path = join(root, name); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unsafe evidence file: ' + name);
    const data = readFileSync(path);
    if (data.length !== stat.size) throw new Error('Evidence changed during capture');
    collected.push({ name, data, sha256: createHash('sha256').update(data).digest('hex') });
  }
  if (collected[0].data.toString('utf8').trim() !== expected) throw new Error('Evidence source mismatch');
  JSON.parse(collected[3].data.toString('utf8'));
  return collected;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const repository = resolve(fileURLToPath(new URL('../..', import.meta.url)));
    const expected = process.env.QUALIFIED_SOURCE_SHA;
    const actual = execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10000 }).trim();
    if (actual !== expected || !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID ?? '') ||
        !/^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('Missing exact run/source identity');
    const files = securityEvidence(join(repository, 'security-qualification'), expected);
    const identity = { source: expected, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
    console.log('VIBEFLARE_SECURITY_EVIDENCE_V1 ' + JSON.stringify({ ...identity,
      files: files.map(f => ({ name: f.name, bytes: f.data.length, sha256: f.sha256 })) }));
    for (const f of files) {
      const encoded = f.data.toString('base64'); const count = Math.ceil(encoded.length / 4096);
      for (let index = 0; index < count; index++) console.log('VIBEFLARE_SECURITY_FRAME_V1 ' +
        JSON.stringify({ ...identity, name: f.name, sha256: f.sha256, index, count, data: encoded.slice(index * 4096, (index + 1) * 4096) }));
    }
  } catch (error) { console.error('Security evidence refused: ' + error.message); process.exitCode = 1; }
}
