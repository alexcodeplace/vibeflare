import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import {
  EXCLUDE_PAID_MODELS_SETTING,
  excludePaidModelsEnabled,
  filterPaidModels,
  modelRequiresPaid,
} from '../src/models/access';
import { setSetting } from '../src/db/queries';
import type { ModelInfo } from '@vibeflare/shared';

function model(name: string, paidRequired?: boolean): ModelInfo {
  return {
    name,
    task: 'text-generation',
    description: null,
    properties: paidRequired === undefined ? null : JSON.stringify({ paid_required: paidRequired }),
    neurons_input: null,
    neurons_output: null,
    neurons_flat: null,
    beta: 0,
    enabled: 1,
    synced_at: 1,
    probed_at: null,
    probe_error: null,
    fail_streak: 0,
  };
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(EXCLUDE_PAID_MODELS_SETTING).run();
});

describe('paid model access policy', () => {
  it('defaults Exclude paid to on when the setting has never been saved', async () => {
    await expect(excludePaidModelsEnabled(env.DB)).resolves.toBe(true);
  });

  it('allows Exclude paid to be disabled explicitly', async () => {
    await setSetting(env.DB, EXCLUDE_PAID_MODELS_SETTING, '0', Date.now());
    await expect(excludePaidModelsEnabled(env.DB)).resolves.toBe(false);
  });

  it('filters paid-required models while decorating all returned models', () => {
    const free = model('@cf/meta/llama-3.2-3b-instruct', false);
    const paid = model('@cf/deepseek-ai/deepseek-v4-flash-0731', true);

    expect(filterPaidModels([paid, free], true).map((item) => item.name)).toEqual([free.name]);
    expect(filterPaidModels([paid, free], false)).toEqual([
      expect.objectContaining({ name: paid.name, paid_required: true }),
      expect.objectContaining({ name: free.name, paid_required: false }),
    ]);
  });

  it('recognizes the built-in fallback list for catalog rows synced before metadata support', () => {
    expect(modelRequiresPaid(model('@cf/deepseek-ai/deepseek-v4-flash-0731'))).toBe(true);
    expect(modelRequiresPaid(model('@cf/meta/llama-3.2-3b-instruct'))).toBe(false);
  });
});
