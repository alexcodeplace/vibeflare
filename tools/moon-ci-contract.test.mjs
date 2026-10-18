import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
test('VibeFlare keeps full PR gate and unchanged browser/security evidence with Moon', () => {
  const w = read('.github/workflows/pr-gate.yml');
  const g = JSON.parse(read('moon.yml'));
  assert.ok(w.includes('alexcodeplace/overdeck/modules/ci/moon@65b559292d51f13f2fcb7c2b3a4a6333cea6dd15'));
  for (const [name, task] of [['Build', 'build'], ['Test', 'unit'], ['E2E', 'e2e']]) {
    assert.ok(w.includes('      - name: ' + name + '\n        run: moon run repo:' + task));
  }
  assert.equal(g.toolchains.default, 'system');
  assert.deepEqual(g.tasks.build.command, ['pnpm', 'run', 'build']);
  assert.deepEqual(g.tasks.unit.command, ['pnpm', 'run', 'test']);
  assert.deepEqual(g.tasks.e2e.command, ['pnpm', '--filter', '@vibeflare/ui', 'run', 'test:e2e']);
  for (const part of ['pnpm security:audit', 'pnpm validate:wrangler', 'tools/verify-logo-assets.mjs',
    'playwright install --with-deps chromium', 'node tools/ci/browser-evidence.mjs', 'name: VibeFlare runner readiness']) assert.ok(w.includes(part), part);
  assert.ok(w.includes("github.event.pull_request.head.repo.full_name == github.repository"));
  assert.ok(w.includes('runs-on: ubuntu-24.04'));
  assert.ok(w.includes('timeout-minutes: 45'));
  assert.ok(w.includes('node --test tools/moon-ci-contract.test.mjs'));
  assert.ok(w.includes('node --test tools/browser-evidence.test.mjs'));
  assert.doesNotMatch(w, /uses: actions\/upload-artifact@/);
  assert.ok(read('apps/ui/playwright.config.ts').includes('screenshot: "only-on-failure"'));

});
