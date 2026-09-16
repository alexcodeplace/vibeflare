import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  upsertModel,
  getModel,
  disableDelistedModels,
  rearmDisabledModels,
} from '../src/db/queries';
import { recordModelHealth } from '../src/ai/health';
import { modelRequiresPaid } from '../src/models/access';

const testEnv = env as unknown as Env;

const base = {
  task: 'text-to-image',
  description: null,
  properties: '[]',
  neurons_input: null,
  neurons_output: null,
  neurons_flat: null,
  beta: 0,
  enabled: 1,
  synced_at: 1_000,
};

async function seed(name: string) {
  await upsertModel(env.DB, { name, ...base });
}

async function failTimes(name: string, times: number) {
  for (let i = 0; i < times; i++) {
    await recordModelHealth(testEnv, { model: name, status: 500, error: 'upstream boom' });
  }
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM models').run();
});

describe('recordModelHealth', () => {
  it('disables a model only after three consecutive upstream failures', async () => {
    await seed('@cf/test/flaky');

    await failTimes('@cf/test/flaky', 2);
    expect((await getModel(env.DB, '@cf/test/flaky'))?.enabled).toBe(1);

    await failTimes('@cf/test/flaky', 1);
    const row = await getModel(env.DB, '@cf/test/flaky');
    expect(row?.enabled).toBe(0);
    expect(row?.probe_error).toBe('upstream boom');
  });

  it('a served request clears the streak and re-enables the model', async () => {
    await seed('@cf/test/recovers');
    await failTimes('@cf/test/recovers', 3);

    await recordModelHealth(testEnv, { model: '@cf/test/recovers', status: 200 });

    const row = await getModel(env.DB, '@cf/test/recovers');
    expect(row?.enabled).toBe(1);
    expect(row?.fail_streak).toBe(0);
    expect(row?.probe_error).toBeNull();
  });

  it('learns a paid-plan requirement from real traffic without disabling the model', async () => {
    await seed('@cf/test/frontier');
    await recordModelHealth(testEnv, {
      model: '@cf/test/frontier',
      status: 403,
      error: 'AiError: 5035: Model is not available on the Workers Free plan',
    });

    const row = await getModel(env.DB, '@cf/test/frontier');
    expect(row?.enabled).toBe(1);
    expect(row?.fail_streak).toBe(0);
    expect(row?.probe_error).toContain('5035');
    expect(row ? modelRequiresPaid(row) : false).toBe(true);
  });

  it('retains paid observations across daily catalog refreshes and real successes', async () => {
    await seed('@cf/test/observed');
    await recordModelHealth(testEnv, { model: '@cf/test/observed', status: 403, error: 'AiError: 5035' });
    await upsertModel(env.DB, { ...base, name: '@cf/test/observed', properties: '{"paid_required":false,"source":"refreshed"}' });
    await recordModelHealth(testEnv, { model: '@cf/test/observed', status: 200 });
    const row = await getModel(env.DB, '@cf/test/observed');
    expect(modelRequiresPaid(row!)).toBe(true);
    expect(JSON.parse(row!.properties!).source).toBe('refreshed');
  });

  it('quota exhaustion is not counted against the model', async () => {
    await seed('@cf/test/quota');
    for (let i = 0; i < 5; i++) {
      await recordModelHealth(testEnv, {
        model: '@cf/test/quota',
        status: 429,
        error: 'AiError: 4006: daily free allocation exceeded',
      });
    }
    const row = await getModel(env.DB, '@cf/test/quota');
    expect(row?.enabled).toBe(1);
    expect(row?.fail_streak).toBe(0);
  });

  it('client errors and cache hits carry no health evidence', async () => {
    await seed('@cf/test/neutral');
    await failTimes('@cf/test/neutral', 2);

    await recordModelHealth(testEnv, { model: '@cf/test/neutral', status: 400, error: 'bad input' });
    await recordModelHealth(testEnv, { model: '@cf/test/neutral', status: 200, cached: true });

    const row = await getModel(env.DB, '@cf/test/neutral');
    expect(row?.fail_streak).toBe(2);
    expect(row?.enabled).toBe(1);
  });
});

describe('rearmDisabledModels', () => {
  it('re-enables a still-listed model once its last failure has aged out', async () => {
    await seed('@cf/test/cooled');
    await failTimes('@cf/test/cooled', 3);
    await upsertModel(env.DB, { name: '@cf/test/cooled', ...base, synced_at: 2_000 });

    const changed = await rearmDisabledModels(env.DB, 2_000, Date.now() + 1);

    expect(changed).toBe(1);
    const row = await getModel(env.DB, '@cf/test/cooled');
    expect(row?.enabled).toBe(1);
    expect(row?.fail_streak).toBe(0);
  });

  it('leaves a recently failed model disabled', async () => {
    await seed('@cf/test/hot');
    await failTimes('@cf/test/hot', 3);
    await upsertModel(env.DB, { name: '@cf/test/hot', ...base, synced_at: 2_000 });

    const changed = await rearmDisabledModels(env.DB, 2_000, Date.now() - 60_000);

    expect(changed).toBe(0);
    expect((await getModel(env.DB, '@cf/test/hot'))?.enabled).toBe(0);
  });
});

describe('disableDelistedModels', () => {
  it('disables models the latest sync did not touch', async () => {
    await seed('@cf/test/retired');
    await upsertModel(env.DB, { name: '@cf/test/current', ...base, synced_at: 2_000 });

    const changed = await disableDelistedModels(env.DB, 2_000);

    expect(changed).toBe(1);
    expect((await getModel(env.DB, '@cf/test/retired'))?.enabled).toBe(0);
    expect((await getModel(env.DB, '@cf/test/current'))?.enabled).toBe(1);
  });
});
