import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const staticUI = existsSync(resolve(root, 'apps/ui/package.json'));
const consumer = createRequire(resolve(root, staticUI ? 'apps/ui/package.json' : 'package.json'));
const astro = createRequire(consumer.resolve('astro/package.json'));
const scaffold = createRequire(consumer.resolve(staticUI ? 'tailwindcss' : 'shadcn'));
const glob = createRequire(scaffold.resolve('fast-glob'));
const micromatch = createRequire(glob.resolve('micromatch'));
const cachePath = astro.resolve('http-cache-semantics');
const bracesPath = micromatch.resolve('braces');
const CachePolicy = astro('http-cache-semantics');
const braces = micromatch('braces');

for (const [name, entry] of [['http-cache-semantics', cachePath], ['braces', bracesPath]]) {
  test(`the actual consumer loads the pinned, source-verified ${name} backport`, () => {
    const installed = dirname(entry);
    const info = JSON.parse(readFileSync(resolve(installed, 'package.json'), 'utf8'));
    const provenance = JSON.parse(readFileSync(resolve(directory, name, 'PROVENANCE.json'), 'utf8'));
    assert.equal(info.name, `@spargax-security/${name}`);
    assert.equal(info.version, '0.1.0');
    assert.equal(info.private, true);
    assert.ok(Object.keys(provenance.patched_files).length > 0);
    for (const [path, expected] of Object.entries(provenance.patched_files)) {
      assert.ok(!path.startsWith('/') && !path.split('/').includes('..'));
      assert.match(expected, /^[a-f0-9]{64}$/);
      const bytes = readFileSync(resolve(installed, path));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${name}/${path}: patched source changed`);
    }
  });
}

function fixture(headers, options) {
  let clock = Date.parse('2026-10-03T00:00:00Z');
  class ClockPolicy extends CachePolicy { now() { return clock; } }
  const request = { url: 'https://cache.example.test/resource', method: 'GET', headers: { host: 'cache.example.test' } };
  const policy = new ClockPolicy(request, { status: 200, headers: { date: new Date(clock).toUTCString(), ...headers } }, options);
  return { policy, request, advance: seconds => { clock += seconds * 1000; }, ClockPolicy };
}

test('security-zeroed entries cannot disclose a shared response through max-stale or stale extensions', () => {
  const cases = [
    { 'set-cookie': 'fixture=owner-only', 'cache-control': 'max-age=600, stale-while-revalidate=600, stale-if-error=600' },
    { 'cache-control': 'no-cache, max-age=600, stale-while-revalidate=600, stale-if-error=600' },
    { 'cache-control': 'private, max-age=600, stale-while-revalidate=600' },
    { 'cache-control': 'no-store, max-age=600' },
    { 'cache-control': 'max-age=600, stale-if-error=600', vary: '*' },
    { 'cache-control': 'proxy-revalidate, max-age=600, stale-while-revalidate=600' },
  ];
  for (const headers of cases) {
    const { policy, request, advance, ClockPolicy } = fixture(headers);
    advance(1);
    assert.equal(policy.maxAge(), 0);
    for (const directive of ['max-stale', 'max-stale=999999999']) {
      const attacker = { ...request, headers: { ...request.headers, 'cache-control': directive } };
      for (const candidate of [policy, ClockPolicy.fromObject(policy.toObject())]) {
        const result = candidate.evaluateRequest(attacker);
        assert.equal(result.response, undefined);
        assert.equal(result.revalidation?.synchronous, true);
        assert.equal(candidate.satisfiesWithoutRevalidation(attacker), false);
        assert.equal(candidate.timeToLive(), 0);
        assert.equal(candidate.useStaleWhileRevalidate(), false);
        assert.equal(candidate._useStaleIfError(), false);
      }
    }
  }
});

test('positive-lifetime public caching and private-cache cookies keep ordinary behavior', () => {
  const publicCache = fixture({ 'cache-control': 'public, max-age=60' });
  assert.equal(publicCache.policy.satisfiesWithoutRevalidation(publicCache.request), true);
  publicCache.advance(90);
  assert.equal(publicCache.policy.satisfiesWithoutRevalidation({ ...publicCache.request, headers: { ...publicCache.request.headers, 'cache-control': 'max-stale=120' } }), true);
  const privateCache = fixture({ 'set-cookie': 'fixture=private-cache', 'cache-control': 'max-age=600' }, { shared: false });
  assert.equal(privateCache.policy.maxAge(), 600);
  assert.equal(privateCache.policy.satisfiesWithoutRevalidation(privateCache.request), true);
});

const boundedFailure = error => error instanceof SyntaxError && error.message === 'Brace AST nesting limit exceeded';

test('deep braces and parentheses are rejected before recursive walkers exhaust the stack', () => {
  for (const [open, close] of [['{', '}'], ['(', ')']]) {
    const pattern = open.repeat(1000) + 'fixture' + close.repeat(1000);
    for (const operation of [value => braces(value), value => braces.parse(value), value => braces.expand(value), value => braces.compile(value)]) {
      assert.throws(() => operation(pattern), boundedFailure);
    }
    assert.throws(() => braces.parse(pattern, { maxDepth: Infinity, maxLength: Infinity }), boundedFailure);
  }
});

test('direct AST compile, expand and stringify cannot bypass depth or cycle guards', () => {
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    const ast = { type: 'root', nodes: [] };
    let current = ast;
    for (let i = 0; i < 1000; i++) { const child = { type: 'paren', nodes: [] }; current.nodes.push(child); current = child; }
    current.nodes.push({ type: 'text', value: 'fixture' });
    assert.throws(() => operation(ast), boundedFailure);
    const cycle = { type: 'root', nodes: [] }; cycle.nodes.push(cycle);
    assert.throws(() => operation(cycle), boundedFailure);
  }
});

test('normal alternatives, ranges, nested groups and escaped literals retain compatibility', () => {
  assert.deepEqual(braces.expand('src/{one,two}.js'), ['src/one.js', 'src/two.js']);
  assert.deepEqual(braces.expand('item/{1..3}.txt'), ['item/1.txt', 'item/2.txt', 'item/3.txt']);
  assert.deepEqual(braces.expand('src/{a,{b,c}}.js'), ['src/a.js', 'src/b.js', 'src/c.js']);
  const regex = new RegExp('^' + braces.compile('src/{one,two}.js') + '$');
  assert.equal(regex.test('src/one.js'), true);
  assert.equal(regex.test('src/three.js'), false);
  assert.doesNotThrow(() => braces.parse('\\{'.repeat(500)));
});
