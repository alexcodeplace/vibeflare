import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { sign } from 'hono/jwt';
import { getSetting, insertUser, setSetting, upsertModel } from '../src/db/queries';
import { MODEL_CATALOG_READY_KEY, MODEL_CATALOG_SYNCED_AT_KEY } from '../src/models/catalog';
import { runner } from '../src/ai/dispatch';
import { classifyUpstreamError, isPaidPlanRequiredError } from '../src/ai/errors';
import type { Env } from '../src/env';

const paidName = '@cf/test/paid';
const freeName = '@cf/test/free';
const base = { task: 'text-generation', description: null, neurons_input: 1, neurons_output: 1, neurons_flat: null, beta: 0, enabled: 1, synced_at: 1 };
let ownerHeaders: Record<string, string>;
let memberHeaders: Record<string, string>;

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM models').run();
  await env.DB.prepare('DELETE FROM settings').run();
  const now = Date.now();
  for (const role of ['owner', 'user'] as const) {
    await insertUser(env.DB, { id: `paid-policy-${role}`, email: null, github_login: null, role, created_at: now });
  }
  const session = async (role: 'owner' | 'user') => ({
    Cookie: `vf_sess=${await sign({ sub: `paid-policy-${role}`, role, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 }, 'test-secret-for-vitest')}`,
    'Content-Type': 'application/json',
  });
  ownerHeaders = await session('owner');
  memberHeaders = await session('user');
  await upsertModel(env.DB, { ...base, name: freeName, properties: '{"paid_required":false}' });
  await upsertModel(env.DB, { ...base, name: paidName, properties: '{"paid_required":true}' });
  await setSetting(env.DB, MODEL_CATALOG_READY_KEY, '1', now);
  await setSetting(env.DB, MODEL_CATALOG_SYNCED_AT_KEY, String(now), now);
});

const put = (body: unknown, headers = ownerHeaders) => SELF.fetch('http://x/admin/settings', {
  method: 'PUT', headers, body: JSON.stringify(body),
});

describe('paid billing policy through real API routes', () => {
  it('returns the safe default and excludes paid models in both model APIs', async () => {
    const settings = await SELF.fetch('http://x/admin/settings', { headers: ownerHeaders });
    expect((await settings.json<{ settings: Record<string, string> }>()).settings['models.exclude_paid']).toBe('1');
    for (const route of ['/admin/models', '/v1/models']) {
      const r = await SELF.fetch(`http://x${route}`, { headers: { ...ownerHeaders, 'x-vf-browser': '1' } });
      expect(r.status).toBe(200);
      const body = await r.json<{ models?: { name: string }[]; data?: { id: string }[] }>();
      expect(body.models?.map(m => m.name) ?? body.data?.map(m => m.id)).toEqual([freeName]);
    }
  });

  it('persists the settings map and does not accidentally write key/value rows', async () => {
    expect((await put({ 'models.exclude_paid': '0' })).status).toBe(200);
    expect(await getSetting(env.DB, 'models.exclude_paid')).toBe('0');
    expect(await getSetting(env.DB, 'key')).toBeNull();
    expect(await getSetting(env.DB, 'value')).toBeNull();
    const r = await SELF.fetch('http://x/admin/models', { headers: ownerHeaders });
    const body = await r.json<{ models: { name: string; paid_required: boolean }[] }>();
    expect(body.models).toContainEqual(expect.objectContaining({ name: paidName, paid_required: true }));
    expect((await put({ 'models.exclude_paid': '1' })).status).toBe(200);
    expect(await getSetting(env.DB, 'models.exclude_paid')).toBe('1');
  });

  it('prevents members from relaxing the installation-wide policy', async () => {
    expect((await put({ 'models.exclude_paid': '0' }, memberHeaders)).status).toBe(403);
    expect(await getSetting(env.DB, 'models.exclude_paid')).toBeNull();
  });

  it('rejects malformed settings before any partial writes', async () => {
    for (const body of [null, [], { 'models.exclude_paid': false }, { 'cache.responses.ttl_days': '99', 'models.exclude_paid': 'maybe' }]) {
      expect((await put(body)).status).toBe(400);
    }
    expect(await getSetting(env.DB, 'cache.responses.ttl_days')).toBeNull();
  });

  it('blocks direct paid inference before AI.run and permits it only after explicit opt-in', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'test stub' });
    const bindings = { DB: env.DB, AI: { run } } as unknown as Env;
    await expect(runner(bindings, paidName, { prompt: 'test' })).rejects.toThrow('Paid models are excluded');
    expect(run).not.toHaveBeenCalled();
    await setSetting(env.DB, 'models.exclude_paid', '0', Date.now());
    await runner(bindings, paidName, { prompt: 'test' });
    expect(run).toHaveBeenCalledOnce();
  });

  it('returns an actionable 403 on a stale browser selection without consuming quota', async () => {
    const r = await SELF.fetch('http://x/v1/chat/completions', {
      method: 'POST', headers: { ...ownerHeaders, 'x-vf-browser': '1' },
      body: JSON.stringify({ model: paidName, stream: true, messages: [{ role: 'user', content: 'test' }] }),
    });
    expect(r.status).toBe(403);
    expect((await r.json<{ error: { type: string } }>()).error.type).toBe('paid_model_excluded');
  });
});

describe('Workers AI paid-plan errors', () => {
  it('recognizes documented 5035 without interpreting arbitrary request ids as a plan error', () => {
    expect(classifyUpstreamError(new Error('AiError: 5035: requires a Workers Paid plan')).status).toBe(403);
    expect(classifyUpstreamError(new Error('4006: daily free allocation exceeded')).status).toBe(429);
    expect(isPaidPlanRequiredError('upstream failed request 150350')).toBe(false);
  });
});
