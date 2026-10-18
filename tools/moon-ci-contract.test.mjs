import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
test('VibeFlare keeps full PR gate and unchanged browser/security evidence with Moon', () => {
  const w = read('.github/workflows/pr-gate.yml');
  const g = JSON.parse(read('moon.yml'));
  assert.ok(w.includes('moonrepo/setup-toolchain@234d6bb3d227f8c0647841c8b1266b9cb94c1c23'));
  assert.doesNotMatch(w, /uses: alexcodeplace\/overdeck\/modules\/ci\/moon@/);
  assert.ok(w.includes("moon-version: '2.6.2'"));
  assert.ok(w.includes("cache: 'false'"));
  const defaults = JSON.parse(read('.moon/tasks/all.yml'));
  const workspace = JSON.parse(read('.moon/workspace.yml'));
  assert.equal(defaults.taskOptions.cache, false);
  assert.equal(defaults.taskOptions.allowFailure, false);
  assert.equal(defaults.taskOptions.retryCount, 0);
  assert.equal(defaults.taskOptions.runInCI, 'always');
  assert.equal(defaults.taskOptions.runDepsInParallel, false);
  assert.equal(workspace.versionConstraint, '=2.6.2');
  assert.equal(workspace.pipeline.installDependencies, false);
  assert.equal(workspace.pipeline.syncWorkspace, false);
  assert.ok(w.includes("MOON_FORCE: 'true'"));
  assert.ok(w.includes("MOON_BASE: ${{ github.sha }}"));
  assert.ok(w.includes("MOON_HEAD: ${{ github.sha }}"));
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
  assert.ok(w.includes('node --test tools/moon-ci-contract.test.mjs tools/browser-evidence.test.mjs'));
  assert.ok(w.includes('node --test tools/browser-evidence.test.mjs'));
  assert.doesNotMatch(w, /uses: actions\/upload-artifact@/);
  assert.ok(read('apps/ui/playwright.config.ts').includes('screenshot: "only-on-failure"'));
  assert.ok(read('tools/ci/browser-evidence.mjs').includes('GITHUB_RUN_ATTEMPT'));
  assert.ok(read('tools/ci/browser-evidence.mjs').includes('Evidence source/run/attempt differs'));

});
