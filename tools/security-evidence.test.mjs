import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { securityEvidence } from './ci/security-evidence.mjs';

function fixture(t) {
  const base = process.env.RUNNER_TEMP || process.env.TMPDIR;
  assert.ok(base, 'An isolated test runner temp root is required');
  const root = mkdtempSync(join(base, 'vibeflare-security-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { 'source-sha.txt': 'a'.repeat(40) + '\n', 'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'backports-tests.log': '# tests 7\n# pass 7\n# fail 0\n', 'audit.json': '{"metadata":{"vulnerabilities":{"high":0}}}' };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(root, name), data);
  return { root, files };
}
test('fixed security evidence retains exact lock, audit and real test-log bytes', t => {
  const f = fixture(t); const files = securityEvidence(f.root, 'a'.repeat(40));
  assert.deepEqual(files.map(x => x.name), Object.keys(f.files));
  for (const file of files) {
    assert.equal(file.data.toString('utf8'), f.files[file.name]);
    assert.equal(file.sha256, createHash('sha256').update(file.data).digest('hex'));
  }
});
test('security transport rejects source mismatch, symlink and oversized lock', t => {
  const f = fixture(t);
  assert.throws(() => securityEvidence(f.root, 'b'.repeat(40)), /source mismatch/);
  const lock = join(f.root, 'pnpm-lock.yaml'); rmSync(lock); symlinkSync(join(f.root, 'audit.json'), lock);
  assert.throws(() => securityEvidence(f.root, 'a'.repeat(40)), /Unsafe evidence file/);
  rmSync(lock); writeFileSync(lock, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => securityEvidence(f.root, 'a'.repeat(40)), /Unsafe evidence file/);
});
