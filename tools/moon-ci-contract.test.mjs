import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
test('VibeFlare keeps full PR gate and unchanged browser/security evidence with Moon', () => {
  const w = read('.github/workflows/pr-gate.yml');
  const g = JSON.parse(read('moon.yml'));
  assert.ok(w.includes('alexcodeplace/overdeck/modules/ci/moon@c8508f8fbd844143c559c7e616c5dcfea8db9e3b'));
  for (const [name, task] of [['Build', 'build'], ['Test', 'unit'], ['E2E', 'e2e']]) {
    assert.ok(w.includes('      - name: ' + name + '\n        run: moon run repo:' + task));
  }
  assert.equal(g.toolchains.default, 'system');
  assert.deepEqual(g.tasks.build.command, ['pnpm', 'run', 'build']);
  assert.deepEqual(g.tasks.unit.command, ['pnpm', 'run', 'test']);
  assert.deepEqual(g.tasks.e2e.command, ['pnpm', '--filter', '@vibeflare/ui', 'run', 'test:e2e']);
  for (const part of ['pnpm security:audit', 'pnpm validate:wrangler', 'tools/verify-logo-assets.mjs',
    'playwright install --with-deps chromium', 'name: browser-evidence', 'name: VibeFlare runner readiness']) assert.ok(w.includes(part), part);
  assert.ok(w.includes("github.event.pull_request.head.repo.full_name == github.repository"));
  assert.ok(w.includes('runs-on: ubuntu-24.04'));
  assert.ok(w.includes('timeout-minutes: 45'));
  assert.ok(w.includes('node --test tools/moon-ci-contract.test.mjs'));
});
