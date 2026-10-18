import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { inventory, writeEvidence, LIMITS } from './ci/browser-evidence.mjs';
const script = new URL('./ci/browser-evidence.mjs', import.meta.url).pathname;
const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sample = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic-image')]);
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vibeflare-browser-evidence-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return { dir, run: () => spawnSync(process.execPath, [script, dir],
    { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: source, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' }, timeout: 5000 }) };
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
  const frames = lines.filter(line => line.startsWith('VIBEFLARE_BROWSER_PNG_V1 ')).map(line => JSON.parse(line.replace(/^VIBEFLARE_BROWSER_PNG_V1 /, '')));
  const bytes = gunzipSync(Buffer.from(frames.map(frame => frame.data).join(''), 'base64'));
  const complete = JSON.parse(lines.at(-1).replace(/^VIBEFLARE_BROWSER_EVIDENCE_COMPLETE_V1 /, ''));
  assert.equal(complete.complete, true);
  assert.equal(complete.manifestSha256, createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
  assert.deepEqual(bytes, sample);
  assert.equal(manifest.files[0].sha256, createHash('sha256').update(sample).digest('hex'));
  assert.equal(manifest.source, source);
  assert.equal(manifest.runId, '12345');
  assert.equal(manifest.attempt, '2');
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

test('an Actions source mismatch refuses to manufacture an evidence receipt', t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'case'));
  writeFileSync(join(f.dir, 'case/screenshot.png'), sample);
  const result = spawnSync(process.execPath, [script, f.dir], {
    encoding: 'utf8', timeout: 5000, env: { ...process.env,
      GITHUB_ACTIONS: 'true', GITHUB_SHA: 'a'.repeat(40),
      GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Evidence source\/run\/attempt differs/);
  assert.doesNotMatch(result.stdout, /VIBEFLARE_BROWSER_EVIDENCE_V1/);
});

test('a complete visual matrix can retain more than32 small PNGs without raising its byte budget', t => {
  const f = fixture(t);
  for (let n = 0; n < 64; n++) writeFileSync(join(f.dir, 'matrix-' + n + '.png'), sample);
  const result = f.run(); assert.equal(result.status, 0, result.stderr);
  const first = result.stdout.split('\n')[0];
  const manifest = JSON.parse(first.replace(/^VIBEFLARE_BROWSER_EVIDENCE_V1 /, ''));
  assert.equal(manifest.files.length, 64);
  assert.equal(manifest.files.reduce((sum, file) => sum + file.bytes, 0), sample.length * 64);
});
test('the finite screenshot inventory bound still refuses excessive entries', t => {
  const f = fixture(t);
  for (let n = 0; n < 257; n++) writeFileSync(join(f.dir, 'matrix-' + n + '.png'), sample);
  const result = f.run(); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /file cap exceeded/);
  assert.doesNotMatch(result.stdout, /VIBEFLARE_BROWSER_EVIDENCE_V1/);
});

test('repeated matrix screenshots are losslessly transmitted once per original SHA', async t => {
  const f = fixture(t);
  for (let n = 0; n < 64; n++) writeFileSync(join(f.dir, 'matrix-' + n + '.png'), sample);
  const output = []; await writeEvidence(f.dir, { source, runId: '1', attempt: '1' }, async line => { output.push(line); });
  const manifest = JSON.parse(output[0].split(' ').slice(1).join(' '));
  assert.equal(manifest.files.length, 64); assert.equal(manifest.uniqueCount, 1);
  const frames = output.filter(line => line.startsWith('VIBEFLARE_BROWSER_PNG_V1 '));
  assert.equal(frames.length, 1);
  const frame = JSON.parse(frames[0].split(' ').slice(1).join(' '));
  assert.deepEqual(gunzipSync(Buffer.from(frame.data, 'base64')), sample);
  assert.ok(manifest.files.every(file => file.sha256 === frame.sha256));
  assert.match(output.at(-1), /EVIDENCE_COMPLETE_V1/);
});
test('changed files or interrupted log transport never emit completion', async t => {
  const f = fixture(t); const png = join(f.dir, 'capture.png'); writeFileSync(png, sample);
  const output = [];
  await assert.rejects(writeEvidence(f.dir, { source }, async line => {
    output.push(line);
    if (line.startsWith('VIBEFLARE_BROWSER_EVIDENCE_V1 ')) writeFileSync(png, Buffer.concat([sample, Buffer.from('changed')]));
  }), /changed after inventory/);
  assert.ok(output.every(line => !line.startsWith('VIBEFLARE_BROWSER_EVIDENCE_COMPLETE_V1 ')));
  writeFileSync(png, sample);
  await assert.rejects(writeEvidence(f.dir, { source }, async () => { throw new Error('closed sink'); }), /closed sink/);
});
test('both unique and complete inventory byte budgets remain enforced', t => {
  const f = fixture(t); writeFileSync(join(f.dir, 'one.png'), sample);
  assert.throws(() => inventory(f.dir, { ...LIMITS, totalBytes: sample.length - 1 }), /total cap exceeded/);
  assert.throws(() => inventory(f.dir, { ...LIMITS, uniqueBytes: sample.length - 1 }), /unique screenshot cap exceeded/);
});

test('an inventory larger than the former16MiB cap stays lossless with constant file-sized buffers', async t => {
  const f = fixture(t); const image = Buffer.concat([sample, Buffer.alloc(1024 * 1024)]);
  for (let n = 0; n < 20; n++) writeFileSync(join(f.dir, 'capture-' + n + '.png'), image);
  const output = []; await writeEvidence(f.dir, { source }, async line => { output.push(line); });
  const manifest = JSON.parse(output[0].split(' ').slice(1).join(' '));
  assert.equal(manifest.totalBytes, image.length * 20);
  assert.ok(manifest.totalBytes > 16 * 1024 * 1024);
  assert.equal(manifest.uniqueBytes, image.length);
  const encoded = output.filter(line => line.startsWith('VIBEFLARE_BROWSER_PNG_V1 '))
    .map(line => JSON.parse(line.split(' ').slice(1).join(' ')).data).join('');
  assert.deepEqual(gunzipSync(Buffer.from(encoded, 'base64')), image);
  assert.ok(output.at(-1).startsWith('VIBEFLARE_BROWSER_EVIDENCE_COMPLETE_V1 '));
});
