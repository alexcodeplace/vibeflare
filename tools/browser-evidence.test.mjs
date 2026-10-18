import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const script = new URL('./ci/browser-evidence.mjs', import.meta.url).pathname;
const sample = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic-image')]);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibeflare-browser-evidence-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return { dir, run: () => spawnSync(process.execPath, [script, dir],
    { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: 'a'.repeat(40) }, timeout: 5000 }) };
}
test('missing optional screenshot directory has a truthful non-evidence status', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [script, join(f.dir, 'absent')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"status":"no-test-results"/);
});
test('lossless PNG frames are reconstructable by path and SHA without hosted artifacts', t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'case'));
  writeFileSync(join(f.dir, 'case/test-failed-1.png'), sample);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  const manifest = JSON.parse(lines[0].replace(/^VIBEFLARE_BROWSER_EVIDENCE_V1 /, ''));
  assert.equal(manifest.files.length, 1);
  const frames = lines.slice(1).map(line => JSON.parse(line.replace(/^VIBEFLARE_BROWSER_PNG_V1 /, '')));
  const bytes = Buffer.from(frames.map(frame => frame.data).join(''), 'base64');
  assert.deepEqual(bytes, sample);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(sample).digest('hex'));
  assert.equal(manifest.source, 'a'.repeat(40));
});
test('symlinks and over-budget evidence refuse without false success', t => {
  const f = fixture(t);
  symlinkSync('/etc', join(f.dir, 'escape'));
  assert.notEqual(f.run().status, 0);
  rmSync(join(f.dir, 'escape'));
  writeFileSync(join(f.dir, 'too-big.png'), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.alloc(4 * 1024 * 1024)]));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cap exceeded/);
});
